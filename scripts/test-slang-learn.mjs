// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// 6. buildSlangContext 的「本群最近在用的梗」段（2026-10-04 新增）
// 背景：真实词库里有 2000 条候选、confirmed 长期为 0，旧实现于是永远返回空串，
// AI 拿不到任何黑话上下文。现在按"这个词有没有出现在本会话最近消息里"补一段。
{
  const entries = [
    { id: 'e1', content: '小号', meaning: '次要账号', status: SLANG_STATUS.CANDIDATE, count: 2 },
    { id: 'e2', content: '终末地', meaning: '鹰角新作', status: SLANG_STATUS.CANDIDATE, count: 7 },
    { id: 'e3', content: '没出现过', meaning: '不该被注入', status: SLANG_STATUS.CANDIDATE, count: 99 },
    { id: 'e4', content: '被拒的词', meaning: '不该被注入', status: SLANG_STATUS.REJECTED, count: 99 },
    { id: 'e5', content: '已确认的', meaning: '走第一段', status: SLANG_STATUS.CONFIRMED, count: 1 },
  ];
  const recentTexts = ['我小号丢了', '小号丢了不算丢', '你们玩终末地了吗', '被拒的词也出现了'];
  const ctx = buildSlangContext(entries, 8, { recentTexts });
  assert.ok(ctx.includes('【本群最近在用的梗】'), '应出现本群最近用词段');
  assert.ok(ctx.includes('小号：次要账号'), '出现在最近消息里的候选词应被注入');
  assert.ok(ctx.includes('终末地：鹰角新作'), '同上');
  assert.ok(!ctx.includes('没出现过'), '没在最近消息里出现的候选词不应注入');
  assert.ok(!ctx.includes('被拒的词'), 'rejected 的词永远不注入');
  assert.ok(ctx.includes('已确认的：走第一段'), '已确认词仍走第一段');
  ok('buildSlangContext 注入本群最近在用的候选词');
}

// 7. 没给 recentTexts 时行为与旧版一致（只有已确认段），且上下文词数受 contextualMax 限制
{
  const entries = [
    { id: 'c1', content: '甲词', meaning: '一', status: SLANG_STATUS.CANDIDATE, count: 5 },
    { id: 'c2', content: '乙词', meaning: '二', status: SLANG_STATUS.CANDIDATE, count: 4 },
    { id: 'c3', content: '丙词', meaning: '三', status: SLANG_STATUS.CANDIDATE, count: 3 },
  ];
  assert.equal(buildSlangContext(entries, 8), '', '不给 recentTexts 时不应凭空注入候选词');
  const capped = buildSlangContext(entries, 8, { recentTexts: ['甲词 乙词 丙词'], contextualMax: 2 });
  assert.ok(capped.includes('甲词') && capped.includes('乙词'), '按 count 优先');
  assert.ok(!capped.includes('丙词'), '超过 contextualMax 的不注入');
  ok('buildSlangContext 兼容旧行为并遵守 contextualMax');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
