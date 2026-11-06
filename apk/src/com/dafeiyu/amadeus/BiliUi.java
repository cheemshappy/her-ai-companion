package com.dafeiyu.amadeus;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Pure UI recognition rules, also exercised against recorded public Bilibili pages. */
final class BiliUi {
    static final class Node {
        final String id,text,description,kind;
        final int left,top,right,bottom,parent;
        final boolean visible,editable;
        Node(String id,String text,String description,String kind,int left,int top,int right,int bottom,int parent,boolean visible,boolean editable){
            this.id=id==null?"":id;this.text=text==null?"":text;this.description=description==null?"":description;this.kind=kind==null?"":kind;
            this.left=left;this.top=top;this.right=right;this.bottom=bottom;this.parent=parent;this.visible=visible;this.editable=editable;
        }
        boolean onScreen(int width,int height){return visible&&right>0&&bottom>0&&left<width&&top<height&&right>left&&bottom>top;}
        boolean surface(){return kind.endsWith("SurfaceView")||kind.endsWith("TextureView");}
    }
    static String normal(String text){return text.replaceAll("\\s+","").toLowerCase(Locale.ROOT);}
    /** Brief root-window gaps during app transitions are not a search failure. */
    static final class SearchWait {
        long missingSince=-1;String previous="";int stable=0;
        String observe(boolean foreground,boolean queryReady,String signature,String status,long now){
            if(!foreground){
                previous="";stable=0;if(missingSince<0)missingSince=now;
                return now-missingSince>=1500?"left-app":"loading";
            }
            missingSince=-1;
            if(!queryReady){previous="";stable=0;return "loading";}
            String key=!signature.isEmpty()?"results:"+signature:("empty".equals(status)||"error".equals(status)?status:"");
            if(key.isEmpty()){previous="";stable=0;return "loading";}
            stable=key.equals(previous)?stable+1:1;previous=key;
            return stable>=3?(signature.isEmpty()?status:"results"):"loading";
        }
    }
    static String searchMessage(List<Node> nodes){
        for(Node n:nodes)if(n.visible&&n.id.matches(".*/(empty[^/]*|no_result[^/]*|error[^/]*|tips|tip_text|tv_tip|tv_hint)")){
            String text=n.text+n.description;
            if(text.matches(".*(网络[^。]*异常|网络[^。]*错误|网络[^。]*失败|加载失败|连接失败|重新加载|点击重试).*"))return "error";
            if(text.matches(".*(没有找到|未找到|暂无相关|没有相关|无搜索结果|换个关键词).*"))return "empty";
        }
        return "loading";
    }
    static boolean searchReady(List<Node> nodes,String query){
        boolean result=false,matched=false;
        for(Node n:nodes)if(n.visible){
            if(n.id.endsWith("/search_result_layout"))result=true;
            if(n.id.matches(".*/(search_fake_text|search_src_text|search_edit|search_input)")&&normal(n.text).equals(normal(query)))matched=true;
        }
        return result&&matched&&!normal(query).isEmpty();
    }
    static boolean descendant(List<Node> nodes,int child,int parent){
        for(int i=child,depth=0;i>=0&&depth<40;i=nodes.get(i).parent,depth++)if(i==parent)return true;
        return false;
    }
    static boolean videoCard(List<Node> nodes,int index){
        int parent=nodes.get(index).parent;
        for(int depth=0;parent>=0&&depth<5;parent=nodes.get(parent).parent,depth++){
            Node container=nodes.get(parent);
            if(container.id.matches(".*/(recycler_view|search_result_layout|search_nested_container)"))break;
            boolean cover=false,duration=false,advert=false;
            for(int i=parent+1;i<nodes.size()&&descendant(nodes,i,parent);i++){
                Node n=nodes.get(i);
                cover|=n.id.endsWith("/cover");
                duration|=n.id.matches(".*/duration(_badge)?");
                String label=(n.text+" "+n.description).trim();
                advert|=label.matches(".*(广告|推广|立即下载|去下载).*")||n.id.matches(".*/(ad_tag|ad_label|tv_download_status)");
            }
            if(cover&&duration)return !advert;
        }
        return false;
    }
    static List<Integer> results(List<Node> nodes,int width,int height){
        List<Integer> result=new ArrayList<>();
        boolean searchPage=false;
        for(Node n:nodes)if(n.visible&&n.id.endsWith("/search_result_layout")){searchPage=true;break;}
        if(!searchPage)return result;
        for(int i=0;i<nodes.size();i++){
            Node n=nodes.get(i);
            if(n.editable||!n.onScreen(width,height)||n.text.trim().length()<2||n.top<height*.12||n.bottom-n.top<15)continue;
            if(n.id.matches(".*/(title|video_name)")&&n.right-n.left>width*.2&&n.bottom-n.top<height*.18&&videoCard(nodes,i))result.add(i);
        }
        result.sort((a,b)->Integer.compare(nodes.get(a).top,nodes.get(b).top));
        return result;
    }
    static boolean exitFullscreen(Node n){return n.visible&&(n.text.contains("退出全屏")||n.description.contains("退出全屏"));}
    static boolean expand(Node n){
        return n.visible&&(n.text.trim().matches("进入全屏|全屏播放|展开全屏|全屏|横屏播放|横屏")||n.description.trim().matches("进入全屏|全屏播放|展开全屏|全屏|横屏播放|横屏")||n.id.matches(".*/(gemini_halfscreen_expand|fullscreen|full_screen|fullScreen|player_expand)"));
    }
    static boolean fullscreen(List<Node> nodes,int width,int height){
        for(Node n:nodes)if(n.onScreen(width,height)&&exitFullscreen(n))return true;
        if(width<=height)return false;
        for(Node n:nodes)if(n.surface()&&n.onScreen(width,height)){
            int w=Math.min(width,n.right)-Math.max(0,n.left),h=Math.min(height,n.bottom)-Math.max(0,n.top);
            if(w>=width*.85&&h>=height*.85)return true;
        }
        return false;
    }
    static int playerSurface(List<Node> nodes,int width,int height){
        int best=-1;long area=Long.MAX_VALUE;
        for(int i=0;i<nodes.size();i++){
            Node n=nodes.get(i);int w=n.right-n.left,h=n.bottom-n.top;
            boolean videoAspect=w>h*1.25||(w>=width*.85&&h<height*.8);
            if(n.surface()&&n.onScreen(width,height)&&w>width*.5&&h>height*.13&&h<height*.8&&videoAspect&&n.top<height*.25&&n.left>=0&&n.right<=width+2&&(long)w*h<area){best=i;area=(long)w*h;}
        }
        return best;
    }
}
