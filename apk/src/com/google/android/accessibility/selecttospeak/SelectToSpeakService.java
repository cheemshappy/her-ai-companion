package com.google.android.accessibility.selecttospeak;

import com.dafeiyu.amadeus.CtrlService;

/**
 * 伪装成系统"随选朗读（Select to Speak）"的无障碍服务（2026-10-21）。
 *
 * 为什么要这个类：**微信从 8.0.52 起按无障碍服务的"类名"做白名单**，
 * 白名单外的服务拿到的节点树是空的（连 uiautomator 都只看到一个 0×0 空节点）。
 * 微信只校验服务 ID **斜杠后面那半截**（类名），不校验包名 ——
 * 这是 AutoJs6 作者在 issue 里明确说过的（SuperMonster003/AutoJs6#463）：
 * "将自身应用的无障碍服务名称（完整 ID 的后半部分）设置为白名单内
 *  （典型的是 com.google.android.accessibility.selecttospeak.SelectToSpeakService）"。
 *
 * 所以这里在本应用里放一个**同名类**（包名无关），AndroidManifest 里注册成
 * 无障碍服务；启用它以后，微信会把它当成系统朗读服务，节点树就正常给了。
 *
 * ⚠️ 这不是"真实的辅助功能"：名字与功能不符。只在本人的手机、本人的账号上用；
 *    微信以后如果加包名校验，这个办法会失效（那时只能退回截图 OCR）。
 */
public class SelectToSpeakService extends CtrlService {
}
