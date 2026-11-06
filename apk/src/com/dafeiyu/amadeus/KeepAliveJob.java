package com.dafeiyu.amadeus;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 保活（2026-10-22）。
 *
 * 安卓上"永远活着"是做不到的（MIUI 尤其爱杀），所以这里做两件能做的事：
 *   1. **开机 / 装完自动起来**：BootReceiver 收到 BOOT_COMPLETED 就把浮窗服务拉起来
 *      （开机广播是允许后台起前台服务的白名单场景）。
 *   2. **每 15 分钟自检一次**：发现浮窗服务没了，就发一条"点我恢复她"的通知，
 *      主人点了立刻回来 —— 不偷偷复活（安卓 12+ 后台也不让随便起前台服务），但不会没声音。
 *
 * 开关存在 SharedPreferences("amadeus_keep") 的 keepAlive；菜单里有一行"保活：开/关"。
 */
public class KeepAliveJob extends JobService {

    private static final String TAG = "amadeus-keep";
    static final int JOB_ID = 0x4b1;
    static final String PREFS = "amadeus_keep";
    static final String CHANNEL = "amadeus_keep";

    public static boolean enabled(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("keepAlive", true);
    }

    public static void setEnabled(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("keepAlive", on).apply();
        if (on) schedule(ctx); else cancel(ctx);
    }

    public static void schedule(Context ctx) {
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, KeepAliveJob.class))
                    .setPeriodic(15 * 60 * 1000L)
                    .setPersisted(true)
                    .build();
            js.schedule(job);
            Log.i(TAG, "保活自检已排上（每 15 分钟）");
        } catch (Throwable e) {
            Log.w(TAG, "排不上：" + e);
        }
    }

    public static void cancel(Context ctx) {
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            js.cancel(JOB_ID);
        } catch (Throwable ignored) { }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        try {
            if (enabled(this) && !FloatService.isRunning()) {
                notifyRecover();
            }
        } catch (Throwable e) {
            Log.w(TAG, "自检失败：" + e);
        }
        jobFinished(params, false);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return false; }

    private void notifyRecover() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "保活提醒", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ch);
        }
        Intent it = new Intent(this, MainActivity.class);
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (android.os.Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, it, flags);
        Notification.Builder b = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("她好像被系统关掉了")
                .setContentText("点一下把她叫回来（浮窗和唤醒词会恢复）")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pi)
                .setAutoCancel(true);
        try { nm.notify(0x4b2, b.build()); } catch (Throwable ignored) { }
    }
}
