/**
 * 唤醒原因的分类 —— 纯逻辑，零 IO。
 *
 * ## 为什么需要这个区分
 *
 * reserved2 的唤醒原因有好几种，它们的**语义完全不同**，不能用同一套话术对待：
 *
 * | 原因 | 语义 | 该不该必须回 |
 * | --- | --- | --- |
 * | `atMention` | 有人 @ 了你 / 引用了你的消息 | **必须回** |
 * | `nameMention` | 有人叫了你的名字 | **必须回** |
 * | `question` | 有人向你提问 | **必须回** |
 * | `private` | 私聊 | **必须回** |
 * | `keyword:xxx` | 有人说到你的关键词 | **必须回**（叫到名字的等价物） |
 * | `speaker:xxx` | 管理员指定的成员说话了 | **必须回** |
 * | `probability` | 5% 概率随机瞄一眼普通闲聊 | 可以不回 |
 * | `poke` | 有人拍了一拍（可能拍的不是你） | 看情况 |
 * | `timeout` | 睡够了自然醒 | 可以不回 |
 * | `proactiveCheck` | 群里冷场，给你一次主动冒泡机会 | 可以不回 |
 * | `replyCheck` | 回来看看有没有人回你 | 可以不回 |
 *
 * ## 曾经的 bug（2026-10-03）
 *
 * `buildWakePromptV2` 只对 `bootstrap`/`timeout`/`replyCheck`/`proactiveCheck`/`poke`
 * 做了特殊处理，**其余全部走同一个兜底模板**，而那个模板里写着
 * 「自行决定是否发言」「插不上再看情况潜水」—— 也就是说**被 @ 了也在邀请它潜水**。
 * 叠加全局提示里「话题与你无关时看完继续潜水」，结果就是群友 @ 它、它爱答不理。
 *
 * 更讽刺的是：`allowSilent`（"必须回"）那套机制本来就有，但只存在于**旧路径**
 * `buildBatchPrompt`，reserved2 根本没接上。
 *
 * ## 设计取舍
 *
 * 「不要没话硬接」（用户要求）和「被叫醒不能爱答不理」（用户要求）并不矛盾 ——
 * 前者针对**没人叫你的普通闲聊**，后者针对**有人在直接跟你说话**。
 * 这个模块就是把这条界线固化下来，避免将来又有人把两者混为一谈。
 */

/** 算作"有人在直接跟 AI 说话"、因此**必须回一句**的唤醒原因。 */
// pokeMe = 有人拍的是**机器人自己**（区别于 poke：拍的是别人或不知道）。
// 以前两者共用一个 'poke'，结果"被拍到自己"这个明确的点对点动作和"群里别人互拍"一样
// 只拿到优先级 0、也不算定向 —— 实测日志里出现过 poke 被压在一堆概率唤醒后面排队。
const DIRECT_REASONS = new Set(['atMention', 'nameMention', 'question', 'private', 'pokeMe']);
/** 带前缀的唤醒原因（`keyword:大肥鱼` / `speaker:某人`），同样算"叫到它"。 */
const DIRECT_PREFIXES = ['keyword:', 'speaker:'];

/** 这次唤醒是不是"有人在直接跟 AI 说话"（区别于概率性瞄一眼）。 */
export function isDirectedWakeReason(reason) {
  const r = String(reason ?? '').trim();
  if (!r) return false;
  if (DIRECT_REASONS.has(r)) return true;
  return DIRECT_PREFIXES.some((p) => r.startsWith(p));
}

/** 把唤醒原因写成人话，用于注入提示词（让模型知道究竟是谁在叫它）。 */
export function describeWakeReason(reason) {
  const r = String(reason ?? '').trim();
  switch (r) {
    case 'atMention': return '@ 了你（或引用了你的消息）';
    case 'nameMention': return '提到了你的名字';
    case 'question': return '向你提了个问题';
    case 'private': return '在私聊里跟你说话';
    case 'poke': return '有人拍了一拍';
    case 'timeout': return '你设置的潜水时间到了';
    case 'proactiveCheck': return '群里冷清了一段时间';
    case 'replyCheck': return '回来看看有没有人回你';
    case 'bootstrap': return '会话刚接入';
    default: break;
  }
  if (r.startsWith('keyword:')) return `说到了你的关键词「${r.slice('keyword:'.length)}」`;
  if (r.startsWith('speaker:')) return `${r.slice('speaker:'.length)} 说话了`;
  if (r === 'pokeMe') return '有人拍了一拍（拍的是你）';
  if (r === 'probability') return '概率触发（只是随机瞄一眼）';
  return r || '未知原因';
}

/** 拍一拍相关原因：`poke` 可能拍的是别人（不能强制回应），`pokeMe` 拍的是机器人自己。 */
export function isPokeWakeReason(reason) {
  const r = String(reason ?? '').trim();
  return r === 'poke' || r === 'pokeMe';
}

/**
 * 唤醒优先级：**会话繁忙时决定哪条积压的唤醒先被投递**。
 *
 * 数字本身没有绝对含义，只有相对顺序有意义：
 * 有人在直接说话（@ / 提问 / 指定成员 / 名字 / 关键词）必须排在
 * 概率性偷看（`probability`，表里没有 = 0）和各类定时唤醒之前。
 *
 * 之前两处积压队列都用 FIFO（`shift()`），@ 会排在一堆 probability 后面等 ——
 * 每次投递都是一个完整回合，群里体感就是"@它半天不理"。
 */
export const WAKE_PRIORITY = Object.freeze({
  private: 100,
  atMention: 90,
  // 有人拍的是机器人自己：明确的点对点动作，和"被叫名字"同级。
  // （不写这一条时 wakePriority('pokeMe') 会落到兜底的 0，排在概率唤醒之后。）
  pokeMe: 85,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20
});

/** 唤醒原因可能带子类型（`keyword:小鲸鱼`、`speaker:昵称`），取冒号前的基名。 */
export function wakePriority(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}

/**
 * 触发判定（**纯函数**）：这条消息该用哪个原因唤醒，`null` = 不唤醒。
 *
 * 顺序即优先级，其中有一条是**反直觉但必须**的：**定向判定必须排在 anyMessage 之前**。
 * 活跃模式（`anyMessage`）下如果先判它，一条 @ 会被归成"普通消息"，代价是三重的：
 *   1. 走 1/分钟 的普通配额，而不是 3/分钟 的定向配额 —— @ 会因限流被整个丢掉，
 *      群里体感就是"@"了它却不理人（这条在日志里出现过：`跳过唤醒（anyMessage）：唤醒频率超限`）；
 *   2. 唤醒提示不带【别等，直接回】，模型于是先等静默窗口，反应慢半拍；
 *   3. 被点名却没回时不会触发服务端的"补一次定向提醒"。
 *
 * 抽成纯函数是为了让这条顺序能被离线单测钉住（scripts/test-wake-reasons.mjs）——
 * 它藏在 bridge.js 的闭包里时，改动顺序不会有任何测试变红。
 *
 * @param {object} o
 * @param {object} o.triggers            会话的 wakeConfig.triggers
 * @param {boolean} o.isPrivate          私聊：任何消息都唤醒
 * @param {boolean} o.atSelf             消息里 @ 的是机器人自己
 * @param {boolean} o.quoteTargetIsSelf  引用的是机器人自己的消息
 * @param {string} o.textContent         带引用信息的文本（判"有没有叫名字"）
 * @param {string} o.plainContent        本条消息自己的文字（判关键词/提问）
 * @param {string} o.selfNickname        机器人昵称
 * @param {string} o.speakerId           发送者 QQ
 * @param {string} o.speakerLabel        发送者显示名（用于 speaker 原因的标签）
 * @param {(text: string) => boolean} o.isDirectedAtAi 提问判定（实现留在 bridge.js，注入进来）
 * @returns {string|null}
 */
export function pickWakeTrigger({
  triggers = {},
  isPrivate = false,
  atSelf = false,
  quoteTargetIsSelf = false,
  textContent = '',
  plainContent = '',
  selfNickname = '',
  speakerId = '',
  speakerLabel = '',
  isDirectedAtAi = () => false
} = {}) {
  const tr = triggers ?? {};
  if (isPrivate) return 'private';
  if (tr.atMention && (atSelf || quoteTargetIsSelf)) return 'atMention';
  if (tr.nameMention && selfNickname) {
    const lower = String(textContent ?? '').toLowerCase();
    const nick = String(selfNickname).toLowerCase();
    if (lower.includes('@' + nick) || lower.includes(nick)) return 'nameMention';
  }
  if (tr.question && isDirectedAtAi(plainContent)) return 'question';
  if (tr.anyMessage) return 'anyMessage';
  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }
  const ids = Array.isArray(tr.speakerIds) ? tr.speakerIds : [];
  if (ids.length && speakerId && ids.some((id) => String(id) === String(speakerId))) {
    return `speaker:${speakerLabel || speakerId}`;
  }
  if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
  return null;
}

/**
 * 唤醒频率闸门：这次唤醒会不会因为限流被**丢弃**。
 *
 * 注意这里的关键词是"丢弃"而不是"延迟"——被闸门拦下的唤醒不会补发，
 * 只能等下一次唤醒时顺带看到那批未读。所以**定向唤醒（有人在叫它）不能走全局那个闸门**：
 * 实测日志里出现过 `唤醒频率超限，跳过（nameMention）` —— 有人点名它，
 * 却因为 60 秒内刚好有过一次概率唤醒而被整个丢掉，体感就是"叫它不理"。
 *
 * 但也不能完全放开：公开群里被刷 @ 会烧钱。所以定向唤醒有**自己的一份配额**
 * （`maxDirectedWakePerMinute`，默认 3），比全局的 `maxWakePerMinute` 宽松，
 * 但仍然有上限。
 *
 * @returns {{skip:boolean, reason?:string, recordDirected?:boolean}}
 */
export function checkWakeRateLimit({
  reason,
  wakeTimes = [],
  directedTimes = [],
  now = Date.now(),
  maxPerMinute = 0,
  maxPerHour = 0,
  maxDirectedPerMinute = 3
}) {
  const within = (t, ms) => Number.isFinite(Number(t)) && now - Number(t) < ms;

  if (isDirectedWakeReason(reason)) {
    const cap = Math.max(1, Number(maxDirectedPerMinute) || 3);
    const recentDirected = (Array.isArray(directedTimes) ? directedTimes : []).filter((t) => within(t, 60000));
    if (recentDirected.length >= cap) return { skip: true, reason: `定向唤醒已达 ${cap}/分钟上限` };
    return { skip: false, recordDirected: true };
  }

  const perMinute = Number(maxPerMinute) || 0;
  const perHour = Number(maxPerHour) || 0;
  const times = Array.isArray(wakeTimes) ? wakeTimes : [];
  const recentMinute = times.filter((t) => within(t, 60000)).length;
  const recentHour = times.filter((t) => within(t, 3600000)).length;
  if ((perMinute > 0 && recentMinute >= perMinute) || (perHour > 0 && recentHour >= perHour)) {
    return { skip: true, reason: `唤醒频率超限（${perMinute}/分钟、${perHour || '∞'}/小时）` };
  }
  return { skip: false, recordDirected: false };
}

/**
 * 从积压队列里挑出**该先投递**的那一条，并把它从队列里摘掉。
 *
 * 队列很短（调用方限制在 20 条），线性扫描足够；同分取更早的那条（稳定，保证不会饿死）。
 * 兼容旧版本残留的纯字符串条目。
 *
 * @param {Array} queue 形如 [{ reason, seq }] 或 ['atMention', ...]
 * @returns {{reason:string, seq:number}|null} 摘掉的那条；队列为空返回 null
 */
export function takeHighestPriorityWake(queue) {
  if (!Array.isArray(queue) || !queue.length) return null;
  let bestIdx = 0;
  let bestPri = -Infinity;
  for (let i = 0; i < queue.length; i += 1) {
    const r = queue[i];
    const reason = typeof r === 'string' ? r : (r?.reason ?? '');
    const pri = wakePriority(reason);
    if (pri > bestPri) { bestPri = pri; bestIdx = i; }
  }
  const [item] = queue.splice(bestIdx, 1);
  if (typeof item === 'string') return { reason: item, seq: 0 };
  return item ?? null;
}
