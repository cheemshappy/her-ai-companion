package com.dafeiyu.amadeus;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Rect;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.media.session.MediaSessionManager;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.content.ComponentName;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** App intents + visible controls + playback verification, shared by both UIs. */
public final class BiliTools {
    static final String PKG="tv.danmaku.bili";
    static final class Snapshot {
        final List<AccessibilityNodeInfo> nativeNodes=new ArrayList<>();
        final List<BiliUi.Node> nodes=new ArrayList<>();
        int width,height;String searchState="loading";
    }
    static Snapshot snapshot(Context ctx,CtrlService cs){
        Snapshot out=new Snapshot();DisplayMetrics dm=new DisplayMetrics();
        ((WindowManager)ctx.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
        out.width=dm.widthPixels;out.height=dm.heightPixels;
        if(cs!=null)try{
            AccessibilityNodeInfo root=cs.getRootInActiveWindow();
            if(root!=null){root.refresh();Rect r=new Rect();root.getBoundsInScreen(r);
                if(r.width()>0&&r.height()>0){out.width=r.width();out.height=r.height();}
                capture(root,-1,out,0);
            }
        }catch(Throwable ignored){}
        return out;
    }
    static void capture(AccessibilityNodeInfo node,int parent,Snapshot out,int depth){
        if(node==null||depth>30||out.nodes.size()>=1200)return;
        Rect r=new Rect();node.getBoundsInScreen(r);int index=out.nodes.size();
        out.nativeNodes.add(node);
        out.nodes.add(new BiliUi.Node(node.getViewIdResourceName(),node.getText()==null?"":node.getText().toString(),node.getContentDescription()==null?"":node.getContentDescription().toString(),String.valueOf(node.getClassName()),r.left,r.top,r.right,r.bottom,parent,node.isVisibleToUser(),node.isEditable()));
        for(int i=0;i<node.getChildCount();i++)capture(node.getChild(i),index,out,depth+1);
    }
    static boolean foreground(CtrlService cs){return cs!=null&&PKG.equals(cs.rootPackage());}
    static boolean click(CtrlService cs,AccessibilityNodeInfo node){
        try{node.refresh();}catch(Throwable ignored){}
        if(node.isClickable()&&node.performAction(AccessibilityNodeInfo.ACTION_CLICK))return true;
        Rect r=new Rect();node.getBoundsInScreen(r);return r.width()>0&&r.height()>0&&cs.tapXY(r.centerX(),r.centerY());
    }
    static void launch(Context ctx,String url){ctx.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)).setPackage(PKG).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP));}
    static boolean waitApp(CtrlService cs)throws Exception{for(int i=0;i<120;i++){if(foreground(cs))return true;Thread.sleep(100);}return false;}
    static Snapshot waitSearch(Context ctx,CtrlService cs,String query)throws Exception{
        BiliUi.SearchWait wait=new BiliUi.SearchWait();long deadline=android.os.SystemClock.elapsedRealtime()+12000;
        while(android.os.SystemClock.elapsedRealtime()<deadline){
            boolean active=foreground(cs);Snapshot page=active?snapshot(ctx,cs):null;
            boolean ready=active&&BiliUi.searchReady(page.nodes,query);StringBuilder signature=new StringBuilder();
            if(ready)for(int index:BiliUi.results(page.nodes,page.width,page.height))signature.append(page.nodes.get(index).text).append('\n');
            String state=wait.observe(active,ready,signature.toString(),ready?BiliUi.searchMessage(page.nodes):"loading",android.os.SystemClock.elapsedRealtime());
            if("left-app".equals(state))return null;
            if(!"loading".equals(state)&&page!=null){page.searchState=state;return page;}
            Thread.sleep(100);
        }
        return null;
    }
    static MediaController media(Context ctx){
        try{MediaSessionManager manager=(MediaSessionManager)ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
            for(MediaController c:manager.getActiveSessions(new ComponentName(ctx,MsgService.class)))if(PKG.equals(c.getPackageName()))return c;
        }catch(Throwable ignored){}return null;
    }
    static JSONObject status(Context ctx,CtrlService cs)throws Exception{
        boolean active=foreground(cs);Snapshot page=snapshot(ctx,cs);
        JSONObject out=new JSONObject().put("foreground",active);
        boolean full=active&&BiliUi.fullscreen(page.nodes,page.width,page.height);
        out.put("fullscreen",full);MediaController controller=media(ctx);PlaybackState state=controller==null?null:controller.getPlaybackState();
        out.put("playing",state==null?JSONObject.NULL:state.getState()==PlaybackState.STATE_PLAYING);
        if(controller!=null&&controller.getMetadata()!=null)out.put("mediaTitle",controller.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE));
        out.put("playbackVerified",state!=null&&state.getState()!=PlaybackState.STATE_NONE&&state.getState()!=PlaybackState.STATE_ERROR);return out;
    }
    static boolean waitFullscreen(Context ctx,CtrlService cs)throws Exception{
        int stable=0,lastW=0,lastH=0;
        for(int i=0;i<120;i++){
            if(!foreground(cs))return false;
            Snapshot page=snapshot(ctx,cs);
            if(BiliUi.fullscreen(page.nodes,page.width,page.height)){
                stable=page.width==lastW&&page.height==lastH?stable+1:1;
                if(stable>=3)return true;
            }else stable=0;
            lastW=page.width;lastH=page.height;Thread.sleep(100);
        }
        return false;
    }
    static boolean fullscreen(Context ctx,CtrlService cs)throws Exception{
        if(!foreground(cs))return false;
        if(status(ctx,cs).optBoolean("fullscreen"))return true;
        for(int round=0;round<3;round++){
            if(!foreground(cs))return false;
            Snapshot page=snapshot(ctx,cs);boolean clicked=false;
            for(int i=0;i<page.nodes.size();i++){
                BiliUi.Node node=page.nodes.get(i);
                if(BiliUi.expand(node)&&node.onScreen(page.width,page.height)){
                    clicked=click(cs,page.nativeNodes.get(i));
                    if(clicked&&waitFullscreen(ctx,cs))return true;
                    break;
                }
            }
            if(status(ctx,cs).optBoolean("fullscreen"))return true;
            // Never estimate the fullscreen button: detail pages have coin/like
            // controls nearby. Only expose controls on an identified video surface.
            if(clicked)continue;
            page=snapshot(ctx,cs);int player=BiliUi.playerSurface(page.nodes,page.width,page.height);
            if(player>=0)click(cs,page.nativeNodes.get(player));
            Thread.sleep(250);
        }
        return status(ctx,cs).optBoolean("fullscreen");
    }
    static boolean chooseResult(Context ctx,CtrlService cs,String query,int index)throws Exception{
        Snapshot page=waitSearch(ctx,cs,query);if(page==null||!"results".equals(page.searchState))return false;
        List<Integer> candidates=BiliUi.results(page.nodes,page.width,page.height);
        if(index>=candidates.size())return false;
        // Re-read immediately: a delayed intent must never click an old detail title.
        page=snapshot(ctx,cs);if(!BiliUi.searchReady(page.nodes,query))return false;
        candidates=BiliUi.results(page.nodes,page.width,page.height);
        return index<candidates.size()&&click(cs,page.nativeNodes.get(candidates.get(index)));
    }
    public static JSONObject run(Context ctx,JSONObject args)throws Exception{
        JSONObject out=new JSONObject();String action=args.optString("action","play"),query=args.optString("query","").trim(),bvid=args.optString("bvid","").trim();CtrlService cs=CtrlService.get();
        if("status".equals(action))return status(ctx,cs).put("ok",true);
        if("pause".equals(action)||"resume".equals(action)){
            MediaController m=media(ctx);if(m==null)return out.put("ok",false).put("error","B站没有提供可控制的播放会话");
            boolean wantPlaying="resume".equals(action);
            if(wantPlaying)m.getTransportControls().play();else m.getTransportControls().pause();
            JSONObject state=null;
            for(int i=0;i<25;i++){Thread.sleep(100);state=status(ctx,cs);if(state.optBoolean("playbackVerified")&&state.optBoolean("playing")==wantPlaying)return state.put("ok",true);}
            return state.put("ok",false).put("error","播放控制已请求，但未确认目标状态");
        }
        if("fullscreen".equals(action)){boolean full=fullscreen(ctx,cs);return status(ctx,cs).put("ok",full);}
        try{ctx.getPackageManager().getPackageInfo(PKG,0);}catch(Exception e){return out.put("ok",false).put("error","手机没有安装标准版哔哩哔哩");}
        if(!action.matches("play|search"))return out.put("ok",false).put("error","不支持的B站操作");
        if("search".equals(action)&&query.isEmpty())return out.put("ok",false).put("error","搜索需要query关键词");
        if(!bvid.isEmpty()&&!"search".equals(action)){
            if(!bvid.matches("BV[0-9A-Za-z]{10}"))return out.put("ok",false).put("error","视频BV号格式不正确");
            launch(ctx,"https://www.bilibili.com/video/"+bvid);
        }else if(!query.isEmpty())launch(ctx,"bilibili://search?keyword="+Uri.encode(query));
        else return out.put("ok",false).put("error","需要搜索词query或视频bvid");
        if(cs==null)return out.put("ok",false).put("launchRequested",true).put("error","页面已请求打开；确认搜索、自动选视频和全屏需要无障碍权限");
        if(!waitApp(cs))return out.put("ok",false).put("error","B站未到前台，可能被锁屏或系统后台启动限制阻止");
        if("search".equals(action)){
            Snapshot page=waitSearch(ctx,cs,query);
            if(page==null)return out.put("ok",false).put("launchRequested",true).put("error","尚未确认当前关键词的搜索结果；可能仍在加载或已离开B站，请读屏核对后重试");
            if("error".equals(page.searchState))return out.put("ok",false).put("opened",true).put("queryVerified",true).put("action","search").put("error","已打开准确搜索页，但B站报告网络或加载失败");
            boolean empty="empty".equals(page.searchState);
            return out.put("ok",true).put("opened",true).put("queryVerified",true).put("action","search").put("empty",empty).put("resultCount",BiliUi.results(page.nodes,page.width,page.height).size()).put("items",cs.listItemsJson()).put("data",empty?"已打开准确搜索页，B站当前未找到相关结果":"已确认当前关键词的搜索结果");
        }
        if(bvid.isEmpty()&&!chooseResult(ctx,cs,query,Math.max(0,args.optInt("index",0))))return out.put("ok",false).put("opened",true).put("error","搜索页已打开，但未识别到视频结果；请读屏确认后选择，不能声称已经播放");
        boolean wantFull=args.optBoolean("fullscreen",true);
        boolean videoPage=false;
        for(int i=0;i<120;i++){
            Thread.sleep(100);if(!foreground(cs))break;
            Snapshot page=snapshot(ctx,cs);
            videoPage=!BiliUi.searchReady(page.nodes,query)&&(BiliUi.playerSurface(page.nodes,page.width,page.height)>=0||BiliUi.fullscreen(page.nodes,page.width,page.height));
            if(videoPage)break;
        }
        if(!videoPage)return out.put("ok",false).put("opened",true).put("error","未确认进入视频播放器；请读屏确认，未继续操作全屏");
        MediaController current=media(ctx);
        if(current!=null&&current.getPlaybackState()!=null&&current.getPlaybackState().getState()==PlaybackState.STATE_PAUSED){current.getTransportControls().play();Thread.sleep(200);}
        if(wantFull)fullscreen(ctx,cs);
        JSONObject state=status(ctx,cs);
        for(int i=0;i<20&&(!state.optBoolean("playbackVerified")||!state.optBoolean("playing"));i++){Thread.sleep(100);state=status(ctx,cs);}
        boolean opened=state.optBoolean("foreground"),full=state.optBoolean("fullscreen");
        state.put("opened",opened).put("ok",opened&&(!wantFull||full)&&state.optBoolean("playbackVerified")&&state.optBoolean("playing"));
        state.put("data",!opened?"B站页面未保留在前台":wantFull&&!full?"已打开视频，全屏尚未确认":"视频页面已打开"+(full?"，已确认全屏":"")+(state.optBoolean("playbackVerified")?state.optBoolean("playing")?"，正在播放":"，播放器当前未播放":"，暂未取得播放状态"));
        return state;
    }
}
