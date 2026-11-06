package com.dafeiyu.amadeus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 录"应用内声音"（AudioPlaybackCapture，2026-10-22）。
 *
 * 两种用法：
 *   1. 一次性：`capStart {seconds}` → 录一段存 wav（调音量/验证用）
 *   2. 连续「听」：`capListen {on, chunk}` → 每 chunk 秒录一段、传 /api/audio 转写，
 *      电脑那边攒成滚动字幕，她回答"刚才视频里说了什么"时读它。
 *
 * 为什么单独一个前台服务：Android 14 要求 MediaProjection 由
 * `mediaProjection` 类型的前台服务持有，而且**必须在用户授权之后**才能起
 * （先起会抛 SecurityException: requires project_media）。
 */
public class CaptureService extends Service {

    private static final String TAG = "amadeus-cap";
    private static final String CHANNEL = "amadeus_capture";
    private static final int NOTIF_ID = 0x21;
    private static final int RATE = 16000;          // 16k 单声道
    private static final int CHANNELS = 1;
    private static volatile CaptureService INSTANCE;

    /** 由 MainActivity 在拿到授权后放进来的"待录"数据 */
    public static volatile int pendingCode = 0;
    public static volatile Intent pendingData = null;
    public static volatile int pendingSeconds = 6;
    public static volatile boolean pendingContinuous = false;

    /** 授权一次就留着，后面反复录不用再弹框 */
    private static volatile MediaProjection projection;

    private volatile Thread worker;
    private volatile boolean running;
    private volatile boolean continuous;

    public static boolean hasProjection() { return projection != null; }
    public static CaptureService get() { return INSTANCE; }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        INSTANCE = this;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "录应用内声音", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setContentTitle(pendingContinuous ? "正在听你手机里的声音" : "正在录音频")
                .setSmallIcon(R.drawable.ic_notification).setOngoing(true);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIF_ID, b.build());
            }
        } catch (Throwable e) {
            Log.w(TAG, "startForeground 失败：" + e);
        }

        final int code = pendingCode;
        final Intent data = pendingData;
        final int secs = pendingSeconds;
        final boolean cont = pendingContinuous;
        if (code != 0 && data != null) {
            pendingCode = 0;
            pendingData = null;
            if (cont) startContinuousInternal(secs, code, data);
            else start(code, data, secs);
        }
    }

    // ────────────────────────────── 一次性录制 ──────────────────────────────
    public void start(int resultCode, Intent data, int seconds) {
        if (running) return;
        running = true;
        continuous = false;
        final int secs = Math.max(1, Math.min(seconds, 60));
        worker = new Thread(() -> {
            AudioRecord rec = null;
            try {
                MediaProjection mp = ensureProjection(resultCode, data);
                rec = openRecorder(mp);
                File dir = getExternalFilesDir(null);
                if (dir != null) dir.mkdirs();
                File out = new File(dir, "cap-" + System.currentTimeMillis() + ".wav");
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(new byte[44]);
                long bytes = recordInto(rec, fos, secs);
                fos.close();
                fillWavHeader(out, bytes);
                Log.i(TAG, "录完：" + out.getAbsolutePath() + " 字节=" + bytes);
            } catch (Throwable e) {
                Log.w(TAG, "内录失败：" + e, e);
            } finally {
                closeRecorder(rec);
                running = false;
            }
        }, "amadeus-cap");
        worker.setDaemon(true);
        worker.start();
    }

    /** 已经授权过了 → 直接再录一段（不弹框）。 */
    public void startAgain(int seconds) {
        if (projection == null) return;
        start(-1, null, seconds);
    }

    // ────────────────────────────── 连续「听」 ──────────────────────────────
    public void startContinuous(int chunkSec) {
        startContinuousInternal(chunkSec, 0, null);
    }

    private void startContinuousInternal(int chunkSec, int resultCode, Intent data) {
        if (running) return;
        running = true;
        continuous = true;
        worker = new Thread(() -> {
            AudioRecord rec = null;
            try {
                MediaProjection mp = ensureProjection(resultCode, data);
                rec = openRecorder(mp);
                Log.i(TAG, "开始听（按说话分段）");
                segmentLoop(rec, chunkSec);
            } catch (Throwable e) {
                Log.w(TAG, "连续听失败：" + e, e);
            } finally {
                closeRecorder(rec);
                running = false;
                continuous = false;
                Log.i(TAG, "连续听结束");
            }
        }, "amadeus-listen");
        worker.setDaemon(true);
        worker.start();
    }

    /**
     * 按"说话片段"录音上传（2026-10-22）：
     *   安静时低占空比探测（录 1 秒 → 歇 4 秒）；
     *   听到声音就开始攒，等 1.2 秒静音再切段上传（一句话一段，ASR 不会被拦腰截断）；
     *   最长的段 20 秒，超了强制切。
     * 比固定 10 秒一刀切的好处：字幕按句子走，短句不会断，长句不会混。
     */
    private void segmentLoop(AudioRecord rec, int maxSec) throws Exception {
        final int blockBytes = 3200;              // 100ms @ 16k/16bit
        final int START = 260;                    // 开始判定的平均幅度
        final int STOP = 140;                     // 静音判定
        final long SILENCE_MS = 1200;
        final long MAX_MS = Math.max(5000, maxSec * 1000L);
        final long IDLE_SILENCE_MS = 5000;

        byte[] buf = new byte[blockBytes];
        ByteArrayOutputStream seg = new ByteArrayOutputStream(1 << 16);
        boolean inSpeech = false;
        long segStart = 0;
        long silenceMs = 0;
        long idleSilenceMs = 0;

        while (running && continuous) {
            int n = rec.read(buf, 0, buf.length);
            if (n <= 0) continue;
            long amp = meanAbs(buf, n);

            if (!inSpeech) {
                if (amp > START) {
                    inSpeech = true;
                    seg.reset();
                    seg.write(buf, 0, n);
                    segStart = System.currentTimeMillis();
                    silenceMs = 0;
                    idleSilenceMs = 0;
                } else {
                    idleSilenceMs += 100;
                    // 安静太久 → 低占空比探测，省电
                    if (idleSilenceMs >= IDLE_SILENCE_MS) {
                        idleSilenceMs = 0;
                        try { Thread.sleep(4000); } catch (InterruptedException ignored) { }
                    }
                }
                continue;
            }

            seg.write(buf, 0, n);
            if (amp < STOP) silenceMs += 100; else silenceMs = 0;
            long dur = System.currentTimeMillis() - segStart;
            boolean cut = silenceMs >= SILENCE_MS || dur >= MAX_MS;
            if (cut) {
                byte[] pcm = seg.toByteArray();
                inSpeech = false;
                seg.reset();
                silenceMs = 0;
                if (pcm.length > 6400) {          // 至少 0.2 秒才传
                    Log.i(TAG, "一段 " + (pcm.length / 32) + "ms，上传");
                    upload(pcm);
                }
            }
        }
    }

    /** 停连续听（不影响一次性录制） */    /** 停连续听（不影响一次性录制） */
    public void stopContinuous() {
        continuous = false;
    }

    /** 关掉内录模式（停投影 + 停服务） */
    public static void shutdown() {
        CaptureService s = INSTANCE;
        if (s != null) s.continuous = false;
        MediaProjection mp = projection;
        projection = null;
        try { if (mp != null) mp.stop(); } catch (Throwable ignored) { }
        if (s != null) { try { s.stopSelf(); } catch (Throwable ignored) { } }
    }

    // ────────────────────────────── 内部实现 ──────────────────────────────
    private MediaProjection ensureProjection(int resultCode, Intent data) throws Exception {
        MediaProjection mp = projection;
        if (mp != null) return mp;
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        mp = mpm.getMediaProjection(resultCode, data);
        if (mp == null) throw new Exception("没有授权（getMediaProjection 返回 null）");
        try {
            mp.registerCallback(new MediaProjection.Callback() { },
                    new android.os.Handler(android.os.Looper.getMainLooper()));
        } catch (Throwable ignored) { }
        projection = mp;
        return mp;
    }

    private AudioRecord openRecorder(MediaProjection mp) throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new Exception("API < 29 不支持内录");
        AudioPlaybackCaptureConfiguration cfg =
                new AudioPlaybackCaptureConfiguration.Builder(mp)
                        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                        .addMatchingUsage(AudioAttributes.USAGE_GAME)
                        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                        .addMatchingUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .addMatchingUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build();
        // 16kHz 单声道就够 ASR 用了，体积只有 44.1k 双声道的 1/5.5（上传省流量/省电）
        int minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec = new AudioRecord.Builder()
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build())
                .setBufferSizeInBytes(Math.max(minBuf * 2, 16384))
                .setAudioPlaybackCaptureConfig(cfg)
                .build();
        rec.startRecording();
        return rec;
    }

    private long recordInto(AudioRecord rec, java.io.OutputStream out, int secs) throws Exception {
        byte[] buf = new byte[8192];
        long bytes = 0;
        long deadline = System.currentTimeMillis() + secs * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (!running) break;
            int n = rec.read(buf, 0, buf.length);
            if (n <= 0) continue;
            out.write(buf, 0, n);
            bytes += n;
        }
        return bytes;
    }

    /** 一段 PCM 的平均绝对幅度（只算前 len 字节）。 */
    private static long meanAbs(byte[] pcm, int len) {
        long sum = 0;
        int samples = 0;
        int limit = Math.min(len, pcm.length);
        for (int i = 0; i + 1 < limit; i += 2) {
            short v = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            sum += Math.abs(v);
            samples++;
        }
        return samples == 0 ? 0 : sum / samples;
    }

    /** 一段 PCM 的平均绝对幅度（判断是不是静音，16bit 小端双声道）。 */
    private static long meanAbs(byte[] pcm) {
        long sum = 0;
        int samples = 0;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            short v = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            sum += Math.abs(v);
            samples++;
        }
        return samples == 0 ? 0 : sum / samples;
    }

    private void closeRecorder(AudioRecord rec) {
        try { if (rec != null) { rec.stop(); rec.release(); } } catch (Throwable ignored) { }
    }

    /** 把一段 PCM 拼成 wav（44 字节头 + 数据）传上去。 */
    private void upload(byte[] pcm) {
        byte[] wav = new byte[44 + pcm.length];
        fillHeader(wav, pcm.length);
        System.arraycopy(pcm, 0, wav, 44, pcm.length);
        for (int i = 0; i < 2; i++) {
            String[] ep = Proactive.endpointParts(i);
            if (ep == null) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(ep[0] + "/api/audio").openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(60000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "audio/wav");
                if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                c.setFixedLengthStreamingMode(wav.length);
                try (java.io.OutputStream os = c.getOutputStream()) { os.write(wav); }
                int code = c.getResponseCode();
                if (code == 200) {
                    Log.i(TAG, "传了一段 " + pcm.length + " 字节");
                    return;
                }
            } catch (Throwable e) {
                Log.w(TAG, "上传失败：" + e);
            } finally {
                if (c != null) c.disconnect();
            }
        }
    }

    private static void fillWavHeader(File f, long dataBytes) {
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw")) {
            raf.seek(0);
            byte[] h = new byte[44];
            fillHeader(h, (int) dataBytes);
            raf.write(h);
        } catch (Throwable e) {
            Log.w(TAG, "写 wav 头失败：" + e);
        }
    }

    private static void fillHeader(byte[] h, int dataBytes) {
        writeInt(h, 0, 0x46464952);          // RIFF
        writeInt(h, 4, 36 + dataBytes);
        writeInt(h, 8, 0x45564157);          // WAVE
        writeInt(h, 12, 0x20746d66);         // fmt
        writeInt(h, 16, 16);
        writeShort(h, 20, 1);                // PCM
        writeShort(h, 22, CHANNELS);
        writeInt(h, 24, RATE);
        writeInt(h, 28, RATE * CHANNELS * 2);
        writeShort(h, 32, CHANNELS * 2);
        writeShort(h, 34, 16);
        writeInt(h, 36, 0x61746164);         // data
        writeInt(h, 40, dataBytes);
    }

    private static void writeInt(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    private static void writeShort(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
    }

    @Override
    public void onDestroy() {
        continuous = false;
        running = false;
        INSTANCE = null;
        super.onDestroy();
    }
}
