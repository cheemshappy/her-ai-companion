package com.dafeiyu.amadeus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 插上 USB 就把"她"打开（2026-10-22 主人要求）。
 *
 * 做法：监听系统广播 android.hardware.usb.action.USB_STATE，extra "connected"=true 时启动 MainActivity。
 * - 我们有 SYSTEM_ALERT_WINDOW 权限，属于"允许后台启动 Activity"的豁免之一，所以能直接 start；
 * - 万一没起来（被系统拦），再用 Shizuku 的 shell 身份 `am start` 兜底；
 * - ⚠️ 不解锁屏屏（刚修好锁屏，别又给顶掉）。锁着的话系统会把界面排在锁屏后面，解锁即见。
 */
public class UsbReceiver extends BroadcastReceiver {

    private static final String TAG = "amadeus-usb";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        boolean connected = intent != null && intent.getExtras() != null
                && intent.getExtras().getBoolean("connected");
        // 三种触发都算"插上了 USB"：
        //   ① USB_STATE(connected=true) —— 有些系统对 manifest 广播不投递
        //   ② ACTION_POWER_CONNECTED   —— 插上就开始充电，manifest 一定能收到（最可靠）
        //   ③ DEBUG_USB                —— 本机测试用
        boolean debug = "com.dafeiyu.amadeus.DEBUG_USB".equals(action);
        boolean power = "android.intent.action.ACTION_POWER_CONNECTED".equals(action);
        if (!debug && !power) {
            if (!"android.hardware.usb.action.USB_STATE".equals(action)) return;
            if (!connected) return;                 // 拔掉的时候不管
        }
        Log.i(TAG, "USB 插上了，把 她 叫出来");

        // 1) 先用 Shizuku 的 shell 身份起 —— 后台起 Activity 在 MIUI 上会被静默拦掉，
        //    而 startActivity 不抛异常，看起来"成功"其实没起来（2026-10-22 实测）。
        boolean started = false;
        try {
            String out = ShizukuBridge.run("am start -n com.dafeiyu.amadeus/.MainActivity");
            started = out != null && out.contains("\"ok\":true");
            Log.i(TAG, "shizuku am start -> " + started);
        } catch (Throwable e) {
            Log.w(TAG, "shizuku 起失败：" + e);
        }

        // 2) 兜底：直接 startActivity（有悬浮窗权限时也能成）
        if (!started) {
            try {
                Intent it = new Intent(ctx, MainActivity.class);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                ctx.startActivity(it);
                Log.i(TAG, "直接 startActivity 已发");
            } catch (Throwable e) {
                Log.w(TAG, "直接起失败：" + e);
            }
        }
    }
}
