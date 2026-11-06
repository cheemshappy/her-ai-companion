package com.dafeiyu.amadeus;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 手机工具的**执行层**（2026-10-21 从 Bridge 里抽出来）。
 *
 * 为什么抽：浮窗（FloatService）也要能读屏/点屏幕 —— 主人在浮窗里问她"屏幕上写的啥"，
 * 她原来根本没法调用这些工具（浮窗只有录音桥，回复走的是不带工具的 /api/turn-stream）。
 * 抽出来以后主界面和浮窗共用一份实现，只要给个 Context 就能跑。
 */
public final class PhoneTools {

    private PhoneTools() { }

    public static JSONObject run(Context ctx, String name, JSONObject a) throws Exception {
        JSONObject o = new JSONObject();
        if (name == null) name = "";
        if (a == null) a = new JSONObject();

        boolean screenRequired=name.matches("phone_(screen|tap_text|tap_xy|swipe|type|back|home|open_chat|list_items|wechat_draft|wechat_send)");
        if(screenRequired&&!CtrlService.ready())return o.put("ok",false).put("error","操作屏幕需要开启「她（操作手机）」无障碍服务；后台读取通知仍可使用。");

        switch (name) {
            case "phone_screen": {
                String text = CtrlService.get().screenText();
                // 微信这类 App 会把整个无障碍界面屏蔽掉（只剩个包名），那就截图让视觉模型抄字
                if (text == null || text.replace("应用:", "").trim().length() < 30) {
                    String ocr = ocrScreen(ctx);
                    if (ocr != null && !ocr.isEmpty()) {
                        o.put("ok", true);
                        o.put("data", (text == null ? "" : text) + "\n【截图识别】\n" + ocr);
                        return o;
                    }
                }
                o.put("ok", true);
                o.put("data", text == null ? "" : text);
                return o;
            }
            case "phone_wechat_draft": {
                String to=a.optString("to",""),draft=a.optString("draft",a.optString("text",""));
                if(to.trim().isEmpty()||draft.trim().isEmpty())return o.put("ok",false).put("error","需要联系人和草稿正文");
                JSONObject opened=ChatNavigator.open(ctx,"微信",to.trim());if(!opened.optBoolean("ok"))return opened;
                JSONObject typed=CtrlService.get().typeTextResult(draft);
                return typed.put("draft",true).put("submitted",false).put("data",typed.optBoolean("ok")?"草稿已填写，尚未发送":"草稿未能填写");
            }
            case "phone_list_items": {
                CtrlService cs = CtrlService.get();
                if (cs == null) { o.put("ok", false); o.put("error", "无障碍没连上"); return o; }
                JSONArray arr = cs.listItemsJson();
                o.put("ok", true);
                o.put("pkg", cs.currentPackage());
                o.put("count", arr.length());
                o.put("data", arr.toString());
                return o;
            }
            case "phone_open_chat": {
                String app=a.optString("app","微信"),who=chatName(a.optString("who",""));
                if(who.isEmpty())return o.put("ok",false).put("error","需要明确联系人");
                CtrlService cs=CtrlService.get();String previous=cs==null?"":cs.rootPackage();
                JSONObject result=ChatNavigator.open(ctx,app,who,a.optBoolean("searchOnly",false));
                // Start the return timer after navigation finishes. A search
                // cannot be interrupted halfway by a five-second old timer.
                if(result.optBoolean("ok")&&!a.optBoolean("searchOnly",false))scheduleReturnTo(ctx,"QQ".equalsIgnoreCase(app)?"com.tencent.mobileqq":"com.tencent.mm",previous,a.optInt("returnAfterMs",5000));
                return result;
            }
            case "phone_msg_digest": { return Digest.run(ctx); }
            case "phone_notification_status": { return MsgService.status(ctx); }

            case "phone_experience": {
                int limit = Math.max(1, Math.min(a.optInt("limit", 20), 60));
                String app = a.optString("app", "");
                Exception last = null;
                for (int i = 0; i < 2; i++) {
                    String[] ep = Proactive.endpointParts(i);
                    if (ep == null) continue;
                    HttpURLConnection c = null;
                    try {
                        String q = "/api/exp?limit=" + limit + (app.isEmpty() ? "" : "&app=" + java.net.URLEncoder.encode(app, "UTF-8"));
                        c = (HttpURLConnection) new URL(ep[0] + q).openConnection();
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(12000);
                        if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                        int code = c.getResponseCode();
                        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        if (is != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        }
                        JSONObject j = new JSONObject(bos.toString("UTF-8"));
                        o.put("ok", true);
                        o.put("data", j.optString("text", ""));
                        return o;
                    } catch (Exception e) {
                        last = e;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                o.put("ok", false);
                o.put("error", "经验库连不上：" + last);
                return o;
            }
            case "phone_wechat_reply": {
                return run(ctx,"phone_send_message",new JSONObject().put("app","微信").put("to",a.optString("to","")).put("text",a.optString("text","")));
            }
            case "phone_wechat_send": {
                // 只点发送（草稿已经填好时用）
                CtrlService cs = CtrlService.get();
                if (cs == null) { o.put("ok", false); o.put("error", "无障碍没连上"); return o; }
                boolean sent = cs.tapText("发送");
                Thread.sleep(800);
                o.put("ok", sent);
                if (sent) o.put("data", "点了发送，你看一眼聊天里有没有");
                else o.put("error", "没找到「发送」按钮（可能没在聊天里）");
                return o;
            }
            case "phone_sleep": {
                // 睡前模式：开勿扰（只放闹钟）+ 关浮窗；on=false 反之
                boolean on = a.optBoolean("on", true);
                String dnd;
                try {
                    // MIUI 不认 settings put global zen_mode，要用 cmd notification set_dnd
                    String out = ShizukuBridge.run("cmd notification set_dnd " + (on ? "alarms" : "off"));
                    boolean ok = out != null && out.contains("\"ok\":true");
                    dnd = ok ? (on ? "勿扰已开（只放闹钟）" : "勿扰关了") : "勿扰没换成（Shizuku 没连上）";
                } catch (Throwable e) {
                    dnd = "勿扰没换成：" + e.getMessage();
                }
                if (on) {
                    try { FloatService.setShown(false); } catch (Throwable ignored) { }
                }
                o.put("ok", true);
                o.put("data", dnd + (on ? "，浮窗也关了" : ""));
                return o;
            }
            case "phone_who_messaged": {
                int hours = Math.max(1, Math.min(a.optInt("hours", 8), 72));
                Exception last = null;
                for (int i = 0; i < 2; i++) {
                    String[] ep = Proactive.endpointParts(i);
                    if (ep == null) continue;
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(ep[0] + "/api/notif/summary?hours=" + hours).openConnection();
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(15000);
                        if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                        int code = c.getResponseCode();
                        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        if (is != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        }
                        JSONObject j = new JSONObject(bos.toString("UTF-8"));
                        o.put("ok", j.optBoolean("ok", false));
                        o.put("data", j.optString("text", ""));
                        return o;
                    } catch (Exception e) {
                        last = e;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                o.put("ok", false);
                o.put("error", "通知汇总失败：" + last);
                return o;
            }
            case "phone_health": {
                // 手机体检：电量、存储、内存
                StringBuilder sb = new StringBuilder();
                try {
                    android.os.BatteryManager bm = (android.os.BatteryManager)
                            ctx.getSystemService(Context.BATTERY_SERVICE);
                    int lvl = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
                    android.content.IntentFilter f = new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED);
                    Intent bs = ctx.registerReceiver(null, f);
                    int status = bs != null ? bs.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) : -1;
                    boolean charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                            || status == android.os.BatteryManager.BATTERY_STATUS_FULL;
                    sb.append("电量 ").append(lvl).append("%").append(charging ? "（在充电）" : "");
                } catch (Throwable e) {
                    sb.append("电量读不到");
                }
                try {
                    android.os.StatFs stat = new android.os.StatFs(android.os.Environment.getDataDirectory().getPath());
                    long free = stat.getAvailableBytes();
                    long total = stat.getTotalBytes();
                    sb.append("；存储剩 ").append(String.format(java.util.Locale.CHINA, "%.1fG/%.0fG", free / 1073741824.0, total / 1073741824.0));
                } catch (Throwable ignored) { }
                try {
                    android.app.ActivityManager am = (android.app.ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
                    android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                    am.getMemoryInfo(mi);
                    sb.append("；内存剩 ").append(String.format(java.util.Locale.CHINA, "%.1fG", mi.availMem / 1073741824.0));
                } catch (Throwable ignored) { }
                o.put("ok", true);
                o.put("data", sb.toString());
                return o;
            }
            case "phone_weather": {
                Exception last = null;
                for (int i = 0; i < 2; i++) {
                    String[] ep = Proactive.endpointParts(i);
                    if (ep == null) continue;
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(ep[0] + "/api/weather").openConnection();
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(20000);
                        if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                        int code = c.getResponseCode();
                        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        if (is != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        }
                        JSONObject j = new JSONObject(bos.toString("UTF-8"));
                        o.put("ok", j.optBoolean("ok", false));
                        if (j.optBoolean("ok", false)) o.put("data", j.optString("text", ""));
                        else o.put("error", j.optString("error", "拿不到天气"));
                        return o;
                    } catch (Exception e) {
                        last = e;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                o.put("ok", false);
                o.put("error", "天气连不上：" + last);
                return o;
            }
            case "phone_alarm": {
                int hour = a.optInt("hour", -1);
                int minute = a.optInt("minute", -1);
                if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                    o.put("ok", false);
                    o.put("error", "时间不对（hour 0~23，minute 0~59）");
                    return o;
                }
                String label = a.optString("label", "她叫你").replace("'", "").replace("\"", "");
                // 优先借 Shizuku 的 shell 身份设（后台也不会被"Permission Denial"拦）
                boolean viaShizuku = false;
                try {
                    String out = ShizukuBridge.run("am start -a android.intent.action.SET_ALARM"
                            + " --ei android.intent.extra.alarm.HOUR " + hour
                            + " --ei android.intent.extra.alarm.MINUTES " + minute
                            + " --es android.intent.extra.alarm.MESSAGE '" + label + "'"
                            + " --ez android.intent.extra.alarm.SKIP_UI true");
                    viaShizuku = out != null && out.contains("\"ok\":true");
                } catch (Throwable ignored) { }
                if (viaShizuku) {
                    o.put("ok", true);
                    o.put("data", "闹钟设好了：" + String.format(java.util.Locale.CHINA, "%02d:%02d", hour, minute));
                    return o;
                }
                try {
                    Intent it = new Intent(android.provider.AlarmClock.ACTION_SET_ALARM);
                    it.putExtra(android.provider.AlarmClock.EXTRA_HOUR, hour);
                    it.putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute);
                    it.putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, a.optString("label", "她叫你"));
                    it.putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true);
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(it);
                    o.put("ok", true);
                    o.put("data", "闹钟设好了：" + String.format(java.util.Locale.CHINA, "%02d:%02d", hour, minute));
                } catch (Throwable e) {
                    o.put("ok", false);
                    o.put("error", "设不了闹钟：" + e.getMessage());
                }
                return o;
            }
            case "phone_todo": {
                Exception last = null;
                for (int i = 0; i < 2; i++) {
                    String[] ep = Proactive.endpointParts(i);
                    if (ep == null) continue;
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(ep[0] + "/api/todo").openConnection();
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(15000);
                        c.setRequestMethod("POST");
                        c.setDoOutput(true);
                        c.setRequestProperty("content-type", "application/json; charset=utf-8");
                        if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                        JSONObject body = new JSONObject();
                        body.put("action", a.optString("action", "list"));
                        body.put("text", a.optString("text", ""));
                        byte[] payload = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                        c.setFixedLengthStreamingMode(payload.length);
                        try (java.io.OutputStream os = c.getOutputStream()) { os.write(payload); }
                        int code = c.getResponseCode();
                        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        if (is != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        }
                        JSONObject j = new JSONObject(bos.toString("UTF-8"));
                        o.put("ok", j.optBoolean("ok", false));
                        if (j.optBoolean("ok", false)) o.put("data", j.optString("text", ""));
                        else o.put("error", j.optString("error", "待办操作失败"));
                        return o;
                    } catch (Exception e) {
                        last = e;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                o.put("ok", false);
                o.put("error", "待办连不上：" + last);
                return o;
            }
            case "phone_hearing": {
                // 应用内声音的滚动字幕在电脑上（/api/audio/lines），这里取回来
                int minutes = Math.max(1, Math.min(a.optInt("minutes", 5), 60));
                Exception last = null;
                for (int i = 0; i < 2; i++) {
                    String[] ep = Proactive.endpointParts(i);
                    if (ep == null) continue;
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(ep[0] + "/api/audio/lines?minutes=" + minutes).openConnection();
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(15000);
                        if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                        int code = c.getResponseCode();
                        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        if (is != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        }
                        JSONObject j = new JSONObject(bos.toString("UTF-8"));
                        String text = j.optString("text", "");
                        o.put("ok", true);
                        o.put("data", text.isEmpty() ? "（最近没听到什么声音）" : text);
                        return o;
                    } catch (Exception e) {
                        last = e;
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                o.put("ok", false);
                o.put("error", "取听音频记录失败：" + last);
                return o;
            }
            case "phone_look": {
                // 强制走"截图 → 视觉模型"（无障碍读不到的界面用这个）。
                // describe=true：不抄字，改成**描述画面**（微信表情包、图片、谁在说话）——2026-10-26 主人反馈
                //   "看消息时看不了微信表情包"，就是靠这条补上的。
                boolean describe = a.optBoolean("describe", false);
                String ocr = ocrScreen(ctx, describe);
                o.put("ok", ocr != null);
                if (ocr == null) o.put("error", "截图识别失败（可能被这个界面的防截屏挡住了）");
                else o.put("data", ocr);
                return o;
            }
            case "phone_open_app": {
                String app = a.optString("app", "").trim();
                String pkg = findPackageByLabel(ctx, app);
                if (pkg == null) {
                    o.put("ok", false);
                    o.put("error", "没找到叫「" + app + "」的应用，先 phone_list_apps 看看叫什么。");
                    return o;
                }
                Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
                if (i == null) { o.put("ok", false); o.put("error", pkg + " 打不开"); return o; }
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                sleep(700);
                o.put("ok", true);
                o.put("data", "已打开 " + pkg);
                return o;
            }
            case "phone_tap_text": {
                String t = a.optString("text", "");
                boolean done = CtrlService.get().tapText(t);
                o.put("ok", done);
                if (!done) o.put("error", "屏幕上没找到「" + t + "」");
                else { o.put("data", "点了「" + t + "」"); recordExp(ctx, "点了「" + t + "」"); }
                return o;
            }
            case "phone_tap_xy": {
                // x/y > 1 按像素理解（截图那种 1280x2772），否则按 0~1 比例
                double x = a.optDouble("x", 0.5), y = a.optDouble("y", 0.5);
                boolean px = x > 1 || y > 1;
                boolean done = px
                        ? CtrlService.get().tapXY((float) x, (float) y)
                        : CtrlService.get().tapRatio((float) x, (float) y);
                o.put("ok", done);
                if (done) { o.put("data", px ? ("点了 (" + (int) x + "," + (int) y + ")") : "点了"); recordExp(ctx, "按坐标点了 " + (int) x + "," + (int) y); }
                else o.put("error", "点不动（无障碍没连上？）");
                return o;
            }
            case "phone_swipe": {
                boolean full = "full".equals(a.optString("distance", "half"));
                boolean done = CtrlService.get().swipe(a.optString("direction", "up"), full);
                o.put("ok", done);
                return o;
            }
            case "phone_type": {
                return CtrlService.get().typeTextResult(a.optString("text",""));
            }

            case "phone_back": {
                o.put("ok", CtrlService.get().back());
                return o;
            }
            case "phone_home": {
                o.put("ok", CtrlService.get().home());
                return o;
            }
            case "phone_notifications": {
                return MsgService.snapshot(ctx,a.optInt("limit",40),a.optString("app",""));
            }
            case "phone_send_message": {
                String app=a.optString("app","微信"),to=a.optString("to","").trim(),text=a.optString("text","").trim();
                if(to.isEmpty()||text.isEmpty())return o.put("ok",false).put("error","需要明确收件人和消息内容");
                if(!text.contains("ai回复"))text+="（ai回复）";
                JSONObject quick=MsgService.reply(ctx,app,to,text);
                if(quick.optBoolean("ok")||quick.optBoolean("ambiguous"))return quick;
                if(!CtrlService.ready())return o.put("ok",false).put("error","没有快捷回复入口，屏幕发送需要无障碍权限");
                JSONObject opened=run(ctx,"phone_open_chat",new JSONObject().put("app",app).put("who",to).put("returnAfterMs",0));
                if(!opened.optBoolean("ok"))return opened;
                CtrlService cs=CtrlService.get();
                if(cs.findEditable()==null)return o.put("ok",false).put("error","未确认进入聊天输入框，未发送");
                if(!cs.typeText(text))return o.put("ok",false).put("error","消息未填入，未发送");
                Thread.sleep(180);
                if(!cs.tapText("发送"))return o.put("ok",false).put("error","未找到发送按钮，消息保留为草稿");
                Thread.sleep(400);
                String after=cs.screenText();boolean verified=after!=null&&after.contains(text)&&cs.findEditable()!=null&&String.valueOf(cs.findEditable().getText()).trim().isEmpty();
                return o.put("ok",true).put("submitted",true).put("deliveryVerified",verified).put("source","screen").put("data",verified?"已发送并在会话中回读到消息":"已点击发送，尚未取得可靠的消息回读");
            }
            case "phone_bilibili": { return BiliTools.run(ctx,a); }

            case "phone_open_settings": {
                openSettingsPanel(ctx, a.optString("panel", ""));
                o.put("ok", true);
                return o;
            }
            case "phone_list_apps": {
                o.put("ok", true);
                o.put("data", listApps(ctx));
                return o;
            }
            default: {
                o.put("ok", false);
                o.put("error", "没有这个工具：" + name);
                return o;
            }
        }
    }

    /**
     * 截图 → POST /api/ocr（电脑上的视觉模型抄字）。
     * 为什么放电脑：手机上跑不动 VLM；而且这条路对"屏蔽无障碍"的 App 是唯一解。
     */
    /**
     * 记一条"操作经验"（2026-10-22）：在某个 App 里成功做了什么。
     * 电脑那边攒起来，她以后不确定怎么操作某个 App 时用 phone_experience 翻。
     * 失败也不影响主流程，纯记日志。
     */
    static void recordExp(Context ctx, String action) {
        try {
            String app = CtrlService.ready() ? CtrlService.get().currentPackage() : "";
            if (app == null) app = "";
            if (app.isEmpty()) {
                // 刚点完可能正处在切换动画里，读不到当前包名；等一下再读一次
                try { Thread.sleep(350); } catch (InterruptedException ignored) { }
                app = CtrlService.ready() ? CtrlService.get().currentPackage() : "";
                if (app == null) app = "";
            }
            if (app.isEmpty()) app = "unknown";
            for (int i = 0; i < 2; i++) {
                String[] ep = Proactive.endpointParts(i);
                if (ep == null) continue;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(ep[0] + "/api/exp").openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(6000);
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setRequestProperty("content-type", "application/json; charset=utf-8");
                    if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                    JSONObject body = new JSONObject();
                    body.put("app", app);
                    body.put("action", action);
                    byte[] payload = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(payload.length);
                    try (java.io.OutputStream os = c.getOutputStream()) { os.write(payload); }
                    if (c.getResponseCode() == 200) return;
                } catch (Throwable ignored) {
                } finally {
                    if (c != null) c.disconnect();
                }
            }
        } catch (Throwable ignored) { }
    }

    static String ocrScreen(Context ctx) { return ocrScreen(ctx, false); }

    /** describe=true 时让视觉模型**描述画面**（表情包/图片是什么），而不是逐字抄字。2026-10-26 */
    static String ocrScreen(Context ctx, boolean describe) {
        byte[] jpeg = shotJpeg(ctx);
        if (jpeg == null || jpeg.length < 1500) return null;

        Exception last = null;
        for (int i = 0; i < 2; i++) {
            String[] ep = Proactive.endpointParts(i);
            if (ep == null) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(ep[0] + "/api/ocr").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(90000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json; charset=utf-8");
                if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                JSONObject body = new JSONObject();
                body.put("image", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP));
                if (describe) body.put("mode", "describe");
                byte[] payload = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(payload.length);
                try (java.io.OutputStream os = c.getOutputStream()) { os.write(payload); }
                int code = c.getResponseCode();
                java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                }
                String text = bos.toString("UTF-8");
                if (code >= 400) throw new Exception("HTTP " + code);
                JSONObject j = new JSONObject(text);
                if (!j.optBoolean("ok", false)) throw new Exception(j.optString("error", "OCR 失败"));
                String out = j.optString("text", "").trim();
                return out.length() > 3000 ? out.substring(0, 3000) : out;
            } catch (Exception e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        android.util.Log.w("amadeus-ocr", "截图识别失败：" + last);
        return null;
    }

    /**
     * 拍一张屏幕（JPEG，缩到 900 宽）。
     * 优先用 **Shizuku 的 screencap**（shell 权限）：无障碍的 takeScreenshot 在这台机器上
     * 拍出来是**全黑**（MIUI 拦），而 shell 的 screencap 连微信那种 FLAG_SECURE 界面也能拍到。
     * Shizuku 没起才退回无障碍截图（多半是黑的，聊胜于无）。
     */
    static byte[] shotJpeg(Context ctx) {
        File ext = null;
        try { ext = ctx.getExternalFilesDir(null); } catch (Throwable ignored) { }
        if (ext != null) {
            // noinspection ResultOfMethodCallIgnored
            ext.mkdirs();
            File f = new File(ext, "shot.png");
            // 拍两次：黑屏（Doze）时 screencap 出来是纯黑的，先唤醒再拍一次
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    if (attempt == 0) {
                        // 试探：直接拍；纯黑就唤醒重拍（正常情况下第一次就够）
                    } else {
                        ShizukuBridge.run("input keyevent 224");   // KEYCODE_WAKEUP
                        Thread.sleep(400);
                    }
                    String out = ShizukuBridge.run("screencap -p " + f.getAbsolutePath());
                    if (out == null || !out.contains("\"ok\":true")) continue;
                    if (!f.exists() || f.length() < 1000) continue;
                    byte[] jpeg = toJpeg(f.getAbsolutePath());
                    // noinspection ResultOfMethodCallIgnored
                    f.delete();
                    if (jpeg == null) continue;
                    // 纯黑图只有十几 KB；正常界面 100KB+
                    if (attempt == 0 && jpeg.length < 25000) {
                        android.util.Log.i("amadeus-ocr", "第一张太小（" + jpeg.length + "B），可能是黑屏，唤醒重拍");
                        continue;
                    }
                    if (jpeg.length > 1500) return jpeg;
                } catch (Throwable e) {
                    android.util.Log.w("amadeus-ocr", "shizuku screencap 失败：" + e);
                }
            }
        }
        // 退路：无障碍截图
        if (!CtrlService.ready()) return null;
        final byte[][] holder = new byte[1][];
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        try {
            CtrlService.get().takeShot(png -> { holder[0] = png; latch.countDown(); });
            latch.await(8, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Throwable e) {
            return null;
        }
        return holder[0];
    }

    /** 图片文件 → 缩放成 900 宽的 JPEG（省 token，也避免太大的包）。 */    /** 图片文件 → 缩放成 900 宽的 JPEG（省 token，也避免太大的包）。 */
    static byte[] toJpeg(String path) {
        try {
            android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeFile(path, o);
            if (o.outWidth <= 0) return null;
            int sample = 1;
            while (o.outWidth / sample > 1800) sample *= 2;
            android.graphics.BitmapFactory.Options o2 = new android.graphics.BitmapFactory.Options();
            o2.inSampleSize = sample;
            android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeFile(path, o2);
            if (bmp == null) return null;
            int w = bmp.getWidth(), h = bmp.getHeight();
            int tw = Math.min(900, w);
            int th = Math.max(1, (int) ((long) h * tw / w));
            android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(bmp, tw, th, true);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 72, bos);
            return bos.toByteArray();
        } catch (Throwable e) {
            return null;
        }
    }

    public static void openSettingsPanel(Context ctx, String panel) {
        String p = panel == null ? "" : panel.toLowerCase();
        Intent i;
        switch (p) {
            case "wifi": i = new Intent(Settings.ACTION_WIFI_SETTINGS); break;
            case "bluetooth": i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS); break;
            case "apps": i = new Intent(Settings.ACTION_APPLICATION_SETTINGS); break;
            case "battery": i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); break;
            case "display": i = new Intent(Settings.ACTION_DISPLAY_SETTINGS); break;
            case "sound": i = new Intent(Settings.ACTION_SOUND_SETTINGS); break;
            case "locale": i = new Intent(Settings.ACTION_LOCALE_SETTINGS); break;
            case "storage": i = new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS); break;
            case "accessibility": i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS); break;
            case "autostart": {
                i = new Intent();
                i.setComponent(new ComponentName("com.miui.securitycenter",
                        "com.miui.permcenter.autostart.AutoStartManagementActivity"));
                break;
            }
            default: i = new Intent(Settings.ACTION_SETTINGS); break;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { ctx.startActivity(i); }
        catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
            } catch (Exception ignored) { }
        }
    }

    public static String findPackageByLabel(Context ctx, String label) {
        if (label == null || label.trim().isEmpty()) return null;
        String want = label.trim().toLowerCase();
        PackageManager pm = ctx.getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN);
        main.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        String loose = null;
        for (ResolveInfo ri : list) {
            String pkg = ri.activityInfo.packageName;
            String name = String.valueOf(ri.loadLabel(pm)).trim();
            String nl = name.toLowerCase();
            if (pkg.equalsIgnoreCase(label)) return pkg;
            if (nl.equals(want)) return pkg;
            if (loose == null && (nl.contains(want) || want.contains(nl))) loose = pkg;
        }
        return loose;
    }

    public static String listApps(Context ctx) {
        PackageManager pm = ctx.getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN);
        main.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        List<String> names = new ArrayList<>();
        for (ResolveInfo ri : list) {
            String n = String.valueOf(ri.loadLabel(pm)).trim();
            if (!n.isEmpty() && !names.contains(n)) names.add(n);
        }
        StringBuilder sb = new StringBuilder();
        for (String n : names) sb.append(n).append("、");
        return sb.toString();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    /**
     * 会话名字清洗（2026-10-23）。
     * 微信的行是「名字 | 预览 | 时间」；QQ 的行是 contentDescription 拼的整串：
     *   「女仆, ,还有骑车那事…,20:30, 消息免打扰」
     * 只留第一段 —— 拿整串去列表里找是永远找不到的（那就是"点了反复跳"的真因）。
     */
    static String chatName(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return s;
        int bar = s.indexOf('|');
        if (bar > 0) s = s.substring(0, bar).trim();
        if (s.contains(", ")) {
            for (String seg : s.split(",\\s*")) {
                String t = seg.trim();
                if (t.isEmpty()) continue;
                if ("消息免打扰".equals(t) || t.matches("^\\d{1,2}:\\d{2}.*")
                        || t.matches("^\\d+\\s*条未读.*")) continue;
                s = t;
                break;
            }
        }
        s = s.replaceAll("\\s*\\d+\\s*条未读", "")
                .replaceAll("\\d{1,2}:\\d{2}", "")
                .replace("消息免打扰", "")
                .trim();
        while (s.startsWith(",") || s.startsWith("，")) s = s.substring(1).trim();
        return s;
    }

    /** 桌面/启动器？——这种"应用"没有 LauncherActivity 可拉，直接按 Home 键回桌面。 */
    static boolean isLauncherPkg(String pkg) {
        if (pkg == null) return false;
        String p = pkg.toLowerCase();
        return p.contains("launcher") || p.contains(".home") || p.contains("homescreen")
                || p.equals("com.miui.home") || p.equals("com.android.settings")
                || p.startsWith("com.hihonor.android.launcher");
    }

    /**
     * 看完消息回到原来的应用（2026-10-25 主人要求）。
     *
     * 规则：
     *   · 停留 afterMs（默认 5 秒，主人 2026-10-25 说的是"停五秒就行"）后检查一次；
     *   · 那时人已经自己切到别的应用了 → 什么都不做（不跟人抢）；
     *   · 正在打字（输入框里已经有字）→ 也不动，别把人家的回复打断；
     *   · 还在微信/QQ 里 → 把原来的应用拉回前台（原来是桌面就回桌面，原来是她自己就回"她"）。
     * 拉应用优先走 Shizuku 的 monkey（不受后台启动 Activity 限制），失败才用 startActivity。
     */
    static void scheduleReturnTo(Context ctx, String chatPkg, String prevPkg, int afterMs) {
        if (afterMs <= 0) return;
        if (prevPkg == null || prevPkg.trim().isEmpty()) return;
        final String prev = prevPkg.trim();
        if (prev.equals(chatPkg)) return;                       // 本来就在微信/QQ 里，没得回
        if (prev.startsWith("com.tencent.mm") || prev.startsWith("com.tencent.mobileqq")) return;
        final int wait = Math.max(1000, Math.min(afterMs, 10 * 60 * 1000));
        android.util.Log.i("amadeus-return", "已排程：只要 " + wait + "ms 后还在 " + chatPkg + "，就回 " + prev);
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(wait);
                CtrlService c = CtrlService.get();
                if (c == null) { android.util.Log.w("amadeus-return", "无障碍掉线，放弃返回"); return; }
                String cur = c.currentPackage();
                android.util.Log.i("amadeus-return", "到点了，当前前台 = " + cur);
                if (cur == null || !cur.startsWith(chatPkg)) { android.util.Log.i("amadeus-return", "人已经自己走了，不动"); return; }
                // 正在打字就别抢：输入框里有内容 = 人在回消息
                try {
                    AccessibilityNodeInfo ed = c.findEditable();
                    if (ed != null) {
                        CharSequence txt = ed.getText();
                        if (txt != null && txt.length() > 0) { android.util.Log.i("amadeus-return", "输入框里有字，不打扰"); return; }
                    }
                } catch (Throwable ignored) { }
                if (isLauncherPkg(prev)) {
                    android.util.Log.i("amadeus-return", "回桌面");
                    try { ShizukuBridge.run("input keyevent 3"); }
                    catch (Throwable ignored) { c.home(); }
                    return;
                }
                if (prev.equals(ctx.getPackageName())) {
                    // 兜底自己也走 am start（后台起 Activity 会被系统拦，am 走 shell 不受限）
                    String r = null;
                    try { r = ShizukuBridge.run("am start -n " + ctx.getPackageName() + "/.MainActivity"); } catch (Throwable ignored) { }
                    android.util.Log.i("amadeus-return", "回「她」: " + r);
                    if (r == null || !r.contains("\"ok\":true")) {
                        Intent i = new Intent(ctx, MainActivity.class);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        ctx.startActivity(i);
                    }
                    return;
                }
                // 别人的应用：先解析出启动 Activity，用 am start -n 精确拉起（比 monkey 可靠）
                String comp = launcherComponent(ctx, prev);
                if (comp != null) {
                    String r = null;
                    try { r = ShizukuBridge.run("am start -n " + comp); } catch (Throwable ignored) { }
                    android.util.Log.i("amadeus-return", "am start " + comp + " → " + r);
                    if (r != null && r.contains("\"ok\":true")) return;
                }
                String out = null;
                try { out = ShizukuBridge.run("monkey -p " + prev + " -c android.intent.category.LAUNCHER 1"); } catch (Throwable ignored) { }
                android.util.Log.i("amadeus-return", "monkey → " + out);
                if (out == null || !out.contains("\"ok\":true")) {
                    Intent li = ctx.getPackageManager().getLaunchIntentForPackage(prev);
                    if (li != null) {
                        li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(li);
                    }
                }
            } catch (Throwable e) {
                android.util.Log.w("amadeus-return", "返回失败: " + e);
            }
        }, "open-chat-return");
        t.setDaemon(true);
        t.start();
    }

    /** 解析某个包的主启动组件（形如 com.foo/.MainActivity），拿不到返回 null。 */
    static String launcherComponent(Context ctx, String pkg) {
        try {
            Intent it = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (it == null) return null;
            android.content.ComponentName cn = it.getComponent();
            if (cn == null) return null;
            return cn.getPackageName() + "/" + cn.getClassName();
        } catch (Throwable e) {
            return null;
        }
    }
}
