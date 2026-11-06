package com.dafeiyu.amadeus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * 让"她"浮在其他应用上面（2026-10-18 加）。
 *
 * 为什么：原来只有「打开这个 App」才能看见她，等于一个聊天软件。
 * 主人的参照是《命运石之门》里活在手机里的牧濑红莉栖 —— 那种感觉要求
 * **你用别的应用时她还在屏幕上**，而不是被切到后台。
 *
 * 实现：前台服务 + TYPE_APPLICATION_OVERLAY 窗口 + 一个透明 WebView，
 * 里面加载 /ui/float.html（复用同一个 Live2D 模型和同一个大脑接口）。
 * 窗口可拖动；点一下把主界面调出来；长按收起；
 * 右下角那个话筒按钮 = 直接说话（2026-10-20 加，不用切回主界面）。
 */
public class FloatService extends Service {

    private static final String CHANNEL = "amadeus_float";
    private static final int NOTIF_ID = 0x11;
    public static boolean running = false;
    private static volatile FloatService INSTANCE;

    private WindowManager wm;
    private WebView web;
    private WindowManager.LayoutParams lp;
    private View root;
    private String loadedBase="";
    private boolean pageFailed;
    private int pageGeneration;
    private boolean pageReady;
    private ServerConnections.Operation connectionSearch;
    private long lastRecoveryAt;
    private final android.os.Handler connectionUi=new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable connectionRetry=()->recover();

    public static void networkAvailable(){
        FloatService service=INSTANCE;if(service==null||service.web==null)return;
        service.web.post(()->{if(service.pageFailed)service.recover();else service.web.evaluateJavascript("window.HerConnection&&HerConnection.recheck()",null);});
    }
    private void recover(){connectionUi.post(()->{
        long now=android.os.SystemClock.elapsedRealtime();
        if(web==null||connectionSearch!=null||now-lastRecoveryAt<10000)return;
        lastRecoveryAt=now;pageFailed=true;
        connectionSearch=ServerConnections.find(getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE),result->connectionUi.post(()->{
            connectionSearch=null;if(web==null)return;
            if(result.ok&&result.endpoint!=null){
                getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE).edit().putString("server_last_working",result.endpoint.url).apply();
                reconnect(result.endpoint.url);
            }else if(!result.message.contains("配对信息已失效"))connectionUi.postDelayed(connectionRetry,20000);
        }));
    });}

    /** Follow the Activity's verified connection after an offline retry succeeds. */
    public static void reconnect(String base){
        FloatService service=INSTANCE;
        if(service==null||service.web==null)return;
        service.web.post(()->{
            ServerEndpoint endpoint=ServerEndpoint.parse(base);
            if(endpoint!=null&&(service.pageFailed||!endpoint.url.equals(service.loadedBase))){
                service.loadedBase=endpoint.url;service.pageFailed=false;
                service.web.loadUrl(endpoint.floatUrl());
            }
        });
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        startForegroundCompat();
        if (!Settings.canDrawOverlays(this)) {
            // 没权限就直接收工，主界面会提示去开
            stopSelf();
            return;
        }
        showOverlay();
        running = true;
        INSTANCE = this;
        wantShown = !MainActivity.VISIBLE;
        shown = true;                 // showOverlay 之后窗口是可见的，下面 sync 会按需藏起来
        syncVisibility();
        // 浮窗开着 = 她在场：开始听"大肥鱼"（关浮窗就停，主人 2026-10-20 定的范围）
        WakeWord.start(this, this::onWakeWord);
    }

    /** 听到"大肥鱼"：让页面开始录音说话（页面那边有 6 秒上限和"再点一下提前结束"）。 */
    private void onWakeWord() {
        WebView w = web;
        if (w == null) return;
        w.post(() -> {
            try { w.evaluateJavascript("window.__onWake && window.__onWake()", null); }
            catch (Throwable ignored) { }
        });
    }

    /** 前台服务（API 34 要声明类型，这里用 specialUse）。 */
    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "她浮在屏幕上", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setContentTitle("她还在屏幕上")
                .setContentText("点这里把对话打开")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pi)
                .setOngoing(true);
        // ⚠️ 麦克风类型不是随时能带的：Android 14 规定"后台被系统重启的前台服务"不能带
        //    microphone 类型，硬带会抛 SecurityException 把整个 App 打崩（2026-10-21 实测
        //    连崩三次）。所以这里分级：先试带麦克风的，失败就退回 specialUse；
        //    等主界面回到前台（onResume）或者用户点话筒时再补上。
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                        | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Throwable e) {
            android.util.Log.w("amadeus-float", "带麦克风类型起不来（多半是后台重启），退回 specialUse：" + e);
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                } else {
                    startForeground(NOTIF_ID, n);
                }
            } catch (Throwable ignored) { }
        }
    }

    /** App 回到前台 / 点话筒时调用：把麦克风类型补上（前台时才被允许）。 */
    public static void allowMic() {
        FloatService f = INSTANCE;
        if (f != null) {
            try { f.startForegroundCompat(); } catch (Throwable ignored) { }
        }
    }

    private void showOverlay() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setAlpha(1f);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebViewClient(new WebViewClient(){
            final PageRecovery recovery=new PageRecovery();
            @Override public boolean shouldOverrideUrlLoading(WebView view,android.webkit.WebResourceRequest request){return request.isForMainFrame()&&!PageOrigins.same(request.getUrl().toString(),loadedBase);}
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){
                recovery.start(url);pageReady=false;final int generation=++pageGeneration;
                connectionUi.postDelayed(()->{if(web!=null&&generation==pageGeneration&&!pageReady)recover();},90000);
                super.onPageStarted(view,url,icon);
            }
            private void retry(WebView view,String url){int ticket=recovery.failure(url);if(ticket>=0)pageFailed=true;if(ticket>0)view.postDelayed(()->{if(recovery.waiting(ticket))view.loadUrl(url);},1000);else if(ticket==0)connectionUi.postDelayed(connectionRetry,5000);}
            @Override public void onReceivedError(WebView view,android.webkit.WebResourceRequest request,android.webkit.WebResourceError error){if(request.isForMainFrame())retry(view,request.getUrl().toString());}
            @Override public void onReceivedHttpError(WebView view,android.webkit.WebResourceRequest request,android.webkit.WebResourceResponse response){if(request.isForMainFrame()&&PageRecovery.transientHttp(response.getStatusCode()))retry(view,request.getUrl().toString());}
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view,android.webkit.WebResourceRequest request){
                android.webkit.WebResourceResponse bundled=BundledAssets.intercept(FloatService.this,request.getUrl());
                return bundled!=null?bundled:super.shouldInterceptRequest(view,request);
            }
            @Override public void onPageFinished(WebView view,String url){
                view.evaluateJavascript("window.__herUiReady===true",value->{if("true".equals(value)&&url!=null&&url.equals(view.getUrl())){recovery.success();pageFailed=false;pageReady=true;}});
                if(url!=null&&url.contains("serveousercontent.com"))view.evaluateJavascript("(()=>{if(/Serveo/.test(document.title)){for(const el of document.querySelectorAll('button,a'))if(/continue to site/i.test(el.textContent)){el.click();break;}}})()",null);
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        // 浮窗自己的小桥：录音（说话）和开主界面；和主界面的 Bridge 是两套
        web.addJavascriptInterface(new FloatBridge(), "Android");

        MainActivity act = MainActivity.INSTANCE;
        android.content.SharedPreferences settings=getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE);
        String base = act != null ? act.activeServerUrl() : settings.getString("server_last_working",settings.getString(MainActivity.KEY_SERVER,""));
        if (base == null || base.isEmpty()) { stopSelf(); return; }
        // ⚠️ 不能直接 base + "/ui/float.html"：base 里带着 ?k=<令牌>，
        //   拼上去会变成 "?k=令牌/ui/float.html"，服务端把整串当令牌 → 404/401。
        String url = buildFloatUrl(base);
        ServerEndpoint endpoint=ServerEndpoint.parse(base);loadedBase=endpoint==null?base:endpoint.url;
        web.loadUrl(url);

        int px = (int) (getResources().getDisplayMetrics().density * 190);
        int py = (int) (getResources().getDisplayMetrics().density * 280);

        lp = new WindowManager.LayoutParams(
                px, py,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.format = PixelFormat.TRANSLUCENT;
        // 位置记忆（2026-10-21）：拖到哪儿下次就在哪儿
        android.content.SharedPreferences sp = getSharedPreferences("amadeus_float", MODE_PRIVATE);
        lp.x = sp.getInt("x", 0);
        lp.y = sp.getInt("y", (int) (getResources().getDisplayMetrics().density * 160));

        root = web;
        attachDragAndTap();
        wm.addView(web, lp);
    }

    /** 仅顶部中央把手拖动；模型点击和长按揉动交给页面。 */
    private void attachDragAndTap() {
        web.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            long downAt;
            boolean moved;
            boolean draggingHandle;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        startX = lp.x;
                        startY = lp.y;
                        downAt = System.currentTimeMillis();
                        moved = false;
                        float density = getResources().getDisplayMetrics().density;
                        draggingHandle = e.getY() <= 30 * density
                                && e.getX() >= 40 * density && e.getX() <= web.getWidth() - 40 * density;
                        return false;   // 让 WebView 也能收到（页面里要能点/滑动）
                    case MotionEvent.ACTION_MOVE:
                        if (!draggingHandle) return false;
                        float dx = e.getRawX() - downX;
                        float dy = e.getRawY() - downY;
                        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) moved = true;
                        if (moved) {
                            lp.x = startX + (int) dx;
                            lp.y = startY + (int) dy;
                            try { wm.updateViewLayout(web, lp); } catch (Throwable ignored) { }
                        }
                        return false;
                    case MotionEvent.ACTION_CANCEL:
                    case MotionEvent.ACTION_UP:
                        if (moved) saveFloatPos(lp.x, lp.y);
                        draggingHandle = false;
                        return false;
                }
                return false;
            }
        });
    }

    /** 把 base（可能带 ?k=…）变成一个合法的浮窗页面地址。 */
    private String buildFloatUrl(String base) {
        try {
            String b = base.startsWith("http") ? base : "http://" + base;
            java.net.URI u = java.net.URI.create(b);
            String q = u.getRawQuery() == null ? "" : "?" + u.getRawQuery();
            return u.getScheme() + "://" + u.getRawAuthority() + "/ui/float.html" + q;
        } catch (Throwable e) {
            // 兜底：硬剥掉问号后面的东西
            int q = base.indexOf('?');
            String head = q >= 0 ? base.substring(0, q) : base;
            String tail = q >= 0 ? base.substring(q) : "";
            if (head.endsWith("/")) head = head.substring(0, head.length() - 1);
            return head + "/ui/float.html" + tail;
        }
    }
    /** 浮窗页面的小桥：只做三件事 —— 录音、开主界面、关浮窗。 */
    private final class FloatBridge {
        @JavascriptInterface
        public void invoke(final String id, final String method, String argsJson) {
            final String m = method == null ? "" : method;
            new Thread(() -> {
                boolean ok = true;
                String out;
                try {
                    switch (m) {
                        case "modelLocal": out=new JSONObject().put("url",BundledAssets.MODEL).put("bundled",true).toString();break;
                        case "recover": out="{}";recover();break;
                        case "pageReady": {
                            final String readyUrl=new JSONObject(argsJson==null?"{}":argsJson).optString("url","");
                            connectionUi.post(()->{if(web!=null&&readyUrl.equals(web.getUrl())){pageReady=true;pageFailed=false;}});
                            out="{}";break;
                        }
                        case "setAlt": {
                            JSONObject a=new JSONObject(argsJson==null?"{}":argsJson);ServerEndpoint endpoint=ServerEndpoint.parse(a.optString("url",""));
                            if(endpoint!=null)getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE).edit().putString(MainActivity.KEY_ALT,endpoint.url).commit();out="{}";break;
                        }
                        case "setFallbacks": {
                            JSONObject a=new JSONObject(argsJson==null?"{}":argsJson);org.json.JSONArray urls=a.optJSONArray("urls"),valid=new org.json.JSONArray();
                            if(urls!=null)for(int i=0;i<Math.min(2,urls.length());i++){ServerEndpoint endpoint=ServerEndpoint.parse(urls.optString(i,""));if(endpoint!=null&&!endpoint.loopback())valid.put(endpoint.url);}
                            getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE).edit().putString("server_fallbacks",valid.toString()).commit();out="{}";break;
                        }
                        case "setStable": {
                            JSONObject a=new JSONObject(argsJson==null?"{}":argsJson);ServerConnections.saveStable(getSharedPreferences(MainActivity.PREFS,MODE_PRIVATE),a.optString("url",""));out="{}";break;
                        }
                        case "recStart":
                            WakeWord.pauseAll();          // 麦克风只有一个，先让她别听
                            allowMic();                   // 前台时把麦克风类型补上（后台重启时是没有的）
                            out = Recorder.start(FloatService.this, FloatService.this::onAutoStop);
                            break;
                        case "recStop":
                            out = Recorder.stop();
                            WakeWord.resumeAll();
                            break;
                        case "focusOn": setFocusable(true); out = "{}"; break;
                        case "focusOff": setFocusable(false); out = "{}"; break;
                        case "wakePause": WakeWord.pauseAll(); out = "{}"; break;
                        case "wakeResume": WakeWord.resumeAll(); out = "{}"; break;
                        case "tool": {
                            // 浮窗里也能读屏/点屏幕了（2026-10-21）：走和主界面同一套 PhoneTools
                            JSONObject a = new JSONObject(argsJson == null || argsJson.trim().isEmpty() ? "{}" : argsJson);
                            String name = a.optString("name", "");
                            JSONObject toolArgs = a.optJSONObject("args");
                            out = PhoneTools.run(FloatService.this, name,
                                    toolArgs == null ? new JSONObject() : toolArgs).toString();
                            break;
                        }
                        case "shizuku": {
                            JSONObject a = new JSONObject(argsJson == null || argsJson.trim().isEmpty() ? "{}" : argsJson);
                            out = ShizukuBridge.run(a.optString("command", ""));
                            break;
                        }
                        case "openApp": out = "{}"; openApp(); break;
                        case "close": out = "{}"; stopSelf(); break;
                        case "info": {
                            JSONObject o = new JSONObject();
                            o.put("running", running);
                            out = o.toString();
                            break;
                        }
                        default: ok = false; out = "{\"error\":\"unknown method\"}";
                    }
                } catch (Throwable e) {
                    ok = false;
                    out = "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
                }
                emitResult(id, ok, out);
            }, "amadeus-float-bridge").start();
        }
    }

    /** 录音自动停了（VAD）：把音频交给页面，走"发出去"那条路。 */
    private void onAutoStop(String json) {
        WakeWord.resumeAll();
        emitEvent("recAuto", json);
    }

    private void emitEvent(String type, String json) {
        WebView w = web;
        if (w == null) return;
        String js = "if(typeof window.__nativeEvent===\"function\") window.__nativeEvent(" + JSONObject.quote(type) + ","
                + JSONObject.quote(json == null ? "{}" : json) + ")";
        w.post(() -> { try { w.evaluateJavascript(js, null); } catch (Throwable ignored) { } });
    }

    private void emitResult(String id, boolean ok, String json) {
        if (web == null) return;
        String js = "if(typeof window.__nativeResult===\"function\") window.__nativeResult(" + JSONObject.quote(id == null ? "" : id) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(json == null ? "{}" : json) + ")";
        web.post(() -> { try { web.evaluateJavascript(js, null); } catch (Throwable ignored) { } });
    }

    /**
     * App 自己在前台时把浮窗藏起来（2026-10-21 主人要求：
     * "最小化窗口在应用里不要出现，只能出现在她这个应用外"）。
     * 用 View 的可见性而不是 removeView：窗口还在，只是不画、不挡触摸。
     */
    /** 浮窗服务是不是还活着（保活自检用） */
    public static boolean isRunning() {
        if (INSTANCE == null) return false;
        try { return INSTANCE.wantShown || INSTANCE.web != null; } catch (Throwable e) { return true; }
    }

    public static void setShown(boolean shown) {
        FloatService f = INSTANCE;
        if (f != null) f.applyShown(shown);
    }

    private volatile boolean shown = true;
    private volatile boolean wantShown = true;

    private void applyShown(boolean want) {
        wantShown = want;
        syncVisibility();
    }

    /** 真正显示的条件：她想露脸 && **主界面不在前台**（主人在 App 里就不用叠一层）。 */
    private void syncVisibility() {
        boolean vis = wantShown && !MainActivity.VISIBLE;
        if (vis == shown) return;
        shown = vis;
        WebView w = web;
        if (w == null) return;
        w.post(() -> {
            try { w.setVisibility(vis ? View.VISIBLE : View.INVISIBLE); } catch (Throwable ignored) { }
        });
    }

    /**
     * 浮窗默认是 FLAG_NOT_FOCUSABLE（不抢输入焦点，不然别的 App 打不了字）。
     * 但"在浮窗里打字"必须临时变成可聚焦 + 弹出输入法，发完再改回去。
     */
    private void setFocusable(boolean on) {
        if (lp == null || web == null) return;
        if(android.os.Looper.myLooper()!=android.os.Looper.getMainLooper()){
            web.post(()->setFocusable(on));return;
        }
        int flags = WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        if (!on) flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        lp.flags = flags;
        try { wm.updateViewLayout(web, lp); } catch (Throwable ignored) { }
        try {
            android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (on) {
                web.requestFocus();
                if (imm != null) imm.showSoftInput(web, android.view.inputmethod.InputMethodManager.SHOW_FORCED);
            } else {
                if (imm != null) imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
            }
        } catch (Throwable ignored) { }
    }

    private void saveFloatPos(int x, int y) {
        try {
            getSharedPreferences("amadeus_float", MODE_PRIVATE).edit()
                    .putInt("x", x).putInt("y", y).apply();
        } catch (Throwable ignored) { }
    }

    private void openApp() {        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        } catch (Throwable ignored) { }
    }

    @Override
    public void onDestroy() {
        connectionUi.removeCallbacks(connectionRetry);if(connectionSearch!=null)connectionSearch.cancel();
        running = false;
        INSTANCE = null;
        WakeWord.stopAll();
        try {
            if (web != null && wm != null) wm.removeView(web);
        } catch (Throwable ignored) { }
        try { if (web != null) web.destroy(); } catch (Throwable ignored) { }
        web = null;
        super.onDestroy();
    }
}
