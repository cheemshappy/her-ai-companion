package com.dafeiyu.amadeus;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.AudioManager;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONObject;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.File;

/**
 * 唤醒词：「大肥鱼」叫一声她就醒（2026-10-20 加）。
 *
 * 只在**浮窗开着**的时候听（主人选的）：浮窗就是"她在场"的开关，
 * 关掉浮窗就彻底不占麦克风。用的是 Vosk 的中文小模型（离线，44MB，
 * 第一次从电脑下，见 {@link VoskModel}）。
 *
 * 为什么要离线模型：HyperOS 上的 SpeechRecognizer 一调就 ERROR_CLIENT（§143.1），
 * 而且系统识别不适合"一直在听"；Vosk 能只跑一个很小的关键词解码，功耗可控。
 *
 * 流程：AudioRecord(16k 单声道) → Vosk 连续识别 → partial 里出现"大肥鱼" →
 * 震动一下 + 回调 {@link Sink#onWake()}（浮窗页面接着开始录音对话）。
 */
public final class WakeWord {

    private static final String TAG = "amadeus-wake";
    /**
     * 模型对"大肥鱼"这种**词表里没有的名字**很不稳定（实测会认成：大肥腴 / 大飞鱼 /
     * 大飞与 / 到飞鱼 / 那飞鱼…），所以不能死磕字面，用一条宽松的正则：
     * "大" + 一个 f 音的字（飞/肥/非/菲）+ 一个 yu 音的字（鱼/腴/与/于/宇/跃/玉）。
     * 比对前先去掉空格（模型的输出常是"大 肥 腴"这种带空格的）。
     */
    private static final java.util.regex.Pattern WAKE_RE = java.util.regex.Pattern.compile(
            "\u5927\\s*(飞|肥|非|菲|吠)\\s*(鱼|腴|与|于|宇|跃|玉|育|遇|娱|渔)");

    /**
     * 灵敏度（2026-10-21 主人要的）：
     *   0 宽松 = 连"飞鱼""肥腴"这种没带"大"的也算（嘈杂/口音重时用，容易误唤醒）
     *   1 标准 = 上面的 WAKE_RE（默认）
     *   2 严格 = 只认"大肥鱼/大飞鱼"字面（几乎不误唤醒，但对她这个模型容易叫不醒）
     * 存在 SharedPreferences("amadeus_wake")，改完立刻生效（每次判定现读）。
     */
    private static final java.util.regex.Pattern WAKE_LOOSE = java.util.regex.Pattern.compile(
            "(大)?\\s*(飞|肥|非|菲|吠)\\s*(鱼|腴|与|于|宇|跃|玉|育|遇|娱|渔)");
    private static final java.util.regex.Pattern WAKE_STRICT = java.util.regex.Pattern.compile(
            "大\\s*(肥|飞)\\s*(鱼|魚|腴)");

    private static final String PREFS = "amadeus_wake";
    private static volatile int sensCache = -1;
    /** 最近听到的片段（诊断用，最多 30 条） */
    private static final java.util.ArrayDeque<String> HEARD = new java.util.ArrayDeque<>();
    private static volatile int wakeCount = 0;
    private static volatile long lastWakeAt = 0;

    public static int sens(Context ctx) {
        if (sensCache < 0) {
            try { sensCache = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("sens", 1); }
            catch (Throwable e) { sensCache = 1; }
        }
        return sensCache;
    }

    public static void setSens(Context ctx, int n) {
        int v = Math.max(0, Math.min(2, n));
        sensCache = v;
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("sens", v).apply();
        } catch (Throwable ignored) { }
    }

    private static void remember(String what) {
        synchronized (HEARD) {
            HEARD.addLast(new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.CHINA).format(new java.util.Date())
                    + "  " + what);
            while (HEARD.size() > 30) HEARD.removeFirst();
        }
    }

    /** 给设置页看的：灵敏度 / 叫醒次数 / 最近听到的片段。 */
    public static String statsJson(Context ctx) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("sens", sens(ctx));
            o.put("wakes", wakeCount);
            o.put("lastWakeAt", lastWakeAt);
            o.put("listening", inst != null);
            org.json.JSONArray arr = new org.json.JSONArray();
            synchronized (HEARD) { for (String h : HEARD) arr.put(h); }
            o.put("heard", arr);
            return o.toString();
        } catch (Throwable e) {
            return "{\"sens\":1,\"wakes\":0,\"heard\":[]}";
        }
    }

    public interface Sink {
        void onWake();
    }

    private static volatile WakeWord inst;

    private final Context ctx;
    private final Sink sink;
    private volatile boolean running;
    private volatile boolean paused;
    private long lastFire = 0;

    private long lastLog = 0;

    private Thread thread;
    private Model model;
    private Recognizer rec;
    private AudioRecord ar;
    private boolean audioOpen;

    private WakeWord(Context ctx, Sink sink) {
        this.ctx = ctx.getApplicationContext();
        this.sink = sink;
    }

    public static synchronized WakeWord start(Context ctx, Sink sink) {
        sens(ctx);
        if (inst != null) return inst;
        WakeWord w = new WakeWord(ctx, sink);
        inst = w;
        w.startInternal();
        return w;
    }

    public static synchronized void stopAll() {
        WakeWord w = inst;
        inst = null;
        if (w != null) w.stopInternal();
    }

    /** 录音说话的时候要暂停（麦克风只有一个）。 */
    public static void pauseAll() {
        WakeWord w = inst;
        if (w != null) w.pause();
    }

    public static void resumeAll() {
        WakeWord w = inst;
        if (w != null) w.resume();
    }

    // ───────────────────────────── 内部 ─────────────────────────────────────
    private void startInternal() {
        running = true;
        thread = new Thread(this::loop, "amadeus-wake");
        thread.setDaemon(true);
        thread.start();
    }

    private void stopInternal() {
        running = false;
        Thread t = thread;
        thread = null;
        if (t != null) {
            try { t.join(1500); } catch (InterruptedException ignored) { }
        }
        closeAll();
    }

    private void loop() {
        try {
            File dir = VoskModel.ensure(ctx);
            LibVosk.setLogLevel(LogLevel.WARNINGS);
            model = new Model(dir.getAbsolutePath());
            rec = new Recognizer(model, 16000f);
            Log.i(TAG, "唤醒词已就绪（大肥鱼）");
            openAudio();
            byte[] buf = new byte[3200];                 // 100ms @16k/16bit
            while (running) {
                if (paused) { sleep(120); continue; }
                AudioRecord a = ar;
                if (a == null) { openAudio(); sleep(200); continue; }
                int n;
                try { n = a.read(buf, 0, buf.length); }
                catch (Throwable e) { Log.w(TAG, "read: " + e); sleep(300); continue; }
                if (n <= 0) { sleep(120); continue; }
                try {
                    // 只在她**听到人说话**的时候记一行（排查识别效果用，平时不刷屏）
                    String partial = rec.getPartialResult();
                    if (partial != null && partial.indexOf('"') >= 0
                            && !shortText(partial).isEmpty()
                            && System.currentTimeMillis() - lastLog > 2000) {
                        lastLog = System.currentTimeMillis();
                        String heardNow = shortText(partial);
                        Log.i(TAG, "听到：" + heardNow);
                        remember(heardNow);
                    }
                    if (rec.acceptWaveForm(buf, n)) {
                        String txt = rec.getResult();
                        if (hit(txt)) fire();
                    } else if (hit(rec.getPartialResult())) {
                        fire();
                    }
                } catch (Throwable e) {
                    Log.w(TAG, "accept: " + e);
                    sleep(300);
                }
            }
        } catch (Throwable e) {
            Log.w(TAG, "唤醒词没起来：" + e, e);
        } finally {
            closeAll();
        }
    }

    private static String shortText(String json) {
        if (json == null) return "";
        String t;
        try {
            JSONObject o = new JSONObject(json);
            t = o.optString("partial", o.optString("text", ""));
        } catch (Throwable e) { t = json; }
        t = t.replace(" ", "");
        return t.length() > 40 ? t.substring(0, 40) : t;
    }

    /** 去空格后看有没有"大肥鱼"；命中后 2.5 秒内不重复触发。 */
    private static boolean hit(String json) {
        if (json == null || json.isEmpty()) return false;
        String text;
        try {
            JSONObject o = new JSONObject(json);
            text = o.optString("partial", o.optString("text", ""));
        } catch (Throwable e) {
            text = json;
        }
        if (text.isEmpty()) return false;
        java.util.regex.Pattern p;
        switch (sensCache < 0 ? 1 : sensCache) {
            case 0: p = WAKE_LOOSE; break;
            case 2: p = WAKE_STRICT; break;
            default: p = WAKE_RE;
        }
        return p.matcher(text).find();
    }

    private void fire() {
        long now = System.currentTimeMillis();
        if (now - lastFire < 2500) return;
        lastFire = now;
        Log.i(TAG, "叫我了");
        wakeCount += 1;
        lastWakeAt = now;
        remember("★ 叫醒（第 " + wakeCount + " 次）");
        buzz();
        try { if (rec != null) rec.reset(); } catch (Throwable ignored) { }
        Sink s = sink;
        if (s != null) {
            try { s.onWake(); } catch (Throwable ignored) { }
        }
    }

    private void buzz() {
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null) return;
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE));
            else v.vibrate(45);
        } catch (Throwable ignored) { }
    }

    private synchronized void openAudio() {
        if (audioOpen) return;
        try {
            int min = AudioRecord.getMinBufferSize(16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int size = Math.max(min * 2, 3200 * 4);
            AudioRecord a = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size);
            if (a.getState() != AudioRecord.STATE_INITIALIZED) {
                a.release();
                throw new Exception("AudioRecord 初始化失败");
            }
            a.startRecording();
            ar = a;
            audioOpen = true;
        } catch (Throwable e) {
            Log.w(TAG, "开麦克风失败: " + e);
            audioOpen = false;
        }
    }

    private synchronized void closeAudio() {
        audioOpen = false;
        AudioRecord a = ar;
        ar = null;
        if (a != null) {
            try { a.stop(); } catch (Throwable ignored) { }
            try { a.release(); } catch (Throwable ignored) { }
        }
    }

    private synchronized void closeAll() {
        closeAudio();
        try { if (rec != null) rec.close(); } catch (Throwable ignored) { }
        rec = null;
        try { if (model != null) model.close(); } catch (Throwable ignored) { }
        model = null;
    }

    private void pause() {
        paused = true;
        closeAudio();
        Log.i(TAG, "暂停（要录音/说话）");
    }

    private void resume() {
        paused = false;
        if (running) openAudio();
        Log.i(TAG, "继续听");
    }

    /**
     * 离线自测（2026-10-20）：把 APK 里 assets/wake-test.wav 喂给模型，看认不认得出。
     * 为什么要有：手机上没法"对着麦克风说一句"来验证，只能拿一段真音频跑一遍。
     * 触发：adb shell am start -n com.dafeiyu.amadeus/.MainActivity -e wakeTest 1
     */
    public static void testAsset(Context ctx) {
        new Thread(() -> {
            try {
                File dir = VoskModel.ensure(ctx);
                LibVosk.setLogLevel(LogLevel.WARNINGS);
                Model m = new Model(dir.getAbsolutePath());
                Recognizer r = new Recognizer(m, 16000f);
                java.io.InputStream in = ctx.getAssets().open("wake-test.wav");
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) > 0) bos.write(b, 0, n);
                in.close();
                byte[] all = bos.toByteArray();
                if (all.length < 1000) throw new Exception("测试音频太小");
                // 跳过 44 字节 WAV 头（自己生成的就是标准 PCM 头）
                int off = 44;
                byte[] pcm = new byte[all.length - off];
                System.arraycopy(all, off, pcm, 0, pcm.length);
                Log.i(TAG, "自测：pcm=" + pcm.length + "B");
                boolean endOfSpeech = r.acceptWaveForm(pcm, pcm.length);
                String segText = r.getResult();
                String finalText = r.getFinalResult();
                Log.i(TAG, "自测结果 断句=" + endOfSpeech + " seg=" + segText + " final=" + finalText);
                Log.i(TAG, "自测命中=" + (hit(segText) || hit(finalText)));
                r.close();
                m.close();
            } catch (Throwable e) {
                Log.w(TAG, "自测失败：" + e, e);
            }
        }, "amadeus-wake-test").start();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }
}
