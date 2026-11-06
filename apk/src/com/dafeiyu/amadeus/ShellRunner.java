package com.dafeiyu.amadeus;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Shizuku UserService 的实现：**跑在 shell 身份下**（uid 2000）。
 *
 * 这里的方法就是"ADB 能干的事"。注意它是 Shizuku 通过 bindUserService 启动的，
 * 不是普通的 Android Service，所以不继承 Service —— 只实现 IRunner 的 Stub。
 *
 * ⚠️ 这个类里不能引用 app 的 Activity/Context，它活在另一个进程里。
 */
public class ShellRunner extends IRunner.Stub {

    @Override
    public int uid() {
        try {
            // android.os.Process.myUid() 在 aidl 生成的 Stub 里不能直接用（没有 context），
            // 用反射拿，省一个 import
            Class<?> c = Class.forName("android.os.Process");
            return (int) c.getMethod("myUid").invoke(null);
        } catch (Throwable e) {
            return -1;
        }
    }

    @Override
    public String exec(String command) {
        String cmd = String.valueOf(command == null ? "" : command);
        if (cmd.trim().isEmpty()) return "ERR 空命令";
        try {
            Process p = new ProcessBuilder(new String[]{"sh", "-c", cmd})
                    .redirectErrorStream(true)
                    .start();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            InputStream in = p.getInputStream();
            byte[] buf = new byte[8192];
            int n;
            long deadline = System.currentTimeMillis() + 15000;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (System.currentTimeMillis() > deadline) break;
            }
            boolean done = p.waitFor(10, java.util.concurrent.TimeUnit.MILLISECONDS) || true;
            try { p.destroy(); } catch (Throwable ignored) { }
            String out = bos.toString("UTF-8");
            return out.length() > 6000 ? out.substring(0, 6000) + "…" : out;
        } catch (Throwable e) {
            return "ERR " + e;
        }
    }
}
