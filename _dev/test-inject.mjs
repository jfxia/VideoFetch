/**
 * _dev/test-inject.mjs — 页面内 hook 行为测试
 * 在 vm 沙箱里跑 content/inject.js，验证：
 *   1. fetch 拉 m3u8 能被捕获并标为 hls
 *   2. 接口 JSON 响应体里的视频变体地址能被提取（X 这类站点的关键路径）
 *   3. Resource Timing 通道能兜住不走 fetch 的播放列表
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}

const events = [];
const perfEntries = [];

function makeCtx(fetchImpl) {
  const ctx = {
    console,
    setTimeout: (fn) => setTimeout(fn, 5),
    setInterval: () => 0,
    clearTimeout,
    clearInterval: () => {},
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { getEntriesByType: () => perfEntries },
    navigator: { userAgent: 'node-test' },
    location: { href: 'https://x.com/axoo_o/status/2112363173596783023' },
    document: {
      baseURI: 'https://x.com/axoo_o/status/2112363173596783023',
      querySelectorAll: () => []
    },
    postMessage: (m) => events.push(m),
    addEventListener: () => {},
    fetch: fetchImpl,
    URL: class extends URL {
      static createObjectURL = () => 'blob:https://x.com/1';
    },
    MediaSource: function MediaSource() {},
    HTMLMediaElement: { prototype: {} },
    ArrayBuffer,
    Uint8Array,
    Map,
    Set,
    Promise,
    Object,
    String,
    JSON,
    Date,
    Math,
    RegExp,
    Error
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function jsonResponse(obj) {
  return {
    ok: true,
    headers: {
      get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : k.toLowerCase() === 'content-length' ? '800' : '')
    },
    clone() {
      return { text: async () => JSON.stringify(obj) };
    }
  };
}

function playResponse(ct) {
  return {
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : '') },
    clone() {
      return { text: async () => '' };
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- [1] fetch 拉播放列表 ---------- */
console.log('[1] fetch 拉 m3u8');
{
  const ctx = makeCtx(async (u) => {
    if (String(u).includes('.m3u8')) return playResponse('application/vnd.apple.mpegurl');
    return playResponse('application/octet-stream');
  });
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await ctx.fetch('https://video.twimg.com/amplify_video/1/pl/abc.m3u8?tag=16');
  await sleep(20);
  const hit = events.find((e) => e.kind === 'media' && /abc\.m3u8/.test(e.data.url));
  ok(!!hit, '捕获到播放列表地址');
  ok(hit && hit.data.type === 'hls', '类型标为 hls', hit && hit.data.type);
  ok(!!events.find((e) => e.kind === 'ready'), '发出注入通报 ready');
}

/* ---------- [2] 接口 JSON 里的视频变体 ---------- */
console.log('\n[2] 接口 JSON 响应体');
{
  events.length = 0;
  const ctx = makeCtx(async () => jsonResponse({
    data: {
      tweet: {
        video_info: {
          variants: [
            { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/2112363173596783023/vid/avc1/640x360/aBc.mp4?tag=16' },
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/2112363173596783023/pl/aBcDeF.m3u8?tag=16' }
          ]
        }
      }
    }
  }));
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await ctx.fetch('https://x.com/i/api/graphql/abc/TweetResultByRestId?variables=%7B%7D');
  await sleep(30);
  const urls = events.filter((e) => e.kind === 'media').map((e) => e.data.url);
  ok(urls.some((u) => u.includes('/pl/aBcDeF.m3u8')), '提取到 m3u8 变体');
  ok(urls.some((u) => /vid\/avc1\/640x360\/aBc\.mp4/.test(u)), '提取到 mp4 变体');
  const hls = events.find((e) => e.kind === 'media' && /aBcDeF\.m3u8/.test(e.data.url));
  ok(hls && hls.data.type === 'hls', 'm3u8 变体标为 hls');
}

/* ---------- [3] 无扩展名的播放列表 URL ---------- */
console.log('\n[3] 无扩展名但含 m3u8 特征');
{
  events.length = 0;
  const ctx = makeCtx(async () => playResponse('application/vnd.apple.mpegurl'));
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await ctx.fetch('https://cdn.example.com/playlist/master?m3u8=1&sig=abc');
  await sleep(20);
  ok(events.some((e) => e.kind === 'media' && e.data.url.includes('master')), '按特征词放宽后能捕获');
}

/* ---------- [4] Resource Timing 兜底 ---------- */
console.log('\n[4] Resource Timing 通道');
{
  events.length = 0;
  perfEntries.length = 0;
  perfEntries.push({ name: 'https://video.twimg.com/amplify_video/9/pl/perfOnly.m3u8?tag=16' });
  const ctx = makeCtx(async () => playResponse('text/html'));
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await sleep(40);
  ok(events.some((e) => e.kind === 'media' && /perfOnly\.m3u8/.test(e.data.url)), '从资源计时里捞到播放列表');
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
