package com.dafeiyu.amadeus;

/** Verified transitions. A search field is never evidence of an open chat. */
final class ChatNavigation {
    interface Ui {
        boolean foreground(); boolean launch(); boolean home(); boolean back();
        boolean search(); boolean searching(); boolean query(String who); boolean queryMatches(String who);
        int matches(String who); boolean select(String who); boolean conversation(String who); void pause(long ms);
    }
    static final class Result {
        final boolean ok,searchVerified,queryVerified;final String stage,error;
        Result(boolean ok,String stage,String error,boolean search,boolean query){this.ok=ok;this.stage=stage;this.error=error;searchVerified=search;queryVerified=query;}
    }
    static Result open(Ui ui,String who){
        return open(ui,who,false);
    }
    static Result open(Ui ui,String who,boolean searchOnly){
        if(!ui.foreground())ui.launch();
        for(int i=0;i<24&&!ui.foreground();i++)ui.pause(250);
        if(!ui.foreground())return new Result(false,"launch","应用未能到前台，请检查后台弹出权限。",false,false);
        if(ui.conversation(who))return new Result(true,"conversation","",false,false);
        // Back actually executes through accessibility if shell is unavailable.
        for(int i=0;i<6&&!ui.home()&&!ui.searching();i++){ui.back();ui.pause(350);if(!ui.foreground()){ui.launch();ui.pause(500);}}
        if(!ui.foreground())return new Result(false,"launch","应用已离开前台，已停止查找。",false,false);
        if(!ui.searching()){
            if(!ui.home())return new Result(false,"home","尚未回到应用首页，已停止，未向其他输入框填写。",false,false);
            if(!ui.search())return new Result(false,"search-entry","没有找到首页搜索入口。",false,false);
        }
        for(int i=0;i<20&&!ui.searching();i++)ui.pause(150);
        if(!ui.searching())return new Result(false,"search-entry","搜索页面没有打开，未填写或发送消息。",false,false);
        if(!ui.query(who)||!ui.queryMatches(who))return new Result(false,"search-input","搜索词没有准确填入，未继续操作。",true,false);
        int count=0;for(int i=0;i<16;i++){ui.pause(150);count=ui.matches(who);if(count>0)break;}
        if(searchOnly)return new Result(count==1,"search-results",count==0?"没有找到这个联系人，已停在搜索结果页，未发送。":count>1?"存在多个同名联系人，未发送。":"已找到联系人，停留搜索结果页，未发送。",true,true);
        if(count!=1)return new Result(false,"search-results",count>1?"存在多个同名联系人，请补充账号或备注，未发送。":"没有找到这个联系人，已停在搜索结果页，未发送。",true,true);
        if(!ui.select(who))return new Result(false,"search-results","联系人结果未能打开，未发送。",true,true);
        for(int i=0;i<20&&!ui.conversation(who);i++)ui.pause(150);
        return ui.conversation(who)?new Result(true,"conversation","",true,true):new Result(false,"conversation","尚未核对到指定联系人会话，未发送。",true,true);
    }
}
