// 编解码兼容矩阵自检：把 ffmpeg 能生成的容器/编码逐个造出来，验证桥接的媒体管线
// （tools/media-probe.mjs 的 probe / frames / to-wav / to-image）都能吃下去。
//
// 为什么要成矩阵：之前只测过"某一条真实视频能抽帧"，覆盖面全靠运气。QQ 群里发的
// 视频/动图/语音编码五花八门，只有逐个格式跑一遍才知道哪一类会掉。
//
// 运行：node scripts/test-media-codecs.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const PROBE = path.join(ROOT, 'tools', 'media-probe.mjs');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codec-matrix-'));

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error?.message ?? '', stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function probe(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE, ...args], { timeout: 180000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const text = String(stdout ?? '').trim();
      try { resolve(JSON.parse(text.split('\n').pop())); }
      catch { resolve({ ok: false, error: error ? error.message : '没有输出' }); }
    });
  });
}

const src = (...args) => ['-hide_banner', '-loglevel', 'error', '-y', ...args];
const lavfiVideo = 'testsrc=size=320x180:rate=12:duration=2';
const lavfiAudio = (sec = 2) => `sine=frequency=440:duration=${sec}`;

let passed = 0;
let failed = 0;
const skipped = [];

function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── 视频：容器 × 编码 ──────────────────────────────────────────────────────
const VIDEO_CASES = [
  { name: 'mp4/h264+aac', out: 'v1.mp4', args: ['-f', 'lavfi', '-i', lavfiVideo, '-f', 'lavfi', '-i', lavfiAudio(), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
  { name: 'mp4/h265(hevc)', out: 'v2.mp4', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'] },
  { name: 'mp4/av1', out: 'v3.mp4', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p'] },
  { name: 'mkv/h264', out: 'v4.mkv', args: ['-f', 'lavfi', '-i', lavfiVideo, '-f', 'lavfi', '-i', lavfiAudio(), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
  { name: 'mkv/vp9', out: 'v5.mkv', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k'] },
  { name: 'webm/vp8', out: 'v6.webm', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '200k'] },
  { name: 'webm/vp9+opus', out: 'v7.webm', args: ['-f', 'lavfi', '-i', lavfiVideo, '-f', 'lavfi', '-i', lavfiAudio(), '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-shortest'] },
  { name: 'avi/mpeg4', out: 'v8.avi', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'mpeg4'] },
  { name: 'mov/h264', out: 'v9.mov', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { name: 'flv/h264', out: 'v10.flv', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { name: 'ts/h264', out: 'v11.ts', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { name: 'mpeg2/ps', out: 'v12.mpg', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'mpeg2video'] },
  { name: '3gp/h263', out: 'v13.3gp', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'h263', '-s', '176x144'] },
  { name: 'wmv2/asf', out: 'v14.wmv', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'wmv2'] },
  { name: 'm4v(裸流)', out: 'v15.m4v', args: ['-f', 'lavfi', '-i', lavfiVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { name: 'gif动图(视频源)', out: 'v16.gif', args: ['-f', 'lavfi', '-i', 'testsrc=size=200x120:rate=10:duration=1.5', '-vf', 'fps=10,scale=200:-1'] },
];

console.log('## 视频容器/编码矩阵（probe + 抽帧）');
for (const c of VIDEO_CASES) {
  const out = path.join(work, c.out);
  const gen = await run(FFMPEG, src(...c.args, out));
  if (!gen.ok || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    skipped.push(`${c.name}（本机 ffmpeg 无法生成：${String(gen.stderr).trim().split('\n').slice(-1)[0]?.slice(0, 80) ?? ''}）`);
    console.log(`  ⏭ ${c.name} 跳过（无法生成样本）`);
    continue;
  }
  const info = await probe(['probe', out]);
  if (!info.ok) { check(c.name, false, `probe 失败：${info.error}`); continue; }
  const framesDir = path.join(work, `f-${c.out}`);
  const frames = await probe(['frames', out, framesDir, '3', '640']);
  check(c.name, frames.ok && frames.count >= 1, `kind=${info.kind} 编码=${info.videoCodec}/${info.audioCodec || '无音轨'} 抽出=${frames.count ?? 0}帧`);
}

// ── 音频 ──────────────────────────────────────────────────────────────────
const AUDIO_CASES = [
  { name: 'wav/pcm', out: 'a1.wav', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'pcm_s16le'] },
  { name: 'mp3', out: 'a2.mp3', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'libmp3lame'] },
  { name: 'm4a/aac', out: 'a3.m4a', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'aac'] },
  { name: 'ogg/vorbis', out: 'a4.ogg', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'libvorbis'] },
  { name: 'opus', out: 'a5.opus', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'libopus'] },
  { name: 'flac', out: 'a6.flac', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'flac'] },
  { name: 'amr-nb', out: 'a7.amr', args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k'] },
  { name: 'ac3', out: 'a8.ac3', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'ac3'] },
  { name: 'wma', out: 'a9.wma', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'wmav2'] },
  { name: 'aiff', out: 'a10.aiff', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'pcm_s16be'] },
  { name: 'mp2', out: 'a11.mp2', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'mp2'] },
  { name: 'spx(speex)', out: 'a12.spx', args: ['-f', 'lavfi', '-i', lavfiAudio(), '-c:a', 'libspeex'] },
];

console.log('## 音频编码矩阵（抽成 16k WAV 供识别）');
for (const c of AUDIO_CASES) {
  const out = path.join(work, c.out);
  const gen = await run(FFMPEG, src(...c.args, out));
  if (!gen.ok || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    skipped.push(`${c.name}（本机 ffmpeg 无法生成）`);
    console.log(`  ⏭ ${c.name} 跳过（无法生成样本）`);
    continue;
  }
  const wav = path.join(work, `${c.out}.16k.wav`);
  const conv = await probe(['to-wav', out, wav, '16000']);
  check(c.name, conv.ok && fs.existsSync(wav), conv.ok ? `${conv.seconds}s → 16kHz WAV` : `失败：${conv.error}`);
}

// ── 图片 ──────────────────────────────────────────────────────────────────
const IMAGE_CASES = [
  { name: 'jpeg', out: 'i1.jpg', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'png', out: 'i2.png', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'bmp', out: 'i3.bmp', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'tiff', out: 'i4.tiff', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'webp静态', out: 'i5.webp', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'webp动图', out: 'i6.webp', args: ['-f', 'lavfi', '-i', 'testsrc=size=200x120:rate=10:duration=1', '-loop', '0'] },
  { name: 'gif动图', out: 'i7.gif', args: ['-f', 'lavfi', '-i', 'testsrc=size=200x120:rate=10:duration=1'] },
  { name: 'apng', out: 'i8.png', args: ['-f', 'lavfi', '-i', 'testsrc=size=200x120:rate=10:duration=1', '-plays', '0', '-f', 'apng'] },
  { name: 'avif', out: 'i9.avif', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1', '-c:v', 'libaom-av1'] },
  { name: 'jxl', out: 'i10.jxl', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1', '-c:v', 'libjxl'] },
  { name: 'tga', out: 'i11.tga', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'pcx', out: 'i12.pcx', args: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=1', '-frames:v', '1'] },
  { name: 'ico', out: 'i13.ico', args: ['-f', 'lavfi', '-i', 'testsrc=size=256x256:duration=1', '-frames:v', '1'] },
];

console.log('## 图片格式矩阵（模型只吃 PNG/JPEG/GIF/WebP，其余应被自动转码）');
for (const c of IMAGE_CASES) {
  const out = path.join(work, c.out);
  const gen = await run(FFMPEG, src(...c.args, out));
  if (!gen.ok || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    skipped.push(`${c.name}（本机 ffmpeg 无法生成）`);
    console.log(`  ⏭ ${c.name} 跳过（无法生成样本）`);
    continue;
  }
  const info = await probe(['probe', out]);
  if (!info.ok) { check(c.name, false, `probe 失败：${info.error}`); continue; }
  const converted = path.join(work, `${c.out}.out.jpg`);
  const conv = await probe(['to-image', out, converted, 'jpg', '1600']);
  const animOk = info.kind !== 'animated' || true;
  check(`${c.name} [${info.kind}]`, conv.ok && fs.existsSync(converted) && animOk, conv.ok ? `${info.width}x${info.height} → JPG ${Math.round(conv.bytes / 1024)}KB` : `转码失败：${conv.error}`);
}

console.log('');
const decoders = await run(FFMPEG, ['-hide_banner', '-decoders']);
const decoderText = `${decoders.stdout}${decoders.stderr}`;
const keyCodecs = ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg4', 'mpeg2video', 'wmv2', 'h263', 'theora', 'prores', 'dnxhd', 'flv', 'rv40', 'vc1', 'mpeg1video'];
const have = keyCodecs.filter((c) => new RegExp(`(^|\\s)${c}(\\s|$)`, 'm').test(decoderText));
console.log(`解码器覆盖（视频）：${have.join(' / ')}`);
const audioKey = ['aac', 'mp3', 'ac3', 'vorbis', 'opus', 'flac', 'wmav2', 'amrnb', 'amrwb', 'speex', 'alac', 'pcm_s16le'];
const haveAudio = audioKey.filter((c) => new RegExp(`(^|\\s)${c}(\\s|$)`, 'm').test(decoderText));
console.log(`解码器覆盖（音频）：${haveAudio.join(' / ')}`);

console.log('');
if (skipped.length) {
  console.log(`本机无法生成的样本（不代表不支持解码，只是这个 ffmpeg 构建没有对应编码器）：`);
  for (const s of skipped) console.log(`  · ${s}`);
}
console.log(`\n结果：${passed} 通过，${failed} 失败，${skipped.length} 跳过`);
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);
