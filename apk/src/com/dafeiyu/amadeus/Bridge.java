package com.dafeiyu.amadeus;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS 桥：前端 window.Android.invoke(id, method, argsJson) 进来，结果用 __nativeResult 回去。
 * 注意：invoke 跑在 WebView 的 JavaBridge 线程，别在这里碰 UI（要 post 回主线程）。
 */
public class Bridge {

    private final MainActivity act;
    private final WebView web;
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Map<String, String> ttsUtterances = new LinkedHashMap<>();

    public Bridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    // ────────────────────────────── 回调给前端 ──────────────────────────────
    public void emitResult(String id, boolean ok, String json) {
        if (web == null) return;
        String js = "if(typeof window.__nativeResult===\"function\") window.__nativeResult(" + JSONObject.quote(id == null ? "" : id) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(json == null ? "{}" : json) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    public void bindTtsUtterance(String utteranceId, String invokeId) {
        synchronized (ttsUtterances) { ttsUtterances.put(utteranceId, invokeId); }
    }

    public String takeTtsUtterance(String utteranceId) {
        synchronized (ttsUtterances) { return ttsUtterances.remove(utteranceId); }
    }

    // ────────────────────────────── 入口 ────────────────────────────────────
    @JavascriptInterface
    public void invoke(String id, String method, String argsJson) {
        JSONObject args;
        try { args = new JSONObject(argsJson == null || argsJson.isEmpty() ? "{}" : argsJson); }
        catch (Exception e) { args = new JSONObject(); }

        try {
            switch (method == null ? "" : method) {
                case "info": {
                    emitResult(id, true, infoJson().toString());
                    return;
                }
                case "setServer": {
                    String url = args.optString("url", "").trim();
                    if (url.isEmpty()) { emitResult(id, false, err("地址为空")); return; }
                    emitResult(id, true, "{}");
                    act.setServer(url);
                    return;
                }
                case "setAlt": {
                    // 备用地址（公网隧道）：页面连上后会自己把最新隧道地址写进来
                    String url = args.optString("url", "").trim();
                    if (url.isEmpty()) { emitResult(id, false, err("地址为空")); return; }
                    act.setAlt(url);
                    emitResult(id, true, "{}");
                    return;
                }
                case "setFallbacks": {act.setFallbacks(args.optJSONArray("urls"));emitResult(id,true,"{}");return;}
                case "setStable": {ServerConnections.saveStable(act.getSharedPreferences(MainActivity.PREFS,0),args.optString("url",""));emitResult(id,true,"{}");return;}
                case "tts": {
                    String text = args.optString("text", "");
                    act.speak(id, text);
                    return;
                }
                case "stopTts": { act.stopTts(); emitResult(id, true, "{}"); return; }
                case "stt": { act.listen(id); return; }
                case "recStart": { act.recStart(id); return; }
                case "recStop": { act.recStop(id); return; }
                case "toast": { act.toast(args.optString("text", "")); emitResult(id, true, "{}"); return; }
                case "retry": { emitResult(id, true, "{}"); act.reload(); return; }
                case "recover": { emitResult(id,true,"{}");act.recoverConnection();return; }
                case "pageReady": {act.pageReady(args.optString("url",""));emitResult(id,true,"{}");return;}
                case "shizuku": {
                    // 状态 / 申请授权 / 执行命令（白名单）
                    String action = args.optString("action", "status");
                    if ("request".equals(action)) {
                        boolean ok = ShizukuBridge.requestPermission(4242);
                        JSONObject o = new JSONObject();
                        o.put("requested", ok);
                        o.put("alive", ShizukuBridge.shizukuAlive());
                        emitResult(id, true, o.toString());
                        return;
                    }
                    if ("run".equals(action)) {
                        emitResult(id, true, ShizukuBridge.run(args.optString("command", "")));
                        return;
                    }
                    emitResult(id, true, ShizukuBridge.statusJson());
                    return;
                }                case "floatOn": {
                    // 让她浮在其他应用上面（要先有"显示在其他应用上层"权限）
                    if (!android.provider.Settings.canDrawOverlays(act)) {
                        emitResult(id, false, err("还没给悬浮窗权限"));
                        act.toast("先允许「显示在其他应用上层」");
                        try {
                            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    android.net.Uri.parse("package:" + act.getPackageName()));
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            act.startActivity(i);
                        } catch (Throwable ignored) { }
                        return;
                    }
                    try {
                        Intent i = new Intent(act, FloatService.class);
                        act.startForegroundService(i);
                        emitResult(id, true, "{\"running\":true}");
                    } catch (Throwable e) {
                        emitResult(id, false, err(String.valueOf(e.getMessage())));
                    }
                    return;
                }
                case "floatOff": {
                    try { act.stopService(new Intent(act, FloatService.class)); } catch (Throwable ignored) { }
                    emitResult(id, true, "{\"running\":false}");
                    return;
                }
                case "floatStatus": {
                    JSONObject o = new JSONObject();
                    try {
                        o.put("running", FloatService.running);
                        o.put("canDraw", android.provider.Settings.canDrawOverlays(act));
                    } catch (Throwable ignored) { }
                    emitResult(id, true, o.toString());
                    return;
                }                case "modelLocal": {
                    // APK 里打包的模型（本机 127.0.0.1 提供，秒开）
                    JSONObject o = new JSONObject();
                    o.put("url", BundledAssets.MODEL);
                    o.put("bundled",true);
                    emitResult(id, true, o.toString());
                    return;
                }
                case "openChat": {
                    org.json.JSONObject args2 = args;
                    final String appName = args2.optString("app", "微信");
                    final String who = args2.optString("who", "");
                    new Thread(() -> {
                        try {
                            org.json.JSONObject res = PhoneTools.run(act, "phone_open_chat",
                                    new org.json.JSONObject().put("app", appName).put("who", who));
                            emitResult(id, res.optBoolean("ok", false), res.toString());
                        } catch (Throwable e) {
                            emitResult(id, false, "{\"error\":\"" + e.getMessage() + "\"}");
                        }
                    }, "open-chat").start();
                    return;
                }
                case "wakePause": {
                    // 2026-10-26：网页录音前先把唤醒词停掉 —— 麦克风只有一个，
                    // 唤醒词占着的时候 getUserMedia 会直接 NotReadableError（"麦克风打不开"）。
                    try { WakeWord.pauseAll(); } catch (Throwable ignored) { }
                    emitResult(id, true, "{}");
                    return;
                }
                case "wakeResume": {
                    try { WakeWord.resumeAll(); } catch (Throwable ignored) { }
                    emitResult(id, true, "{}");
                    return;
                }
                case "keepAlive": {
                    boolean on = args.optBoolean("on", true);
                    KeepAliveJob.setEnabled(act, on);
                    if (on) {
                        KeepAliveJob.schedule(act);
                        try {
                            Intent svc = new Intent(act, FloatService.class);
                            svc.setAction("amadeus.START");
                            act.startForegroundService(svc);
                        } catch (Throwable ignored) { }
                    }
                    emitResult(id, true, "{\"enabled\":" + on + "}");
                    return;
                }
                case "capListen": {
                    // 连续听应用内声音（on=false 停）；会弹一次授权
                    act.capListen(args.optBoolean("on", true), args.optInt("chunk", 12));
                    emitResult(id, true, "{}");
                    return;
                }
                case "capOff": { CaptureService.shutdown(); emitResult(id, true, "{}"); return; }
                case "capStart": {
                    // 录应用内声音（会弹系统的"开始录制/投放"授权框）
                    act.startCapture(args.optInt("seconds", 6));
                    emitResult(id, true, "{\"started\":true}");
                    return;
                }
                case "wakeStats": { emitResult(id, true, WakeWord.statsJson(act)); return; }
                case "wakeSens": {
                    WakeWord.setSens(act, args.optInt("sens", 1));
                    emitResult(id, true, "{}");
                    return;
                }
                case "setServerPrompt": { emitResult(id, true, "{}"); act.showServerDialog(); return; }
                case "vibrate": { vibrate(args.optInt("ms", 40)); emitResult(id, true, "{}"); return; }
                case "minimize": { emitResult(id, true, "{}"); act.moveTaskToBack(true); return; }
                case "openUrl": {
                    String u = args.optString("url", "");
                    if (u.isEmpty()) { emitResult(id, false, err("url 为空")); return; }
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                    emitResult(id, true, "{}");
                    return;
                }
                case "openSettings": {
                    PhoneTools.openSettingsPanel(act, args.optString("panel", ""));
                    emitResult(id, true, "{}");
                    return;
                }
                case "requestNotificationAccess": {
                    Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                    emitResult(id, true, "{}");
                    return;
                }
                case "tool": {
                    final String name = args.optString("name", "");
                    final JSONObject a = args.optJSONObject("args") == null ? new JSONObject() : args.optJSONObject("args");
                    io.execute(() -> {
                        String out;
                        try { out = runTool(name, a).toString(); }
                        catch (Exception e) { out = err(String.valueOf(e.getMessage())); }
                        emitResult(id, true, out);
                    });
                    return;
                }
                default: {
                    emitResult(id, false, err("unknown method: " + method));
                }
            }
        } catch (Exception e) {
            emitResult(id, false, err(String.valueOf(e.getMessage())));
        }
    }

    // ────────────────────────────── 工具实现 ────────────────────────────────
    /** 工具执行搬到 PhoneTools（浮窗也要用），这里只做转发。 */
    private JSONObject runTool(String name, JSONObject a) throws Exception {
        return PhoneTools.run(act, name, a);
    }

    private JSONObject infoJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("serverUrl", act.serverUrl());
            o.put("altUrl", act.altUrl());
            o.put("activeServerUrl", act.activeServerUrl());
            o.put("connectionChecking",act.connectionChecking());
            o.put("connectionDiagnostics",act.connectionDiagnostics());
            o.put("accessibility", CtrlService.ready());
            o.put("notification", MsgService.connected());
            o.put("manufacturer", Build.MANUFACTURER);
            o.put("model", Build.MODEL);
            o.put("android", Build.VERSION.RELEASE);
            DisplayMetrics dm = new DisplayMetrics();
            android.view.WindowManager wm = (android.view.WindowManager) act.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) wm.getDefaultDisplay().getRealMetrics(dm);
            o.put("screen", dm.widthPixels + "x" + dm.heightPixels);
        } catch (Exception ignored) { }
        return o;
    }

    private void vibrate(int ms) {
        try {
            Vibrator v = (Vibrator) act.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.vibrate(Math.max(10, Math.min(ms, 200)));
        } catch (Exception ignored) { }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    private static String err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("error", msg == null ? "error" : msg); } catch (Exception ignored) { }
        return o.toString();
    }
}
