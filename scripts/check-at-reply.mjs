// 只读核对：**被直接叫到时，机器人到底回没回**。
//
// 为什么需要它：reserved2 的唤醒提示词与"必须回"的约束是**概率性**的（模型可以不照做），
// 所以"改好了没有"不能靠感觉，必须有可重复的度量。这个脚本把两侧数据对齐：
//
//   ① state/bridge.log 里 `[reserved2] 计划唤醒 <会话>（<原因>）` —— 它**被叫了**
//   ② 消息库里 user_id = 机器人自己 的消息 —— 它**说没说话**
//   ③ 若某次"被叫"之后 N 分钟内没有任何机器人消息，就算一次**没回**
//
// 口径（会被当成结论，所以写清楚）：
//   · 只统计 **directed**（被 @ / 叫名字 / 提问 / 私聊 / 关键词 / 指定成员）的唤醒；
//     概率性唤醒本来就可以不回，混进来会把结果算歪。
//   · 禁言回执（"已禁言 …"/"已解除 …"）不算"回应"—— 那是命令的副作用，不是在跟人说话。
//   · 时间窗默认 180 秒：`计划唤醒` 到真正投递还有合批窗口（batchWindowMs）+ 模型思考时间。
//   · 桥接日志是 `HH:MM:SS` 无日期，所以按**当天**解释；跨零点的日志段会被算错（脚本会提示）。
//
// 本脚本**只读**：不写日志、不发消息、不碰 QQ。
//
// 用法：
//   node scripts/check-at-reply.mjs                     # 今天，窗口 180s
//   node scripts/check-at-reply.mjs --minutes 240
//   node scripts/check-at-reply.mjs --since 21:00       # 只看 21:00 之后
//   node scripts/check-at-reply.mjs --json
import fs from 'node:fs';
import path from 'node:path';

import { normalizeReportGroupIds, resolveMessagesDbCandidates, pickMessagesDb } from '../src/group-stats.js';
import { isDirectedWakeReason, describeWakeReason } from '../src/wake-reasons.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const asBoolFlag = (name) => process.argv.includes(`--${name}`);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  // 兼容多群写法：groupIds 数组优先，其次是旧的单值 groupId。
  const GROUP_ID = Number(arg('group', normalizeReportGroupIds({
    groupId: cfg.groupStats?.groupId,
    groupIds: cfg.groupStats?.groupIds
  })[0] ?? 0));
const WINDOW_MIN = Number(arg('minutes', 180)) / 60; // 秒 → 分
const SINCE = arg('since', null);
const AS_JSON = asBoolFlag('json');

const LOG = arg('log', path.join(ROOT, 'state', 'bridge.log'));

/**
 * 按**时间顺序**收集可用的日志文件（含轮转出来的 bridge.log.1 / .2 …）。
 *
 * 【2026-10-04 修】以前只读当前那份 bridge.log。日志凌晨 03:39 轮转后，
 * 更早的事件被挪进了 bridge.log.1，于是脚本对"22:00 之后"这类窗口返回 **0 次被叫** ——
 * 看起来像"没人叫它"，实际是**日志看不到了**。默默给出错误答案是这类度量工具最糟的失败模式，
 * 所以这里既读轮转文件，也会在窗口早于可用日志时显式告警。
 */
function collectLogFiles(base) {
  const files = [];
  for (let n = 9; n >= 1; n -= 1) {
    const p = `${base}.${n}`;
    if (fs.existsSync(p)) files.push(p);
  }
  if (fs.existsSync(base)) files.push(base);
  return files;
}
const LOG_FILES = collectLogFiles(LOG);

// ── ① 解析桥接日志里的"被直接叫到"事件 ──────────────────────────────────────
const wakeRe = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[reserved2\] (?:计划唤醒 )?(group:(\d+)|private:(\d+))（?([^）\n]*)）?/;
const queuedRe = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[reserved2\] (?:补发繁忙期间积压的唤醒：|会话繁忙，暂存唤醒原因 )(group:(\d+)|private:(\d+))（?([^）\n]*)）?/;
const missedRe = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[reserved2\] 被直接叫到（([^）]*)）却无行动/;
// 被频率闸门**丢掉**的唤醒（不是延迟 —— 拦下不会补发，只能等下次唤醒顺带看到未读）。
// 定向唤醒（@/名字/提问）本来不该走到这里，所以它一旦出现就说明配额需要调。
const skipRe = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[reserved2\] 跳过唤醒 (group:(\d+)|private:(\d+))（([^）]*)）：(.*)$/;

/**
 * 把一批日志文件解析成"带绝对时间的行"。
 *
 * 日志行只有 `HH:MM:SS`，**没有日期**。要跨午夜、跨轮转文件地还原绝对时间，
 * 用每个文件的 **mtime 当锚点**：最后一行必然属于该文件最后写入的那一天；
 * 然后**从最后一行向前回推** —— 逆行时若遇到更大的时刻，说明跨过了一次零点，日期减一天。
 * （正向推是做不到的：起点日期未知。）
 */
function parseLogFiles(files) {
  const rows = [];
  for (const f of files) {
    let text;
    let baseMs;
    try {
      text = fs.readFileSync(f, 'utf8');
      const st = fs.statSync(f);
      baseMs = new Date(st.mtime.getFullYear(), st.mtime.getMonth(), st.mtime.getDate()).getTime();
    } catch { continue; }
    const lines = text.split('\n');
    let dayShift = 0;
    let prevClock = null;
    const buf = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const hm = /^(\d{2}):(\d{2}):(\d{2}) /.exec(lines[i]);
      if (!hm) continue;
      const clock = Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3]);
      if (prevClock !== null && clock > prevClock) dayShift -= 1;
      prevClock = clock;
      buf.push({ line: lines[i], at: baseMs + dayShift * 86400000 + clock * 1000 });
    }
    rows.push(...buf.reverse());
  }
  return rows.sort((a, b) => a.at - b.at);
}

function parseLog(rows) {
  const events = [];
  const misses = [];
  const skips = [];
  const notes = [];

  for (const { line, at } of rows) {
    const clock = new Date(at).toLocaleTimeString('en-GB', { hour12: false });
    let m = wakeRe.exec(line) || queuedRe.exec(line);
    if (m) {
      const key = m[4] || (m[6] ? `private:${m[6]}` : '');
      const reason = String(m[7] || '').trim().replace(/@seq\d+$/, '');
      events.push({ at, clock, key, reason, directed: isDirectedWakeReason(reason) });
      continue;
    }
    const mm = missedRe.exec(line);
    if (mm) misses.push({ at, clock, reason: mm[4] });
    const sm = skipRe.exec(line);
    if (sm) {
      // 捕获组：1=时 2=分 3=秒 4=key 5=群号 6=私聊号 7=原因 8=详情
      // （别照抄 wakeRe 的下标 —— 那个正则少一层括号，序号不一样）
      skips.push({
        at,
        reason: String(sm[7] || '').trim(),
        detail: String(sm[8] || '').trim(),
        directed: isDirectedWakeReason(String(sm[7] || '').trim())
      });
    }
  }
  return { events, misses, skips, notes };
}

// ── ② 读机器人自己发过的话 ──────────────────────────────────────────────────
async function botMessages(dbPath, groupId) {
  const botId = path.basename(path.dirname(dbPath)); // SnowLuma 的库在 data/<QQ>/ 下
  const { openMessagesStore, messagesTableAvailable } = await import('../src/group-stats.js');
  const db = await openMessagesStore(dbPath);
  try {
    if (!messagesTableAvailable(db)) return { botId, msgs: [] };
    const rows = db.prepare(
      `SELECT timestamp, json_extract(data,'$.raw_message') AS raw
       FROM messages WHERE is_group=1 AND session_id=? AND CAST(json_extract(data,'$.user_id') AS TEXT)=?
       ORDER BY timestamp`
    ).all(Number(groupId), String(botId));
    const msgs = rows.map((r) => ({ at: Number(r.timestamp) * 1000, text: String(r.raw ?? '') }));
    return { botId, msgs };
  } finally {
    try { db.close(); } catch {}
  }
}

/** 禁言回执不算"在跟人说话"。 */
const isReceipt = (t) => /^已(禁言|解除禁言)/.test(String(t ?? '').trim());

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (!LOG_FILES.length) {
  console.error(`找不到日志：${LOG}（含轮转文件）`);
  process.exit(2);
}
const logRows = parseLogFiles(LOG_FILES);
const { events, misses, skips, notes } = parseLog(logRows);

// 让"0 次被叫"可解释：把日志实际覆盖的时段打出来。
// （"窗口早于日志覆盖范围"的告警放在 sinceMs 算出来之后 —— 这里引用它会踩 TDZ。）
const firstEventAt = events.length ? events[0].at : null;
const lastEventAt = events.length ? events[events.length - 1].at : null;
if (!notes.length) {
  notes.push(`日志来源：${LOG_FILES.map((f) => path.basename(f)).join(' + ')}`);
}
if (firstEventAt) {
  notes.push(`日志覆盖时段：${new Date(firstEventAt).toLocaleString('zh-CN', { hour12: false })} ~ ${new Date(lastEventAt).toLocaleString('zh-CN', { hour12: false })}`);
}

const candidates = resolveMessagesDbCandidates({ explicit: cfg.groupStats?.dbPath || arg('db', ''), homeDir: cfg.snowluma?.homeDir });
if (!candidates.length) {
  console.error('找不到 SnowLuma 消息库（用 --db <path> 指定）');
  process.exit(2);
}
const dbPath = candidates.length === 1 ? candidates[0] : await pickMessagesDb({ candidates });
const { botId, msgs } = await botMessages(dbPath, GROUP_ID);

const sinceMs = SINCE ? (() => {
  const [h, mi] = String(SINCE).split(':').map(Number);
  const d = new Date(); d.setHours(h, mi || 0, 0, 0);
  // 清晨查"昨晚 22:00"是自然用法，而 HH:MM 会被解析成**今天** —— 于是落在一个还没到的时刻。
  // 这种情况下按昨天算。（不这么做的话 `--since 22:00` 在早上会静默返回 0 条。）
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return d.getTime();
})() : 0;

// 窗口早于日志覆盖范围时明确告警：否则统计出来是 0，看起来像"没人叫它"。
if (sinceMs && firstEventAt && firstEventAt > sinceMs) {
  notes.push(`⚠️ 请求的窗口（${new Date(sinceMs).toLocaleString('zh-CN', { hour12: false })} 起）早于日志覆盖范围`
    + `（最早事件 ${new Date(firstEventAt).toLocaleString('zh-CN', { hour12: false })}）—— 那段事件已被轮转掉，统计不到`);
}

const directed = events.filter((e) => e.directed && e.key === `group:${GROUP_ID}` && e.at >= sinceMs);
const windowMs = WINDOW_MIN * 60000;
const rowsOut = directed.map((e) => {
  const hit = msgs.find((m) => m.at >= e.at && m.at <= e.at + windowMs && !isReceipt(m.text));
  return { ...e, replied: !!hit, replyAt: hit ? hit.at : null, replyText: hit ? hit.text.replace(/\s+/g, ' ').slice(0, 60) : null };
});
const answered = rowsOut.filter((r) => r.replied).length;
const rate = rowsOut.length ? answered / rowsOut.length : null;

// 更贴近体感的第二种口径：把"连续被叫"合并成一次事件。
// 它正忙的时候，几分钟内的好几个 @ 会排队、最后被同一条回复一并答掉 ——
// 按"每次唤醒"算会把这些算成多次没回，低估实际应答情况。
const episodes = [];
for (const r of rowsOut) {
  const last = episodes[episodes.length - 1];
  if (last && r.at - last.lastAt <= windowMs) {
    last.lastAt = r.at;
    last.reasons.add(r.reason);
    last.replied = last.replied || r.replied;
    if (r.replyAt) last.replyAt = last.replyAt ?? r.replyAt;
  } else {
    episodes.push({ firstAt: r.at, lastAt: r.at, clock: r.clock, reasons: new Set([r.reason]), replied: r.replied, replyAt: r.replyAt });
  }
}
const epAnswered = episodes.filter((e) => e.replied).length;
const epRate = episodes.length ? epAnswered / episodes.length : null;

// 响应延迟：从"第一次被叫"到"第一条回复"。用**事件簇**而不是单次唤醒计时 ——
// 一次被叫期间可能触发好几次唤醒，按单次算会把延迟算成 0（回复落在窗口中间）。
const latencies = episodes
  .filter((e) => e.replied && e.replyAt)
  .map((e) => e.replyAt - e.firstAt)
  .filter((ms) => ms >= 0)
  .sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null);
const latency = {
  count: latencies.length,
  min: latencies[0] ?? null,
  p50: pct(0.5),
  p90: pct(0.9),
  max: latencies[latencies.length - 1] ?? null
};
const secs = (ms) => (ms === null ? '—' : `${Math.round(ms / 1000)}s`);

if (AS_JSON) {
  console.log(JSON.stringify({
    groupId: GROUP_ID, windowMin: Math.round(WINDOW_MIN), botId,
    perWake: { total: rowsOut.length, answered, rate },
    perEpisode: { total: episodes.length, answered: epAnswered, rate: epRate, items: episodes.map((e) => ({ clock: e.clock, reasons: [...e.reasons], replied: e.replied })) },
    latency,
    rows: rowsOut, misses, skips, notes
  }, null, 2));
} else {
  console.log(`会话 group:${GROUP_ID}   机器人 ${botId}   应答窗口 ${Math.round(WINDOW_MIN)} 分钟`);
  console.log(`被直接叫到 ${rowsOut.length} 次，其中回了 ${answered} 次` + (rate === null ? '' : `  → 按次数 ${(rate * 100).toFixed(0)}%`));
  if (epRate !== null) {
    console.log(`合并连续呼叫后共 ${episodes.length} 次"被叫"，答了 ${epAnswered} 次  → 按事件 ${(epRate * 100).toFixed(0)}%  ← 这个更贴近体感`);
  }
  if (latency.count) {
    console.log(`响应延迟（被叫 → 第一句话）：最快 ${secs(latency.min)} / 中位 ${secs(latency.p50)} / p90 ${secs(latency.p90)} / 最慢 ${secs(latency.max)}`);
  }
  if (rowsOut.length) {
    console.log('');
    console.log('  时刻       原因                      结果');
    for (const r of rowsOut) {
      const verdict = r.replied ? `✓ 回了（${new Date(r.replyAt).toLocaleTimeString('zh-CN', { hour12: false })}）` : '✗ 没回';
      console.log(`  ${r.clock}   ${(describeWakeReason(r.reason) || r.reason).padEnd(22)}  ${verdict}`);
    }
  }
  const missedEps = episodes.filter((e) => !e.replied);
  if (missedEps.length) {
    console.log(`\n  ✗ 完全没答的 ${missedEps.length} 次"被叫"：`);
    for (const e of missedEps) console.log(`    ${e.clock}  ${[...e.reasons].map((r) => describeWakeReason(r)).join('、')}`);
  }
  const mySkips = skips.filter((s) => s.key === `group:${GROUP_ID}` && s.at >= sinceMs);
  if (mySkips.length) {
    const byReason = new Map();
    for (const s of mySkips) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
    console.log(`\n  ⏱ 被频率闸门丢掉的唤醒 ${mySkips.length} 次（丢 = 不补发，只能等下次唤醒顺带看到未读）：`);
    for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${r}  × ${n}${isDirectedWakeReason(r) ? '   ← 这是定向唤醒，说明配额需要调高' : ''}`);
    }
  }
  if (!rowsOut.length) console.log('\n  （这个时间范围内没有被直接叫到的记录：没人 @ 它，或日志已被轮转）');
  for (const n of notes) console.log(`\n  ⚠️ ${n}`);
}
