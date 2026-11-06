package com.dafeiyu.amadeus;

import android.content.Context;
import android.media.MediaRecorder;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;

/**
 * 录音器（2026-10-20 从 MainActivity 抽出来；2026-10-21 加"说完自动停"）。
 *
 * 为什么抽：主界面和浮窗都要能"按一下说话"，而原来的实现写在 MainActivity 里 ——
 * 浮窗（FloatService）根本没有 MainActivity 实例（App 可以被杀到只剩浮窗）。
 * 这里只依赖 Context，两边共用。
 *
 * **自动停（VAD）**：以前要么点两下、要么浮窗固定录 6 秒，结果是"说完还在录、
 * 多录的那几秒全是静音"，识别反而更差。现在用 {@link MediaRecorder#getMaxAmplitude()}
 * 盯着电平：说过话之后**安静 1.2 秒**就自己停，最长 20 秒兜底。
 * 自动停时调用 {@link Done#onDone(String)} 把音频（base64 JSON）交回去。
 *
 * 返回的是 JSON 字符串（base64 音频），和 Bridge 的约定一致：
 *   start → {"ok":true,"recording":true}
 *   stop  → {"ok":true,"mime":"audio/mp4","data":"<base64>"}
 * 失败直接抛异常，由调用方转成 {"error":"…"}。
 */
public final class Recorder {

    private static final String TAG = "amadeus-rec";
    /** 电平阈值下限（0~32767）。安静房间约 200~800，正常说话 3000+。 */
    private static final int VOICE_AMP_MIN = 1500;
    /** 说完之后安静这么久就收工（太短会把人说话的停顿当说完）。 */
    private static final long SILENCE_MS = 1600;
    /** 至少录这么久才允许自动停（防止刚开就停）。 */
    private static final long MIN_MS = 900;
    /** 最长录多久（兜底，防止一直不停）。 */
    private static final long MAX_MS = 20000;

    public interface Done {
        /** 自动停了：json 是 stop() 的结果（失败时是 {"ok":false,"error":…}）。 */
        void onDone(String json);
    }

    private static MediaRecorder rec;
    private static File file;

    private Recorder() { }

    public static String start(Context ctx) throws Exception {
        return start(ctx, null);
    }

    public static synchronized String start(Context ctx, Done done) throws Exception {
        stopQuietly();
        file = new File(ctx.getCacheDir(), "rec-" + System.currentTimeMillis() + ".m4a");
        MediaRecorder r = new MediaRecorder();
        r.setAudioSource(MediaRecorder.AudioSource.MIC);
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        r.setAudioSamplingRate(44100);
        r.setAudioEncodingBitRate(96000);
        r.setOutputFile(file.getAbsolutePath());
        r.prepare();
        r.start();
        rec = r;
        if (done != null) startVad(done);
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("recording", true);
        return o.toString();
    }

    /** 盯着电平：说过话 → 安静 1.2 秒 → 自动 stop 并回调。 */
    private static void startVad(final Done done) {
        final long startedAt = System.currentTimeMillis();
        Thread t = new Thread(() -> {
            long lastVoiceAt = startedAt;
            // 自适应底噪：屋子吵的时候（实测底噪能到 1500）阈值自动抬高，
            // 不然"没人说话"也会被当成一直在说，永远停不下来。
            double noise = 600;
            while (true) {
                sleep(90);
                MediaRecorder r = rec;
                if (r == null) return;                    // 用户手动停了
                int amp;
                try { amp = r.getMaxAmplitude(); }        // 自上次调用以来的峰值
                catch (Throwable e) { return; }           // 已经 release 了
                noise = noise * 0.92 + amp * 0.08;
                long now = System.currentTimeMillis();
                int th = (int) Math.max(VOICE_AMP_MIN, noise * 2.2);
                if (amp > th) lastVoiceAt = now;
                boolean tooLong = now - startedAt > MAX_MS;
                boolean silence = now - lastVoiceAt > SILENCE_MS && now - startedAt > MIN_MS;
                if (!tooLong && !silence) continue;
                Log.i(TAG, "自动停（" + (now - startedAt) + "ms，最后一句在 "
                        + (now - lastVoiceAt) + "ms 前，amp=" + amp + "）");
                String json;
                try { json = stop(); }
                catch (Throwable e) {
                    json = "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
                }
                try { done.onDone(json); } catch (Throwable ignored) { }
                return;
            }
        }, "amadeus-rec-vad");
        t.setDaemon(true);
        t.start();
    }

    public static synchronized String stop() throws Exception {
        if (rec == null) throw new Exception("还没在录");
        try { rec.stop(); } catch (Throwable ignored) { }
        try { rec.release(); } catch (Throwable ignored) { }
        rec = null;
        if (file == null || !file.exists() || file.length() < 2000) throw new Exception("录音太短");
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int off = 0, n;
            while (off < bytes.length && (n = in.read(bytes, off, bytes.length - off)) > 0) off += n;
        }
        String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("mime", "audio/mp4");
        o.put("data", b64);
        return o.toString();
    }

    public static synchronized void stopQuietly() {
        if (rec == null) return;
        try { rec.stop(); } catch (Throwable ignored) { }
        try { rec.release(); } catch (Throwable ignored) { }
        rec = null;
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }
}
