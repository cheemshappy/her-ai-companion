package com.dafeiyu.amadeus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 开机 / 装完 / 手机重启后：把浮窗服务拉起来（2026-10-22）。
 * BOOT_COMPLETED 是允许后台起前台服务的白名单场景，所以这里能直接 startForegroundService。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(a)) {
            return;
        }
        Log.i("amadeus-keep", "收到 " + a + "，试着把浮窗拉起来");
        try {
            if (!KeepAliveJob.enabled(ctx)) return;
            Intent svc = new Intent(ctx, FloatService.class);
            svc.setAction("amadeus.START");
            if (android.os.Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
            else ctx.startService(svc);
            KeepAliveJob.schedule(ctx);
        } catch (Throwable e) {
            Log.w("amadeus-keep", "拉不起来：" + e);
        }
    }
}
