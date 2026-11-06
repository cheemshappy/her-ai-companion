package com.dafeiyu.amadeus;

import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

final class ChatNavigator {
    static JSONObject open(Context context,String app,String who)throws Exception{
        return open(context,app,who,false);
    }
    static JSONObject open(Context context,String app,String who,boolean searchOnly)throws Exception{
        CtrlService cs=CtrlService.get();
        if(cs==null)return new JSONObject().put("ok",false).put("stage","accessibility").put("error","操作手机服务未连接");
        boolean qq="QQ".equalsIgnoreCase(app)||app.contains("QQ");
        String pkg=qq?"com.tencent.mobileqq":"com.tencent.mm";
        ChatNavigation.Ui device=new ChatNavigation.Ui(){
            public boolean foreground(){return pkg.equals(cs.rootPackage());}
            public boolean launch(){
                String comp=qq?"com.tencent.mobileqq/.activity.SplashActivity":"com.tencent.mm/.ui.LauncherUI";
                try{if(new JSONObject(ShizukuBridge.run("am start -n "+comp)).optBoolean("ok"))return true;}catch(Exception ignored){}
                try{Intent intent=context.getPackageManager().getLaunchIntentForPackage(pkg);if(intent==null)return false;intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);context.startActivity(intent);return true;}catch(Exception ignored){return false;}
            }
            public boolean home(){return foreground()&&cs.chatHome(qq);}
            public boolean back(){return cs.back();}
            public boolean search(){return foreground()&&cs.openChatSearch();}
            public boolean searching(){return foreground()&&cs.chatSearchField()!=null;}
            public boolean query(String name){return cs.setChatSearchQuery(name);}
            public boolean queryMatches(String name){return cs.chatSearchQueryMatches(name);}
            public int matches(String name){return foreground()?cs.contactResults(name).size():0;}
            public boolean select(String name){return foreground()&&cs.selectContactResult(name);}
            public boolean conversation(String name){return foreground()&&cs.conversationMatches(name);}
            public void pause(long ms){try{Thread.sleep(ms);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}}
        };
        ChatNavigation.Result result=ChatNavigation.open(device,who,searchOnly);
        return new JSONObject().put("ok",result.ok).put("stage",result.stage).put("app",qq?"QQ":"微信")
                .put("searchVerified",result.searchVerified).put("queryVerified",result.queryVerified).put("contactFound",result.ok)
                .put("submitted",false).put("error",result.ok?"":result.error).put("data",result.ok&&!searchOnly?"已核对并打开指定联系人会话":result.error);
    }
}
