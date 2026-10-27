/**
 * _dev/test-popup.mjs — 视频源列表渲染测试
 * 用最小 DOM 桩把 popup.js 真跑起来，验证：
 *   1. 同一视频的多档变体合并成一张卡片
 *   2. JSON 之类的非媒体直链不出现
 *   3. 时长不足一分钟不会显示成「0 分钟」
 *   4. 26 条原始条目收敛到少数几张卡片
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

/* ---------- 最小 DOM ---------- */
const nodes = new Map();
const sent = [];
const dl = { opened: [], shown: [], folders: 0, failOpen: false };

function makeEl(tag) {
  const e = {
    tagName: tag,
    className: '',
    id: '',
    textContent: '',
    value: '',
    title: '',
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) {
        if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (on) this._s.add(c);
        else this._s.delete(c);
      }
    },
    appendChild(c) { this.children.push(c); return c; },
    _ls: {},
    addEventListener(type, fn) {
      (this._ls[type] = this._ls[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = this._ls[type];
      if (a) this._ls[type] = a.filter((x) => x !== fn);
    },
    async dispatch(type, ev) {
      const a = this._ls[type] || [];
      for (const fn of a) await fn(ev || { type, target: this });
    },
    setAttribute() {},
    remove() {},
    querySelectorAll() { return []; }
  };
  let _text = '';
  Object.defineProperty(e, 'textContent', {
    get() { return _text; },
    set(v) {
      _text = String(v == null ? '' : v);
      if (_text === '') e.children.length = 0;
    }
  });
  return e;
}

function idEl(id) {
  if (!nodes.has(id)) {
    const e = makeEl('div');
    e.id = id;
    nodes.set(id, e);
  }
  return nodes.get(id);
}

function textOf(n) {
  if (!n) return '';
  let s = n.textContent || '';
  for (const c of n.children || []) s += ' ' + textOf(c);
  return s.trim();
}

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Map,
  Set,
  Promise,
  Object,
  String,
  Number,
  Array,
  RegExp,
  Error,
  URL,
  ArrayBuffer,
  Uint8Array,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  document: {
    getElementById: idEl,
    createElement: makeEl,
    querySelectorAll: () => [],
    body: makeEl('body')
  },
  navigator: { language: 'zh-CN', languages: ['zh-CN'], clipboard: { writeText() {} } },
  chrome: {
    tabs: {
      query: async () => [{ id: 42, url: 'https://x.com/axoo_o/status/2112363173596783023' }]
    },
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === 'list') return { ok: true, items: [], tasks: [], diag: { hooked: true, hooks: [], net: {}, ignored: [] } };
        return { ok: true };
      },
      onMessage: { addListener() {} }
    },
    downloads: {
      showDefaultFolder() { dl.folders++; },
      show(id) { dl.shown.push(id); },
      // 真实接口走 callback + chrome.runtime.lastError，桩按同一套写法
      open(id, cb) {
        if (dl.failOpen) ctx.chrome.runtime.lastError = { message: 'File not found' };
        else dl.opened.push(id);
        try { if (cb) cb(); } finally { delete ctx.chrome.runtime.lastError; }
      }
    }
  }
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

// 文案表：popup.js 里所有界面文字都走 VFI18N
vm.runInContext(readFileSync(new URL('../lib/i18n.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8'), ctx);

/* ---------- 构造 26 条真实形态的条目 ---------- */
const VID = '2112363173596783023';
const HLS = `https://video.twimg.com/amplify_video/${VID}/pl/aBcDeF.m3u8?tag=16`;
const mp4 = (res) => `https://video.twimg.com/amplify_video/${VID}/vid/avc1/${res}/aBcDeF.mp4?tag=16`;

const now = Date.now();
const items = [
  { id: '1', url: HLS, type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 2481, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now },
  { id: '2', url: mp4('1920x1080'), type: 'file', mime: 'video/mp4', size: 8200000, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 10 },
  { id: '3', url: mp4('1280x720'), type: 'file', mime: 'video/mp4', size: 4200000, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 20 },
  { id: '4', url: mp4('640x360'), type: 'file', mime: 'video/mp4', size: 1100000, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 30 },
  { id: '5', url: mp4('480x270'), type: 'file', mime: 'video/mp4', size: 620000, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 40 },
  { id: '6', url: mp4('320x180'), type: 'file', mime: 'video/mp4', size: 280000, title: 'axoo on X', pageUrl: '', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 50 },
  // 噪音：JSON 接口、图片、网页
  { id: '7', url: 'https://x.com/i/api/graphql/abc/TweetResultByRestId', type: 'file', mime: 'application/json', size: 180000, title: 'axoo on X', host: 'x.com', frameId: 0, from: 'page', ts: now - 5 },
  { id: '8', url: 'https://abs.twimg.com/responsive-web/client-web/main.js', type: 'file', mime: 'application/javascript', size: 900000, title: 'axoo on X', host: 'abs.twimg.com', frameId: 0, from: 'page', ts: now - 6 },
  { id: '9', url: 'https://pbs.twimg.com/media/abc.jpg', type: 'file', mime: 'image/jpeg', size: 120000, title: 'axoo on X', host: 'pbs.twimg.com', frameId: 0, from: 'network', ts: now - 7 },
  // 另一条推文的视频（时间线预加载）
  { id: '10', url: 'https://video.twimg.com/amplify_video/2112000000000000001/pl/zzz.m3u8?tag=16', type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 1900, title: 'axoo on X', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 600 },
  { id: '11', url: 'https://video.twimg.com/amplify_video/2112000000000000001/vid/avc1/1280x720/zzz.mp4?tag=16', type: 'file', mime: 'video/mp4', size: 3000000, title: 'axoo on X', host: 'video.twimg.com', frameId: 0, from: 'api', ts: now - 610 },
  // 录制流
  { id: '12', url: 'blob:https://x.com/8f3a-1111', type: 'blob', mime: 'video/mp4;codecs="avc1.64001f,mp4a.40.2"', recId: 'r1', title: 'axoo on X', host: 'x.com', frameId: 0, from: 'mse', ts: now - 2 }
];

vm.runInContext('items = ' + JSON.stringify(items), ctx);
vm.runInContext(`probeCache.set(${JSON.stringify(HLS)}, {
  ok: true, type: 'master', live: false,
  variants: [
    { index: 0, label: '1920x1080', bandwidth: 2176000, resolution: '1920x1080' },
    { index: 1, label: '1280x720', bandwidth: 832000, resolution: '1280x720' },
    { index: 2, label: '640x360', bandwidth: 288000, resolution: '640x360' }
  ]
})`, ctx);
vm.runInContext(`probeCache.set('https://video.twimg.com/amplify_video/2112000000000000001/pl/zzz.m3u8?tag=16', {
  ok: true, type: 'master', live: false,
  variants: [{ index: 0, label: '1280x720', bandwidth: 832000, resolution: '1280x720' }]
})`, ctx);

vm.runInContext('renderSources()', ctx);

const cards = nodes.get('src-list').children;
const allText = cards.map(textOf).join(' | ');

console.log('[1] 分组与去噪');
ok(cards.length === 3, '12 条输入收敛为 3 张卡片', '实际 ' + cards.length + ' 张');
ok(!/TweetResultByRestId/.test(allText), 'JSON 接口被过滤');
ok(!/main\.js/.test(allText), '脚本被过滤');
ok(!/abc\.jpg/.test(allText), '图片被过滤');

console.log('\n[2] 同一视频合并');
const first = cards[0];
const firstText = textOf(first);
ok(/video\.twimg\.com/.test(firstText), '首卡是当前推文的视频');
ok(/个清晰度/.test(firstText), '显示清晰度数量', (firstText.match(/\d+ 个清晰度/) || [''])[0]);
const ops = first.children[first.children.length - 1];
const selects = ops.children.filter((c) => c.tagName === 'select');
ok(selects.length === 1, '首卡只有一个清晰度下拉');
ok(selects[0] && selects[0].children.length === 8, '下拉含 3 档 HLS + 5 档直链', selects[0] && String(selects[0].children.length));
ok(selects[0] && /HLS/.test(selects[0].children[0].textContent), '默认选中最高清 HLS', selects[0] && selects[0].children[0].textContent);

console.log('\n[3] 录制流垫底');
ok(/BLOB/.test(textOf(cards[cards.length - 1])), '最后一张是 BLOB');

console.log('\n[4] 时长格式');
vm.runInContext(`probeCache.set('https://v.example.com/hls/9999999900001/index.m3u8', { ok: true, type: 'media', live: false, duration: 17, segments: 6 })`, ctx);
vm.runInContext(`items = [{ id: 'x', url: 'https://v.example.com/hls/9999999900001/index.m3u8', type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 500, title: '短片段', host: 'v.example.com', frameId: 0, from: 'network', ts: Date.now() }]`, ctx);
vm.runInContext('renderSources()', ctx);
const shortText = textOf(nodes.get('src-list').children[0]);
ok(/17 秒/.test(shortText), '短时长显示为秒', shortText);
ok(!/0 分钟/.test(shortText), '不再出现「0 分钟」');

/* ---------- 5. 清晰度选择必须与实际下载档位一致 ---------- */
console.log('\n[5] 下拉切换到实际下载档位');
{
  const M = 'https://missav.example/hls/siro-5711/master.m3u8';
  const V = [
    { h: 2160, uri: 'https://cdn.example/siro-5711/2160p/index.m3u8' },
    { h: 1080, uri: 'https://cdn.example/siro-5711/1080p/index.m3u8' },
    { h: 720, uri: 'https://cdn.example/siro-5711/720p/index.m3u8' },
    { h: 480, uri: 'https://cdn.example/siro-5711/480p/index.m3u8' }
  ];
  // 引擎真实返回形态：resolution 是对象
  const variants = V.map((v, i) => ({
    index: i,
    label: '1920x' + v.h + ' · 2000kbps',
    bandwidth: 2000000,
    resolution: { width: 1920, height: v.h },
    uri: v.uri
  }));

  vm.runInContext(`probeCache.set(${JSON.stringify(M)}, ${JSON.stringify({
    ok: true, type: 'master', live: false, variants
  })})`, ctx);
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'm1', url: M, type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 400, title: 'siro-5711', host: 'missav.example', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);

  const card = nodes.get('src-list').children[0];
  const opsBox = card.children[card.children.length - 1];
  const sel = opsBox.children.find((c) => c.tagName === 'select');
  const btn = opsBox.children.find((c) => c.tagName === 'button');
  ok(!!sel && !!btn, '拿到下拉与按钮');
  ok(sel.children.length === 4, '4 档清晰度', String(sel.children.length));
  ok(sel.children[0].textContent.indexOf('2160') >= 0, '首项是最高档', sel.children[0].textContent);

  function lastStart() {
    const a = sent.filter((m) => m.type === 'start');
    return a[a.length - 1];
  }

  // 场景 A：改选 720p 后直接点下载（不触发重渲染）
  sel.value = '1';           // 选项 1 = 1080p
  await sel.dispatch('change');
  sel.value = '2';           // 选项 2 = 720p
  await sel.dispatch('change');
  await btn.dispatch('click');
  const a = lastStart();
  ok(a && a.variant === 2, '选 720p 时 variant=2', a ? String(a.variant) : 'null');
  ok(a && a.variantUri === V[2].uri, '同时带上 720p 的 URI', a && a.variantUri);

  // 场景 B：再改回 1080p 后点下载（模拟用户来回切换）
  sel.value = '1';
  await sel.dispatch('change');
  await btn.dispatch('click');
  const b = lastStart();
  ok(b && b.variant === 1, '改回 1080p 时 variant=1', b ? String(b.variant) : 'null');
  ok(b && b.variantUri === V[1].uri, '同时带上 1080p 的 URI', b && b.variantUri);

  // 场景 C：重渲染后仍保持用户选择
  // reload() 在测试里拿到空列表会把 items 清掉，这里补回条目再渲染
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'm1', url: M, type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 400, title: 'siro-5711', host: 'missav.example', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);
  const card2 = nodes.get('src-list').children[0];
  const ops2 = card2.children[card2.children.length - 1];
  const sel2 = ops2.children.find((c) => c.tagName === 'select');
  const btn2 = ops2.children.find((c) => c.tagName === 'button');
  ok(sel2 && String(sel2.value) === '1', '重渲染后仍停在 1080p', sel2 && String(sel2.value));
  await btn2.dispatch('click');
  const c2 = lastStart();
  ok(c2 && c2.variant === 1, '重渲染后点击仍是 1080p', c2 ? String(c2.variant) : 'null');
}

/* ---------- 6. 同一分辨率多套编码只留一项（Reddit：720p 同时给 avc/vp9）---------- */
console.log('\n[6] 重复分辨率去重');
{
  const M = 'https://v.redd.it/d36t7r0slpwh1/HLSPlaylist.m3u8';
  const AVC = 'https://v.redd.it/d36t7r0slpwh1/CMAF_720.m3u8';
  const VP9 = 'https://v.redd.it/d36t7r0slpwh1/CMAF_VP9_720.m3u8';
  const LOW = 'https://v.redd.it/d36t7r0slpwh1/CMAF_220.m3u8';
  const variants = [
    { index: 0, label: '720x720 · 2606kbps', bandwidth: 2606147, codecs: 'avc1.4d401f,mp4a.40.2', resolution: { width: 720, height: 720 }, uri: AVC },
    { index: 1, label: '720x720 · 1613kbps', bandwidth: 1612888, codecs: 'vp09.00.30.08.01.01.01.01.00,mp4a.40.2', resolution: { width: 720, height: 720 }, uri: VP9 },
    { index: 2, label: '220x220 · 318kbps', bandwidth: 317670, codecs: 'avc1.4d401e,mp4a.40.2', resolution: { width: 220, height: 220 }, uri: LOW }
  ];
  vm.runInContext(`probeCache.set(${JSON.stringify(M)}, ${JSON.stringify({ ok: true, type: 'master', live: false, variants })})`, ctx);
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'r1', url: M, type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 900, title: 'reddit clip', host: 'v.redd.it', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);

  const card = nodes.get('src-list').children[0];
  const opsBox = card.children[card.children.length - 1];
  const sel = opsBox.children.find((c) => c.tagName === 'select');
  const btn = opsBox.children.find((c) => c.tagName === 'button');
  ok(sel && sel.children.length === 2, '3 个变体收敛为 2 档', sel && String(sel.children.length));

  sel.value = '0';
  await sel.dispatch('change');
  await btn.dispatch('click');
  const a = sent.filter((m) => m.type === 'start').pop();
  ok(a && a.variantUri === AVC, '720p 选中 H.264 那一路', a && a.variantUri);
  ok(a && a.variant === 0, '索引跟着对上', a ? String(a.variant) : 'null');
}

/* ---------- 7. 纯音频源（Reddit 的 CMAF_AUDIO_*.mp4/m3u8）单独收起 ---------- */
console.log('\n[7] 纯音频源不进视频列表');
{
  const VID = 'https://v.redd.it/d36t7r0slpwh1';
  const M = VID + '/HLSPlaylist.m3u8';
  vm.runInContext(`probeCache.set(${JSON.stringify(M)}, ${JSON.stringify({
    ok: true, type: 'master', live: false,
    variants: [
      { index: 0, label: '720x720 · 2606kbps', bandwidth: 2606147, codecs: 'avc1.4d401f,mp4a.40.2', resolution: { width: 720, height: 720 }, uri: VID + '/CMAF_720.m3u8' },
      { index: 1, label: '220x220 · 318kbps', bandwidth: 317670, codecs: 'avc1.4d401e,mp4a.40.2', resolution: { width: 220, height: 220 }, uri: VID + '/CMAF_220.m3u8' }
    ]
  })})`, ctx);

  const mk = (id, url, type, mime) => ({
    id, url, type, mime, size: 1000, title: 'reddit clip', host: 'v.redd.it', frameId: 0, from: 'network', ts: Date.now()
  });
  vm.runInContext(`items = ${JSON.stringify([
    mk('v1', M, 'hls', 'application/x-mpegurl'),
    mk('a1', VID + '/CMAF_AUDIO_64.mp4', 'file', 'video/mp4'),
    mk('a2', VID + '/CMAF_AUDIO_128.mp4', 'file', 'video/mp4'),
    mk('a3', VID + '/CMAF_AUDIO_128.m3u8', 'hls', 'application/x-mpegurl'),
    mk('a4', VID + '/CMAF_VIDEO_ONLY_AUDIO_TRACK.mp4', 'file', 'video/mp4')
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);

  const list = nodes.get('src-list');
  ok(list.children.length === 3, '2 张视频卡 + 折叠区', String(list.children.length));
  ok(/HLS/.test(textOf(list.children[0])), '首块是视频源');

  const more = list.children[2];
  const btn = more.children.find((c) => c.tagName === 'button');
  const box = more.children.find((c) => c.className === 'audio-list');
  ok(/另有 3 个纯音频源/.test(textOf(btn)), '折叠区提示 3 个纯音频源', textOf(btn));
  ok(box && box.hidden === true, '默认收起');
  ok(!/CMAF_AUDIO/.test(textOf(list.children[0])), '视频卡里不出现音轨地址');

  await btn.dispatch('click');
  ok(box.hidden === false, '点击后展开');
  ok(/下载音频/.test(textOf(box)), '展开后按钮为「下载音频」');
  ok((box.children || []).length === 3, '3 张音频卡片', String(box.children.length));
  ok(/仅声音/.test(textOf(box)), '标出「仅声音 · 无画面」');

  // 名字里同时有 audio 与 video 的仍按视频处理
  ok(/CMAF_VIDEO_ONLY_AUDIO_TRACK|HLS/.test(textOf(list.children[0])), '含 video 字样的不误判为音轨');
}

/* ---------- 8. 任务卡的暂停 / 继续 / 保存 ---------- */
console.log('\n[8] 任务卡：暂停 / 继续 / 保存');
{
  const mkTask = (patch) => ({
    id: 'tk', title: '测试视频', status: 'running', progress: 40, received: 4 * 1024 * 1024,
    total: 10 * 1024 * 1024, speed: 1024 * 1024, segmentsDone: 2, segmentsTotal: 5,
    variantLabel: '720p', createdAt: Date.now(), ...patch
  });

  const render = (t) => {
    vm.runInContext('tasks = ' + JSON.stringify([t]), ctx);
    vm.runInContext('renderTasks()', ctx);
    return nodes.get('task-list').children[0];
  };
  const buttons = (card) => {
    const acts = (card.children || []).find((c) => c.className === 'acts');
    return acts ? acts.children.filter((c) => c.tagName === 'button') : [];
  };
  const labels = (card) => buttons(card).map((b) => b.textContent).join('/');
  const findByLabel = (card, s) => buttons(card).find((b) => b.textContent.indexOf(s) >= 0);

  const running = render(mkTask());
  ok(/暂停\/保存\/取消/.test(labels(running)), '运行中：暂停 · 保存 · 取消', labels(running));

  sent.length = 0;
  await findByLabel(running, '暂停').dispatch('click');
  ok(sent.some((m) => m.type === 'pause' && m.taskId === 'tk'), '点暂停发出 pause');

  sent.length = 0;
  await findByLabel(running, '保存').dispatch('click');
  ok(sent.some((m) => m.type === 'save' && m.taskId === 'tk'), '点保存发出 save');

  const paused = render(mkTask({ status: 'paused', progress: 40, speed: 0 }));
  ok(/继续\/保存\/取消/.test(labels(paused)), '暂停中：继续 · 保存 · 取消', labels(paused));
  ok(/已暂停/.test(textOf(paused)), '副标题标出「已暂停」');
  ok(/40%/.test(textOf(paused)), '保留真实进度 40%');

  sent.length = 0;
  await findByLabel(paused, '继续').dispatch('click');
  ok(sent.some((m) => m.type === 'resume' && m.taskId === 'tk'), '点继续发出 resume');

  const saving = render(mkTask({ status: 'saving', speed: 0 }));
  ok(findByLabel(saving, '暂停').disabled && findByLabel(saving, '保存中').disabled,
    '保存中：暂停与保存置灰，避免重复点', labels(saving));
  ok(!findByLabel(saving, '取消').disabled, '保存中仍可取消');
  ok(/正在保存/.test(textOf(saving)), '提示正在保存当前进度');

  const pausing = render(mkTask({ status: 'pausing', speed: 0 }));
  ok(/暂停中…\/保存\/取消/.test(labels(pausing)), '暂停中：按钮显示「暂停中…」', labels(pausing));
  ok(findByLabel(pausing, '暂停中').disabled, '停下来期间暂停按钮不可再点');
  ok(/正在停下来/.test(textOf(pausing)), '副标题说明正在停下来');
  ok(/暂停/.test(textOf(pausing)), '百分比区显示「暂停」而不是进度数字');

  const snapped = render(mkTask({ status: 'paused', progress: 40, speed: 0, snapAt: Date.now(), snapSize: 3387935, snapDownloadId: 7, snapName: 'VideoFetch/测试视频（截至40%）.mp4' }));
  ok(/继续\/保存\/打开快照\/取消/.test(labels(snapped)), '存过快照：多一个「打开快照」', labels(snapped));
  ok(/快照 3.2/.test(textOf(snapped)), '副标题显示快照体积', textOf(snapped));

  dl.opened.length = 0;
  await findByLabel(snapped, '打开快照').dispatch('click');
  ok(dl.opened.indexOf(7) >= 0, '「打开快照」用系统默认程序打开', JSON.stringify(dl.opened));

  const live = render(mkTask({ status: 'running', live: true, progress: -1 }));
  ok(/暂停/.test(labels(live)) && !/保存/.test(labels(live).replace('停止并保存', '')),
    '直播：只给暂停与「停止并保存」', labels(live));

  const blob = render(mkTask({ status: 'running', kind: 'blob', progress: -1 }));
  ok(!/暂停/.test(labels(blob)), '录制任务不提供暂停', labels(blob));
  ok(/停止并保存/.test(labels(blob)), '录制任务只有停止并保存');

  const partial = render({
    id: 'tk', title: '中途保存', status: 'done', progress: 40, fileSize: 4.8 * 1024 * 1024,
    hasAudio: true, partial: true, outputExt: 'mp4'
  });
  ok(/截至 40%/.test(textOf(partial)), '完成后标出「截至 40%」', textOf(partial));
  ok(/已保存/.test(textOf(partial)), '右侧写已保存');
  ok(/含音轨/.test(textOf(partial)), '读到音轨时标一句「含音轨」', textOf(partial));

  // 读不到音轨 ≠ 没有声音：卡片上不能出现任何否定判断
  const noFlag = render({
    id: 'tk', title: '读不到音轨', status: 'done', progress: 100, fileSize: 4.8 * 1024 * 1024, outputExt: 'mp4'
  });
  ok(!/无音轨/.test(textOf(noFlag)), '读不到音轨时不写「无音轨」', textOf(noFlag));
  ok(!/含音轨/.test(textOf(noFlag)), '读不到音轨时也不写「含音轨」', textOf(noFlag));
}

/* ---------- 9. 存进自定义文件夹的任务卡 ---------- */
console.log('\n[9] 自定义文件夹：不给「打开文件夹」（浏览器打不开那个目录）');
{
  const mkTask = (patch) => ({
    id: 'tk', title: 'clip', status: 'done', progress: 100, fileSize: 5 * 1024 * 1024,
    hasAudio: true, outputExt: 'mp4', ...patch
  });
  const render = (t) => {
    vm.runInContext('tasks = ' + JSON.stringify([t]), ctx);
    vm.runInContext('renderTasks()', ctx);
    return nodes.get('task-list').children[0];
  };
  const buttons = (card) => {
    const acts = (card.children || []).find((c) => c.className === 'acts') || { children: [] };
    return acts.children.filter((c) => c.tagName === 'button');
  };

  const dirTask = render(mkTask({ savedTo: 'dir', dirName: 'Videos' }));
  ok(buttons(dirTask).length === 0, '自定义目录：不给打开按钮', String(buttons(dirTask).length));
  ok(/Videos/.test(textOf(dirTask)), '卡片上标出目录名', textOf(dirTask));

  const dlTask = render(mkTask({ savedTo: 'downloads', downloadId: 9 }));
  ok(buttons(dlTask).length === 2, '下载目录：打开文件 + 打开所在文件夹', String(buttons(dlTask).length));
  ok(/打开文件/.test(textOf(dlTask)), '按钮文案正确', textOf(dlTask));

  const btnOf = (card, label) => buttons(card).find((b) => b.textContent === label);
  dl.opened.length = 0;
  dl.shown.length = 0;
  await btnOf(dlTask, '打开文件').dispatch('click');
  ok(dl.opened.indexOf(9) >= 0, '点「打开文件」交给系统默认程序', JSON.stringify(dl.opened));
  await btnOf(dlTask, '打开所在文件夹').dispatch('click');
  ok(dl.shown.indexOf(9) >= 0, '点「打开所在文件夹」仍在文件夹中定位', JSON.stringify(dl.shown));

  // 文件被移走或删掉时 downloads.open 会报错，此时退回定位并说明
  dl.opened.length = 0;
  dl.shown.length = 0;
  dl.failOpen = true;
  await btnOf(dlTask, '打开文件').dispatch('click');
  // 桩里的 getElementById 永远返回元素，toast 走 nodes 取
  const toastEl = nodes.get('toast');
  ok(dl.shown.indexOf(9) >= 0, '打不开时退回「在文件夹中显示」', JSON.stringify(dl.shown));
  ok(toastEl && /下载列表/.test(toastEl.textContent), '并提示文件已不在原位置', toastEl ? toastEl.textContent : '无提示');
  dl.failOpen = false;

  const noId = render(mkTask({ savedTo: 'downloads' }));
  ok(buttons(noId).length === 1 && /打开所在文件夹/.test(textOf(noId)),
    '没有 downloadId 时只给「打开所在文件夹」', String(buttons(noId).length));

  // 回退时（自定义目录不可用）要说明存到哪儿了
  const fellBack = render(mkTask({ savedTo: 'downloads', downloadId: 9, saveWarn: 'no-perm' }));
  ok(/已改存到浏览器下载文件夹/.test(textOf(fellBack)), '回退到下载目录时说明原因', textOf(fellBack));

  const snapDir = render(mkTask({
    status: 'paused', progress: 40, snapAt: Date.now(), snapSize: 2 * 1024 * 1024,
    snapSavedTo: 'dir', snapDirName: 'Videos'
  }));
  ok(!/打开快照/.test(textOf(snapDir)), '自定义目录的快照也没有「打开快照」');
}

/* ---------- 10. 英文界面 ---------- */
console.log('\n[10] 切到英文：同一份数据渲染出英文');
{
  vm.runInContext("VFI18N.setLang('en')", ctx);
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'e1', url: 'https://v.example.com/hls/9999999900002/index.m3u8', type: 'hls', mime: 'application/x-mpegurl', size: 500, title: 'clip', host: 'v.example.com', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext(`probeCache.set('https://v.example.com/hls/9999999900002/index.m3u8', { ok: true, type: 'master', live: false, duration: 17, segments: 6, variants: [
    { index: 0, label: '1920x1080', resolution: '1920x1080' },
    { index: 1, label: '1280x720', resolution: '1280x720' }
  ]})`, ctx);
  vm.runInContext('renderSources()', ctx);
  const srcText = textOf(nodes.get('src-list').children[0]);
  ok(/2 qualities/.test(srcText), '清晰度数量用英文', srcText);
  ok(/17 sec/.test(srcText), '时长用英文单位', srcText);
  ok(!/个清晰度|秒/.test(srcText), '不再出现中文文案', srcText);

  vm.runInContext("tasks = [{ id: 'en1', title: 'clip', status: 'paused', progress: 40, speed: 0, snapAt: Date.now(), snapSize: 1048576 }]", ctx);
  vm.runInContext('renderTasks()', ctx);
  const taskText = textOf(nodes.get('task-list').children[0]);
  ok(/Paused/.test(taskText), '任务卡状态用英文', taskText);
  ok(/Resume/.test(taskText) && /Save/.test(taskText), '按钮用英文');

  // 引擎抛出来的中文错误也要翻成英文
  vm.runInContext("tasks = [{ id: 'en2', title: 'clip', status: 'error', error: '该 m3u8 没有可用清晰度' }]", ctx);
  vm.runInContext('renderTasks()', ctx);
  ok(/no usable quality level/.test(textOf(nodes.get('task-list').children[0])), '引擎错误文案翻译');

  vm.runInContext("VFI18N.setLang('zh')", ctx);
  vm.runInContext('renderTasks()', ctx);
  ok(/没有可用清晰度/.test(textOf(nodes.get('task-list').children[0])), '切回中文仍原样保留');
}

/* ---------- 11. 重复源的区分参数 ---------- */
console.log('\n[11] 重复源的区分参数');
{
  // 同名同主机的两路直链，大小不同：应显示各自体积与路径尾段
  const A = 'https://cdn.example/video/8800012345/full.mp4';
  const B = 'https://cdn.example/video/8800098765/trailer.mp4';
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'a', url: A, type: 'file', mime: 'video/mp4', size: 52428800, title: '同名的视频', host: 'cdn.example', frameId: 0, from: 'network', ts: Date.now() },
    { id: 'b', url: B, type: 'file', mime: 'video/mp4', size: 1048576, title: '同名的视频', host: 'cdn.example', frameId: 0, from: 'network', ts: Date.now() - 100 }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);
  const dup = nodes.get('src-list').children;
  ok(dup.length === 2, '两条同源直链各自成卡', String(dup.length));
  ok(/50\.0 MB/.test(textOf(dup[0])) && /1\.0 MB/.test(textOf(dup[1])), '直链卡片显示各自大小');
  ok(/full\.mp4/.test(textOf(dup[0])) && /trailer\.mp4/.test(textOf(dup[1])), '同名卡片补路径尾段');

  // 唯一标题的卡片不显示路径尾段
  vm.runInContext(`items = ${JSON.stringify([
    { id: 's', url: 'https://cdn.example/only/unique-name.mp4', type: 'file', mime: 'video/mp4', size: 2048, title: '独一无二的标题', host: 'cdn.example', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);
  ok(!/unique-name\.mp4/.test(textOf(nodes.get('src-list').children[0])), '不重名时不加尾段');

  // HLS master：下拉带编码器与估算体积，卡片 meta 带 ≈ 体积
  const M2 = 'https://cdn.example/hls/8800099999/master.m3u8';
  vm.runInContext(`probeCache.set(${JSON.stringify(M2)}, {
    ok: true, type: 'master', live: false, duration: 600,
    variants: [
      { index: 0, label: '1920x1080', bandwidth: 2176000, resolution: '1920x1080', codecs: 'avc1.640028,mp4a.40.2', uri: 'https://cdn.example/hls/8800099999/1080.m3u8' },
      { index: 1, label: '1280x720', bandwidth: 832000, resolution: '1280x720', codecs: 'hvc1.1.6.L93.B0', uri: 'https://cdn.example/hls/8800099999/720.m3u8' }
    ]
  })`, ctx);
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'c', url: M2, type: 'hls', mime: 'application/vnd.apple.mpegurl', size: 500, title: '码率测试', host: 'cdn.example', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  vm.runInContext('renderSources()', ctx);
  const hlsCard = nodes.get('src-list').children[0];
  const hlsOps = hlsCard.children[hlsCard.children.length - 1];
  const hlsSel = hlsOps.children.find((c) => c.tagName === 'select');
  const o0 = hlsSel.children[0].textContent;
  const o1 = hlsSel.children[1].textContent;
  ok(/H\.264/.test(o0), '下拉档位带编码器名', o0);
  ok(/HEVC/.test(o1), 'HEVC 档位同样标注', o1);
  ok(/≈155\.6 MB/.test(o0), '档位带按时长×码率的估算体积', o0);
  ok(/≈155\.6 MB/.test(textOf(hlsCard)), '卡片 meta 显示 ≈ 体积', textOf(hlsCard));
  ok(!/≈/.test(textOf(nodes.get('src-list').children[0]).split('≈155.6 MB')[0].split('已录')), '前缀 ≈ 只用于估算值');

  // 换档位后 meta 的估算体积跟着变：720p → 600×832000/8 = 62400000 B = 59.5 MB
  hlsSel.value = '1';
  await hlsSel.dispatch('change');
  ok(/≈59\.5 MB/.test(textOf(hlsCard)), '切换档位后估算体积随码率更新', textOf(hlsCard));
}

/* ---------- 12. 无大小的直链自动探测补齐 ---------- */
console.log('\n[12] 无大小的直链自动探测补齐');
{
  const origSend = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (m) => {
    sent.push(m);
    if (m && m.type === 'probe-size') return { ok: true, size: 6200000 };
    return origSend(m);
  };
  // 微博形态：同一视频两档码率，标题相同，content-length 都没给
  const NB = 'https://f.video.weibocdn.com/002AAA/N601041200pwTf0E010.mp4?label=mp4_ld&ssig=AAA';
  const WB = 'https://f.video.weibocdn.com/002AAA/g001041200GAvd0E010.mp4?label=mp4_hd&ssig=BBB';
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'n1', url: NB, type: 'file', mime: 'video/mp4', size: 0, title: '同名视频', host: 'f.video.weibocdn.com', frameId: 0, from: 'network', ts: Date.now() },
    { id: 'n2', url: WB, type: 'file', mime: 'video/mp4', size: 0, title: '同名视频', host: 'f.video.weibocdn.com', frameId: 0, from: 'network', ts: Date.now() - 100 }
  ])}`, ctx);
  vm.runInContext('renderSources(); queueSizeProbes()', ctx);
  await new Promise((r) => setTimeout(r, 40));
  const cs = nodes.get('src-list').children;
  ok(cs.length === 2, '两条路径不同的直链各自成卡', String(cs.length));
  const ps = sent.filter((m) => m.type === 'probe-size');
  ok(ps.length === 2, '两条都发起了大小探测', String(ps.length));
  ok(ps.every((m) => m.tabId === 42), '探测带上了标签页 id');
  const t0 = textOf(cs[0]);
  const t1 = textOf(cs[1]);
  ok(/5\.9 MB/.test(t0) && /5\.9 MB/.test(t1), '探测结果补成卡片大小（两卡同探同值）');
  ok(/pwTf0E010\.mp4/.test(t0) && /GAvd0E010\.mp4/.test(t1), '同名卡片仍以路径尾段区分');
  // 已有真实 size 的条目不再探测
  vm.runInContext(`items = ${JSON.stringify([
    { id: 'k1', url: 'https://cdn.example/has/size.mp4', type: 'file', mime: 'video/mp4', size: 2048, title: '有大小', host: 'cdn.example', frameId: 0, from: 'network', ts: Date.now() }
  ])}`, ctx);
  const before = sent.filter((m) => m.type === 'probe-size').length;
  vm.runInContext('renderSources(); queueSizeProbes()', ctx);
  await new Promise((r) => setTimeout(r, 20));
  ok(sent.filter((m) => m.type === 'probe-size').length === before, '已有大小的条目不重复探测');
  ctx.chrome.runtime.sendMessage = origSend;
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
