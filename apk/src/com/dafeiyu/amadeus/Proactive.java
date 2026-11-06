package com.dafeiyu.amadeus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

/**
 * 手机后台的「她主动说话」通道（2026-10-20）。
 *
 * 为什么要这个类：通知监听（{@link MsgService}）只解决了"她能读通知"，
 * 但"她要不要主动开口"没有任何人推得动 —— 手机端所有请求都是页面发起的，
 * 页面关掉就等于失联。主人的要求是"每小时把重要消息跟我说一句"，
 * 所以这里补两条**不依赖页面**的后台线：
 *
 *   ① 上行：通知来一条就攒着，每 6 秒 POST /api/notifications 推给电脑
 *      （电脑那边的 DeepSeek 才有原料可挑）；
 *   ② 下行：每 60 秒长轮询 GET /api/proactive?wait=20000，拿到简报就
 *      弹一条通知 + 播她的声音（服务端已经用克隆音色合成了 mp3）。
 *
 * 为什么播放走"先下 mp3 再放"而不是直接 setDataSource(url)：
 * 服务端要带 x-amadeus-key 头，MediaPlayer 的 header 支持在不同 ROM 上不一致，
 * 而且手机在弱网下流式播放会卡；40KB 的 mp3 直接下下来最稳。
 */
public final class Proactive {

    private static final String TAG = "amadeus-proactive";
    private static final String CHANNEL = "amadeus_brief";
    private static final int NOTIF_BASE = 0x1200;
    private static final long FLUSH_GAP_MS = 900;      // 攒不到1秒推一批，别一条一个请求
    private static final int MAX_OUTBOX = 60;

    private static final ArrayDeque<JSONObject> outbox = new ArrayDeque<>();
    private static volatile boolean flushRunning = false;
    private static volatile boolean polling = false;
    private static Context appCtx;
    private static int notifSeq = 0;
    private static MediaPlayer player;

    private Proactive() { }

    // ───────────────────────────── 上行：通知 → 电脑 ────────────────────────
    /** 通知监听里每条都调一下（很快，只入内存队列）。 */
    public static void onNotification(Context ctx, String pkg, String app, String title, String text, long timeMs) {
        if (ctx == null) return;
        appCtx = ctx.getApplicationContext();
        try {
            JSONObject o = new JSONObject();
            o.put("pkg", pkg == null ? "" : pkg);
            o.put("app", app == null ? "" : app);
            o.put("title", title == null ? "" : title);
            o.put("text", text == null ? "" : text);
            o.put("t", timeMs > 0 ? timeMs : System.currentTimeMillis());
            synchronized (outbox) {
                outbox.addLast(o);
                while (outbox.size() > MAX_OUTBOX) outbox.removeFirst();
            }
            ensureFlusher();
        } catch (Throwable e) {
            Log.w(TAG, "enqueue failed: " + e);
        }
    }

    private static synchronized void ensureFlusher() {
        if (flushRunning) return;
        flushRunning = true;
        Thread t = new Thread(() -> {
            try {
                while (true) {
                    sleep(FLUSH_GAP_MS);
                    JSONArray batch;
                    synchronized (outbox) {
                        if (outbox.isEmpty()) break;          // 空了就下班，下次来通知再起
                        batch = new JSONArray();
                        int n = 0;
                        while (!outbox.isEmpty() && n < 20) { batch.put(outbox.removeFirst()); n++; }
                    }
                    try { postNotifications(batch); }
                    catch (Throwable e) {
                        synchronized(outbox){for(int j=batch.length()-1;j>=0;j--)if(batch.optJSONObject(j)!=null)outbox.addFirst(batch.optJSONObject(j));while(outbox.size()>MAX_OUTBOX)outbox.removeLast();}
                        sleep(12000);
                    }
                }
            } finally {
                flushRunning = false;
                synchronized(outbox){if(!outbox.isEmpty())ensureFlusher();}
            }
        }, "amadeus-notif-flush");
        t.setDaemon(true);
        t.start();
    }

    private static void postNotifications(JSONArray items) throws Exception {
        JSONObject body = new JSONObject();
        body.put("items", items);
        // 主地址失败就试备用（出门在外走隧道）
        Exception last = null;
        for (int i = 0; i < 2; i++) {
            Endpoint ep = endpoint(i);
            if (ep == null) continue;
            try {
                call(ep, "/api/notifications", "POST", body.toString(), 15000);
                return;
            } catch (Exception e) { last = e; }
        }
        if (last != null) throw last;
    }

    // ───────────────────────────── 下行：她的简报 → 手机 ────────────────────
    /** 幂等：重复调用只会有一个轮询线程。 */
    public static synchronized void ensurePoller(Context ctx) {
        if (ctx != null) appCtx = ctx.getApplicationContext();
        if (polling || appCtx == null) return;
        polling = true;
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    // 每小时扫一遍微信/QQ 的新消息（2026-10-22）
                    try { Digest.maybeRunHourly(appCtx); } catch (Throwable ignored) { }
                    String raw = null;
                    Exception last = null;
                    for (int i = 0; i < 2; i++) {
                        Endpoint ep = endpoint(i);
                        if (ep == null) continue;
                        try {
                            raw = call(ep, "/api/proactive?wait=20000", "GET", null, 30000);
                            break;
                        } catch (Exception e) { last = e; }
                    }
                    if (raw == null) {
                        if (last != null) Log.w(TAG, "poll failed: " + last);
                        sleep(60000);
                        continue;
                    }
                    JSONArray items = new JSONObject(raw).optJSONArray("items");
                    int n = items == null ? 0 : items.length();
                    for (int i = 0; i < n; i++) {
                        try { deliver(items.optJSONObject(i)); }
                        catch (Throwable e) { Log.w(TAG, "deliver failed: " + e); }
                    }
                    if (n == 0) sleep(3000);      // 长轮询刚超时，别马上又发一个
                } catch (Throwable e) {
                    Log.w(TAG, "poll loop: " + e);
                    sleep(30000);
                }
            }
        }, "amadeus-proactive");
        t.setDaemon(true);
        t.start();
        Log.i(TAG, "poller started");
    }

    private static void deliver(JSONObject item) {
        if (item == null) return;
        String text = item.optString("text", "").trim();
        if (text.isEmpty()) return;
        String audioUrl = item.optString("audioUrl", "");
        showBriefing(text);
        if (!audioUrl.isEmpty()) playAudio(audioUrl);
        // 消息清单：除了通知，还在 App 里画一张清单卡片
        if ("digest".equals(item.optString("kind", ""))) {
            JSONArray items = item.optJSONArray("items");
            MainActivity a = MainActivity.INSTANCE;
            if (items != null && a != null) {
                try {
                    org.json.JSONObject payload = new org.json.JSONObject();
                    payload.put("at", item.optLong("at", System.currentTimeMillis()));
                    payload.put("items", items);
                    a.showDigest(payload.toString());
                } catch (Throwable e) { Log.w(TAG, "digest ui: " + e); }
            }
        }
    }

    private static void showBriefing(String text) {
        Context ctx = appCtx;
        if (ctx == null) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "她的简报", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("她会主动告诉你这一小时谁找过你、有什么要紧事");
                ch.enableVibration(true);
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(ctx, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(ctx, CHANNEL)
                    : new Notification.Builder(ctx);
            b.setContentTitle("她")
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE);
            nm.notify(NOTIF_BASE + (notifSeq++ % 100), b.build());
            // App 开着就顺手让她在屏幕上说出来（声音仍然只有一份：下面 playAudio）
            MainActivity a = MainActivity.INSTANCE;
            if (a != null) a.herSay(text);
            Log.i(TAG, "briefing shown: " + text);
        } catch (Throwable e) {
            Log.w(TAG, "notify failed: " + e);
        }
    }

    /** 播她的声音（服务端已经合成好的 mp3）。失败就算了，通知还在。 */
    private static void playAudio(String audioPath) {
        final Context ctx = appCtx;
        if (ctx == null) return;
        new Thread(() -> {
            try {
                File f = downloadAudio(ctx, audioPath);
                if (f == null) return;
                synchronized (Proactive.class) {
                    stopAudio();
                    MediaPlayer mp = new MediaPlayer();
                    AudioAttributes attrs = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANT)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build();
                    mp.setAudioAttributes(attrs);
                    mp.setDataSource(f.getAbsolutePath());
                    mp.setOnCompletionListener(m -> { try { m.release(); } catch (Throwable ignored) { } });
                    mp.prepare();
                    mp.start();
                    player = mp;
                }
                Log.i(TAG, "audio playing: " + f.getName());
            } catch (Throwable e) {
                Log.w(TAG, "audio failed: " + e);
            }
        }, "amadeus-brief-audio").start();
    }

    private static void stopAudio() {
        try { if (player != null) { player.stop(); player.release(); } } catch (Throwable ignored) { }
        player = null;
    }

    private static File downloadAudio(Context ctx, String path) {
        Exception last = null;
        for (int i = 0; i < 2; i++) {
            Endpoint ep = endpoint(i);
            if (ep == null) continue;
            HttpURLConnection c = null;
            try {
                String url = path.startsWith("http") ? path : ep.base + path;
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(20000);
                if (!ep.token.isEmpty()) c.setRequestProperty("x-amadeus-key", ep.token);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                String name = path.substring(path.lastIndexOf('/') + 1).replaceAll("[^0-9a-zA-Z._-]", "");
                if (name.isEmpty()) name = "brief.mp3";
                File dir = new File(ctx.getCacheDir(), "briefing");
                if (!dir.exists()) dir.mkdirs();
                // 清掉旧的，别让缓存越攒越多
                File[] olds = dir.listFiles();
                if (olds != null && olds.length > 8) for (File o : olds) o.delete();
                File out = new File(dir, name);
                try (InputStream is = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                }
                if (out.length() < 800) throw new Exception("音频太小 " + out.length());
                return out;
            } catch (Exception e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        if (last != null) Log.w(TAG, "download failed: " + last);
        return null;
    }

    // ───────────────────────────── 基础：地址 / HTTP ───────────────────────
    private static final class Endpoint {
        String base;
        String token;
    }

    /** 给别的类用（VoskModel 下载模型）：{base, token}；没配就 null。 */
    public static String[] endpointParts(int i) {
        Endpoint e = endpoint(i);
        return e == null ? null : new String[] { e.base, e.token };
    }

    /** i=0 主地址（家里热点/局域网）、i=1 备用地址（公网隧道）。 */
    private static Endpoint endpoint(int i) {
        Context ctx = appCtx;
        if (ctx == null) return null;
        SharedPreferences sp = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String raw = sp.getString(i == 0 ? MainActivity.KEY_SERVER : MainActivity.KEY_ALT, "");
        return parse(raw);
    }

    /** "http://192.168.137.1:8790/?k=令牌" → base + token。 */
    private static Endpoint parse(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http")) s = "http://" + s;
        String head = s;
        String token = "";
        int qi = s.indexOf('?');
        if (qi >= 0) {
            head = s.substring(0, qi);
            for (String kv : s.substring(qi + 1).split("&")) {
                int eq = kv.indexOf('=');
                if (eq > 0 && "k".equals(kv.substring(0, eq))) {
                    try { token = URLDecoder.decode(kv.substring(eq + 1), "UTF-8"); } catch (Throwable ignored) { }
                }
            }
        }
        while (head.endsWith("/")) head = head.substring(0, head.length() - 1);
        if (head.isEmpty()) return null;
        Endpoint e = new Endpoint();
        e.base = head;
        e.token = token;
        return e;
    }

    private static String call(Endpoint ep, String path, String method, String body, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(ep.base + path).openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod(method);
            c.setRequestProperty("accept", "application/json");
            if (!ep.token.isEmpty()) c.setRequestProperty("x-amadeus-key", ep.token);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json; charset=utf-8");
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(b.length);
                try (OutputStream os = c.getOutputStream()) { os.write(b); }
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = readAll(is);
            if (code >= 400) throw new Exception("HTTP " + code + " " + text);
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        try (InputStream in = is; ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }
}
