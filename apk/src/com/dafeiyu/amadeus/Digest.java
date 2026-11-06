package com.dafeiyu.amadeus;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 每小时看一遍微信/QQ 的新消息，汇总成"提醒清单"（2026-10-22）。
 *
 * 规则（主人定的）：
 *   微信：优先看**置顶**（列表最上面那几个），再看有没有人发新消息；
 *        **不看折叠的群聊**里的消息。
 *   QQ：**跳过**「华电车万草丛」「ncepu东方示例群」两个群，其它有新消息就看。
 *   只看这两个应用，别的应用不管。
 *
 * 做法：读会话列表（无障碍按行拆）→ 和服务端上次快照比对 → 变了的就是新消息。
 */
public class Digest {

    private static final String TAG = "amadeus-digest";
    static final String[] WX_SKIP = {"折叠的群聊"};
    static final String[] QQ_SKIP = {"车万草丛", "示例群"};

    /** 微信/QQ 系：小程序、公众号、视频号、H5 全在同一个包里跑，所以按前缀判（2026-10-25）。 */
    static boolean isChatPkg(String pkg) {
        if (pkg == null) return false;
        String p = pkg.trim();
        if (p.isEmpty()) return false;
        return p.startsWith("com.tencent.mm") || p.startsWith("com.tencent.mobileqq")
                || p.startsWith("com.tencent.tim");
    }

    /** 跑一次：扫两个 App → 传服务端 → 拿回清单文本。阻塞，别在主线程调。 */
    public static JSONObject run(Context ctx) {
        try { return MsgService.snapshot(ctx,100,"chat").put("text","已在后台读取通知，无需打开微信或QQ"); }
        catch(Exception e) { return new JSONObject(); }
    }

    /** Explicit legacy scan only; the hourly task never calls this. */
    public static JSONObject scanOnScreen(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            // 2026-10-25：工具被叫起来也一样先看主人在不在用微信/QQ —— 宁可不看，也别抢屏幕。
            CtrlService csStart = CtrlService.get();
            String fgStart = csStart != null ? csStart.currentPackage() : "";
            if (isChatPkg(fgStart)) {
                out.put("ok", false);
                out.put("error", "主人在用微信/QQ（前台 " + fgStart + "），先不看");
                return out;
            }
            // 连不上电脑就别去翻微信/QQ 了：翻一遍要亮屏、要切 App，白折腾还打扰人。
            android.app.KeyguardManager km =
                    (android.app.KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null && km.isKeyguardLocked()) {
                out.put("ok", false);
                out.put("error", "手机锁着，扫不了（解锁后自动补）");
                return out;
            }
            if (!serverReachable(ctx)) {
                Log.i(TAG, "连不上电脑，这轮不扫");
                out.put("ok", false);
                out.put("error", "连不上电脑（先不开微信/QQ）");
                return out;
            }
            JSONArray apps = new JSONArray();
            JSONObject wx = scan(ctx, "com.tencent.mm", "微信", WX_SKIP, new String[]{"通讯录", "发现"});
            JSONObject qq = scan(ctx, "com.tencent.mobileqq", "QQ", QQ_SKIP, new String[]{"联系人", "动态"});
            markOwnIfLatest(ctx, wx, "com.tencent.mm");
            markOwnIfLatest(ctx, qq, "com.tencent.mobileqq");
            apps.put(wx);
            apps.put(qq);
            out.put("apps", apps);
            JSONObject resp = post(ctx, apps);
            if (resp != null) return resp;
            out.put("ok", false);
            out.put("error", "服务端没响应");
            return out;
        } catch (Throwable e) {
            Log.w(TAG, "汇总失败：" + e);
            try { out.put("ok", false); out.put("error", String.valueOf(e.getMessage())); } catch (Throwable ignored) { }
            return out;
        }
    }

    /** 用 /api/ping 探一下电脑那边在不在（3 秒超时，别拖太久）。 */
    private static boolean serverReachable(Context ctx) {
        for (int i = 0; i < 2; i++) {
            String[] ep = Proactive.endpointParts(i);
            if (ep == null) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(ep[0] + "/api/ping").openConnection();
                c.setConnectTimeout(2500);
                c.setReadTimeout(2500);
                if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                int code = c.getResponseCode();
                if (code >= 200 && code < 500) return true;
            } catch (Throwable ignored) {
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return false;
    }

    private static final String PREFS = "amadeus_digest";
    private static long lastLockedLog = 0;
    /** 上一次看到他正在用微信/QQ 的时刻（2026-10-24） */
    private static long busyAt = 0;
    private static long lastBusyLog = 0;

    /**
     * 什么时候扫（2026-10-22）：
     *   · 跨过整点（hour 变了）→ 扫；
     *   · 距离上次扫描超过 55 分钟（App 被杀/没网错过了）→ **补扫**；
     *   · 第一次装/第一次跑 → 扫。
     * 上次扫描时间存在 SharedPreferences，进程重启也不会重复扫。
     */
    public static void maybeRunHourly(Context ctx) {
        // Passive notification ingestion already feeds the brain's hourly digest.
        // Screen scans are opt-in through scanOnScreen; never steal the foreground.
        if (!ctx.getSharedPreferences("amadeus_digest",0).getBoolean("screenScanExplicitlyEnabled",false)) return;
        try {
            // 手机锁着就别扫：扫描要点亮屏幕 + 退到会话列表，会把你锁屏顶掉（2026-10-22 主人反馈）
            android.app.KeyguardManager km =
                    (android.app.KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null && km.isKeyguardLocked()) {
                if (System.currentTimeMillis() - lastLockedLog > 600000L) {
                    lastLockedLog = System.currentTimeMillis();
                    Log.i(TAG, "手机锁着，先不扫（等解锁后再补）");
                }
                return;
            }
            long now = System.currentTimeMillis();
            // ★ 2026-10-24 主人要求：「我在使用微信或 QQ 的时候就别看了，要看等我没用的时候再看」
            //   扫一遍要亮屏 + 把微信/QQ 拉到前台，他正在用的时候等于硬抢屏幕。
            //   所以：前台是微信/QQ → 这轮不扫（也不记 lastScanAt，等他切走再补）。
            // 2026-10-25 补强：主人反馈"我在用微信的时候它还在看"——
            //   ① 原来的 currentPackage() 在浮窗/切换瞬间会返回空或它自己 → 判不出来就照扫了，
            //      现在 CtrlService 会记无障碍事件里的前台包名，这里也改成"判不出来就不扫"；
            //   ② 小程序/公众号/视频号都在 com.tencent.mm 这个包里跑，所以按**包名前缀**判。
            CtrlService csNow = CtrlService.get();
            String fg = csNow != null ? csNow.currentPackage() : "";
            if (isChatPkg(fg)) {
                busyAt = now;
                if (now - lastBusyLog > 600000L) {
                    lastBusyLog = now;
                    Log.i(TAG, "主人在用微信/QQ（前台 " + fg + "），先不扫（等他切走）");
                }
                return;
            }
            if (fg == null || fg.isEmpty()) {
                // 连前台是谁都读不出来（无障碍断了 / 正在切换）——更不该去抢屏幕
                if (now - lastBusyLog > 600000L) {
                    lastBusyLog = now;
                    Log.i(TAG, "看不出主人在用哪个 App，这轮先不扫");
                }
                return;
            }
            // 刚退出微信/QQ 也别立刻抢屏幕：留 5 分钟安静期（原来 2 分钟，主人 2026-10-25 说还是太急）
            if (busyAt > 0 && now - busyAt < 5 * 60 * 1000L) return;
            android.content.SharedPreferences sp =
                    ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
            long lastAt = sp.getLong("lastScanAt", 0L);
            boolean hourChanged = (now / 3600000L) != (lastAt / 3600000L);
            boolean missed = now - lastAt >= 55L * 60L * 1000L;
            if (!hourChanged && !missed) return;
            sp.edit().putLong("lastScanAt", now).apply();
            Log.i(TAG, (missed ? "补扫（距上次 " + ((now - lastAt) / 60000) + " 分钟）" : "整点了，扫一遍微信/QQ"));
            run(ctx);
        } catch (Throwable e) {
            Log.w(TAG, "hourly: " + e);
        }
    }

    // ── 扫一个 App 的会话列表 ──────────────────────────────────────────────
    private static JSONObject scan(Context ctx, String pkg, String label, String[] skip, String[] tabs) throws Exception {
        JSONObject o = new JSONObject();
        o.put("app", label);
        o.put("pkg", pkg);
        JSONArray list = new JSONArray();
        o.put("rows", list);
        CtrlService cs = CtrlService.get();
        if (cs == null) { o.put("error", "无障碍没连上"); return o; }
        try {
            Intent li = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) { o.put("error", "没装"); return o; }
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            // 优先用 Shizuku（shell 身份）拉起，后台也能切过去；
            // 直接用 startActivity 有时被系统拦，结果读到的还是"她"自己的窗口（0 行）
            // 先点亮屏幕（灭了的话 activity 起不来，读到的还是桌面）
            try {
                ShizukuBridge.run("input keyevent 224");   // 只点亮，不 dismiss 锁屏
                Thread.sleep(500);
            } catch (Throwable ignored) { }
            boolean started = false;
            try {
                String comp = "com.tencent.mm".equals(pkg) ? "com.tencent.mm/.ui.LauncherUI"
                        : "com.tencent.mobileqq/.activity.SplashActivity";
                String out = ShizukuBridge.run("am start -n " + comp);
                started = out != null && out.contains("\"ok\":true");
            } catch (Throwable ignored) { }
            if (!started) ctx.startActivity(li);
            // 等它真的到前台（最多 5 秒）
            for (int i = 0; i < 10; i++) {
                Thread.sleep(500);
                if (pkg.equals(cs.currentPackage())) break;
            }
            if (!pkg.equals(cs.currentPackage())) {
                o.put("error", "没能切到 " + label + "（当前：" + cs.currentPackage() + "）");
                return o;
            }
            Thread.sleep(800);
            // 退回会话列表（看到底部 tab 才算到）。
            // ⚠️ 按 back 会把整个任务栈退掉（实测退着退着就回到桌面/别的 App），
            //    所以每次 back 之后都确认"前台还是不是这个 App"，不是就重新拉起来。
            for (int i = 0; i < 8; i++) {
                String cur = cs.currentPackage();
                if (!pkg.equals(cur)) {
                    try { ShizukuBridge.run("am start -n " + (pkg.endsWith(".mm")
                            ? "com.tencent.mm/.ui.LauncherUI" : "com.tencent.mobileqq/.activity.SplashActivity")); }
                    catch (Throwable ignored) { }
                    Thread.sleep(1200);
                }
                String t = cs.screenText();
                boolean atHome = t != null && t.contains(tabs[0]) && t.contains(tabs[1]);
                if (atHome) break;
                try { ShizukuBridge.run("input keyevent 4"); } catch (Throwable ignored) { cs.back(); }
                Thread.sleep(700);
            }
            JSONArray rows = cs.listItemsJson();
            if (rows.length() < 3) {
                // 微信的会话列表不是 isScrollable 节点（QQ 是），退回"按坐标聚行"
                JSONArray alt = cs.rowsJson();
                if (alt.length() > rows.length()) {
                    Log.i(TAG, label + " 用坐标聚行拿到 " + alt.length() + " 行");
                    rows = mergePreview(alt);
                }
            }
            if (rows.length() < 3) {
                // 没拿到列表：多半微信停在文件预览/小程序里。强杀重开一定回到会话列表。
                try {
                    ShizukuBridge.run("am force-stop " + pkg);
                    Thread.sleep(1200);
                    String comp = "com.tencent.mm".equals(pkg) ? "com.tencent.mm/.ui.LauncherUI"
                            : "com.tencent.mobileqq/.activity.SplashActivity";
                    ShizukuBridge.run("am start -n " + comp);
                    for (int i = 0; i < 12; i++) {
                        Thread.sleep(500);
                        if (pkg.equals(cs.currentPackage())) break;
                    }
                    Thread.sleep(1500);
                    rows = cs.listItemsJson();
                    if (rows.length() < 3) {
                        JSONArray alt = cs.rowsJson();
                        if (alt.length() > rows.length()) rows = alt;
                    }
                    Log.i(TAG, label + " 重开后拿到 " + rows.length() + " 行");
                } catch (Throwable e) {
                    Log.w(TAG, "重开失败：" + e);
                }
            }
            boolean folded = false;
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                JSONArray texts = row.optJSONArray("texts");
                if (texts == null || texts.length() == 0) continue;
                // 未读数：列表行里单独一个 1~99 的数字（微信/QQ 的红点数字）
                int unread = 0;
                for (int k = 0; k < texts.length(); k++) {
                    String t = texts.optString(k).trim();
                    if (t.matches("\\d{1,3}")) {
                        try { unread = Integer.parseInt(t); } catch (Throwable ignored) { }
                    }
                }
                StringBuilder sb = new StringBuilder();
                if (unread > 0) sb.append(unread).append(" 条未读 | ");
                java.util.LinkedHashSet<String> uniq = new java.util.LinkedHashSet<>();
                for (int k = 0; k < texts.length(); k++) {
                    String t = texts.optString(k).trim();
                    if (t.isEmpty() || uniq.contains(t)) continue;   // 去重（子节点常重复）
                    if (t.matches("^(置顶|取消置顶|标为未读|标为已读|删除|消息免打扰|不显示|置顶聊天)$")) continue;
                    uniq.add(t);
                    if (uniq.size() >= 3) break;                     // 名字 + 预览 + 时间，够了
                }
                boolean hasTime = false;
                for (String t : uniq) {
                    if (sb.length() > 0) sb.append(" | ");
                    sb.append(t);
                    // 有时间戳/未读标记的才像"会话行"
                    if (t.matches(".*(\\d{1,2}:\\d{2}|昨天|周[一二三四五六日天]|星期[一二三四五六日天]|刚刚|\\d+\\s*条).*")) hasTime = true;
                }
                if (!hasTime) continue;                              // 工具栏/状态行直接丢
                String line = sb.toString();
                if (line.trim().isEmpty()) continue;
                // 导航条/工具栏噪音（返回、搜索、更多功能…）
                if (line.matches(".*(返回|更多功能|关闭朗读|搜索小程序|通讯录|发现|联系人|动态).*")) continue;
                // 跳过折叠的群聊：它下面（其实就是一个入口）不展开
                if (containsAny(line, skip)) { folded = true; continue; }
                if (folded && !line.contains("折叠")) { /* 折叠入口之后才算正常会话，这里不跳过 */ }
                // 跳过搜出来的底部 tab、顶部标题这些
                if (line.length() <= 2) continue;
                if (line.matches(".*(微信|通讯录|发现|我|QQ|消息|联系人|动态|搜索).*") && texts.length() == 1) continue;
                list.put(line);
            }
            o.put("ok", true);
        } catch (Throwable e) {
            o.put("error", String.valueOf(e.getMessage()));
        }
        return o;
    }

    /**
     * 微信的会话行被坐标拆成了两行：上一行「名字 + 时间」，下一行「消息预览」。
     * 这里把紧跟其后的"没有时间、只有一段文字"的行并到上一行里（2026-10-22）。
     */
    private static JSONArray mergePreview(JSONArray rows) {
        JSONArray out = new JSONArray();
        try {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                JSONArray texts = row.optJSONArray("texts");
                if (texts == null) continue;
                boolean hasTime = false;
                for (int k = 0; k < texts.length(); k++) {
                    if (isTimeish(texts.optString(k))) { hasTime = true; break; }
                }
                if (hasTime && i + 1 < rows.length()) {
                    JSONObject next = rows.getJSONObject(i + 1);
                    JSONArray nt = next.optJSONArray("texts");
                    if (nt != null && nt.length() == 1 && !isTimeish(nt.optString(0))) {
                        texts.put(nt.optString(0));   // 把预览接到这一行
                        i++;                          // 跳过预览行
                    }
                }
                out.put(row);
            }
        } catch (Throwable ignored) {
            return rows;
        }
        return out;
    }

    private static boolean isTimeish(String t) {
        if (t == null) return false;
        return t.matches(".*(\\d{1,2}:\\d{2}|昨天|周[一二三四五六日天]|星期[一二三四五六日天]|刚刚).*");
    }

    /**
     * 主人发消息也会把会话顶到最上面 —— 那不算"新消息"（2026-10-23 主人要求）。
     * 做法：进最新那个会话，看最后一条内容行是不是**右对齐**（我发的气泡在右边）。
     * 是的话给这一行打上「｜我发的」，服务端会直接丢掉。
     *
     * ⚠️ 只查最上面那一条（每个 App 一次），不做全量 —— 全量要把每个会话都点开，太慢也太打扰。
     */
    private static void markOwnIfLatest(Context ctx, JSONObject appObj, String pkg) {
        if (appObj == null) return;
        JSONArray rows = appObj.optJSONArray("rows");
        if (rows == null || rows.length() == 0) return;
        CtrlService cs = CtrlService.get();
        if (cs == null) return;
        // 2026-10-26 主人反馈"我自己发的消息还是被列成新消息"。
        // 两个 bug：
        //   ① 原来只查**最上面那一条**会话 —— 你在两个聊天里都回过话，只有一条会被标记；
        //   ② 判定用的是 `r.optInt("x0", 0)`，可 rowsJson() 给的行结构是 {cy, items:[{x,t}]}，
        //      根本没有 "x0" 字段 → 永远是 0 → **一次都没判中过**（这就是"一直没修好"的原因）。
        // 现在：查最上面 3 条，x 取该行所有文字的**最小 x**（气泡左边界），> 45% 屏宽就算自己发的。
        try {
            int w = ctx.getResources().getDisplayMetrics().widthPixels;
            int limit = Math.min(3, rows.length());
            int marked = 0;
            for (int idx = 0; idx < limit; idx++) {
                String row = rows.optString(idx, "");
                if (row.isEmpty() || row.contains("我发的")) continue;
                String who = row.split("\\|")[0].trim();
                if (who.isEmpty()) continue;
                try { ShizukuBridge.run("am start -n " + ("com.tencent.mm".equals(pkg)
                        ? "com.tencent.mm/.ui.LauncherUI" : "com.tencent.mobileqq/.activity.SplashActivity")); }
                catch (Throwable ignored) { }
                for (int i = 0; i < 8; i++) {
                    Thread.sleep(350);
                    if (pkg.equals(cs.currentPackage())) break;
                }
                if (!cs.tapTextInList(who)) break;      // 点不进去就别再试后面的
                Thread.sleep(1100);
                JSONArray msgs = cs.rowsJson();
                String lastText = "";
                int minX = Integer.MAX_VALUE;
                for (int i = 0; i < msgs.length(); i++) {
                    JSONObject r = msgs.optJSONObject(i);
                    if (r == null) continue;
                    JSONArray items = r.optJSONArray("items");
                    if (items == null || items.length() == 0) continue;
                    StringBuilder sb = new StringBuilder();
                    int rowMinX = Integer.MAX_VALUE;
                    for (int k = 0; k < items.length(); k++) {
                        JSONObject it = items.optJSONObject(k);
                        if (it == null) continue;
                        String t = it.optString("t", "").trim();
                        if (t.isEmpty()) continue;
                        if (sb.length() > 0) sb.append(' ');
                        sb.append(t);
                        rowMinX = Math.min(rowMinX, it.optInt("x", 0));
                    }
                    String line = sb.toString().trim();
                    if (line.isEmpty() || isTimeish(line)) continue;
                    lastText = line;
                    minX = rowMinX;
                }
                boolean mine = !lastText.isEmpty() && minX != Integer.MAX_VALUE && minX > w * 0.45;
                Log.i(TAG, "第 " + (idx + 1) + " 条会话「" + who + "」最后一条 x=" + minX + "/" + w + " → " + (mine ? "我发的" : "别人发的"));
                if (mine) {
                    rows.put(idx, row + "｜我发的");
                    marked += 1;
                }
                // 退回会话列表，准备看下一条
                try { ShizukuBridge.run("input keyevent 4"); } catch (Throwable ignored) { cs.back(); }
                Thread.sleep(500);
            }
            if (marked > 0) Log.i(TAG, "本轮标了 " + marked + " 条是主人自己发的（不算新消息）");
        } catch (Throwable e) {
            Log.w(TAG, "markOwn 失败：" + e);
        }
    }

    private static boolean containsAny(String s, String[] arr) {
        for (String a : arr) if (a != null && !a.isEmpty() && s.contains(a)) return true;
        return false;
    }

    // ── 传给电脑，拿回汇总 ────────────────────────────────────────────────
    private static JSONObject post(Context ctx, JSONArray apps) {
        for (int i = 0; i < 2; i++) {
            String[] ep = Proactive.endpointParts(i);
            if (ep == null) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(ep[0] + "/api/digest").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(30000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json; charset=utf-8");
                if (ep[1] != null && !ep[1].isEmpty()) c.setRequestProperty("x-amadeus-key", ep[1]);
                JSONObject body = new JSONObject();
                body.put("apps", apps);
                byte[] payload = body.toString().getBytes("UTF-8");
                c.setFixedLengthStreamingMode(payload.length);
                try (OutputStream os = c.getOutputStream()) { os.write(payload); }
                int code = c.getResponseCode();
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                }
                if (code == 200) return new JSONObject(bos.toString("UTF-8"));
            } catch (Throwable e) {
                Log.w(TAG, "上传失败：" + e);
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }
}
