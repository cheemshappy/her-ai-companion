package com.dafeiyu.amadeus;

/** Bounded page retries. Late and duplicate failures cannot overwrite a new page. */
final class PageRecovery {
    private String current="";
    private int generation=0,handled=-1,attempts=0;
    int start(String url){current=url==null?"":url;return ++generation;}
    int failure(String url){
        if(url==null||!url.equals(current)||handled==generation)return -1;
        handled=generation;
        return url.startsWith("https://")&&attempts++<2?generation:0;
    }
    boolean waiting(int ticket){return ticket>0&&ticket==generation&&handled==generation;}
    void success(){attempts=0;}
    void reset(){current="";generation++;handled=-1;attempts=0;}
    static boolean transientHttp(int status){return status==408||status==429||status==500||status==502||status==503||status==504;}
}
