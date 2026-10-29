// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

const REQUEST_TIMEOUT_MS = 20000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 明确「不该重试」的错误：这些重试多少次结果都一样，白白拖慢 tool 调用。
const PERMANENT_MEDIA_ERROR_RE = /URL 无效|仅允许 http\/https|禁止访问内网|域名解析到内网|解析到内网|域名解析失败|重定向次数过多|重定向缺少 Location|不是有效图片|不能包含凭据/;
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'
]);

/**
 * 二进制抓取失败是否值得重试。
 *
 * 只重试「瞬时」类失败：连接被重置、读超时、响应体中断、HTTP 408/429/5xx。
 * HTTP 403/404 不重试 —— 那正是 QQ CDN 的 rkey 过期表现，重试只会浪费 20~45 秒，
 * 应该交给调用方走「本地缓存 / get_msg 重新解析」的降级路径。
 */
export function isRetryableMediaFetchError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (PERMANENT_MEDIA_ERROR_RE.test(msg)) return false;
  if (RETRYABLE_NETWORK_CODES.has(String(error?.code ?? ''))) return true;
  if (/超时|timeout|hang up|响应体读取中断|socket/i.test(msg)) return true;
  if (/^(?:图片|资源)抓取失败：HTTP (?:408|429|5\d\d)\b/.test(msg)) return true;
  return false;
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
function requestOnce(url, ip, limit, binary = false, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0',
          accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: timeoutMs,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('响应体读取中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('响应体读取中断'));
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          finish(null, { statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            finish(null, { statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) { appendText(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > limit) {
            finish(new Error(`图片超过大小限制（${limit} 字节）`));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) finish(null, { statusCode, buffer: Buffer.concat(chunks) });
          else {
            appendText(decoder.end());
            finish(null, { statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

export async function safeFetch(urlString, maxChars = 50000) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/**
 * 单次抓取（不含重试）：走到这里必须是已经通过 URL 校验的地址。
 * @param {boolean} expectImage 为 true 时校验响应体确实是图片；视频/音频等其它二进制传 false。
 */
async function safeFetchBufferOnce(urlString, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS, expectImage = true) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxBytes, true, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`${expectImage ? '图片' : '资源'}抓取失败：HTTP ${result.statusCode}`);
    }
    if (expectImage && !looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 抓取图片字节并返回 Buffer（带 SSRF 防护、图片格式校验与瞬时失败重试）。
 *
 * 重试是刚需：QQ 图片 CDN（multimedia.nt.qq.com.cn）偶发连接重置/读超时，
 * 单次失败就让 AI 看到「抓图失败」的代价远高于多花 1~2 秒重试。
 *
 * 默认行为与历史版本一致（单次尝试、20 秒总时限），只有调用方显式传 options 才启用重试和
 * 更长时限 —— `scripts/test-audit-security.mjs` 用假计时器断言"20 秒总预算"，默认值一改
 * 那个安全自检就会挂。媒体路径请用 {@link MEDIA_FETCH_OPTIONS}。
 *
 * @param {string} urlString
 * @param {number} maxBytes
 * @param {{attempts?: number, timeoutMs?: number}} [options]
 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024, options = {}) {
  validateLimit(maxBytes, 'maxBytes');
  const attempts = clampInt(options.attempts, 1, 5, 1);
  const timeoutMs = clampInt(options.timeoutMs, 5000, 300000, REQUEST_TIMEOUT_MS);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await safeFetchBufferOnce(urlString, maxBytes, timeoutMs, true);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableMediaFetchError(error)) throw error;
      // 指数退避 + 抖动：同一条 CDN 上的并发重试不要同时打过去。
      await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    }
  }
  throw lastError ?? new Error('图片抓取失败');
}

/**
 * 媒体下载的推荐参数：QQ 图片原图常在 5~15MB，20 秒在慢链路/CDN 抖动时会误判失败；
 * 一次连接被重置就报「抓图失败」的代价远高于多花 1~2 秒重试。
 * 只在桥接的图片/表情/视频路径使用，避免影响安全自检对默认 20 秒总时限的断言。
 */
export const MEDIA_FETCH_OPTIONS = Object.freeze({ attempts: 3, timeoutMs: 45000 });
/** 视频这类几十 MB 的下载：给更宽的总时限。 */
export const MEDIA_FETCH_OPTIONS_LARGE = Object.freeze({ attempts: 3, timeoutMs: 90000 });

/**
 * 抓取任意二进制（视频/音频等），同样带 SSRF 防护与瞬时失败重试，但不做图片格式校验。
 *
 * 之所以单独成一个函数而不是给 safeFetchBuffer 加开关：调用方要拿到的语义完全不同
 * （图片必须肉眼可读，视频只要字节完整）。混在一个函数里迟早会有人忘记传开关。
 *
 * @param {string} urlString
 * @param {number} maxBytes
 * @param {{attempts?: number, timeoutMs?: number}} [options]
 */
export async function safeFetchRawBuffer(urlString, maxBytes = 32 * 1024 * 1024, options = {}) {
  validateLimit(maxBytes, 'maxBytes');
  const attempts = clampInt(options.attempts, 1, 5, 1);
  const timeoutMs = clampInt(options.timeoutMs, 5000, 300000, REQUEST_TIMEOUT_MS);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await safeFetchBufferOnce(urlString, maxBytes, timeoutMs, false);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableMediaFetchError(error)) throw error;
      await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    }
  }
  throw lastError ?? new Error('资源抓取失败');
}
