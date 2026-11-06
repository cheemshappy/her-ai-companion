package com.dafeiyu.amadeus;

import android.content.ComponentName;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 通道（2026-10-18）。
 *
 * 目标：让"她"拿到 **ADB 级权限**（uid 2000），能干无障碍干不了的事 ——
 * 改系统开关（WRITE_SECURE_SETTINGS / settings put）、静默截屏、全局返回/锁屏/音量、
 * 在没有可点控件的自绘界面上操作……
 *
 * 做法（Shizuku 13 的正确姿势）：
 *   Shizuku.bindUserService(UserServiceArgs, ServiceConnection)
 *   → Shizuku 用 shell 身份启动 ShellRunner，我们把 IRunner 当远程接口调。
 *   （旧版那个 Shizuku.newProcess 在 13.x 已经变成 private 了。）
 *
 * 主人已选择完整委托；不再增加命令前缀白名单，实际能力由Android shell权限决定。
 */
public final class ShizukuBridge {

    private ShizukuBridge() { }

    private static IRunner runner = null;
    private static String lastError = "";
    /** Shizuku 的绑定/回调需要主线程 Looper（WebView 的 JS 桥是后台线程）。 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static boolean binding = false;

    public static boolean shizukuAlive() {
        try { return Shizuku.pingBinder(); } catch (Throwable e) { return false; }
    }

    public static boolean hasPermission() {
        try { return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED; }
        catch (Throwable e) { return false; }
    }

    public static boolean requestPermission(int requestCode) {
        try {
            if (!shizukuAlive() || hasPermission()) return hasPermission();
            Shizuku.requestPermission(requestCode);
            return true;
        } catch (Throwable e) { return false; }
    }

    public static String statusJson() {
        boolean alive = shizukuAlive();
        int ver = -1;
        try { if (alive) ver = Shizuku.getVersion(); } catch (Throwable ignored) { }
        return "{\"alive\":" + alive + ",\"granted\":" + hasPermission()
                + ",\"version\":" + ver + ",\"runner\":" + (runner != null) + ",\"error\":" + quote(lastError) + "}";
    }

    public static String checkCommand(String command) {
        String c = String.valueOf(command == null ? "" : command).trim();
        if (c.isEmpty()) return "命令为空";
        if(c.indexOf('\0')>=0)return "命令格式不正确";
        // Owner selected full delegation. Android shell/system permissions are
        // authoritative; the app adds no second prefix whitelist or popup.
        return null;
    }

    private static final ServiceConnection CONN = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            Log.i("AMADEUS_SHZ", "onServiceConnected " + name);
            runner = IRunner.Stub.asInterface(service);
            binding = false;
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.w("AMADEUS_SHZ", "onServiceDisconnected " + name);
            runner = null;
            binding = false;
        }

        @Override
        public void onBindingDied(ComponentName name) {
            Log.w("AMADEUS_SHZ", "onBindingDied " + name);
            runner = null;
            binding = false;
        }

        @Override
        public void onNullBinding(ComponentName name) {
            Log.w("AMADEUS_SHZ", "onNullBinding " + name);
            runner = null;
            binding = false;
        }
    };

    /** 绑定 Shizuku 的 shell 服务（绑定成功前 runner 为 null）。 */
    public static boolean bind() {
        if (runner != null) return true;
        if (binding) return false;
        if (!shizukuAlive() || !hasPermission()) return false;
        try {
            ComponentName cn = new ComponentName("com.dafeiyu.amadeus", ShellRunner.class.getName());
            Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(cn)
                    .daemon(false)
                    .processNameSuffix("shell")
                    .debuggable(false)
                    .version(1);
            Log.i("AMADEUS_SHZ", "bindUserService post, cn=" + cn);
            MAIN.post(() -> {
                try {
                    Shizuku.bindUserService(args, CONN);
                } catch (Throwable e) {
                    lastError = "bind: " + e;
                    binding = false;
                    Log.e("AMADEUS_SHZ", "bindUserService threw", e);
                }
            });
            binding = true;
            return true;
        } catch (Throwable e) {
            binding = false;
            lastError = String.valueOf(e);
            Log.e("AMADEUS_SHZ", "bind failed", e);
            return false;
        }
    }

    /** 等 runner 就绪（最多 timeoutMs）。 */
    public static boolean waitReady(long timeoutMs) {
        if (runner != null) return true;
        bind();
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (runner != null) return true;
            try { Thread.sleep(80); } catch (InterruptedException ignored) { }
        }
        return runner != null;
    }

    /**
     * 执行一条命令。
     *
     * ⚠️ 走的是**反射调用 Shizuku 的私有 newProcess** —— 官方推荐的 UserService 路线在这台
     * 机器上起不来（ShizukuServiceStarter 报 LoadedApk.makeApplication NPE，
     * 见 2026-10-18 日志）。newProcess 是 App 自己的类，不是隐藏的系统 API，反射安全。
     */
    public static String run(String command) {
        String bad = checkCommand(command);
        if (bad != null) return "{\"ok\":false,\"error\":" + quote(bad) + "}";
        if (!shizukuAlive()) return "{\"ok\":false,\"error\":\"Shizuku 服务没在跑\"}";
        if (!hasPermission()) return "{\"ok\":false,\"error\":\"她还没拿到 Shizuku 授权\"}";
        try {
            java.lang.reflect.Method m = Shizuku.class.getDeclaredMethod(
                    "newProcess", String[].class, String[].class, String.class);
            m.setAccessible(true);
            java.lang.Process p = (java.lang.Process) m.invoke(null, new String[]{"sh", "-c", command}, null, null);
            String out = readAll(p.getInputStream());
            String err = readAll(p.getErrorStream());
            boolean done;
            try {
                done = p.waitFor(15, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Throwable e) {
                p.waitFor();   // 老实现没有 waitFor(long, TimeUnit)
                done = true;
            }
            if (!done) { try { p.destroy(); } catch (Throwable ignored) { } }
            int code = -1;
            try { code = p.exitValue(); } catch (Throwable ignored) { }
            String text = (out == null ? "" : out) + ((err == null || err.isEmpty()) ? "" : "\n" + err);
            if (text.length() > 6000) text = text.substring(0, 6000) + "…";
            return "{\"ok\":" + (done && code == 0) + ",\"code\":" + code + ",\"out\":" + quote(text) + "}";
        } catch (Throwable e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            lastError = String.valueOf(c);
            Log.e("AMADEUS_SHZ", "newProcess failed", c);
            return "{\"ok\":false,\"error\":" + quote(String.valueOf(c)) + "}";
        }
    }

    private static String readAll(InputStream in) {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } catch (Throwable e) {
            return "";
        }
    }

    public static int runnerUid() {
        try { return runner == null ? -1 : runner.uid(); } catch (Throwable e) { return -1; }
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : String.valueOf(s).toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c == '\t') b.append("\\t");
            else b.append(c);
        }
        return b.append('"').toString();
    }
}
