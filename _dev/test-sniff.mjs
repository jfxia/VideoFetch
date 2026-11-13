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
const tabRemovedListeners = [];
const tabUpdatedListeners = [];
const badgeTexts = [];   // { tabId, text }
const badgeColors = [];  // { tabId, color }
const badgeTextColors = []; // { tabId, color }
const tabs = [
  { id: 42, url: 'https://x.com/axoo_o/status/2112363173596783023', title: 'axoo on X: "测试"', active: true },
  { id: 43, url: 'https://example.com/watch', title: '示例页', active: false }
];
let queriedPatterns = [];
const csCalls = [];   // 转发给 content script 的消息

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    sendMessage: async () => ({ ok: true }),
    // ensureOffscreen 会先问一遍现存的 offscreen 文档
    getContexts: async () => [],
    getURL: (p) => 'chrome-extension://test/' + p
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
    onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
    onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn) },
    sendMessage: async (id, m, opts) => { csCalls.push({ id, m, opts }); return { ok: true }; }
  },
  action: {
    setBadgeText: async (o) => badgeTexts.push(o),
    setBadgeBackgroundColor: async (o) => badgeColors.push(o),
    setBadgeTextColor: async (o) => badgeTextColors.push(o)
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
// probe-size 的探测结果由用例注入，验证回写校验
// resume 的结果也由用例控制：引擎还留着断点就返回 ok，否则表示会话已经没了
globalThis.__canResume = false;
chrome.runtime.sendMessage = async (m) => {
  if (m && m.type === 'probe-size') return { ok: true, size: globalThis.__probeSize };
  if (m && m.type === 'resume') {
    return globalThis.__canResume
      ? { ok: true }
      : { ok: false, error: '任务已不在后台，请重新开始下载' };
  }
  return { ok: true };
};

// 预置四种任务状态，供 [10] 组测重试：下载失败、后台重启前还在跑、已完成、录制数据已清。
// 必须放在后台模块导入之前 —— loadTasks 只在首次被调用时读存储，之后有缓存。
sessionStore.set('vf:tasks', [
  { id: 'rt1', kind: 'hls', title: '失败的任务', url: 'https://cdn.example.com/rt/a.m3u8',
    pageUrl: 'https://example.com/watch', tabId: 43, frameId: 0, mime: 'application/vnd.apple.mpegurl',
    variant: 3, variantUri: 'https://cdn.example.com/rt/720.m3u8',
    status: 'error', error: '网络中断', progress: 12, createdAt: Date.now() - 60000 },
  { id: 'rt2', kind: 'file', title: '后台重启前的任务', url: 'https://cdn.example.com/rt/b.mp4',
    pageUrl: 'https://example.com/watch', tabId: 43, status: 'running', progress: 30 },
  { id: 'rt3', kind: 'hls', title: '已完成', url: 'https://cdn.example.com/rt/c.m3u8',
    pageUrl: 'https://example.com/watch', tabId: 43, status: 'done', progress: 100 },
  { id: 'rt4', kind: 'blob', title: '录制已清', url: 'blob:https://example.com/1',
    pageUrl: 'https://example.com/watch', tabId: 43, status: 'error', recId: null }
]);

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

/** 某个 tabId 最近一次角标文本（undefined = 还没写过） */
function lastBadge(tabId) {
  for (let i = badgeTexts.length - 1; i >= 0; i--) {
    if (badgeTexts[i].tabId === tabId) return badgeTexts[i].text;
  }
  return undefined;
}
const lastBadgeColor = (tabId) => {
  for (let i = badgeColors.length - 1; i >= 0; i--) {
    if (badgeColors[i].tabId === tabId) return badgeColors[i].color;
  }
  return undefined;
};
const lastBadgeTextColor = (tabId) => {
  for (let i = badgeTextColors.length - 1; i >= 0; i--) {
    if (badgeTextColors[i].tabId === tabId) return badgeTextColors[i].color;
  }
  return undefined;
};

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

console.log('\n[6] 图标角标：红点只数视频卡片');
{
  // 先按真实顺序走一遍页面装载：文档标识记下来，后面的换页才有"上一页"可比
  const [onUpdated] = tabUpdatedListeners;
  onUpdated(43, { status: 'loading', url: 'https://example.com/watch' });
  await sleep(20);

  // [1] 已给 tab 43 归档了 1 条 hls（index.m3u8，路径无长数字 ID，自成一卡）
  await sleep(30);
  ok(lastBadge(43) === '1', '有视频源时红点显示 1', 'text=' + lastBadge(43));
  ok(/^#/.test(String(lastBadgeColor(43))), '红点带背景色', String(lastBadgeColor(43)));
  ok(lastBadgeTextColor(43) === '#FFFFFF', '红点数字为白色', String(lastBadgeTextColor(43)));

  // 同一视频的另一档变体：共用路径里的长数字 ID，仍是一张卡片
  fireHeaders({
    url: 'https://cdn.example.com/movie/87654321/index.m3u8',
    tabId: 43, type: 'xmlhttprequest', frameId: 0, initiator: 'https://example.com',
    documentUrl: 'https://example.com/watch',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }]
  });
  await sleep(60);
  ok(lastBadge(43) === '2', '新增视频后红点变为 2', 'text=' + lastBadge(43));
  fireHeaders({
    url: 'https://cdn.example.com/movie/87654321/720p.m3u8',
    tabId: 43, type: 'xmlhttprequest', frameId: 0, initiator: 'https://example.com',
    documentUrl: 'https://example.com/watch',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }]
  });
  await sleep(60);
  ok(lastBadge(43) === '2', '同视频的另一档不计入红点', 'text=' + lastBadge(43));

  // 纯音轨不算视频
  fireHeaders({
    url: 'https://cdn.example.com/clips/CMAF_AUDIO_64.mp4',
    tabId: 43, type: 'xmlhttprequest', frameId: 0, initiator: 'https://example.com',
    documentUrl: 'https://example.com/watch',
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '1048576' }
    ]
  });
  await sleep(60);
  ok(lastBadge(43) === '2', '纯音轨不计入红点', 'text=' + lastBadge(43));

  // 再来一个真正的视频
  fireHeaders({
    url: 'https://cdn.example.net/other/99887766/1080p.mp4',
    tabId: 43, type: 'xmlhttprequest', frameId: 0, initiator: 'https://example.com',
    documentUrl: 'https://example.com/watch',
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '52428800' }
    ]
  });
  await sleep(60);
  ok(lastBadge(43) === '3', '红点变为 3', 'text=' + lastBadge(43));

  // 同源换页：路径变了就是另一个页面，上一次的结果不能留
  onUpdated(43, { status: 'loading', url: 'https://example.com/watch?v=2' });
  await sleep(40);
  ok(lastBadge(43) === '', '同站换到另一页后红点消失', 'text=' + JSON.stringify(lastBadge(43)));
  let after = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  ok(after.items.length === 0, '同站换页后列表清空', 'items=' + after.items.length);

  // 回到原页再攒两个源，验证跨站跳转（老用例的语义）依旧清
  await fireMsg(
    { target: 'sw', type: 'page-media', items: [{ url: 'https://cdn.example.net/a/11112222/1080p.mp4', type: 'file', mime: 'video/mp4' }] },
    { tab: { id: 43, url: 'https://example.com/watch?v=2' }, frameId: 0 }
  );
  await sleep(60);
  ok(lastBadge(43) === '1', '新页面的源正常入列', 'text=' + lastBadge(43));
  onUpdated(43, { status: 'loading', url: 'https://example.org/another' });
  await sleep(40);
  ok(lastBadge(43) === '', '跨站跳转后红点消失', 'text=' + JSON.stringify(lastBadge(43)));

  // 没有视频源的标签页从未被写过红点
  ok(lastBadge(99) === undefined, '无视频的标签页不显示红点');
}

console.log('\n[7] 非媒体内容不进列表');
{
  const before = (await fireMsg({ target: 'sw', type: 'list', tabId: 43 })).items.length;
  await fireMsg(
    { target: 'sw', type: 'page-media', items: [
      { url: 'https://cdn.example.com/photo/big.JPEG?w=800', type: 'file' },
      { url: 'https://cdn.example.com/photo/raw.jpg', type: 'file', mime: 'image/jpeg' },
      { url: 'https://cdn.example.com/files/report.pdf', type: 'file' }
    ] },
    { tab: { id: 43, url: 'https://example.com/watch' }, frameId: 0 }
  );
  await sleep(80);
  const r = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  ok(r.items.length === before, '图片与文档没有增加列表条目');
  ok(!r.items.some((i) => /\.(?:jpe?g|pdf)(?:[?#]|$)/i.test(i.url)), '列表中无图片文档地址', r.items.map((i) => i.url).join(' ').slice(-80));
}

console.log('\n[7] 同路径不同签名参数的重复抓取合并为一条');
{
  const P = 'https://f.video.weibocdn.com/002TUY2Ulx/AbCdEf0104.mp4';
  const fire = (ssig, len, expires) =>
    fireHeaders({
      url: `${P}?label=mp4_hd&Expires=${expires}&ssig=${ssig}`,
      tabId: 43, type: 'xmlhttprequest', frameId: 0, initiator: 'https://example.org',
      documentUrl: 'https://example.org/another',
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-length', value: String(len) }
      ]
    });

  fire('AAA', 10485760, 1760000000);
  await sleep(60);
  // 页面预取 + 播放器再取一次：签名变了，content-length 因 4 字节对齐略有出入
  fire('BBB', 10485764, 1760003600);
  await sleep(60);
  let r = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  const mine = r.items.filter((i) => i.url.includes('weibocdn'));
  ok(mine.length === 1, '同路径两次抓取只留一条', String(mine.length));
  ok(mine[0] && mine[0].url.includes('ssig=BBB'), '保留新签名的地址', mine[0] && mine[0].url);
  ok(mine[0] && mine[0].size === 10485760, '缺失时补齐 size，已有值不被覆盖', mine[0] && String(mine[0].size));

  // 大小对不上（超过 1%）：不能当同一个文件（太小会被丢弃门槛拦下，这里用 4 MB）
  fire('CCC', 4194304, 1760000000);
  await sleep(60);
  r = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  const mine2 = r.items.filter((i) => i.url.includes('weibocdn'));
  ok(mine2.length === 2, '大小差异过大时不合并', String(mine2.length));
}

console.log('\n[8] probe-size 回写校验：可疑小值不写入');
{
  fireHeaders({
    url: 'https://f.video.weibocdn.com/o0/AbCdEf0104.mp4?ssig=X',
    tabId: 42, type: 'xmlhttprequest', frameId: 0, initiator: 'https://x.com',
    documentUrl: 'https://x.com/axoo_o/status/2112363173596783023',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }]
  });
  await sleep(60);
  globalThis.__probeSize = 552; // 签名 URL 对探测返回的 552B 错误体
  await fireMsg({ target: 'sw', type: 'probe-size', url: 'https://f.video.weibocdn.com/o0/AbCdEf0104.mp4?ssig=X', tabId: 42 });
  let r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  let hit = r.items.find((i) => i.url.includes('AbCdEf0104'));
  ok(hit && !hit.size, '可疑小值 552 不回写', hit && String(hit.size));
  globalThis.__probeSize = 5242880;
  await fireMsg({ target: 'sw', type: 'probe-size', url: 'https://f.video.weibocdn.com/o0/AbCdEf0104.mp4?ssig=X', tabId: 42 });
  r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  hit = r.items.find((i) => i.url.includes('AbCdEf0104'));
  ok(hit && hit.size === 5242880, '可信大小正常回写', hit && String(hit.size));
  delete globalThis.__probeSize;
}

console.log('\n[9] 录制导出后撤掉页面侧数据与列表卡片');
{
  await fireMsg(
    { target: 'sw', type: 'page-media', items: [
      { url: 'https://cdn.example.com/rec/one.mp4', type: 'file', mime: 'video/mp4', recId: 'r9' },
      { url: 'https://cdn.example.com/rec/two.mp4', type: 'file', mime: 'video/mp4' }
    ] },
    { tab: { id: 42, url: 'https://x.com/axoo_o/status/2112363173596783023' }, frameId: 0 }
  );
  await sleep(80);
  let r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  ok(r.items.some((i) => i.recId === 'r9'), '录制来源先出现在列表里');

  const mark = csCalls.length;
  await fireMsg({ target: 'sw', type: 'record-drop', tabId: 42, frameId: 0, recId: 'r9' });
  await sleep(40);

  const fwd = csCalls.slice(mark).find((c) => c.m && c.m.type === 'record-drop');
  ok(!!fwd, '通知 content script 删页面侧分片', fwd ? JSON.stringify(fwd.m) : '未转发');
  ok(fwd && fwd.m.recId === 'r9' && fwd.id === 42, '带对的 recId 与标签页');

  r = await fireMsg({ target: 'sw', type: 'list', tabId: 42 });
  ok(!r.items.some((i) => i.recId === 'r9'), '已导出过的录制卡片撤掉');
  ok(r.items.some((i) => i.url.includes('rec/two.mp4')), '不相关的来源不受影响');
  ok(lastBadge(42) !== '', '角标跟着重算', 'text=' + JSON.stringify(lastBadge(42)));
}

console.log('\n[10] 失败任务的重试');
{
  const find = (arr, id) => (arr || []).find((t) => t.id === id) || {};
  const l0 = await fireMsg({ target: 'sw', type: 'list', tabId: 43 });
  ok(find(l0.tasks, 'rt2').status === 'interrupted', '后台重启后跑着的任务落到「中断」', String(find(l0.tasks, 'rt2').status));

  // 引擎那边断点还在：重试接着下，进度不清零
  globalThis.__canResume = true;
  const r1 = await fireMsg({ target: 'sw', type: 'retry', taskId: 'rt1' });
  ok(r1 && r1.ok, '失败的任务可以重试', String(r1 && r1.error));
  ok(r1.resumed === true, '断点还在，选择续传而不是重下', String(r1 && r1.resumed));
  const t1 = find((await fireMsg({ target: 'sw', type: 'list', tabId: 43 })).tasks, 'rt1');
  ok(['queued', 'running'].includes(t1.status), '状态回到进行中', String(t1.status));
  ok(!t1.error, '旧的错误文字被清掉', String(t1.error));
  ok(t1.progress === 12, '进度保留，不从 0 重来', String(t1.progress));
  ok(t1.url === 'https://cdn.example.com/rt/a.m3u8', '原地址保留');
  ok(t1.variant === 3 && /720\.m3u8$/.test(t1.variantUri), '原档位保留，不会悄悄降级', t1.variant + ' / ' + t1.variantUri);

  // 引擎那边会话已经没了（后台重启过）：只能从头再来，进度归零
  globalThis.__canResume = false;
  const r2 = await fireMsg({ target: 'sw', type: 'retry', taskId: 'rt2' });
  ok(r2 && r2.ok, '中断的任务也能重试', String(r2 && r2.error));
  ok(r2.resumed === false, '会话随后台重启消失，改走重下', String(r2 && r2.resumed));
  const t2 = find((await fireMsg({ target: 'sw', type: 'list', tabId: 43 })).tasks, 'rt2');
  ok(t2.progress === 0 && t2.received === 0, '这种情况进度归零', String(t2.progress));

  const r3 = await fireMsg({ target: 'sw', type: 'retry', taskId: 'rt3' });
  ok(r3 && r3.ok === false, '已完成的任务不接受重试', String(r3 && r3.error));
  const r4 = await fireMsg({ target: 'sw', type: 'retry', taskId: 'rt4' });
  ok(r4 && r4.ok === false && /录制数据/.test(r4.error), '录制数据已清的任务说明原因', String(r4 && r4.error));
  const r5 = await fireMsg({ target: 'sw', type: 'retry', taskId: 'gone' });
  ok(r5 && r5.ok === false && /不存在/.test(r5.error), '找不到的任务给出提示', String(r5 && r5.error));

  // 这些字段不进持久化，SW 重启后重试就只能退回第 0 档重新选
  const saved = sessionStore.get('vf:tasks') || [];
  const s1 = find(saved, 'rt1');
  ok(s1.url && s1.variant === 3 && s1.variantUri, '持久化保留地址与档位', [s1.url, s1.variant, s1.variantUri].join(' | '));
}

console.log('\n[11] 视频源只保留当前页面');
{
  const T = 44;
  const senderOf = (url, frameId = 0) => ({ tab: { id: T, url }, frameId });
  const addOne = async (url, pageUrl) => {
    await fireMsg(
      { target: 'sw', type: 'page-media', items: [{ url, type: 'file', mime: 'video/mp4' }] },
      senderOf(pageUrl || 'https://spa.test/play/1')
    );
    await sleep(40);
  };
  const listOf = async (pageUrl) => {
    const m = { target: 'sw', type: 'list', tabId: T };
    if (pageUrl) m.pageUrl = pageUrl;
    return fireMsg(m);
  };

  // 页面装载：主框架 hook 通报，记下这一份文档
  await fireMsg({ target: 'sw', type: 'hook-report', data: { url: 'https://spa.test/play/1' } }, senderOf('https://spa.test/play/1'));
  await addOne('https://cdn.spa.test/v/1/a.mp4');
  ok((await listOf()).items.length === 1, '当前页的源正常显示');
  ok(lastBadge(T) === '1', '红点计入当前页的源', 'text=' + lastBadge(T));

  // 单页应用换路由：文档没重载，旧源退场
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://spa.test/play/2' }, senderOf('https://spa.test/play/2'));
  await sleep(40);
  ok((await listOf()).items.length === 0, '换路由后旧源不再列出');
  ok(lastBadge(T) === '', '换路由后红点归零', 'text=' + JSON.stringify(lastBadge(T)));

  // 同一地址又被播放器取一次：说明它还在用，复活
  await addOne('https://cdn.spa.test/v/1/a.mp4', 'https://spa.test/play/2');
  ok((await listOf()).items.length === 1, '同一地址再次上报则复活');

  // 拖进度、暂停这类只改播放状态的参数不算换页
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://spa.test/play/2?t=42' }, senderOf('https://spa.test/play/2?t=42'));
  await sleep(30);
  ok((await listOf()).items.length === 1, '只改播放进度不算换页，源还在');
  // 换了一集（真正的路由变化）
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://spa.test/play/2?ep=3' }, senderOf('https://spa.test/play/2?ep=3'));
  await sleep(30);
  ok((await listOf()).items.length === 0, '换集后旧源退场');

  // 哈希分页与普通锚点的区别
  await addOne('https://cdn.spa.test/v/2/b.mp4', 'https://spa.test/play/2?ep=3');
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://spa.test/play/2?ep=3#comments' }, senderOf('https://spa.test/play/2?ep=3#comments'));
  await sleep(30);
  ok((await listOf()).items.length === 1, '跳到页内锚点不算换页');
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://spa.test/play/2?ep=3#/v/9' }, senderOf('https://spa.test/play/2?ep=3#/v/9'));
  await sleep(30);
  ok((await listOf()).items.length === 0, '哈希路由变化算换页');

  // 主框架整页换到另一个站点：不留任何旧条目
  await fireMsg({ target: 'sw', type: 'hook-report', data: { url: 'https://other.test/x' } }, senderOf('https://other.test/x'));
  await sleep(40);
  ok((await listOf()).items.length === 0, '整页换站后清空');
  ok(sessionStore.get('vf:doc:' + T) === 'https://other.test/x', '当前页面记在存储里（后台重启后仍能比对）');

  // 弹窗知道当前停在哪一页：与记录不符就顺手清掉（事件漏收时的兜底）
  await addOne('https://cdn.other.test/y.mp4', 'https://other.test/x');
  ok((await listOf('https://other.test/x')).items.length === 1, '同页打开弹窗不清');
  ok((await listOf('https://other.test/z')).items.length === 0, '弹窗报的页面与记录不符则清空');
  await addOne('https://cdn.other.test/y.mp4', 'https://other.test/z');
  ok((await listOf()).items.length === 1, '不带页面信息时不做判断，避免误清');

  // iframe 里的路由变化不归这个标签页管
  await fireMsg({ target: 'sw', type: 'page-nav', url: 'https://other.test/z?iframe=1' }, { tab: { id: T, url: 'https://other.test/z' }, frameId: 7 });
  await sleep(30);
  ok((await listOf('https://other.test/z')).items.length === 1, '子框架换路由不影响主页面');
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
