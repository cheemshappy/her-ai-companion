package com.dafeiyu.amadeus;

import java.util.ArrayList;
import java.util.List;

/** Bounded recovery rules shared by the main page and the floating service. */
final class ConnectionPolicy {
    // Android may try several IPv6/IPv4 addresses before TLS succeeds. A real
    // phone completed a cold HTTPS handshake after 23.7s despite per-socket limits.
    static final int ATTEMPT_MS=90000;
    static int connectTimeout(ServerEndpoint endpoint){return endpoint.loopback()?900:5000;}
    static int readTimeout(ServerEndpoint endpoint){return endpoint.loopback()?1800:9000;}
    static long retryDelay(int failures){return Math.min(60000L,5000L*(1L<<Math.min(4,Math.max(0,failures-1))));}
    static List<ServerEndpoint> candidates(String primary,String alternate,String recent){
        return candidates(primary,alternate,recent,java.util.Collections.emptyList());
    }
    static List<ServerEndpoint> candidates(String primary,String alternate,String recent,List<String> backups){
        return candidates(primary,alternate,recent,backups,"");
    }
    static List<ServerEndpoint> candidates(String primary,String alternate,String recent,List<String> backups,String stable){
        List<ServerEndpoint> endpoints=new ArrayList<>();
        List<String> saved=new ArrayList<>();saved.add(primary);saved.add(alternate);saved.add(recent);
        if(backups!=null)for(int i=0;i<Math.min(2,backups.size());i++)saved.add(backups.get(i));
        saved.add(stable);
        for(int i=0;i<saved.size();i++){
            String value=saved.get(i);
            ServerEndpoint endpoint=ServerEndpoint.parse(value);if(endpoint==null)continue;
            // Choosing a public primary explicitly must not resurrect an unrelated historical origin.
            ServerEndpoint selected=ServerEndpoint.parse(primary);
            if(i==2&&selected!=null&&!selected.loopback())continue;
            if(i>=2){
                boolean paired=false;for(ServerEndpoint current:endpoints)if(!endpoint.token.isEmpty()&&endpoint.token.equals(current.token))paired=true;
                if(endpoint.loopback()||!paired)continue;
            }
            boolean duplicate=false;for(ServerEndpoint existing:endpoints)if(existing.origin.equals(endpoint.origin)&&existing.token.equals(endpoint.token)){duplicate=true;break;}
            if(!duplicate)endpoints.add(endpoint);
        }
        return endpoints;
    }
}
