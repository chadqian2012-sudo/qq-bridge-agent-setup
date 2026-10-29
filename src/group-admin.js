/**
 * 群管理命令（禁言 / 解除禁言）—— **纯逻辑层，不含任何 IO**。
 *
 * ## 为什么单独一个模块、而且刻意不做成 MCP 工具
 *
 * 禁言是"能让真人闭嘴"的动作，授权判定必须**可测、可审、不可被话术绕过**。所以：
 *
 * 1. **不暴露给模型**。这里没有任何 MCP 工具注册；qq-agent-presets 的工具面里也**没有**
 *    禁言类工具。QQ 群里的 AI 无论被怎么诱导，都没有"禁言"这个动作可调 ——
 *    这比"在提示词里叮嘱它别听诱导"可靠得多，因为提示词是概率性的，工具面是结构性的。
 * 2. **由桥接硬解析斜杠命令**（与 `/role` `/silent` `/reset` 同一套路，见 RULES.md
 *    「管理命令由桥接硬执行（不经过模型）」）。命令在 handleIncoming 里被截住，
 *    根本不会走到会话投递。
 * 3. **授权只认 QQ 服务端下发的事件字段** `sender.role`（OneBot 群消息事件自带），
 *    **绝不解析消息正文**来推断身份 —— 群友写"我是群主"不会产生任何效果。
 * 4. 所有判定集中在本文件的纯函数里，可以脱离网络把权限矩阵测死
 *    （见 scripts/test-group-admin.mjs）。
 *
 * ## 命令语法
 *
 *   /mute            禁言「被引用那条消息」的发件人（默认时长）
 *   /mute 1h         指定时长：30m / 1h / 12h / 3d
 *   /mute @某人 1h   显式指定对象（@ 优先于引用）
 *   /unmute          解除禁言（等价于 duration=0）
 *   /unmute @某人
 *
 * 时长上限由配置给定，超出会被**收敛到上限并在回复里说明**（静默截断会让管理员以为
 * 自己设了更久，反而容易误判）。
 */

/** 默认时长上限：30 天。够长，同时挡住"禁言 100 年"这类手滑或恶意输入。 */
export const DEFAULT_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
/** 默认时长：1 小时（与群规第一条一致）。 */
export const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** 时长单位 → 毫秒 */
const DURATION_UNITS = Object.freeze({
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
});

/** 不写单位时按分钟解释，但这个上限之外的数字一律拒绝。
 *  为什么必须有：`/mute 123456789` 里有人的本意是"指定这个 QQ 号"，而 123456789
 *  作为**分钟**是 234 年。它会被 clamp 成 30 天，然后落到"被引用的那个人"头上 ——
 *  目标与时长同时错位，是会真伤到人的歧义。纯数字超过 7 天就不再当分钟解释。 */
const MAX_BARE_NUMBER_MINUTES = 7 * 24 * 60;

/**
 * 解析时长串：`30m` / `1h` / `12h` / `3d` / 纯数字（按分钟，上限 7 天）。
 * 返回 null 表示无法识别（调用方应拒绝执行，而不是猜一个默认值）。
 */
export function parseDuration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // 纯数字按分钟（`/mute 30` = 30 分钟），这是群里最不容易写错的习惯写法。
  const unit = m[2] ?? 'm';
  if (!m[2] && value > MAX_BARE_NUMBER_MINUTES) return null; // 见上面的说明：不当分钟解释
  const ms = Math.round(value * DURATION_UNITS[unit]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * 解析一条消息文本是不是禁言类命令。
 *
 * @returns {null | {action:'mute'|'unmute', durationMs:number|null, atUserIds:string[],
 *                   durationText:string, explicitDuration:boolean, raw:string}}
 */
export function parseMuteCommand(text) {
  const raw = String(text ?? '').trim();
  // 只认行首命令；允许 `/mute` 与 `／mute`（中文全角斜杠，手机输入法常见）。
  // 结尾用 (?=\s|$) 而不是 \b：中文动词（`/禁言`）后面跟空格时 \b 不成立
  // —— JS 里汉字不是 \w，汉字与空格之间没有词边界，用 \b 会导致中文写法全部失效。
  const m = /^[/／](mute|unmute|禁言|解除禁言)(?=\s|$)\s*([\s\S]*)$/i.exec(raw);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const action = (verb === 'unmute' || verb === '解除禁言') ? 'unmute' : 'mute';
  const rest = m[2] ?? '';

  // 先把 @QQ号 拿出来：OneBot 的 at 段在本函数看不到（纯文本层），
  // 所以 handleIncoming 会把 at 段渲染成「@123456」形式再进来 ——
  // 这里用宽松的串匹配取数字，兼容 `@123` 与 `[CQ:at,qq=123]` 两种残留形态。
  const atUserIds = [];
  for (const mm of rest.matchAll(/@\s*(\d{5,12})|qq=(\d{5,12})/g)) {
    const id = mm[1] ?? mm[2];
    if (id && !atUserIds.includes(id)) atUserIds.push(id);
  }

  // 时长：取"去掉 @ 段之后"的第一个能解析成时长的词
  const withoutAt = rest.replace(/@\s*\d{5,12}/g, ' ').replace(/qq=\d{5,12}/g, ' ');
  let durationMs = null;
  let durationText = '';
  for (const token of withoutAt.split(/\s+/).filter(Boolean)) {
    const parsed = parseDuration(token);
    if (parsed !== null) { durationMs = parsed; durationText = token; break; }
  }

  if (action === 'unmute') durationMs = 0;

  return { action, durationMs, durationText, explicitDuration: durationText !== '', atUserIds, raw };
}

/**
 * 从**原始 OneBot 消息段**里分析出命令的位置与 @ 对象。
 *
 * 为什么必须有这一层（2026-10-03 的真实故障）：
 *
 *   群主的习惯是**先 @ 机器人再写命令**：
 *     `@DeepSeek V4.1 Flash /mute @小心地超人 1m`
 *   而 `parseMuteCommand` 只认「命令在行首」，于是这条消息没被当成命令，
 *   直接落到群里那个 AI 手里 —— AI 没有禁言工具，只能回一句"我按不动"。
 *   表面上像"权限没生效"，实际是**命令根本没被解析到**。
 *
 *   另外，渲染后的文本里 @ 是**昵称**（`@小心地超人`），拿不到 QQ 号；
 *   禁言对象必须从原始 `at` 段的 `data.qq` 取。
 *
 * 返回：
 *   - atUserIds：消息里被 @ 的人（**排除机器人自己**，否则会被当成"一次 @ 了多个人"）
 *   - restIndex：从第几段开始才是命令正文（跳过开头的 at 段 / 引用段 / 纯空白文本段）
 *
 * @param {Array} segments
 * @param {object} o
 * @param {string} o.botId 机器人自己的 QQ（用于把自己从 @ 列表里剔掉）
 */
export function analyzeCommandSegments(segments, { botId = '' } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const bot = String(botId ?? '');
  const atUserIds = [];
  for (const s of segs) {
    if (s?.type !== 'at') continue;
    const qq = String(s?.data?.qq ?? '').trim();
    if (!/^\d+$/.test(qq)) continue;      // 忽略 @全体成员（qq=all）等非数字
    if (bot && qq === bot) continue;      // 机器人自己不算"禁言对象"
    if (!atUserIds.includes(qq)) atUserIds.push(qq);
  }

  let restIndex = 0;
  while (restIndex < segs.length) {
    const s = segs[restIndex];
    const type = s?.type;
    if (type === 'at' || type === 'reply') { restIndex += 1; continue; }
    if (type === 'text' && !String(s?.data?.text ?? '').trim()) { restIndex += 1; continue; }
    break;
  }
  return { atUserIds, restIndex };
}

/** 这条文本里**是否可能**含禁言命令（廉价预筛，避免对每条群消息都做分段解析）。 */
export function looksLikeMuteCommand(text) {
  return /[/／]\s*(mute|unmute|禁言|解除禁言)(?=\s|$)/i.test(String(text ?? ''));
}

/**
 * 命令里"看起来像时长但解析不出来"的词 —— 用于给出明确报错，而不是默默用默认值。
 * 例如 `/mute 2hs`：调用方应回复"时长无法识别"，而不是按默认 1 小时执行。
 */
export function looksLikeBadDuration(text) {
  const rest = String(text ?? '').trim();
  if (!rest) return '';
  const withoutAt = rest.replace(/@\s*\d{5,12}/g, ' ').replace(/qq=\d{5,12}/g, ' ');
  for (const token of withoutAt.split(/\s+/).filter(Boolean)) {
    // 以数字开头、又解析不出时长 → 大概率是写错的时长（也可能是一个不受支持的裸 QQ 号，
    // 两种情况都该报错让管理员改写成 @ 形式，而不是猜）。
    if (/^\d/.test(token) && parseDuration(token) === null) return token;
  }
  return '';
}

/**
 * 授权判定：**只看服务端下发的角色**，不看消息正文，不看模型判断。
 *
 * @param {object} o
 * @param {string} o.senderRole      事件里的 sender.role（owner / admin / member）
 * @param {string|number} o.senderId
 * @param {string[]} o.authorityRoles 允许下令的角色（默认只 owner）
 * @param {string[]} o.authorityUserIds 显式追加的 QQ 白名单（默认空）
 * @param {string|number} o.groupId 发起命令的群号（用于单群关闭判定）
 * @param {Array<string|number>} o.disabledGroups 管理员指定的"本群不开放群管理命令"群号
 * @returns {{ok:boolean, reason:string}}
 */
export function authorizeMuteCommand({
  senderRole, senderId, authorityRoles = ['owner'], authorityUserIds = [], groupId = '', disabledGroups = []
}) {
  // 单群**关闭**优先于任何授权：它是一条"这个群不执行禁言"的硬规则，
  // 不能因为调用者在 authorityUserIds 里、或是服务端下发了 owner 角色就被绕过。
  // 否则"把某个群关掉"就只是把默认路径关掉，白名单里的人照样能禁言——那正是要防的情况。
  const gid = String(groupId ?? '').trim();
  const disabled = (disabledGroups ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (gid && disabled.includes(gid)) {
    return { ok: false, reason: `本群（${gid}）已关闭群管理命令（管理员在 config.json groupAdmin.disabledGroups 指定）` };
  }

  const role = String(senderRole ?? '').trim().toLowerCase();
  const id = String(senderId ?? '').trim();
  const roles = (authorityRoles ?? []).map((r) => String(r ?? '').trim().toLowerCase());
  const ids = (authorityUserIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);

  if (id && ids.includes(id)) return { ok: true, reason: 'allowlist' };
  if (roles.includes(role)) return { ok: true, reason: `role:${role}` };

  // 群主身份只可能来自服务端 role，这里显式说明，避免以后有人图省事改成解析文本。
  return { ok: false, reason: `sender role=${role || '未知'} 不在授权角色（${roles.join('/') || '空'}）内` };
}

/**
 * 目标解析：显式 @ 优先，其次"被引用的那条消息"的发件人。
 *
 * @returns {{ok:boolean, targetId:string|null, source:'at'|'reply'|null, reason:string}}
 */
export function resolveMuteTarget({ atUserIds = [], replySenderId = null } = {}) {
  const at = (atUserIds ?? []).map(String).filter(Boolean);
  if (at.length > 1) return { ok: false, targetId: null, source: null, reason: '一次只能禁言一个人（检测到多个 @）' };
  if (at.length === 1) return { ok: true, targetId: at[0], source: 'at', reason: '' };
  const r = replySenderId === null || replySenderId === undefined ? '' : String(replySenderId).trim();
  if (r) return { ok: true, targetId: r, source: 'reply', reason: '' };
  return { ok: false, targetId: null, source: null, reason: '没指定对象：请 @ 对方，或引用他的消息后再发命令' };
}

/**
 * 自我保护 / 保护他人：机器人自己、群主、其它管理员都不该被这条命令禁言。
 * QQ 服务端本来也会拒绝，但**在发请求之前就拒绝**才能给出准确回复、也避免产生
 * "看起来执行了其实失败"的错觉。
 *
 * @param {object} o
 * @param {string} o.targetId
 * @param {string} o.botId
 * @param {string} o.groupOwnerId
 * @param {string} o.targetRole   目标在群里的角色（若已知）
 */
export function checkMuteTargetSafety({ targetId, botId, groupOwnerId, targetRole = '' }) {
  const t = String(targetId ?? '');
  if (!t) return { ok: false, reason: '目标为空' };
  if (String(botId ?? '') && t === String(botId)) return { ok: false, reason: '不能禁言机器人自己' };
  if (String(groupOwnerId ?? '') && t === String(groupOwnerId)) return { ok: false, reason: '不能禁言群主' };
  const role = String(targetRole ?? '').toLowerCase();
  if (role === 'owner') return { ok: false, reason: '不能禁言群主' };
  if (role === 'admin') return { ok: false, reason: '不能禁言管理员（QQ 也不允许）' };
  return { ok: true, reason: '' };
}

/** 把时长收敛到上限。返回是否发生了收敛，便于回复里如实说明。 */
export function clampDuration(durationMs, maxMs = DEFAULT_MAX_DURATION_MS) {
  const d = Number(durationMs);
  const cap = Number(maxMs) > 0 ? Number(maxMs) : DEFAULT_MAX_DURATION_MS;
  if (!Number.isFinite(d) || d < 0) return { ms: 0, clamped: false };
  if (d > cap) return { ms: cap, clamped: true };
  return { ms: d, clamped: false };
}

/** 人类可读时长（回复与日志共用）。 */
export function humanDuration(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '0（解除）';
  const d = Math.floor(n / 86400000);
  const h = Math.floor((n % 86400000) / 3600000);
  const m = Math.floor((n % 3600000) / 60000);
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分钟`);
  if (!parts.length) parts.push(`${Math.round(n / 1000)} 秒`);
  return parts.join(' ');
}

/**
 * 生成"被拒绝"的审计日志行。
 *
 * 被拒绝时**不在群里回复**（"忽略诱导"：给诱导者反馈只会让它换话术继续试），
 * 但必须留痕 —— 否则"谁在试图指使机器人禁言别人"这件事就查不到了。
 */
export function formatDeniedAudit({ key, senderId, senderRole, text, reason, atMs = Date.now() }) {
  const stamp = new Date(atMs).toISOString();
  const oneLine = String(text ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  return `${stamp} DENY ${key} sender=${senderId} role=${senderRole || '?'} reason=${reason} text=${oneLine}`;
}

/** 生成"已执行"的审计日志行。 */
export function formatExecutedAudit({ key, senderId, targetId, action, durationMs, clamped, ok, detail, atMs = Date.now() }) {
  const stamp = new Date(atMs).toISOString();
  return `${stamp} ${ok ? 'OK  ' : 'FAIL'} ${key} by=${senderId} target=${targetId} `
    + `action=${action} duration=${humanDuration(durationMs)}${clamped ? '(clamped)' : ''} detail=${detail ?? ''}`;
}
