// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 群活跃日报（时区/日期边界、调度决策防重复发送、统计口径；fixture SQLite，不读生产库）
  'test-group-stats.mjs',
  // 定时开关（夜里 01:00 暂停 / 07:30 恢复）的决策表：只在夜里生效的脚本，
  // 写错窗口边界没人当场发现，所以用干跑钩子把边界钉住。纯离线。
  'test-ai-schedule.mjs',
  // 群聊服务时限（allow.groupUntil）：运营方承诺"服务到某天为止"，到点必须自动失效。
  'test-service-window.mjs',
  // 群管理命令（禁言/解除）的授权矩阵：**安全关键** —— 只认服务端角色、不看消息文本，
  // 目标保护、时长收敛、危险歧义（/mute <QQ号> 被当分钟）都在这里钉死。纯函数，不联网。
  'test-group-admin.mjs',
  // 违法广告自动处置：反例**全部取自真实群流量的实测假阳性**
  //（SnowLuma 状态播报、群友的反诈宣传、朋友玩笑…），把规则改松就会红。
  'test-auto-mod.mjs',
  // 「禁言王」榜：口径不能被算歪 —— 只算成功的 mute、排除 unmute/别的群/别的日子，
  // 且 UTC 时间戳必须按**本地日**切（否则 00:00–08:00 的禁言会跑到前一天）。
  'test-mute-stats.mjs',
  // 唤醒原因分类：守"被直接叫到必须回、随机瞄一眼可不回"这条行为边界。
  // 之前正因为没有它，被 @ 了也在提示词里邀请模型潜水（群友投诉"爱答不理"）。
  'test-wake-reasons.mjs',
  // 脚本编码约定（含中文的 .ps1 必须带 BOM、.vbs 必须纯 ASCII、含中文的 .bat 必须 chcp 65001）
  // —— 这三条都是「看起来没事、运行期才炸」的静默陷阱，且 PowerShell 7 测不出 5.1 的问题。
  'test-script-encoding.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
];
let failed = 0;
let skipped = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, timeout: 60000, encoding: 'utf8',
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  // 改成捕获输出后再打印：需要识别子测试打的 AUDIT-SKIP 标记，
  // 把它单独统计成"跳过"。否则"缺少外部工具（voice-tool/）"会和真正的回归混在同一个数字里，
  // 既掩盖真问题，也让 34 项里常年飘红 10 项、失去回归信号的意义。
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const skipMarked = /AUDIT-SKIP:/.test(result.stdout ?? '');
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  } else if (skipMarked) {
    skipped++;
  }
}
console.log(`\nAudit suite: ${tests.length - failed - skipped}/${tests.length} scripts passed${skipped ? `, ${skipped} skipped (外部工具缺失)` : ''}${failed ? `, ${failed} failed` : ''}.`);
process.exitCode = failed ? 1 : 0;
