package com.dafeiyu.amadeus;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 唤醒词用的离线识别模型（Vosk 中文小模型，约 44MB）。
 *
 * 为什么不塞进 APK：模型 44MB，塞进 assets 每次编译都要把它写一遍（还拖慢安装）。
 * 这里第一次用到时从电脑（phone-brain 的 /model/vosk-cn.zip）下一次，解压到
 * filesDir 里，以后就直接用。反正她也离不开那台电脑。
 */
public final class VoskModel {

    private static final String TAG = "amadeus-vosk";
    private static final String DIR_NAME = "vosk-model-small-cn";
    private static final long MIN_ZIP = 30L * 1024 * 1024;

    private VoskModel() { }

    /** 返回模型目录（已就绪）；没就绪会下载 + 解压（阻塞，放后台线程调）。 */
    public static File ensure(Context ctx) throws Exception {
        File dir = new File(ctx.getFilesDir(), DIR_NAME);
        if (ready(dir)) {
            dump(dir);          // 已经解压过：也打一遍，方便排查"模型加载失败"
            return dir;
        }

        File zip = new File(ctx.getCacheDir(), "vosk-cn.zip");
        if (!zip.exists() || zip.length() < MIN_ZIP) downloadFromAny(ctx, zip);

        // 解压最多试两次：第一次要是被截断/写坏了，删干净重来
        for (int attempt = 0; attempt < 2; attempt++) {
            Log.i(TAG, "解压模型 " + zip.length() / 1024 / 1024 + "MB（第 " + (attempt + 1) + " 次）");
            deleteTree(dir);
            int files = unzip(zip, ctx.getFilesDir());
            Log.i(TAG, "  解开 " + files + " 个文件");
            if (ready(dir)) break;
            Log.w(TAG, "  解压不完整，重来");
            // noinspection ResultOfMethodCallIgnored
            zip.delete();
            if (attempt == 0) {
                // 重新下一遍（可能是下载被截断）
                downloadFromAny(ctx, zip);
            }
        }
        // 解压完就删，省 44MB 缓存
        // noinspection ResultOfMethodCallIgnored
        zip.delete();
        if (!ready(dir)) throw new Exception("模型解压后不完整（缺 conf/model.conf）");
        dump(dir);
        Log.i(TAG, "模型就绪：" + dir.getAbsolutePath());
        return dir;
    }

    /** 把关键文件的大小打出来（模型加载失败时一眼看出是不是解压坏了）。 */
    private static void dump(File dir) {
        String[] must = { "am/final.mdl", "conf/mfcc.conf", "conf/model.conf",
                "graph/HCLr.fst", "graph/Gr.fst", "ivector/final.ie", "ivector/final.dubm",
                "ivector/final.mat", "ivector/global_cmvn.stats" };
        for (String m : must) {
            File f = new File(dir, m);
            Log.i(TAG, "  " + m + " = " + (f.exists() ? f.length() + "B" : "缺失"));
        }
    }

    /** 判断模型是否真的完整（看一个**文件**，别只看目录 —— 空目录会骗人）。 */
    private static boolean ready(File dir) {
        return new File(dir, "conf/model.conf").isFile() && new File(dir, "am/final.mdl").isFile();
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        // noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 依次试主地址、备用地址下载模型。 */
    private static void downloadFromAny(Context ctx, File zip) throws Exception {
        Exception last = null;
        for (int i = 0; i < 2; i++) {
            String[] ep = Proactive.endpointParts(i);
            if (ep == null) continue;
            try {
                Log.i(TAG, "下载模型 ← " + ep[0]);
                long got = download(ep[0], ep[1], "/model/vosk-cn.zip", zip);
                if (got < MIN_ZIP) throw new Exception("模型太小：" + got);
                return;
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "下载失败 (" + ep[0] + "): " + e);
            }
        }
        throw last != null ? last : new Exception("没有可用的服务器地址");
    }

    private static long download(String base, String token, String path, File out) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(120000);
            if (token != null && !token.isEmpty()) c.setRequestProperty("x-amadeus-key", token);
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong();
            long got = 0;
            try (InputStream in = c.getInputStream();
                 OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); got += n; }
            }
            Log.i(TAG, "  下了 " + got + "B（服务器说 " + total + "B）");
            if (total > 0 && got != total) throw new Exception("下载被截断：" + got + "/" + total);
            return got;
        } finally {
            c.disconnect();
        }
    }

    private static int unzip(File zip, File destRoot) throws Exception {
        int files = 0;
        String root = destRoot.getAbsolutePath();
        // ⚠️ 用 ZipFile（读**中央目录**），不要用 ZipInputStream（顺序读本地头）。
        //    实测这个模型 zip（HF 上下的）用 ZipInputStream 只能读出 9 个文件就"结束"了，
        //    但 unzip -l 能看到全部 15 个 —— 典型的就是本地头和中央目录不一致。
        try (java.util.zip.ZipFile zf = new java.util.zip.ZipFile(zip)) {
            java.util.Enumeration<? extends java.util.zip.ZipEntry> en = zf.entries();
            byte[] buf = new byte[64 * 1024];
            while (en.hasMoreElements()) {
                java.util.zip.ZipEntry e = en.nextElement();
                String name = e.getName().replace('\\', '/');
                if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store") || name.endsWith("/.DS_Store")) continue;
                File out = new File(destRoot, name);
                String abs = out.getAbsolutePath();
                if (!abs.startsWith(root)) continue;                 // 防 zip slip
                if (e.isDirectory()) {
                    // noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) {
                    // noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
                try (InputStream in = zf.getInputStream(e);
                     OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                files++;
            }
        }
        return files;
    }
}
