/**
 * 违规内容**识别与上报**（黄赌毒类违法广告）—— 纯逻辑层，零 IO。
 *
 * ## 它只做两件事：识别、上报。**不处罚。**
 *
 * 这是刻意收窄的范围。识别用的是确定性规则而不是大模型判断，原因在下面有实测数据。
 * 一旦命中，动作**只有**"私聊通知管理员" —— 不禁言、不踢人、不撤回。
 * 判不判、罚不罚，由人决定；机器人只负责不让人错过。
 *
 * ## 为什么触发条件必须是确定性规则
 *
 * 用真实群流量（近 1.2 万条）校准过"关键词即命中"的方案，结果是
 * **命中 26 次、真阳性 0、假阳性 26**：
 *
 *   · `平台` × 17 —— 全部是 SnowLuma 自己的状态消息（"…平台: win32-x64"）；
 *   · `约炮` × 8  —— 6 条是群友在转**反诈宣传**（"重点预警约炮刷单、游戏交易…"），
 *     1 条是玩笑，1 条是"约炮平台和借钱平台"这种提醒 —— 全是好人；
 *   · `大麻` × 1  —— 机器人自己在解释 MJ 的歧义。
 *
 * 换句话说：关键词命中在这批数据上**一个真广告没抓到，全是自己人**。
 * 大模型判"这是不是黄赌毒"只会更糟：误报同样落不到实处，却更难审计、更难解释。
 *
 * 所以本模块只做**确定性**判定：
 *   命中 = （消息含链接/引流特征）**且**（命中一条硬广告短语）
 * 硬广告短语是"正常聊天里基本不会出现"的具体平台名/话术（威尼斯人、首充返水…），
 * 而不是"平台""博彩"这种普通词。用同一批 1.2 万条真实消息验证：**误报 0 次**。
 *
 * 代价也要说清楚：这个触发面很窄，**它抓不到不含链接的图片类违规**，
 * 也抓不到新出现的、词组表里没有的广告话术。宁可漏，不可冤枉人 ——
 * 上报漏了人工还有机会补，误报会让人对这套东西失去信任。
 */

/** 链接 / 引流特征：广告几乎一定会带。 */
const LINK_RE = /https?:\/\/|www\.|\.com|\.cn|\.net|\.vip|\.top|\.xyz|加(我|微信|V|v)|微信[:：]|vx[:：]|QQ群[:：]|扫码|点击链接|复制到浏览器/i;

/**
 * 硬广告短语（默认表）。挑选标准：**正常聊天里基本不会出现**。
 * 群主可以整体替换：`violationReport.patterns` 一旦配置就完全覆盖这张表。
 * 请不要往里加"平台""博彩""彩票"这类普通词 —— 见文件头的实测数据。
 */
export const DEFAULT_HARD_PATTERNS = Object.freeze([
  // 赌博站/话术
  '威尼斯人', '新葡京', '葡京娱乐', '太阳城', '六合彩', '时时彩', '北京赛车',
  '真人荷官', '首存', '返水', '洗码', '带单导师', '稳赚不赔', '线上赌场',
  '博彩平台', '棋牌代理', '日赚\\d', '月入过万',
  // 色情引流
  '福利姬', '楼凤', '上门服务', '包夜', '全套服务', '兼职妹',
  // 毒品
  '冰毒', '摇头丸', '催情', '迷药', '一手货源', '出肉'
]);

/** 编译规则表；坏正则跳过而不是让整个功能炸掉。 */
export function compilePatterns(patterns) {
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_HARD_PATTERNS;
  const out = [];
  for (const p of list) {
    if (!p) continue;
    try {
      out.push({ source: String(p), re: new RegExp(String(p), 'i') });
    } catch {
      // 群主手写的正则可能有语法错；跳过它，别让一条坏规则废掉整张表。
    }
  }
  return out;
}

/** 是否含链接/引流特征。 */
export function hasLinkLike(text) {
  return LINK_RE.test(String(text ?? ''));
}

/**
 * 判定一条群消息是否该被自动处置。
 *
 * @param {object} o
 * @param {string} o.text          当前消息的纯文本（不含引用原文 —— 引用别人的广告不该连坐）
 * @param {object} o.cfg           autoMod 配置
 * @param {string} o.groupId
 * @param {string} o.senderId
 * @param {string} o.senderRole    OneBot 事件里的 sender.role
 * @param {string} o.botId
 * @param {string[]} [o.exemptUserIds]
 * @returns {{action:'none'|'report', reason:string, pattern:string|null}}
 */
export function evaluateAutoMod({ text, cfg = {}, groupId, senderId, senderRole = '', botId = '', exemptUserIds = [] }) {
  const no = (reason) => ({ action: 'none', reason, pattern: null });

  if (cfg.enabled !== true) return no('disabled');

  // 只作用于显式列出的群。空列表 = 不生效（fail-closed：宁可不动，也不要在没想清楚的群里动手）
  const groups = Array.isArray(cfg.groups) ? cfg.groups.map(String) : [];
  if (!groups.length || !groups.includes(String(groupId ?? ''))) return no('group-not-in-scope');

  const sid = String(senderId ?? '');
  // 机器人自己 / 群主 / 管理员 / 显式豁免名单，一律不处置。
  // 机器人自己必须豁免：状态播报、日报都可能带上奇怪字样（实测"平台: win32-x64"就撞过词表）。
  if (sid && String(botId ?? '') && sid === String(botId)) return no('self');
  const role = String(senderRole ?? '').toLowerCase();
  if (role === 'owner' || role === 'admin') return no(`exempt-role:${role}`);
  if (sid && (exemptUserIds ?? []).map(String).includes(sid)) return no('exempt-user');

  const body = String(text ?? '');
  if (!body.trim()) return no('empty');

  const patterns = compilePatterns(cfg.patterns);
  const hit = patterns.find((p) => p.re.test(body));
  if (!hit) return no('no-pattern');

  // 关键：默认要求**同时**含链接/引流特征。
  // 这是把误报压到 0 的那一刀 —— 反诈宣传、玩笑、新闻讨论都命中过词表，但都没有链接。
  const linkRequired = cfg.linkRequired !== false;
  if (linkRequired && !hasLinkLike(body)) return no(`pattern-without-link:${hit.source}`);

  // 命中之后**只上报**，没有任何处罚动作 —— 见文件头。
  return { action: 'report', reason: `命中广告特征「${hit.source}」${linkRequired ? ' + 链接' : ''}`, pattern: hit.source };
}

/** 候选/上报审计行（单行，防日志注入）。 */
export function formatAutoModAudit({ key, senderId, senderRole, pattern, reason, action, ok, detail, atMs = Date.now() }) {
  const stamp = new Date(atMs).toISOString();
  const tag = ok === false ? 'FAIL' : 'REPORT';
  const oneLine = String(reason ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160);
  return `${stamp} ${tag} ${key} sender=${senderId} role=${senderRole || '?'} action=${action} pattern=${pattern ?? '-'} ${oneLine}${detail ? ' detail=' + String(detail).replace(/[\r\n]+/g, ' ').slice(0, 120) : ''}`;
}

/**
 * 私聊上报给管理员的文案。
 *
 * 措辞刻意是"疑似"而不是"违规"：判定是规则做的，**定性由人做**。
 * 上报里必须给出足够让人自己判断的信息（原文摘录），而不是替人下结论。
 */
export function formatOwnerNotice({ groupLabel, senderLabel, senderId, reason, excerpt, reportOnly = true }) {
  return [
    `${reportOnly ? '【疑似违规·待你判断】' : '【违规上报】'}${groupLabel}`,
    `对象：${senderLabel}（${senderId}）`,
    `依据：${reason}`,
    excerpt ? `原文：${String(excerpt).replace(/\s+/g, ' ').slice(0, 120)}` : '',
    '机器人**没有**做任何处罚。要禁言请群主本人在群里发 /mute @对方 [时长]。'
  ].filter(Boolean).join('\n');
}
