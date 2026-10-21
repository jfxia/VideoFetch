/**
 * _dev/test-sniff.mjs — 后台嗅探逻辑测试
 * 重点验证两件事：
 *   1. 有 tabId 的请求正常归档
 *   2. tabId = -1（Service Worker / Worker 代发）的请求能按 initiator 找回归属标签页
 *   3. 被丢弃的可疑请求会进入诊断记录
 */
import { readFileSync } from 'node:fs';

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

/* ---------- mock ---------- */
const sessionStore = new Map();
const messageListeners = [];
const headerListeners = [];
const tabs = [
  { id: 42, url: 'https://x.com/axoo_o/status/2112363173596783023', title: 'axoo on X: "测试"', active: true },
  { id: 43, url: 'https://example.com/watch', title: '示例页', active: false }
];
let queriedPatterns = [];

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    sendMessage: async () => ({ ok: true })
  },
  storage: {
    session: {
      get: async (k) => {
        const key = typeof k === 'string' ? k : null;
        if (!key) return {};
        return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      remove: async (k) => sessionStore.delete(k),
      setAccessLevel: async () => {}
    },
    local: { get: async () => ({}), set: async () => {} }
  },
  tabs: {
    query: async ({ url }) => {
      queriedPatterns.push(url);
      const origin = url.replace('/*', '');
      return tabs.filter((t) => t.url.startsWith(origin));
    },
    get: async (id) => tabs.find((t) => t.id === id) || { id, title: '' },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    sendMessage: async () => ({ ok: true })
  },
  webRequest: {
    onHeadersReceived: { addListener: (fn) => headerListeners.push(fn) }
  },
  declarativeNetRequest: {
    updateSessionRules: async () => {},
    updateDynamicRules: async () => {}
  },
  downloads: { download: async () => 1 },
  offscreen: { createDocument: async () => {}, hasDocument: async () => true }
};

await import('../background/service-worker.js');

const [onHeaders] = headerListeners;
const fireHeaders = (d) => onHeaders(d);

function fireMsg(msg, sender = {}) {
  return new Promise((resolve) => {
    let done = false;
    const sendResponse = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    for (const fn of messageListeners) {
      const r = fn(msg, sender, sendResponse);
      if (r !== true && !done) {
        done = true;
        resolve(undefined);
      }
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 用例 ---------- */
console.log('[1] 普通请求：tabId 有效');
{
  fireHeaders({
    url: 'https://cdn.example.com/movie/index.m3u8',
    tabId: 43,
    type: 'xmlhttprequest',
    frameId: 0,
    initiator: 'https://example.com',
    documentUrl: 'https://example.com/watch',
    responseHeaders: [
      { name: 'content-type', value: 'application/vnd.apple.mpegurl' },
      { name: 'content-length', value: '1024' }
    ]
  });
  await sleep(60);
  const r = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  ok(r && r.ok, 'list 返回成功');
  ok(r.items.some((i) => i.url.includes('index.m3u8') && i.type === 'hls'), '归档为 hls');
}

console.log('\n[2] tabId = -1：Service Worker 代发的请求');
{
  fireHeaders({
    url: 'https://video.twimg.com/amplify_video/2112363173596783023/pl/aBcDeF.m3u8?tag=16',
    tabId: -1,
    type: 'xmlhttprequest',
    frameId: 0,
    initiator: 'https://x.com',
    documentUrl: '',
    responseHeaders: [
      { name: 'content-type', value: 'application/vnd.apple.mpegurl' },
      { name: 'content-length', value: '2481' }
    ]
  });
  await sleep(120);
  ok(queriedPatterns.includes('https://x.com/*'), '按 initiator 反查了标签页', queriedPatterns.join(' '));
  const r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  const hit = r.items.find((i) => i.url.includes('amplify_video'));
  ok(!!hit, '无 tabId 的流已归属到 x.com 标签页');
  ok(hit && hit.type === 'hls', '类型判定为 hls');
}

console.log('\n[3] 缺少 initiator 时不应误挂到别的标签页');
{
  const before = (await fireMsg({ target: 'sw', type: 'list', tabId: 43 })).items.length;
  fireHeaders({
    url: 'https://orphan.example.net/stream/x.m3u8',
    tabId: -1,
    type: 'other',
    frameId: 0,
    initiator: undefined,
    documentUrl: undefined,
    responseHeaders: [{ name: 'content-type', value: 'application/x-mpegURL' }]
  });
  await sleep(80);
  const after = (await fireMsg({ target: 'sw', type: 'list', tabId: 43 })).items.length;
  ok(before === after, '未污染的标签页列表');
}

console.log('\n[4] 注入通报与诊断快照');
{
  await fireMsg(
    { target: 'sw', type: 'hook-report', data: { url: 'https://x.com/axoo_o/status/2112363173596783023' } },
    { tab: { id: 42, url: 'https://x.com/axoo_o/status/2112363173596783023' }, frameId: 0 }
  );
  const r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  ok(r.diag && r.diag.hooked === true, '诊断显示已注入');
  ok(r.diag.net.media >= 1, '诊断统计到媒体请求', 'media=' + r.diag.net.media);
  ok(r.diag.global.orphan >= 2, '诊断统计到无归属请求', 'orphan=' + r.diag.global.orphan);
  ok(r.diag.global.orphanResolved >= 1, '诊断记下成功找回数量', 'resolved=' + r.diag.global.orphanResolved);
}

console.log('\n[5] 被丢弃的可疑请求要留证');
{
  fireHeaders({
    url: 'https://video.twimg.com/amplify_video/123/vid/avc1/480x270/tiny.mp4',
    tabId: 42,
    type: 'xmlhttprequest',
    frameId: 0,
    initiator: 'https://x.com',
    documentUrl: 'https://x.com/axoo_o/status/2112363173596783023',
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '4096' }
    ]
  });
  await sleep(50);
  const r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  ok(r.diag.ignored.some((x) => x.url.includes('tiny.mp4')), '过小的 mp4 进入诊断 ignored');
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
