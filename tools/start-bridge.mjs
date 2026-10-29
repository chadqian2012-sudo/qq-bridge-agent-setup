// The supervisor runs this wrapper so every bridge launch uses the same DSH home.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let runtime;
try { runtime = JSON.parse(fs.readFileSync(path.join(root, 'state', 'install.json'), 'utf8').replace(/^\uFEFF/, '')); }
catch { console.error('Missing or invalid state/install.json; run install.ps1 first.'); process.exit(2); }
if (!runtime.dshHome) { console.error('Missing DSH home in state/install.json.'); process.exit(2); }
const child = spawn(process.execPath, [path.join(root, 'src', 'bridge.js')], {
  cwd: root, env: { ...process.env, DSH_HOME: runtime.dshHome }, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error('Bridge launch failed:', error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
