package com.dafeiyu.amadeus;

/** One connection attempt at a time. Older probes cannot replace a newer choice. */
final class ConnectionAttempt {
    private int generation;
    private boolean busy;
    synchronized int begin() { if (busy) return 0; busy=true; return ++generation; }
    synchronized boolean current(int ticket) { return ticket>0&&busy&&ticket==generation; }
    synchronized boolean finish(int ticket) { if(!current(ticket))return false;busy=false;return true; }
    synchronized void cancel() { generation++;busy=false; }
    synchronized boolean busy(){return busy;}
}
