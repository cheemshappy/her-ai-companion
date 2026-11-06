package com.dafeiyu.amadeus;

import android.content.SharedPreferences;
import org.json.JSONObject;
import org.json.JSONArray;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.*;

/** Race saved, paired routes; a slow or dead local address cannot delay remote recovery. */
final class ServerConnections {
    static final class Result {
        final ServerEndpoint endpoint;final boolean ok;final String message;
        Result(ServerEndpoint endpoint,boolean ok,String message){this.endpoint=endpoint;this.ok=ok;this.message=message;}
    }
    interface Callback {void complete(Result result);}
    static final class Operation {
        volatile boolean cancelled;
        volatile String stableOrigin="";
        final long startedAt=android.os.SystemClock.elapsedRealtime();
        final ConcurrentMap<String,String> stages=new ConcurrentHashMap<>();
        final List<HttpURLConnection> connections=new CopyOnWriteArrayList<>();
        ExecutorService pool;Thread worker;
        final java.util.concurrent.atomic.AtomicBoolean cleanupStarted=new java.util.concurrent.atomic.AtomicBoolean();
        void cancel(){cancelled=true;if(worker!=null)worker.interrupt();if(pool!=null)pool.shutdownNow();
            // disconnect() can wait on an in-flight TLS socket. Never run it on the UI thread.
            if(cleanupStarted.compareAndSet(false,true)){Thread cleanup=new Thread(this::close,"her-close-routes");cleanup.setDaemon(true);cleanup.start();}}
        void close(){for(HttpURLConnection connection:connections)try{connection.disconnect();}catch(Exception ignored){}if(pool!=null)pool.shutdownNow();}
        JSONArray diagnostics(){JSONArray result=new JSONArray();for(java.util.Map.Entry<String,String> stage:stages.entrySet())try{JSONObject row=new JSONObject();row.put("route",stage.getKey());row.put("stage",stage.getValue());row.put("elapsedMs",android.os.SystemClock.elapsedRealtime()-startedAt);result.put(row);}catch(Exception ignored){}return result;}
    }
    static List<ServerEndpoint> saved(SharedPreferences prefs){
        java.util.ArrayList<String> backups=new java.util.ArrayList<>();try{JSONArray saved=new JSONArray(prefs.getString("server_fallbacks","[]"));for(int i=0;i<Math.min(2,saved.length());i++)backups.add(saved.optString(i,""));}catch(Exception ignored){}
        return ConnectionPolicy.candidates(prefs.getString(MainActivity.KEY_SERVER,""),prefs.getString(MainActivity.KEY_ALT,""),prefs.getString("server_last_working",""),backups,prefs.getString("server_stable",""));
    }
    static boolean saveStable(SharedPreferences prefs,String url){
        ServerEndpoint endpoint=ServerEndpoint.parse(url);if(endpoint==null||endpoint.loopback()||endpoint.token.isEmpty())return false;
        ServerEndpoint primary=ServerEndpoint.parse(prefs.getString(MainActivity.KEY_SERVER,"")),alternate=ServerEndpoint.parse(prefs.getString(MainActivity.KEY_ALT,""));
        if(!((primary!=null&&endpoint.token.equals(primary.token))||(alternate!=null&&endpoint.token.equals(alternate.token))))return false;
        prefs.edit().putString("server_stable",endpoint.url).commit();return true;
    }
    static Operation find(SharedPreferences prefs,Callback callback){
        Operation operation=new Operation();
        ServerEndpoint stable=ServerEndpoint.parse(prefs.getString("server_stable",""));if(stable!=null&&!stable.loopback())operation.stableOrigin=stable.origin;
        List<ServerEndpoint> endpoints=saved(prefs);
        for(int i=0;i<endpoints.size();i++)operation.stages.put((endpoints.get(i).loopback()?"local-":"public-")+i,"queued");
        operation.worker=new Thread(()->{
            Result result=new Result(null,false,"暂时没有连上电脑；会自动重试，也可以更新配对地址。");
            try{
                if(!endpoints.isEmpty()){
                    operation.pool=Executors.newFixedThreadPool(endpoints.size());
                    CompletionService<Result> pending=new ExecutorCompletionService<>(operation.pool);
                    for(int i=0;i<endpoints.size();i++){final ServerEndpoint endpoint=endpoints.get(i);final String route=(endpoint.loopback()?"local-":"public-")+i;pending.submit(()->probe(endpoint,operation,route));}
                    long until=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(ConnectionPolicy.ATTEMPT_MS);
                    for(int left=endpoints.size();left>0&&!operation.cancelled;left--){
                        long remaining=until-System.nanoTime();if(remaining<=0)break;
                        Future<Result> future=pending.poll(remaining,TimeUnit.NANOSECONDS);if(future==null)break;
                        Result next=future.get();if(next.ok||!result.message.contains("配对")||next.message.contains("配对"))result=next;
                        if(next.ok)break;
                    }
                }
                if(!operation.cancelled)callback.complete(result);
            }catch(Exception ignored){if(!operation.cancelled)callback.complete(result);}
            finally{operation.close();}
        },"her-connection-routes");
        operation.worker.start();return operation;
    }
    private static Result probe(ServerEndpoint endpoint,Operation operation,String route){
        HttpURLConnection connection=null;
        try{
            if(operation.cancelled)return new Result(endpoint,false,"");
            operation.stages.put(route,"opening");
            boolean discovery=endpoint.origin.equals(operation.stableOrigin);
            connection=(HttpURLConnection)new URL(discovery?endpoint.origin+"/api/tunnel":endpoint.pingUrl()).openConnection();operation.connections.add(connection);
            if(operation.cancelled)return new Result(endpoint,false,"");
            connection.setConnectTimeout(ConnectionPolicy.connectTimeout(endpoint));connection.setReadTimeout(ConnectionPolicy.readTimeout(endpoint));
            connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
            connection.setRequestProperty("User-Agent","Her-Android-Connection/1.0");
            if(!endpoint.token.isEmpty())connection.setRequestProperty("x-amadeus-key",endpoint.token);
            operation.stages.put(route,"connecting");int code=connection.getResponseCode();operation.stages.put(route,"http-"+code);
            if(code==401||code==403)return new Result(endpoint,false,"配对信息已失效，请使用电脑上的新配对地址。");
            if(code!=200)return new Result(endpoint,false,"这条线路暂时不可用，正在自动恢复；也可以更新连接地址。");
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            try(InputStream input=connection.getInputStream()){
                byte[] buffer=new byte[1024];int size;
                while((size=input.read(buffer))!=-1){bytes.write(buffer,0,size);if(bytes.size()>16384)return new Result(endpoint,false,"连接返回了其他页面，请更新地址。");}
            }
            JSONObject data=new JSONObject(bytes.toString("UTF-8"));
            if(discovery){
                if(!data.optBoolean("ok"))return new Result(endpoint,false,"恢复入口尚未找到电脑线路，会继续重试。");
                java.util.ArrayList<String> urls=new java.util.ArrayList<>();urls.add(data.optString("urlWithToken"));JSONArray backups=data.optJSONArray("urlsWithToken");
                if(backups!=null)for(int i=0;i<Math.min(2,backups.length());i++)urls.add(backups.optString(i,""));
                java.util.HashSet<String> seen=new java.util.HashSet<>();int attempts=0;
                for(String value:urls){
                    ServerEndpoint current=ServerEndpoint.parse(value);
                    if(current==null||current.loopback()||!current.origin.startsWith("https://")||!current.token.equals(endpoint.token)||current.origin.equals(operation.stableOrigin)||!seen.add(current.origin)||operation.cancelled)continue;
                    if(attempts++>=2)break;
                    Result resolved=probe(current,operation,route+".resolved");
                    if(resolved.ok){operation.stages.put(route,"discovered-verified");return resolved;}
                }
                operation.stages.put(route,"discovery-no-live-route");return new Result(endpoint,false,"已找到恢复入口，电脑线路还在启动，会继续重试。");
            }
            boolean ok=data.optBoolean("ok")&&"phone-brain".equals(data.optString("name"));
            operation.stages.put(route,ok?"verified":"unexpected-response");
            return new Result(endpoint,ok,ok?"":"连接返回了其他页面，请更新地址。");
        }catch(Exception error){String category=error instanceof java.net.SocketTimeoutException?"timeout":error instanceof javax.net.ssl.SSLException?"tls":error instanceof java.net.UnknownHostException?"dns":error instanceof java.net.ConnectException?"connect":"io";operation.stages.put(route,category);return new Result(endpoint,false,"暂时没有连上电脑；会自动重试，也可以更新配对地址。");}
        finally{if(connection!=null){operation.connections.remove(connection);try{connection.disconnect();}catch(Exception ignored){}}}
    }
}
