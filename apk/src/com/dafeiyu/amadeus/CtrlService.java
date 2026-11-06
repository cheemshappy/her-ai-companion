package com.dafeiyu.amadeus;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * 干活的那只手：读屏、点击、滑动、输入。
 * 只在用户手动开启无障碍后才有实例（INSTANCE 非空）。
 */
public class CtrlService extends AccessibilityService {

    private static volatile CtrlService INSTANCE;

    public static CtrlService get() { return INSTANCE; }
    public static boolean ready() { return INSTANCE != null; }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        INSTANCE = this;
        // Android 13+ cache can retain a previous WebView/video tree after an
        // activity switch. Actions must inspect the current screen's real nodes.
        if(android.os.Build.VERSION.SDK_INT>=33)try{setCacheEnabled(false);}catch(Throwable ignored){}
    }

    @Override
    public void onDestroy() {
        if (INSTANCE == this) INSTANCE = null;
        super.onDestroy();
    }

    /**
     * 最近一次"别人家的前台窗口"（2026-10-25）。
     * 为什么要记：要判断"主人是不是正在用微信/QQ"。原来直接读 getRootInActiveWindow()，
     * 有两个坑 —— 浮窗在的时候根窗口可能是我们自己；窗口切换的瞬间又常常是 null。
     * 两种都会让"主人在不在用微信"判错，结果就是她在主人刷微信的时候还在翻消息。
     */
    private static volatile String lastFgPkg = "";
    private static volatile long lastFgAt = 0;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        try {
            if (event == null) return;
            int t = event.getEventType();
            if (t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    && t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return;
            CharSequence p = event.getPackageName();
            if (p == null) return;
            String s = p.toString();
            if (s.isEmpty()) return;
            if (s.equals(getPackageName())) return;   // 自己的浮窗/页面不算"主人在用别的应用"
            lastFgPkg = s;
            lastFgAt = System.currentTimeMillis();
        } catch (Throwable ignored) { }
    }

    /** 上一次看到的前台包名（可能是几分钟前的，调用方自己判时效）。 */
    public String lastForegroundPackage() { return lastFgPkg; }

    @Override
    public void onInterrupt() { }

    // ────────────────────────────────── 读屏 ─────────────────────────────────
    /** 当前窗口的可读文本（带坐标，方便模型判断）。 */
    /**
     * 截屏（2026-10-21）：微信这类 App **整个屏蔽了无障碍**（uiautomator 都只看到一个空节点），
     * 读屏拿不到字，只能截图丢给视觉模型抄。这里用无障碍的 takeScreenshot（API 30+），
     * 不需要 MediaProjection 那种每次弹窗授权。
     * 回调在主线程，给的是 JPEG（已缩到 900 宽，够认字又省 token）。
     */
    public interface ShotCb { void onShot(byte[] jpeg); }

    public void takeShot(final ShotCb cb) {
        if (android.os.Build.VERSION.SDK_INT < 30) { cb.onShot(null); return; }
        try {
            takeScreenshot(android.view.Display.DEFAULT_DISPLAY, getMainExecutor(),
                    new TakeScreenshotCallback() {
                        @Override public void onSuccess(ScreenshotResult r) {
                            byte[] out = null;
                            try {
                                android.hardware.HardwareBuffer hb = r.getHardwareBuffer();
                                android.graphics.Bitmap bmp =
                                        android.graphics.Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                                if (bmp != null) {
                                    android.graphics.Bitmap sw =
                                            bmp.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
                                    int w = sw.getWidth(), h = sw.getHeight();
                                    int tw = Math.min(900, w);
                                    int th = Math.max(1, (int) ((long) h * tw / w));
                                    android.graphics.Bitmap small =
                                            android.graphics.Bitmap.createScaledBitmap(sw, tw, th, true);
                                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                                    small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, bos);
                                    out = bos.toByteArray();
                                }
                                hb.close();
                            } catch (Throwable ignored) { }
                            cb.onShot(out);
                        }
                        @Override public void onFailure(int errorCode) { cb.onShot(null); }
                    });
        } catch (Throwable e) {
            cb.onShot(null);
        }
    }

    public String screenText() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "";
        StringBuilder sb = new StringBuilder();
        try {
            CharSequence pkg = root.getPackageName();
            if (pkg != null) sb.append("应用: ").append(pkg).append('\n');
        } catch (Exception ignored) { }
        List<String> lines = new ArrayList<>();
        walk(root, lines, 0);
        int count = 0;
        for (String l : lines) {
            if (count++ > 160) { sb.append("…（还有更多，已截断）\n"); break; }
            sb.append(l).append('\n');
        }
        return sb.toString();
    }

    private void walk(AccessibilityNodeInfo node, List<String> out, int depth) {
        if (node == null || depth > 40 || out.size() > 400) return;
        String text = str(node.getText());
        String desc = str(node.getContentDescription());
        String cls = str(node.getClassName());
        String label = text.length() > 0 ? text : desc;
        if (label.length() > 0) {
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            String kind = cls.contains("Button") ? "按钮" : cls.contains("EditText") ? "输入框"
                    : cls.contains("Image") ? "图标" : "文本";
            // 2026-10-26 主人反馈"读消息是谁发的会搞错"：聊天界面里气泡没有名字，
            // 以前她只能猜。这里按**气泡在左还是右**给个提示（右边=自己发的，左边=对方）。
            // 只在微信/QQ 里加，别的界面加了反而干扰。
            String side = "";
            try {
                String pkg = str(getRootInActiveWindow() == null ? null : getRootInActiveWindow().getPackageName());
                if ((pkg.startsWith("com.tencent.mm") || pkg.startsWith("com.tencent.mobileqq"))
                        && "文本".equals(kind) && r.width() > 0 && !node.isEditable()) {
                    int w = metrics().widthPixels;
                    int cx = (r.left + r.right) / 2;
                    if (cx > w * 0.55f) side = "我：";
                    else if (cx < w * 0.45f) side = "对方：";
                }
            } catch (Throwable ignored) { }
            String line = "· " + side + label + "  [" + kind;
            if (node.isEditable()) line += "·可输入";
            if (node.isClickable()) line += "·可点";
            line += "]";
            out.add(line);
        }
        int n = node.getChildCount();
        for (int i = 0; i < n; i++) {
            AccessibilityNodeInfo c = null;
            try { c = node.getChild(i); } catch (Exception ignored) { }
            if (c != null) walk(c, out, depth + 1);
        }
    }

    private static String str(CharSequence cs) { return cs == null ? "" : cs.toString().trim(); }

    private List<AccessibilityNodeInfo> allNodes() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return out;
        try{root.refresh();}catch(Throwable ignored){}
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        int guard = 0;
        while (!q.isEmpty() && guard++ < 4000) {
            AccessibilityNodeInfo n = q.poll();
            out.add(n);
            int c = 0;
            try { c = n.getChildCount(); } catch (Exception ignored) { }
            for (int i = 0; i < c; i++) {
                try {
                    AccessibilityNodeInfo ch = n.getChild(i);
                    if (ch != null) q.add(ch);
                } catch (Exception ignored) { }
            }
        }
        return out;
    }

    public AccessibilityNodeInfo findByText(String target) {
        if (target == null || target.trim().isEmpty()) return null;
        String t = target.trim();
        String lower = t.toLowerCase();
        AccessibilityNodeInfo loose = null;
        for (AccessibilityNodeInfo n : allNodes()) {
            String text = str(n.getText());
            String desc = str(n.getContentDescription());
            String both = (text + " " + desc).trim();
            if (both.isEmpty()) continue;
            String bl = both.toLowerCase();
            if (both.equals(t) || bl.equals(lower)) return n;
            if (loose == null && (bl.contains(lower) || lower.contains(bl))) loose = n;
        }
        return loose;
    }

    /**
     * 只在"列表项"里找文字并点（跳过输入框）。
     * 为什么要这个：微信搜索页里，搜索框的文本就是刚输入的查询词，
     * 直接 tapText(名字) 会点到搜索框自己，结果原地打转（2026-10-22 踩过）。
     */
    public boolean tapTextInList(String text) {
        if (text == null || text.trim().isEmpty()) return false;
        String t = text.trim();
        AccessibilityNodeInfo loose = null;
        for (AccessibilityNodeInfo n : allNodes()) {
            String cls = str(n.getClassName());
            if (n.isEditable() || cls.contains("EditText")) continue;
            String both = (str(n.getText()) + " " + str(n.getContentDescription())).trim();
            if (both.isEmpty()) continue;
            if (both.equals(t)) {
                if (clickUp(n)) return true;
            } else if (loose == null && both.contains(t) && both.length() <= t.length() + 20) {
                loose = n;
            }
        }
        if (loose != null) return clickUp(loose);
        return false;
    }

    private boolean clickUp(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo cur = n;
        for (int i = 0; i < 6 && cur != null; i++) {
            if (cur.isClickable() && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            cur = cur.getParent();
        }
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        if (r.width() <= 0 || r.height() <= 0) return false;
        return tapXY(r.centerX(), r.centerY());
    }

    /**
     * 把当前页面上的文字按"行"拆出来（ChatGPT 式列表用，2026-10-22）。
     * 微信/QQ 的会话列表没有现成的行结构，只能拿节点坐标自己拼：
     *   同一个 y 附近的文字算一行，按 y 排序，行内按 x 排序。
     * 返回 [{y, texts:[...]}, ...]
     */
    public JSONArray rowsJson() {
        JSONArray out = new JSONArray();
        try {
            java.util.List<android.util.Pair<Rect, String>> nodes = new ArrayList<>();
            for (AccessibilityNodeInfo n : allNodes()) {
                String t = (str(n.getText()) + " " + str(n.getContentDescription())).trim();
                if (t.isEmpty()) continue;
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (r.width() <= 0 || r.height() <= 0) continue;
                nodes.add(new android.util.Pair<>(r, t));
            }
            // 按 y 中心聚行（阈值按屏幕高度 1.2%）
            int tol = Math.max(24, (int) (metrics().heightPixels * 0.012f));
            java.util.List<JSONObject> rows = new ArrayList<>();
            for (android.util.Pair<Rect, String> pr : nodes) {
                int cy = pr.first.centerY();
                JSONObject hit = null;
                for (JSONObject row : rows) {
                    if (Math.abs(row.optInt("cy") - cy) <= tol) { hit = row; break; }
                }
                if (hit == null) {
                    hit = new JSONObject();
                    hit.put("cy", cy);
                    hit.put("items", new JSONArray());
                    rows.add(hit);
                }
                JSONObject it = new JSONObject();
                it.put("x", pr.first.left);
                it.put("t", pr.second);
                hit.getJSONArray("items").put(it);
            }
            // 行内按 x 排，行间按 y 排
            java.util.Collections.sort(rows, (a, b) -> {
                try { return Integer.compare(a.getInt("cy"), b.getInt("cy")); }
                catch (Exception e) { return 0; }
            });
            for (JSONObject row : rows) {
                JSONArray items = row.getJSONArray("items");
                java.util.List<JSONObject> list = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) list.add(items.getJSONObject(i));
                list.sort((a, b) -> Integer.compare(a.optInt("x"), b.optInt("x")));
                JSONArray merged = new JSONArray();
                for (JSONObject it : list) merged.put(it.optString("t"));
                JSONObject o = new JSONObject();
                o.put("y", row.getInt("cy"));
                o.put("texts", merged);
                // 这一行最左边节点的 x（2026-10-23）：聊天页里"我发的"气泡是右对齐的，
                // x0 会明显偏右；拿它来判断一条消息是不是主人自己发的。
                o.put("x0", list.isEmpty() ? 0 : list.get(0).optInt("x"));
                out.put(o);
            }
        } catch (Throwable ignored) { }
        return out;
    }

    /**
     * 取"列表项"（2026-10-22）：微信/QQ 的会话列表，每一行是个可点的容器，
     * 里面的名字/预览/时间是子节点。用可点容器 + 尺寸过滤比按 y 聚行准得多。
     * 返回 [{y, texts:[...]}, ...]
     */
    public JSONArray listItemsJson() {
        JSONArray out = new JSONArray();
        try {
            AccessibilityNodeInfo list = null;
            for (AccessibilityNodeInfo n : allNodes()) {
                if (n != null && n.isScrollable()) { list = n; break; }
            }
            if (list == null) return out;          // 没有可滚动列表 = 不在会话列表
            int c = 0;
            try { c = list.getChildCount(); } catch (Throwable ignored) { }
            for (int i = 0; i < c; i++) {
                AccessibilityNodeInfo row;
                try { row = list.getChild(i); } catch (Throwable e) { continue; }
                if (row == null) continue;
                JSONArray texts = new JSONArray();
                collectTexts(row, texts, 0);
                if (texts.length() == 0) continue;
                Rect r = new Rect();
                row.getBoundsInScreen(r);
                JSONObject o = new JSONObject();
                o.put("y", r.centerY());
                o.put("texts", texts);
                out.put(o);
            }
        } catch (Throwable ignored) { }
        return out;
    }

    private void collectTexts(AccessibilityNodeInfo n, JSONArray out, int depth) {
        if (n == null || depth > 4) return;
        String t = (str(n.getText()) + " " + str(n.getContentDescription())).trim();
        if (!t.isEmpty()) out.put(t);
        int c = 0;
        try { c = n.getChildCount(); } catch (Throwable ignored) { }
        for (int i = 0; i < c; i++) {
            try { collectTexts(n.getChild(i), out, depth + 1); } catch (Throwable ignored) { }
        }
    }

    // ────────────────────────────────── 动作 ─────────────────────────────────
    public boolean tapText(String text) {
        AccessibilityNodeInfo n = findByText(text);
        if (n == null) return false;
        AccessibilityNodeInfo cur = n;
        for (int i = 0; i < 6 && cur != null; i++) {
            if (cur.isClickable()) {
                if (cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            }
            cur = cur.getParent();
        }
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        if (r.width() <= 0 || r.height() <= 0) return false;
        return tapXY(r.centerX(), r.centerY());
    }

    public boolean tapXY(float x, float y) {
        // Some ROMs accept an accessibility gesture but never dispatch it.
        // Existing Shizuku authorization gives a synchronous, reliable route.
        try{
            JSONObject shell=new JSONObject(ShizukuBridge.run("input tap "+Math.round(x)+" "+Math.round(y)));
            if(shell.optBoolean("ok",false))return true;
        }catch(Throwable ignored){}
        Path p = new Path();
        p.moveTo(x, y);
        GestureDescription.StrokeDescription st = new GestureDescription.StrokeDescription(p, 0, 60);
        GestureDescription g = new GestureDescription.Builder().addStroke(st).build();
        if(android.os.Looper.myLooper()==android.os.Looper.getMainLooper())return dispatchGesture(g,null,null);
        java.util.concurrent.CountDownLatch latch=new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean completed=new java.util.concurrent.atomic.AtomicBoolean(false);
        new android.os.Handler(android.os.Looper.getMainLooper()).post(()->{
            boolean accepted=dispatchGesture(g,new GestureResultCallback(){
                @Override public void onCompleted(GestureDescription description){completed.set(true);latch.countDown();}
                @Override public void onCancelled(GestureDescription description){latch.countDown();}
            },null);
            if(!accepted)latch.countDown();
        });
        try{latch.await(2500,java.util.concurrent.TimeUnit.MILLISECONDS);}catch(InterruptedException ignored){}
        return completed.get();
    }

    /** 比例坐标 0~1 → 像素 */
    public boolean tapRatio(float rx, float ry) {
        DisplayMetrics dm = metrics();
        return tapXY(rx * dm.widthPixels, ry * dm.heightPixels);
    }

    public boolean swipe(String dir, boolean full) {
        DisplayMetrics dm = metrics();
        float w = dm.widthPixels, h = dm.heightPixels;
        float midX = w / 2f, midY = h / 2f;
        float span = (full ? 0.62f : 0.36f);
        float fromX = midX, fromY = midY, toX = midX, toY = midY;
        switch (dir == null ? "up" : dir) {
            case "down": fromY = h * (0.5f - span / 2); toY = h * (0.5f + span / 2); break;
            case "left": fromX = w * (0.5f + span / 2); toX = w * (0.5f - span / 2); break;
            case "right": fromX = w * (0.5f - span / 2); toX = w * (0.5f + span / 2); break;
            default: fromY = h * (0.5f + span / 2); toY = h * (0.5f - span / 2); break;
        }
        Path p = new Path();
        p.moveTo(fromX, fromY);
        p.lineTo(toX, toY);
        GestureDescription.StrokeDescription st = new GestureDescription.StrokeDescription(p, 0, 280);
        GestureDescription g = new GestureDescription.Builder().addStroke(st).build();
        return dispatchGesture(g, null, null);
    }

    public AccessibilityNodeInfo findEditable() {
        for (AccessibilityNodeInfo n : allNodes()) {
            String cls = str(n.getClassName());
            if ((n.isEditable() || cls.contains("EditText")) && n.isVisibleToUser() && n.isEnabled()) return n;
        }
        return null;
    }

    private boolean visibleBounds(AccessibilityNodeInfo node,Rect bounds){
        node.getBoundsInScreen(bounds);return node.isVisibleToUser()&&bounds.width()>0&&bounds.height()>0;
    }
    public boolean chatHome(boolean qq){
        boolean first=false,second=false;int h=metrics().heightPixels;
        for(AccessibilityNodeInfo node:allNodes()){
            Rect r=new Rect();if(!visibleBounds(node,r)||r.centerY()<h*.72f)continue;
            String text=str(node.getText()),desc=str(node.getContentDescription());
            if((qq?"联系人":"通讯录").equals(text)||(qq?"联系人":"通讯录").equals(desc))first=true;
            if((qq?"消息":"发现").equals(text)||(qq?"消息":"发现").equals(desc))second=true;
        }
        return first&&second;
    }
    public AccessibilityNodeInfo chatSearchField(){
        int h=metrics().heightPixels;
        for(AccessibilityNodeInfo node:allNodes()){
            Rect r=new Rect();if(!visibleBounds(node,r)||r.bottom>h*.36f||!(node.isEditable()||str(node.getClassName()).contains("EditText")))continue;
            return node;
        }
        return null;
    }
    public boolean openChatSearch(){
        for(AccessibilityNodeInfo node:allNodes()){
            Rect r=new Rect();if(!visibleBounds(node,r)||r.bottom>metrics().heightPixels*.35f)continue;
            String text=str(node.getText()),desc=str(node.getContentDescription());
            if("搜索".equals(text)||"搜索".equals(desc)||"搜一搜".equals(text)||"搜索按钮".equals(desc))return clickUp(node);
        }
        return false;
    }
    public boolean setChatSearchQuery(String query){
        AccessibilityNodeInfo field=chatSearchField();if(field==null)return false;
        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args=new Bundle();args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,query);
        field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args);
        if(chatSearchQueryMatches(query))return true;
        try{return typeTextResult(query).optBoolean("verified")&&chatSearchQueryMatches(query);}catch(Exception ignored){return false;}
    }
    public boolean chatSearchQueryMatches(String query){
        AccessibilityNodeInfo field=chatSearchField();if(field==null)return false;
        try{field.refresh();}catch(Exception ignored){}
        return query.equals(str(field.getText()));
    }
    public List<AccessibilityNodeInfo> contactResults(String name){
        List<AccessibilityNodeInfo> found=new ArrayList<>();java.util.HashSet<String> boxes=new java.util.HashSet<>();
        AccessibilityNodeInfo field=chatSearchField();if(field==null)return found;Rect input=new Rect();field.getBoundsInScreen(input);
        int h=metrics().heightPixels;
        List<AccessibilityNodeInfo> nodes=allNodes();
        java.util.TreeMap<Integer,String> sections=new java.util.TreeMap<>();
        for(AccessibilityNodeInfo node:nodes){
            Rect r=new Rect();if(!visibleBounds(node,r)||r.top<input.bottom)continue;
            String label=str(node.getText());
            if(label.matches("联系人|好友|群聊|聊天记录|公众号|小程序|搜一搜|搜索指定内容|相关搜索|网络搜索"))sections.put(r.top,label);
        }
        for(AccessibilityNodeInfo node:nodes){
            Rect r=new Rect();if(!visibleBounds(node,r)||node.isEditable()||str(node.getClassName()).contains("EditText")||r.top<input.bottom||r.bottom>h*.88f)continue;
            String text=str(node.getText()),desc=str(node.getContentDescription());
            if(!name.equals(text)&&!name.equals(desc))continue;
            java.util.Map.Entry<Integer,String> section=sections.floorEntry(r.top);
            // Exact text in chat history or the public-search suggestion is
            // not a recipient. Only contact/group result sections qualify.
            if(section==null||!section.getValue().matches("联系人|好友|群聊"))continue;
            // Search terms can also be mirrored by a noneditable child of the field.
            boolean editAncestor=false;AccessibilityNodeInfo parent=node.getParent();
            for(int i=0;parent!=null&&i<5;i++,parent=parent.getParent())if(parent.isEditable()||str(parent.getClassName()).contains("EditText")){editAncestor=true;break;}
            if(editAncestor)continue;
            Rect clickable=new Rect(r);AccessibilityNodeInfo row=node;
            for(int i=0;row!=null&&i<5;i++,row=row.getParent())if(row.isClickable()){row.getBoundsInScreen(clickable);break;}
            String box=clickable.flattenToString();if(boxes.add(box))found.add(node);
        }
        return found;
    }
    public boolean selectContactResult(String name){List<AccessibilityNodeInfo> matches=contactResults(name);return matches.size()==1&&clickUp(matches.get(0));}
    public boolean conversationMatches(String name){
        if(chatSearchField()!=null)return false;
        int h=metrics().heightPixels;boolean title=false,input=false;
        for(AccessibilityNodeInfo node:allNodes()){
            Rect r=new Rect();if(!visibleBounds(node,r))continue;
            String text=str(node.getText()),desc=str(node.getContentDescription());
            if(r.bottom<h*.25f&&(name.equals(text)||name.equals(desc)))title=true;
            if(r.top>h*.45f&&(node.isEditable()||str(node.getClassName()).contains("EditText")))input=true;
        }
        return title&&input;
    }

    /** Preserve Unicode (Japanese/CJK/emoji), prefer the actually focused field. */
    public JSONObject typeTextResult(String text) {
        JSONObject out=new JSONObject();
        try {
            AccessibilityNodeInfo n=null;
            java.util.List<AccessibilityNodeInfo> editable=new java.util.ArrayList<>();
            for(AccessibilityNodeInfo node:allNodes())if((node.isEditable()||str(node.getClassName()).contains("EditText"))&&node.isVisibleToUser()&&node.isEnabled()){
                editable.add(node);if(node.isFocused())n=node;
            }
            if(n==null&&editable.size()==1)n=editable.get(0);
            if(n==null&&editable.size()>1)return out.put("ok",false).put("error","有多个输入框，请先点选要输入的那一个");
            if(n==null)return out.put("ok",false).put("package",rootPackage()).put("nodes",allNodes().size()).put("error","没有找到可编辑的输入框");
            if(n.isPassword())return out.put("ok",false).put("error","密码输入框请由主人填写");
            n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Bundle value=new Bundle();value.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,text);
            boolean accepted=n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,value);
            if(verifyText(n,text))return out.put("ok",true).put("verified",true).put("method","set-text");
            android.content.ClipboardManager cm=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            if(cm==null)return out.put("ok",false).put("error","输入未生效，系统剪贴板不可用");
            // Select the old content before pasting: retries must replace, not duplicate.
            if(!n.refresh())return out.put("ok",false).put("error","输入框已经变化，请重新点选后再输入");
            CharSequence old=n.getText();int oldLength=old==null?0:old.length();
            if(oldLength>0){
                Bundle selection=new Bundle();selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT,0);selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,oldLength);
                boolean selected=n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION,selection);
                n.refresh();
                if(!selected||n.getTextSelectionStart()!=0||n.getTextSelectionEnd()!=oldLength)return out.put("ok",false).put("verified",false).put("error","无法选中原文字替换，请手动清空输入框后重试");
            }
            cm.setPrimaryClip(android.content.ClipData.newPlainText("她·输入",text));
            boolean pasted=n.performAction(AccessibilityNodeInfo.ACTION_PASTE);
            boolean verified=verifyText(n,text);
            out.put("ok",verified).put("verified",verified).put("method","unicode-paste");
            if(!verified)out.put("error",pasted||accepted?"输入操作已提交，但没有回读到完整文字，不能当成输入成功":"此输入框拒绝设置和粘贴文字");
            return out;
        }catch(Throwable e){try{out.put("ok",false).put("error","输入未完成："+e.getClass().getSimpleName());}catch(Exception ignored){}return out;}
    }
    private boolean verifyText(AccessibilityNodeInfo node,String expected){
        for(int i=0;i<5;i++){
            try{if(!node.refresh())return false;CharSequence value=node.getText();if(expected.equals(value==null?"":value.toString()))return true;Thread.sleep(45);}catch(Throwable ignored){}
        }
        return false;
    }
    public boolean typeText(String text){return typeTextResult(text).optBoolean("ok",false);}

    public boolean back() { return performGlobalAction(GLOBAL_ACTION_BACK); }
    public boolean home() { return performGlobalAction(GLOBAL_ACTION_HOME); }

    /**
     * 根窗口的**原始**包名（不把我们自己过滤掉）。
     * 2026-10-26：`phone_open_chat` 要记"主人是从哪个应用点过来的" ——
     * 如果人正看着「她」，正确答案就是**我们自己**，用 currentPackage() 会退回到
     * 上一次别人家的应用（比如刚用完的微信），于是"看完回到原应用"直接失效。
     */
    public String rootPackage() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return "";
            CharSequence p = root.getPackageName();
            return p == null ? "" : p.toString();
        } catch (Throwable e) {
            return "";
        }
    }

    public String currentPackage() {
        // 2026-10-25：先信"根窗口"，但**根窗口是我们自己时不算数**（浮窗就是这种），
        // 这时退回无障碍事件里记下来的前台包名（10 分钟内有效）。
        String rootPkg = "";
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) {
            CharSequence p = root.getPackageName();
            if (p != null) rootPkg = p.toString();
        }
        boolean rootUsable = !rootPkg.isEmpty() && !rootPkg.equals(getPackageName());
        long age = System.currentTimeMillis() - lastFgAt;
        String tracked = (lastFgPkg != null && !lastFgPkg.isEmpty() && age < 10 * 60 * 1000L) ? lastFgPkg : "";
        if (rootUsable) return rootPkg;
        if (!tracked.isEmpty()) return tracked;
        return rootPkg;
    }

    private DisplayMetrics metrics() {
        DisplayMetrics dm = new DisplayMetrics();
        try {
            WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm != null) wm.getDefaultDisplay().getRealMetrics(dm);
        } catch (Exception ignored) { }
        if (dm.widthPixels == 0) { dm.widthPixels = 1080; dm.heightPixels = 2400; }
        return dm;
    }

    // 给 Bridge 用的 JSON 汇总
    public JSONObject status() {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", true);
            o.put("pkg", currentPackage());
        } catch (Exception ignored) { }
        return o;
    }
}
