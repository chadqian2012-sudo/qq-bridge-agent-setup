// 脚本编码约定的离线回归。
//
// 为什么值得单独一个测试：这个坑**同一天内咬了作者两次**。
//   · Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时按 ANSI（本机 GBK）解码，
//     文件里的中文注释/字符串会变成乱码字节，其中的括号与引号能把语法直接撑坏
//     （实测：`Write-Host '已重新启用：…'` → ParserError: MissingEndCurlyBrace）。
//     注意 pwsh 7 默认按 UTF-8 读，**所以本地用 pwsh 测是绿的，计划任务里用
//     powershell.exe 跑却是红的**——只在一种宿主上验证根本发现不了。
//   · VBScript 一律按 ANSI 读，所以 .vbs 必须纯 ASCII。
//   · .bat/.cmd 由 cmd.exe 按当前代码页解码：含中文时必须在开头 chcp 65001。
//
// 这三条都是「静默失败」型问题：文件看起来没问题，运行期才炸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function readBuf(p) { return fs.readFileSync(p); }
function hasBom(buf) { return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; }
function textOf(buf) { return buf.toString('utf8'); }
function hasCjk(s) { return /[\u4e00-\u9fff]/.test(s); }

/** 收集仓库内（排除 node_modules / .git）指定扩展名的文件。 */
function collect(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, exts, out);
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

test('含中文的 .ps1 必须带 UTF-8 BOM（否则 Windows PowerShell 5.1 按 ANSI 读会语法报错）', () => {
  const files = [...collect(path.join(ROOT, 'tools'), ['.ps1']), ...collect(ROOT, ['.ps1'])];
  const uniq = [...new Set(files)];
  assert.ok(uniq.length > 0, '应至少扫到一个 .ps1');

  const bad = [];
  let cjkCount = 0;
  for (const p of uniq) {
    const buf = readBuf(p);
    const text = textOf(buf);
    if (!hasCjk(text)) continue; // 纯 ASCII：有没有 BOM 都安全
    cjkCount++;
    if (!hasBom(buf)) bad.push(rel(p));
  }
  assert.ok(cjkCount > 0, '应至少扫到一个含中文的 .ps1（否则这个测试是空转的）');
  assert.deepEqual(bad, [], `这些 .ps1 含中文但没有 UTF-8 BOM：${bad.join('、')} —— `
    + 'Windows PowerShell 5.1 会按 ANSI 解码，中文串里的括号/引号会撑坏语法。'
    + '修法：把文件重存为「UTF-8 带 BOM」。');
});

test('tools/*.vbs 必须纯 ASCII（VBScript 按 ANSI 读取）', () => {
  const dir = path.join(ROOT, 'tools');
  if (!fs.existsSync(dir)) return;
  const files = collect(dir, ['.vbs']);
  const bad = files.filter((p) => hasCjk(textOf(readBuf(p)))).map(rel);
  assert.deepEqual(bad, [], `这些 .vbs 含非 ASCII 字符：${bad.join('、')} —— `
    + 'VBScript 按 ANSI 解码，中文注释会被误解码并可能破坏解析。请改成英文注释。');
});

test('含中文的 .bat / .cmd 必须在开头 chcp 65001（cmd.exe 按代码页解码脚本字节）', () => {
  const files = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && ['.bat', '.cmd'].includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(ROOT, e.name));
  assert.ok(files.length > 0, '应至少扫到一个 .bat/.cmd');

  const bad = [];
  for (const p of files) {
    const text = textOf(readBuf(p));
    if (!hasCjk(text)) continue;
    const head = text.split(/\r?\n/).slice(0, 6).join('\n');
    if (!/chcp\s+65001/i.test(head)) bad.push(rel(p));
  }
  assert.deepEqual(bad, [], `这些批处理含中文但没有在开头 chcp 65001：${bad.join('、')} —— `
    + 'cmd.exe 会按 ANSI 解码文件字节，中文会变成乱码（echo 出去就是一堆问号）。');
});

test('本次新增的脚本都在检查范围内（防止测试空转）', () => {
  // 明确断言几个关键文件被扫到：如果哪天目录结构变了，这里会先红，
  // 而不是让上面三个测试静默地什么都不检查。
  for (const f of ['tools/health-watchdog.ps1', 'tools/ensure-keepalive.ps1', 'tools/boot-all.ps1', 'tools/keepalive-loop.vbs']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少 ${f}`);
  }
});
