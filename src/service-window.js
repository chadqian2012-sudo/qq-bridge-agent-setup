/**
 * 群聊服务时限（2026-10-06）。
 *
 * 需求背景：运营方要"只给清波寨恢复服务到 10.7 为止"。靠人工到点回来删白名单不可靠
 * （半夜、人在外面、忘了），所以把"到期时间"写进配置，由代码自己判定失效：
 *
 *   config.json → allow.groupUntil: { "9000000012": "2026-10-08T00:30:00+08:00" }
 *
 * 到期后的效果与"从白名单里删掉"完全一致：群消息被忽略、会话被退役停用、日报拒绝发送
 * （`allowed()` 会返回 false，所有调用方共用这一个判断）。
 *
 * 纯函数、只读配置与当前时间：方便离线回归（scripts/test-service-window.mjs）。
 * 刻意**不缓存**解析结果：这是每条约 6 秒才读一次的短函数，缓存只会引入"改了配置不生效"。
 */

/** `"2026-10-08T00:30:00+08:00"` → 毫秒时间戳；非法/空 → null。 */
export function parseDeadline(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * 该目标的群聊服务是否已到期。
 * 只对 `kind === 'group'` 生效（私聊不受此限）；没配时限或时间非法 → 不算到期（fail-open 到白名单语义）。
 */
export function serviceWindowExpired(kind, id, cfg, nowMs = Date.now()) {
  if (!cfg || kind !== 'group') return false;
  const map = cfg.allow?.groupUntil;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const until = parseDeadline(map[String(id)]);
  if (until === null) return false;
  return Number(nowMs) >= until;
}

/**
 * 诊断/日志用：这个群的服务时限还剩多久。没配时限返回 null。
 * @returns {{until:number, untilIso:string, expired:boolean, leftMs:number}|null}
 */
export function describeServiceWindow(id, cfg, nowMs = Date.now()) {
  const until = parseDeadline(cfg?.allow?.groupUntil?.[String(id)]);
  if (until === null) return null;
  const leftMs = until - Number(nowMs);
  return { until, untilIso: new Date(until).toISOString(), expired: leftMs <= 0, leftMs };
}

/** 人类可读的剩余时长（诊断用），例如 `2 天 3 小时`。 */
export function formatRemaining(leftMs) {
  const ms = Math.max(0, Number(leftMs) || 0);
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
