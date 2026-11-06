package com.dafeiyu.amadeus;

import java.net.URI;
import java.net.URLDecoder;

/** Keep pairing queries on the selected URL; never display or redirect credentials. */
final class ServerEndpoint {
    final String url, origin, token;
    private ServerEndpoint(String url,String origin,String token){this.url=url;this.origin=origin;this.token=token;}
    static ServerEndpoint parse(String value){
        try{
            String text=value==null?"":value.trim();
            if(text.isEmpty())return null;
            if(!text.matches("(?i)^https?://.*"))text="http://"+text;
            URI uri=URI.create(text);
            if(!("http".equalsIgnoreCase(uri.getScheme())||"https".equalsIgnoreCase(uri.getScheme()))||uri.getHost()==null||uri.getUserInfo()!=null)return null;
            String origin=uri.getScheme().toLowerCase()+"://"+uri.getRawAuthority();
            String token="";
            if(uri.getRawQuery()!=null)for(String pair:uri.getRawQuery().split("&")){
                int eq=pair.indexOf('=');
                if(eq>=0&&"k".equals(URLDecoder.decode(pair.substring(0,eq),"UTF-8")))token=URLDecoder.decode(pair.substring(eq+1),"UTF-8");
            }
            // All current pages belong to the same root application.
            return new ServerEndpoint(origin+"/"+(uri.getRawQuery()==null?"":"?"+uri.getRawQuery()),origin,token);
        }catch(Exception ignored){return null;}
    }
    String pingUrl(){return origin+"/api/ping";}
    String floatUrl(){return origin+"/ui/float.html"+url.substring((origin+"/").length());}
    boolean loopback(){String host=URI.create(origin).getHost();return "127.0.0.1".equals(host)||"localhost".equalsIgnoreCase(host)||"[::1]".equals(host)||"::1".equals(host);}
    static String display(String value){ServerEndpoint ep=parse(value);return ep==null?"未设置":ep.origin;}
}
