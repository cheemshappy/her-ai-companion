package com.dafeiyu.amadeus;

import android.app.Notification;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedList;

/** Passive notification inbox. Never launches WeChat/QQ or clears their unread state. */
public class MsgService extends NotificationListenerService {
    private static volatile MsgService instance;
    private static final LinkedList<JSONObject> RECENT=new LinkedList<>();
    private static boolean loaded=false;
    public static boolean connected(){return instance!=null;}
    public static JSONObject status(Context ctx)throws Exception{
        String enabled=android.provider.Settings.Secure.getString(ctx.getContentResolver(),"enabled_notification_listeners");
        return new JSONObject().put("ok",true).put("connected",connected()).put("permissionGranted",enabled!=null&&enabled.contains(ctx.getPackageName()+"/"))
            .put("source","notification").put("opensApps",false).put("screenScanning",false);
    }
    private static synchronized void load(Context ctx){
        if(loaded)return;loaded=true;
        try{JSONArray saved=new JSONArray(ctx.getSharedPreferences("amadeus_notification_inbox",0).getString("items","[]"));
            for(int i=0;i<saved.length();i++)if(saved.optJSONObject(i)!=null)RECENT.add(saved.getJSONObject(i));
        }catch(Exception ignored){}
    }
    @Override public void onCreate(){super.onCreate();load(this);Proactive.ensurePoller(this);}
    @Override public void onListenerConnected(){
        super.onListenerConnected();instance=this;load(this);Proactive.ensurePoller(this);
        try{for(StatusBarNotification sbn:getActiveNotifications())capture(sbn);}catch(Throwable ignored){}
    }
    @Override public void onListenerDisconnected(){instance=null;super.onListenerDisconnected();
        try{requestRebind(new android.content.ComponentName(this,MsgService.class));}catch(Throwable ignored){}
    }
    @Override public void onDestroy(){if(instance==this)instance=null;super.onDestroy();}
    @Override public void onNotificationPosted(StatusBarNotification sbn){capture(sbn);}
    private void capture(StatusBarNotification sbn){
        if(sbn==null||sbn.getNotification()==null||getPackageName().equals(sbn.getPackageName()))return;
        try{
            Notification n=sbn.getNotification();Bundle ex=n.extras;if(ex==null)return;
            String pkg=sbn.getPackageName(),app=appLabel(pkg);
            String title=String.valueOf(ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE,ex.getCharSequence(Notification.EXTRA_TITLE,"")));
            boolean found=false;
            android.os.Parcelable[] raw=ex.getParcelableArray("android.messages");
            if(raw!=null)for(Notification.MessagingStyle.Message message:Notification.MessagingStyle.Message.getMessagesFromBundleArray(raw)){
                if(message.getText()==null||message.getText().length()==0)continue;
                String sender=message.getSender()==null?"":message.getSender().toString();
                String body=message.getText().toString();
                if(!sender.isEmpty()&&!sender.equals(title))body=sender+"："+body;
                add(pkg,app,title,body,message.getTimestamp()>0?message.getTimestamp():sbn.getPostTime(),sbn.getKey());found=true;
            }
            if(!found){
                CharSequence big=ex.getCharSequence(Notification.EXTRA_BIG_TEXT),body=big==null?ex.getCharSequence(Notification.EXTRA_TEXT):big;
                CharSequence[] lines=ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
                if(lines!=null&&lines.length>0){for(CharSequence line:lines)if(line!=null)add(pkg,app,title,line.toString(),sbn.getPostTime(),sbn.getKey());}
                else if(body!=null)add(pkg,app,title,body.toString(),sbn.getPostTime(),sbn.getKey());
            }
        }catch(Throwable ignored){}
    }
    private void add(String pkg,String app,String title,String body,long time,String key)throws Exception{
        if(body.trim().isEmpty())return;
        if(body.length()>4000)body=body.substring(0,4000);if(title.length()>160)title=title.substring(0,160);
        JSONObject item=new JSONObject().put("pkg",pkg).put("app",app).put("title",title).put("text",body).put("time",time).put("notificationKey",key);
        synchronized(RECENT){
            for(JSONObject old:RECENT)if(pkg.equals(old.optString("pkg"))&&title.equals(old.optString("title"))&&body.equals(old.optString("text"))&&Math.abs(time-old.optLong("time"))<60000)return;
            RECENT.add(item);while(RECENT.size()>200)RECENT.removeFirst();
            JSONArray data=new JSONArray();long cut=System.currentTimeMillis()-86400000L;
            RECENT.removeIf(x->x.optLong("time")<cut);
            for(JSONObject record:RECENT)data.put(record);
            getSharedPreferences("amadeus_notification_inbox",0).edit().putString("items",data.toString()).apply();
        }
        Proactive.onNotification(this,pkg,app,title,body,time);
    }
    private String appLabel(String pkg){try{PackageManager pm=getPackageManager();return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg,0)));}catch(Exception e){return pkg;}}
    public static JSONObject snapshot(Context ctx,int limit,String app)throws Exception{
        load(ctx);JSONArray items=new JSONArray();boolean chats="chat".equals(app);long cutoff=System.currentTimeMillis()-86400000L;
        synchronized(RECENT){
            for(int i=RECENT.size()-1;i>=0&&items.length()<Math.max(1,Math.min(limit,100));i--){
                JSONObject item=RECENT.get(i);String pkg=item.optString("pkg");
                if(item.optLong("time")<cutoff)continue;
                boolean wx=pkg.startsWith("com.tencent.mm"),qq=pkg.startsWith("com.tencent.mobileqq")||pkg.startsWith("com.tencent.tim");
                if(chats&&!wx&&!qq)continue;
                if("微信".equals(app)&&!wx||"QQ".equalsIgnoreCase(app)&&!qq)continue;
                if(!app.isEmpty()&&!chats&&!"微信".equals(app)&&!"QQ".equalsIgnoreCase(app)&&!item.optString("app").contains(app)&&!pkg.contains(app))continue;
                if(qq&&(item.optString("title").contains("车万草丛")||item.optString("title").contains("示例群")))continue;
                items.put(item);
            }
        }
        return new JSONObject().put("ok",true).put("connected",connected()).put("source","notification").put("opensApps",false).put("count",items.length()).put("items",items)
            .put("coverage","只包含系统通知公开的消息；免打扰、关闭通知或隐藏正文的会话可能没有完整内容。");
    }
    public static String recentJson(int limit){try{MsgService svc=instance;return svc==null?"（通知监听尚未连接）":snapshot(svc,limit,"").toString();}catch(Exception e){return "（通知暂不可用）";}}
    /** Quick reply only when an active notification matches exactly one recipient. */
    public static JSONObject reply(Context ctx,String app,String to,String text)throws Exception{
        MsgService svc=instance;
        if(svc==null)return new JSONObject().put("ok",false).put("unavailable",true).put("error","通知监听未连接");
        StatusBarNotification match=null;int matches=0;
        for(StatusBarNotification sbn:svc.getActiveNotifications()){
            String pkg=sbn.getPackageName();boolean wanted="QQ".equalsIgnoreCase(app)?pkg.startsWith("com.tencent.mobileqq")||pkg.startsWith("com.tencent.tim"):pkg.startsWith("com.tencent.mm");
            Bundle ex=sbn.getNotification().extras;if(!wanted||ex==null)continue;
            String title=String.valueOf(ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE,ex.getCharSequence(Notification.EXTRA_TITLE,"")));
            if(title.equals(to)){match=sbn;matches++;}
        }
        if(matches>1)return new JSONObject().put("ok",false).put("ambiguous",true).put("error","有多个同名通知，不能确定收件人");
        if(match!=null&&match.getNotification().actions!=null)for(Notification.Action action:match.getNotification().actions){
            RemoteInput[] inputs=action.getRemoteInputs();if(inputs==null||action.actionIntent==null)continue;
            Bundle results=new Bundle();boolean free=false;
            for(RemoteInput input:inputs)if(input.getAllowFreeFormInput()){results.putCharSequence(input.getResultKey(),text);free=true;}
            if(!free)continue;
            Intent fill=new Intent();RemoteInput.addResultsToIntent(inputs,fill,results);action.actionIntent.send(ctx,0,fill);
            return new JSONObject().put("ok",true).put("submitted",true).put("deliveryVerified",false).put("source","notification-reply").put("opensApps",false).put("data","已通过系统通知提交回复，目标应用尚未提供送达回执");
        }
        return new JSONObject().put("ok",false).put("unavailable",true).put("error","目标通知没有快捷回复入口");
    }
}
