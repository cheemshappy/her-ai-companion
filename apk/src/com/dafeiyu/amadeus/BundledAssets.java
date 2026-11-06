package com.dafeiyu.amadeus;

import android.content.Context;
import android.webkit.WebResourceResponse;
import android.net.Uri;
import java.util.HashMap;

/** Serve APK assets on the page's own origin: HTTPS remote pages need no loopback request. */
final class BundledAssets {
    static final String MODEL="/bundled-model/deepseek-chan/大肥鱼.model3.json";
    static WebResourceResponse intercept(Context context,Uri uri){
        String raw=uri.getEncodedPath();if(raw==null)return null;
        boolean model=raw.startsWith("/bundled-model/"),vendor=raw.startsWith("/bundled-vendor/");
        if(!model&&!vendor)return null;
        try{
            String relative=Uri.decode(raw.substring(model?15:16));
            if(relative.contains("..")||relative.contains("\\")||relative.startsWith("/")||relative.indexOf('\0')>=0)throw new Exception();
            String file=(model?"model/":"web/vendor/")+relative;
            String mime=file.endsWith(".json")?"application/json":file.endsWith(".js")?"application/javascript":file.endsWith(".png")?"image/png":"application/octet-stream";
            HashMap<String,String> headers=new HashMap<>();headers.put("Cache-Control","public, max-age=86400");headers.put("Access-Control-Allow-Origin","*");
            return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,context.getAssets().open(file));
        }catch(Exception ignored){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",new HashMap<>(),new java.io.ByteArrayInputStream(new byte[0]));}
    }
}
