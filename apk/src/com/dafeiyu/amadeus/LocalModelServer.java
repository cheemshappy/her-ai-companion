package com.dafeiyu.amadeus;

import android.content.res.AssetManager;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;

/**
 * 极简本地 HTTP 服务：把打进 APK 的 Live2D 模型喂给 WebView。
 *
 * 为什么需要它：
 *   公网隧道（serveo）对单个大文件会在 ~14 秒左右掐断，2.2MB 的 .moc3 根本下不来；
 *   而模型放进 assets 后由本机 127.0.0.1 提供，秒开且离线可用。
 *
 * 只支持 GET / HEAD，只读 assets/model/ 下的东西，绑定 127.0.0.1（外部访问不到）。
 */
public class LocalModelServer {

    public static final int PORT = 8791;
    private static final String ROOT = "model/";

    private final AssetManager assets;
    private ServerSocket server;
    private Thread thread;
    private volatile boolean running = false;

    public LocalModelServer(AssetManager assets) {
        this.assets = assets;
    }

    /** 有没有打包模型？没有就不用起服务。 */
    public boolean hasBundledModel() {
        try {
            String[] top = assets.list("model");
            return top != null && top.length > 0;
        } catch (IOException e) {
            return false;
        }
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + PORT + "/";
    }

    public void start() {
        if (running) return;
        running = true;
        thread = new Thread(() -> {
            try {
                server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
                while (running) {
                    Socket s = server.accept();
                    new Thread(() -> handle(s)).start();
                }
            } catch (IOException e) {
                running = false;
            }
        }, "local-model-server");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(20000);
            InputStream in = s.getInputStream();
            OutputStream out = new BufferedOutputStream(s.getOutputStream());

            // 只读请求行足够（我们不需要 header）
            StringBuilder sb = new StringBuilder();
            int c;
            while ((c = in.read()) != -1 && c != '\n' && sb.length() < 2048) sb.append((char) c);
            String line = sb.toString().trim();
            String[] parts = line.split(" ");
            if (parts.length < 2) { writeStatus(out, 400, "bad request"); return; }

            String method = parts[0];
            String path = parts[1];

            // 把剩下的 header 读掉（预检/大请求都不至于把连接卡住）
            StringBuilder rest = new StringBuilder();
            int prev = 0;
            while (prev != -1 && rest.length() < 8192) {
                prev = in.read();
                if (prev == -1) break;
                rest.append((char) prev);
                if (rest.length() >= 4 && rest.charAt(rest.length() - 4) == '\r' && rest.charAt(rest.length() - 3) == '\n'
                        && rest.charAt(rest.length() - 2) == '\r' && rest.charAt(rest.length() - 1) == '\n') break;
            }

            // Chrome 的 Private Network Access：https 页面访问 127.0.0.1 会先发 OPTIONS 预检
            if ("OPTIONS".equals(method)) {
                String pre = "HTTP/1.1 204 No Content\r\n"
                        + "Access-Control-Allow-Origin: *\r\n"
                        + "Access-Control-Allow-Methods: GET,HEAD,OPTIONS\r\n"
                        + "Access-Control-Allow-Headers: *\r\n"
                        + "Access-Control-Allow-Private-Network: true\r\n"
                        + "Connection: close\r\n\r\n";
                out.write(pre.getBytes("UTF-8"));
                out.flush();
                return;
            }
            if (!"GET".equals(method) && !"HEAD".equals(method)) { writeStatus(out, 405, "method not allowed"); return; }
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            path = URLDecoder.decode(path, "UTF-8");
            if (!path.startsWith("/")) path = "/" + path;
            if (path.contains("..") || path.contains("\\") || path.indexOf(0) >= 0) { writeStatus(out, 403, "forbidden"); return; }
            // /model/xxx -> assets model/xxx
            String assetPath = path.startsWith("/model/") ? path.substring(1) : ROOT + path.substring(1);

            InputStream file;
            try {
                file = assets.open(assetPath);
            } catch (IOException e) {
                writeStatus(out, 404, "not found");
                return;
            }

            if ("HEAD".equals(method)) {
                file.close(); writeHeaders(out, 200, guessType(assetPath), -1); return;
            }
            writeHeaders(out, 200, guessType(assetPath), -1);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = file.read(buf)) > 0) out.write(buf, 0, n);
            file.close();
            out.flush();
        } catch (Exception ignored) {
        }
    }

    private void writeHeaders(OutputStream out, int code, String type, long len) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(code == 200 ? " OK" : " Not Found").append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Private-Network: true\r\n");
        h.append("Cache-Control: public, max-age=86400\r\n");
        if (len >= 0) h.append("Content-Length: ").append(len).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
    }

    private void writeStatus(OutputStream out, int code, String msg) throws IOException {
        byte[] body = msg.getBytes("UTF-8");
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(" ").append(msg).append("\r\n");
        h.append("Content-Type: text/plain; charset=utf-8\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Private-Network: true\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private static String guessType(String p) {
        String l = p.toLowerCase();
        if (l.endsWith(".json")) return "application/json; charset=utf-8";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        if (l.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
