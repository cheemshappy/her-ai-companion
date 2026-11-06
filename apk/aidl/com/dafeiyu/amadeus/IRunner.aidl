// Shizuku UserService 的接口：Shizuku 会用 **shell 身份**启动这个服务的实现类，
// 所以里面的代码天然拥有 ADB 权限（uid 2000）。
//
// ⚠️ AIDL 里不能写常量字段（`int VERSION = 1;` 会报 syntax error），版本号在 Java 侧传。
package com.dafeiyu.amadeus;

interface IRunner {
    /** 执行一条 shell 命令，返回合并后的输出。 */
    String exec(String command);

    /** 确认一下跑在什么 uid（调试用，2000 = shell = ADB 权限，-1 = 拿不到）。 */
    int uid();
}
