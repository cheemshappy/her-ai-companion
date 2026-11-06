package com.dafeiyu.amadeus;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Button;
import android.view.Gravity;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

public class MainActivity extends Activity {

    public static final String PREFS = "amadeus";
    public static final String KEY_SERVER = "server";
    /** 备用地址（2026-10-18）：在家走热点/局域网，出门走公网隧道，自动二选一。 */
    public static final String KEY_ALT = "server_alt";
    public static final String DEFAULT_SERVER = "10.115.199.36:8790";

    private WebView web;
    private FrameLayout root;
    private View connectionPanel;
    private TextView connectionTitle, connectionStatus;
    private Button retryButton;
    private final ConnectionAttempt connectionAttempt = new ConnectionAttempt();
    private boolean connectionVisible;
    private boolean awaitingPageReady;
    private boolean editingConnection;
    private int offlineFailures;
    private long lastRecoveryAt;
    private ServerConnections.Operation routeSearch;
    private android.net.ConnectivityManager connectivity;
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private final Runnable automaticRetry=()->{if(connectionVisible&&VISIBLE&&!editingConnection&&!awaitingPageReady&&!connectionAttempt.busy())loadServer();};
    private int navigationGeneration;
    private Bridge bridge;
    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 当前验证可用的主/备地址；浮窗在恢复后跟随它。 */
    private volatile String activeUrl = "";

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private SpeechRecognizer sr;
    private volatile String pendingSttId = null;
    private volatile String pendingTtsId = null;
    private int tunnelRetry = 0;
    private final PageRecovery pageRecovery = new PageRecovery();
    /** 供 FloatService 拿服务器地址/上下文用（浮窗活在 Activity 之外）。 */
    public static volatile MainActivity INSTANCE = null;
    /** 主界面是不是真的在前台（浮窗靠它决定要不要露脸）。 */
    public static volatile boolean VISIBLE = false;
    private LocalModelServer localModel;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            if (KeepAliveJob.enabled(this)) KeepAliveJob.schedule(this);
        } catch (Throwable ignored) { }
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        INSTANCE = this;
        // 「她主动说话」的后台轮询：开机/打开 App 就起步（通知监听没开也能收简报）
        Proactive.ensurePoller(this);
        // 允许 adb 直接指定服务器地址：
        //   adb shell am start -n com.dafeiyu.amadeus/.MainActivity -e server 10.0.0.5:8790
        Intent launch = getIntent();
        if (launch != null) {
            String fromIntent = launch.getStringExtra("server");
            if (fromIntent != null && !fromIntent.trim().isEmpty()) {
                prefs.edit().putString(KEY_SERVER, fromIntent.trim()).apply();
            }
        }
        // 调试：喂一段音频给唤醒词模型，看认不认得出（-e wakeTest 1）
        if (launch != null && launch.getStringExtra("wakeTest") != null) {
            WakeWord.testAsset(this);
        }
        // 2026-10-22 主人要求还原锁屏：不再常亮（原来开着 App 屏幕永不熄，等于锁不了屏）
        getWindow().setStatusBarColor(Color.parseColor("#070B14"));
        getWindow().setNavigationBarColor(Color.parseColor("#070B14"));
        goFullscreen();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#070B14"));
        setContentView(root);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setBackgroundColor(Color.parseColor("#070B14"));
        // 页面里要用 MediaRecorder 录音（录音→传电脑转写，替代不靠谱的系统识别）
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                ui.post(() -> {
                    try {
                        for (String r : request.getResources()) {
                            if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                                request.grant(new String[]{r});
                                return;
                            }
                        }
                        request.deny();
                    } catch (Throwable ignored) { }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,android.webkit.WebResourceRequest request){return request.isForMainFrame()&&!PageOrigins.same(request.getUrl().toString(),activeServerUrl());}
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){pageRecovery.start(url);super.onPageStarted(view,url,icon);}
            private void failed(WebView view,String url,String reason){
                int ticket=pageRecovery.failure(url);
                if(ticket<0)return;
                if(ticket>0){ui.postDelayed(()->{if(pageRecovery.waiting(ticket))view.loadUrl(url);},1000);return;}
                showOffline(reason);
            }
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view,android.webkit.WebResourceRequest request){
                android.webkit.WebResourceResponse bundled=BundledAssets.intercept(MainActivity.this,request.getUrl());
                return bundled!=null?bundled:super.shouldInterceptRequest(view,request);
            }
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest req,
                                        android.webkit.WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    failed(view,req.getUrl().toString(),err == null ? "" : String.valueOf(err.getDescription()));
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int code, String desc, String url) {
                failed(view,url,desc);
            }
            @Override public void onReceivedHttpError(WebView view,android.webkit.WebResourceRequest req,android.webkit.WebResourceResponse response){
                if(req.isForMainFrame()&&PageRecovery.transientHttp(response.getStatusCode()))failed(view,req.getUrl().toString(),"连接暂时不可用（"+response.getStatusCode()+"）");
            }

            /**
             * 免费隧道（serveo）有两道坎，全在这里替用户处理掉：
             *  1) "Serveo Browser Warning" 页 → 自动点 "Continue to Site"；
             *  2) 点完会被重定向到**去掉 ?k= 的地址** → 我们的服务返回 401「需要配对链接」
             *     → 这时用带令牌的地址再载入一次（此时隧道 cookie 已在，不会再弹警告）。
             */
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if(url!=null&&url.equals(activeUrl))view.evaluateJavascript("window.__herUiReady===true",value->{if("true".equals(value))pageReady(url);});
                if (url == null || !url.contains("serveousercontent.com")) return;
                view.evaluateJavascript(
                    "(function(){try{var t=document.title||'';"
                    + "if(t.indexOf('Serveo')>=0){var els=document.querySelectorAll('button,a');"
                    + "for(var i=0;i<els.length;i++){var x=(els[i].innerText||els[i].textContent||'').trim();"
                    + "if(/continue to site/i.test(x)){els[i].click();return 'clicked';}}return 'warn';}"
                    + "return (t.indexOf('她')>=0)?'ok':'notours';}catch(e){return 'err';}})()",
                    value -> {
                        if (value == null) return;
                        if (value.contains("notours") && tunnelRetry < 2) {
                            tunnelRetry++;
                            // 用"这次真正在用的地址"重来（可能已经是备用/隧道那条）
                            String target = activeUrl != null && activeUrl.startsWith("http") ? activeUrl : serverUrl();
                            if (target != null && target.startsWith("http")) view.loadUrl(target);
                        }
                    });
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "Android");
        // 允许电脑用 chrome://inspect / CDP 直接调试手机里的页面
        // （adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>）
        try { WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0); } catch (Throwable ignored) { }

        // 把打包在 APK 里的 Live2D 模型用小HTTP服务喂给页面（隧道下载不动 2MB 的 moc3）
        try {
            localModel = new LocalModelServer(getAssets());
            if (localModel.hasBundledModel()) localModel.start();
        } catch (Throwable ignored) { }

        initTts();
        requestNotifPermission();
        watchNetwork();
        loadServer();
    }

    private void goFullscreen() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
    }

    // ────────────────────────────── 加载 / 设置地址 ──────────────────────────
    public String serverUrl() { return prefs.getString(KEY_SERVER, ""); }
    public String activeServerUrl(){return activeUrl!=null&&!activeUrl.isEmpty()?activeUrl:serverUrl();}
    public boolean connectionChecking(){return connectionAttempt.busy();}
    public org.json.JSONArray connectionDiagnostics(){return routeSearch==null?new org.json.JSONArray():routeSearch.diagnostics();}

    /** 备用地址（公网隧道）。页面连上后会通过 /api/tunnel 自动把它更新成最新地址。 */
    public String altUrl() { return prefs.getString(KEY_ALT, ""); }

    public void setAlt(String url) {
        if (url == null || url.trim().isEmpty()) return;
        // ⚠️ commit() 而不是 apply()：紧接着可能就要用它
        prefs.edit().putString(KEY_ALT, url.trim()).commit();
    }
    public void setFallbacks(org.json.JSONArray urls){
        org.json.JSONArray valid=new org.json.JSONArray();if(urls!=null)for(int i=0;i<Math.min(2,urls.length());i++){
            ServerEndpoint endpoint=ServerEndpoint.parse(urls.optString(i,""));if(endpoint!=null&&!endpoint.loopback())valid.put(endpoint.url);
        }prefs.edit().putString("server_fallbacks",valid.toString()).commit();
    }

    /** 本地模型服务的 model3.json 地址；没有打包模型就返回空。 */
    public String localModelUrl() {
        try {
            if (localModel == null || !localModel.hasBundledModel()) return "";
            return localModel.baseUrl() + "model/deepseek-chan/大肥鱼.model3.json";
        } catch (Throwable e) { return ""; }
    }

    /** Native recovery is available even when the WebView document never loads. */
    public void loadServer() {
        if(Looper.myLooper()!=Looper.getMainLooper()){ui.post(this::loadServer);return;}
        final int ticket=connectionAttempt.begin();
        if(ticket==0)return;
        ui.removeCallbacks(automaticRetry);
        if(routeSearch!=null)routeSearch.cancel();
        final int navigation=++navigationGeneration;
        awaitingPageReady=false;
        web.stopLoading();pageRecovery.reset();
        final String primary = serverUrl();
        if (ServerConnections.saved(prefs).isEmpty()) { connectionAttempt.finish(ticket);showOffline("还没有设置可用的电脑连接地址");showServerDialog();return; }
        showConnectionPanel(true,"正在同时检查本地和远程连接…");
        ui.postDelayed(()->{if(connectionAttempt.current(ticket)){
            connectionAttempt.cancel();if(routeSearch!=null)routeSearch.cancel();showOffline("连接等待超时，会自动重试；也可以更新地址。");
        }},ConnectionPolicy.ATTEMPT_MS+1500);
        routeSearch=ServerConnections.find(prefs,result->{
            final ServerEndpoint endpoint=result.endpoint;
            ui.post(() -> {
                if(!connectionAttempt.finish(ticket)||isFinishing()||isDestroyed())return;
                if(!result.ok||endpoint==null){showOffline(result.message);return;}
                activeUrl=endpoint.url;tunnelRetry=0;
                offlineFailures=0;ui.removeCallbacks(automaticRetry);
                connectionStatus.setText("连接已找到，正在打开她…");
                prefs.edit().putString("server_last_working",activeUrl).apply();
                FloatService.reconnect(activeUrl);
                awaitingPageReady=true;web.loadUrl(activeUrl);
                // Slow resources may still be loading. Offer manual retry without truncating the parser.
                ui.postDelayed(()->{
                    if(navigation==navigationGeneration&&connectionVisible&&activeUrl.equals(endpoint.url)&&retryButton!=null&&!retryButton.isEnabled()){
                        connectionStatus.setText("远程网络较慢，仍在加载；也可以点击重新连接。");
                        retryButton.setEnabled(true);retryButton.setAlpha(1f);retryButton.setText("重新连接");
                    }
                },30000);
                ui.postDelayed(()->{if(navigation==navigationGeneration&&connectionVisible&&activeUrl.equals(endpoint.url)&&!editingConnection)showOffline("界面没有完整加载，会自动重新连接。");},90000);
            });
        });
    }

    /** API-only outages never produce a WebView load error; pages report them here. */
    public void recoverConnection(){ui.post(()->{
        long now=android.os.SystemClock.elapsedRealtime();
        if(editingConnection||now-lastRecoveryAt<10000)return;
        lastRecoveryAt=now;loadServer();
    });}
    private void watchNetwork(){
        try{
            connectivity=(android.net.ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
            networkCallback=new android.net.ConnectivityManager.NetworkCallback(){
                @Override public void onAvailable(android.net.Network network){ui.postDelayed(()->{
                    if(isFinishing()||isDestroyed()||editingConnection)return;
                    if(connectionVisible&&VISIBLE&&!awaitingPageReady)recoverConnection();
                    else if(VISIBLE)web.evaluateJavascript("window.HerConnection&&HerConnection.recheck()",null);
                    FloatService.networkAvailable();
                },900);}
            };
            connectivity.registerDefaultNetworkCallback(networkCallback);
        }catch(Exception ignored){}
    }

    public void reload() { loadServer(); }
    public void pageReady(String url){ui.post(()->{
        if(!awaitingPageReady||connectionAttempt.busy()||editingConnection||url==null||!url.equals(activeUrl)||!url.equals(web.getUrl()))return;
        awaitingPageReady=false;pageRecovery.success();hideConnectionPanel();FloatService.reconnect(activeUrl);
    });}
    public void setServer(String value){
        ui.post(()->{
            navigationGeneration++;connectionAttempt.cancel();pageRecovery.reset();
            if(routeSearch!=null)routeSearch.cancel();offlineFailures=0;
            prefs.edit().putString(KEY_SERVER,value.trim()).commit();loadServer();
        });
    }

    /** Native controls do not depend on JavaScript, page origin, or a failed navigation. */
    public void showOffline(String reason) {
        if(Looper.myLooper()!=Looper.getMainLooper()){ui.post(()->showOffline(reason));return;}
        awaitingPageReady=false;
        // Raw WebView errors may contain a paired URL. Only native explanatory text is shown.
        String message=reason!=null&&!reason.contains("http")&&!reason.contains("net::")?reason:"网络连接中断，可以重新尝试或更新地址。";
        showConnectionPanel(false,message);
        ui.removeCallbacks(automaticRetry);
        if(!editingConnection&&!message.contains("配对信息已失效")&&!message.contains("格式不正确")){
            offlineFailures++;ui.postDelayed(automaticRetry,ConnectionPolicy.retryDelay(offlineFailures));
        }
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private TextView connectionText(String text,int size,int color){
        TextView view=new TextView(this);view.setText(text);view.setTextSize(size);view.setTextColor(color);view.setGravity(Gravity.CENTER);view.setPadding(0,dp(10),0,dp(10));return view;
    }
    private void showConnectionPanel(boolean checking,String message){
        if(connectionPanel==null){
            ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.parseColor("#070B14"));
            LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setGravity(Gravity.CENTER);content.setPadding(dp(28),dp(40),dp(28),dp(40));
            scroll.addView(content,new ScrollView.LayoutParams(-1,-1));
            connectionTitle=connectionText("",24,Color.parseColor("#eaf2ff"));content.addView(connectionTitle);
            connectionStatus=connectionText("",16,Color.parseColor("#a4b6cb"));content.addView(connectionStatus);
            TextView hint=connectionText("",14,Color.parseColor("#8ba0bd"));hint.setTag("connection-hint");content.addView(hint);
            retryButton=new Button(this);retryButton.setText("重新连接");retryButton.setTextColor(Color.parseColor("#06121f"));
            android.graphics.drawable.GradientDrawable bg=new android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR,new int[]{0xff2f8fff,0xff56d0ff});bg.setCornerRadius(dp(28));retryButton.setBackground(bg);
            LinearLayout.LayoutParams buttonLayout=new LinearLayout.LayoutParams(dp(190),dp(54));buttonLayout.topMargin=dp(24);buttonLayout.bottomMargin=dp(12);content.addView(retryButton,buttonLayout);
            retryButton.setOnClickListener(v->loadServer());
            Button change=new Button(this);change.setText("更新连接地址");change.setTextColor(0xffb5c9df);change.setBackgroundColor(Color.TRANSPARENT);change.setOnClickListener(v->showServerDialog());content.addView(change,new LinearLayout.LayoutParams(-2,dp(52)));
            TextView addresses=connectionText("",12,0xff6f849c);addresses.setTag("connection-addresses");content.addView(addresses);
            connectionPanel=scroll;root.addView(scroll,new FrameLayout.LayoutParams(-1,-1));
        }
        connectionVisible=true;connectionPanel.setVisibility(View.VISIBLE);connectionPanel.bringToFront();web.setVisibility(View.VISIBLE);
        connectionTitle.setText(checking?"正在重新连接":"暂时连不上电脑上的我");connectionStatus.setText(message);
        retryButton.setEnabled(!checking);retryButton.setAlpha(checking?.65f:1f);retryButton.setText(checking?"正在连接…":"重新连接");
        TextView hint=connectionPanel.findViewWithTag("connection-hint");
        ServerEndpoint primary=ServerEndpoint.parse(serverUrl());
        hint.setText(primary!=null&&primary.loopback()?"USB 连接只在手机连着电脑时可用。拔线后会尝试备用网络连接。\n电脑需要保持开机和联网。":"请保持电脑开机和联网；备用网络地址可能会随电脑重启而变化。");
        TextView addresses=connectionPanel.findViewWithTag("connection-addresses");
        addresses.setText("电脑连接："+ServerEndpoint.display(serverUrl())+"\n备用连接："+ServerEndpoint.display(altUrl()));
    }
    private void hideConnectionPanel(){
        ui.removeCallbacks(automaticRetry);offlineFailures=0;
        connectionVisible=false;web.setVisibility(View.VISIBLE);if(connectionPanel!=null)connectionPanel.setVisibility(View.GONE);
    }

    public void showServerDialog() {
        if(Looper.myLooper()!=Looper.getMainLooper()){ui.post(this::showServerDialog);return;}
        navigationGeneration++;connectionAttempt.cancel();pageRecovery.reset();web.stopLoading();
        editingConnection=true;ui.removeCallbacks(automaticRetry);if(routeSearch!=null)routeSearch.cancel();
        if(connectionVisible)showConnectionPanel(false,"请填入电脑上当前可用的配对地址。");
        EditText et = new EditText(this);
        et.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        et.setHint("IP:端口，例如 " + DEFAULT_SERVER);
        String cur = serverUrl();
        et.setText(cur == null ? "" : cur.replace("http://", ""));
        et.setSelectAllOnFocus(true);

        new AlertDialog.Builder(this)
                .setTitle("电脑地址")
                .setMessage("填入电脑上当前的配对地址（保留完整链接）。\nUSB地址只在连着电脑时可用；公网地址可用于离开电脑后的连接。")
                .setView(et)
                .setPositiveButton("连接", (d, w) -> {
                    String v = et.getText().toString().trim();
                    if (v.isEmpty()) return;
                    editingConnection=false;offlineFailures=0;
                    connectionAttempt.cancel();prefs.edit().putString(KEY_SERVER, v).commit();
                    loadServer();
                })
                .setNegativeButton("取消", (d,w)->{editingConnection=false;if(connectionVisible)showOffline("可以重新连接，或稍后更新配对地址。");})
                .setOnCancelListener(d->{editingConnection=false;if(connectionVisible)showOffline("可以重新连接，或稍后更新配对地址。");})
                .show();
    }

    // ────────────────────────────── TTS ─────────────────────────────────────
    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {
                        emitEvent("speechStart", "{}");
                    }
                    @Override public void onDone(String id) {
                        emitEvent("speechEnd", "{}");
                        finishTts(id);
                    }
                    @Override public void onError(String id) {
                        emitEvent("speechEnd", "{}");
                        finishTts(id);
                    }
                });
            }
        });
    }

    private void finishTts(String uttId) {
        String target = bridge.takeTtsUtterance(uttId);
        if (target != null) bridge.emitResult(target, true, "{}");
    }

    public void speak(String id, String text) {
        if (text == null) text = "";
        text = text.trim();
        if (!ttsReady) { bridge.emitResult(id, true, "{\"skipped\":true}"); return; }
        String utt = "u" + System.currentTimeMillis();
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        bridge.bindTtsUtterance(utt, id);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utt);
    }

    public void stopTts() { if (tts != null) tts.stop(); }

    /**
     * 后台简报：让页面把她说的这句话显示出来（气泡 + 对话记录）。
     * 声音是 Proactive 那边直接播的 mp3，这里**不再出声**，否则会念两遍。
     */
    /** 把"消息清单"推给页面，让它在界面里画成卡片（2026-10-22） */
    public void showDigest(String itemsJson) {
        if (web == null || itemsJson == null) return;
        final String js = "window.__showDigest && window.__showDigest(" + itemsJson + ");";
        runOnUiThread(() -> {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignored) { }
        });
    }

    public void herSay(String text) {
        if (web == null || text == null || text.trim().isEmpty()) return;
        final String js = "window.__herSay && window.__herSay(" + org.json.JSONObject.quote(text) + ");";
        runOnUiThread(() -> {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignored) { }
        });
    }

    // ────────────────────────────── STT ─────────────────────────────────────
    /**
     * 语音输入三层兜底（2026-10-20）：
     *   ① 应用内 SpeechRecognizer（**单例复用**，不再每次 destroy+create ——
     *      HyperOS 上那样会立刻返回 ERROR_CLIENT，实测 code=5）
     *   ② ERROR_CLIENT 时延迟 400ms 重建一次再试
     *   ③ 还不行就拉**系统语音输入弹窗**（ACTION_RECOGNIZE_SPEECH 走 Activity），
     *      用小米自己的识别服务 —— 这条几乎总能出字
     */
    private static final int REQ_STT_DIALOG = 2201;
    private int sttAttempt = 0;

    public void listen(String id) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1001);
            bridge.emitResult(id, false, "{\"error\":\"没给麦克风权限，再说一次试试\"}");
            return;
        }
        pendingSttId = id;
        sttAttempt = 0;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            startSystemSttDialog();
            return;
        }
        ui.post(() -> startLocalStt());
    }

    private void startLocalStt() {
        try {
            if (sr == null) {
                sr = SpeechRecognizer.createSpeechRecognizer(this);
                sr.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle b) { }
                    @Override public void onBeginningOfSpeech() { }
                    @Override public void onRmsChanged(float v) { }
                    @Override public void onBufferReceived(byte[] b) { }
                    @Override public void onEndOfSpeech() { }
                    @Override public void onError(int code) {
                        // 5 = ERROR_CLIENT：最常见就是"刚刚重建过识别器"，重试一次再说
                        if (code == 5 && sttAttempt == 0) {
                            sttAttempt = 1;
                            ui.postDelayed(() -> {
                                try { if (sr != null) { sr.destroy(); sr = null; } } catch (Throwable ignored) { }
                                startLocalStt();
                            }, 400);
                            return;
                        }
                        // 别的错误直接交给系统弹窗兜底
                        ui.postDelayed(MainActivity.this::startSystemSttDialog, 200);
                    }
                    @Override public void onResults(Bundle results) {
                        String pid = pendingSttId; pendingSttId = null;
                        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        String text = (list != null && !list.isEmpty()) ? list.get(0) : "";
                        if (pid != null) bridge.emitResult(pid, true, jsonText(text));
                    }
                    @Override public void onPartialResults(Bundle b) { }
                    @Override public void onEvent(int t, Bundle b) { }
                });
            }
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            sr.startListening(i);
        } catch (Exception e) {
            startSystemSttDialog();
        }
    }

    /** 兜底：系统语音输入弹窗（小米自带的识别）。 */
    private void startSystemSttDialog() {
        try {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            startActivityForResult(i, REQ_STT_DIALOG);
        } catch (Exception e) {
            String pid = pendingSttId; pendingSttId = null;
            if (pid != null) bridge.emitResult(pid, false, "{\"error\":" + JSONObject.quote("语音输入不可用：" + e.getMessage()) + "}");
        }
    }

    // ────────────── 原生录音（2026-10-20）─────────────────────────────
    /**
     * 为什么要原生：页面跑在 http://192.168.137.1:8790，**不是安全来源**，
     * WebView 里 navigator.mediaDevices 直接是 undefined，getUserMedia 根本调不到。
     * 所以录音放原生做，录完把字节 base64 交给页面，页面再 POST /api/asr。
     */

    private static final int REQ_CAPTURE = 7788;
    private int captureSeconds = 6;
    private int captureChunk = 12;
    private boolean listenPending = false;

    /**
     * 录应用内声音（2026-10-22）。顺序**不能反**：
     * Android 14 要求 mediaProjection 类型的前台服务在**拿到用户授权之后**才能起，
     * 先起服务会被 SecurityException 打死（实测：requires ... project_media）。
     * 所以这里只请求授权，真正的 startForegroundService 放在 onActivityResult 里。
     */
    /** 连续「听」：on=true 开始（没授权就先弹框），on=false 停。 */
    public void capListen(boolean on, int chunkSec) {
        captureChunk = Math.max(4, Math.min(chunkSec, 60));
        if (!on) {
            CaptureService svc = CaptureService.get();
            if (svc != null) svc.stopContinuous();
            CaptureService.shutdown();
            return;
        }
        listenPending = true;
        if (CaptureService.hasProjection() && CaptureService.get() != null) {
            CaptureService.get().startContinuous(captureChunk);
            return;
        }
        try {
            android.media.projection.MediaProjectionManager mpm =
                    (android.media.projection.MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
        } catch (Throwable e) {
            toast("听音频起不来：" + e.getMessage());
        }
    }

    public void startCapture(int seconds) {
        captureSeconds = Math.max(1, Math.min(seconds, 30));
        // 已经授权过 → 直接再录一段，不用再弹框
        if (CaptureService.hasProjection() && CaptureService.get() != null) {
            CaptureService.get().startAgain(captureSeconds);
            return;
        }
        try {
            android.media.projection.MediaProjectionManager mpm =
                    (android.media.projection.MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
        } catch (Throwable e) {
            toast("内录起不来：" + e.getMessage());
        }
    }

    public void recStart(String id) {
        try {
            // 浮窗开着时她在听唤醒词 —— 录音前先让她闭嘴（麦克风只有一个）
            WakeWord.pauseAll();
            bridge.emitResult(id, true, Recorder.start(this, json -> emitEvent("recAuto", json)));
        } catch (Throwable e) {
            bridge.emitResult(id, false, "{\"error\":" + JSONObject.quote("录音启动失败：" + e.getMessage()) + "}");
        }
    }

    public void recStop(String id) {
        try {
            bridge.emitResult(id, true, Recorder.stop());
        } catch (Throwable e) {
            bridge.emitResult(id, false, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        } finally {
            WakeWord.resumeAll();
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_CAPTURE) {
            if (res == RESULT_OK && data != null) {
                CaptureService.pendingCode = res;
                CaptureService.pendingData = data;
                CaptureService.pendingContinuous = listenPending;
                CaptureService.pendingSeconds = listenPending ? captureChunk : captureSeconds;
                try { startForegroundService(new Intent(this, CaptureService.class)); }
                catch (Throwable e) { toast("录制服务起不来：" + e.getMessage()); }
            } else {
                toast("没给录制权限");
            }
            listenPending = false;
            return;
        }
        if (req == REQ_STT_DIALOG) {
            String pid = pendingSttId; pendingSttId = null;
            if (pid == null) return;
            String text = "";
            try {
                if (res == RESULT_OK && data != null) {
                    ArrayList<String> list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                    if (list != null && !list.isEmpty()) text = list.get(0);
                }
            } catch (Throwable ignored) { }
            bridge.emitResult(pid, true, jsonText(text));
            return;
        }
        super.onActivityResult(req, res, data);
    }

    private static String jsonText(String t) {
        return "{\"text\":" + JSONObject.quote(t == null ? "" : t) + "}";
    }

    // ────────────────────────────── 杂项 ────────────────────────────────────
    private void requestNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1002);
            }
        }
    }

    public void emitEvent(String type, String json) {
        if (web == null) return;
        String js = "if(typeof window.__nativeEvent===\"function\") window.__nativeEvent(" + JSONObject.quote(type) + "," + JSONObject.quote(json == null ? "{}" : json) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    public void toast(String s) { ui.post(() -> android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()); }

    /**
     * 无障碍服务现在到底开没开？
     * 用的是系统侧的启用列表（而不是"服务实例在不在"），免得进程刚起来时误报。
     * 2026-10-18 实测：正常升版本更新**不会**让无障碍掉（v1→v2→v3 三次验证），
     * 但被系统/安全中心手动关掉是可能的，所以每次回到前台都自检一次，前端会亮横幅。
     */
    public boolean a11yEnabled() {
        try {
            android.view.accessibility.AccessibilityManager am =
                    (android.view.accessibility.AccessibilityManager) getSystemService(ACCESSIBILITY_SERVICE);
            if (am == null) return false;
            java.util.List<android.accessibilityservice.AccessibilityServiceInfo> list =
                    am.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            for (android.accessibilityservice.AccessibilityServiceInfo info : list) {
                android.content.pm.ResolveInfo ri = info.getResolveInfo();
                if (ri != null && ri.serviceInfo != null && getPackageName().equals(ri.serviceInfo.packageName)) return true;
            }
        } catch (Throwable ignored) { }
        return false;
    }

    public void reportA11y() {
        emitEvent("a11y", "{\"enabled\":" + (a11yEnabled() ? "true" : "false") + "}");
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从系统设置回来时刷新一下
        ui.postDelayed(this::reportA11y, 400);
        // 主人 2026-10-21 要求：App 自己在前面时**不要**出现浮窗；
        // 顺便把唤醒词也停掉（她在 App 里用话筒说话，别让"大肥鱼"再抢麦克风）
        VISIBLE = true;
        if(connectionVisible&&!editingConnection&&!awaitingPageReady)ui.postDelayed(automaticRetry,500);
        FloatService.allowMic();       // 回到前台才能补上"麦克风"前台服务类型
        FloatService.setShown(false);
        WakeWord.pauseAll();
    }

    @Override
    protected void onPause() {
        super.onPause();
        VISIBLE = false;
        ui.removeCallbacks(automaticRetry);
        FloatService.setShown(true);
        WakeWord.resumeAll();
    }

    /**
     * 应用已经在前台时，再用 `adb shell am start -e server <url>` 也能改地址
     * （singleTask 下只会走 onNewIntent，不会再调 onCreate）。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null) {
            String fromIntent = intent.getStringExtra("server");
            if (fromIntent != null && !fromIntent.trim().isEmpty()) {
                setServer(fromIntent);
            }
        }
    }

    @Override
    public void onBackPressed() {
        emitEvent("back", "{}");
    }

    @Override
    protected void onDestroy() {
        navigationGeneration++;connectionAttempt.cancel();pageRecovery.reset();
        ui.removeCallbacks(automaticRetry);if(routeSearch!=null)routeSearch.cancel();
        try{if(connectivity!=null&&networkCallback!=null)connectivity.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}
        if (INSTANCE == this) INSTANCE = null;
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignored) { }
        try { if (sr != null) sr.destroy(); } catch (Exception ignored) { }
        super.onDestroy();
    }
}
