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
const msgListeners = [];   // window 'message' 监听器：测试用它向 hook 下发命令
const winListeners = new Map(); // 其他 window 事件（pagehide 一类）

function makeCtx(fetchImpl, storageMock) {
  const nav = { userAgent: 'node-test' };
  if (storageMock) nav.storage = storageMock;
  const ctx = {
    console,
    setTimeout: (fn) => setTimeout(fn, 5),
    setInterval: () => 0,
    clearTimeout,
    clearInterval: () => {},
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { getEntriesByType: () => perfEntries },
    navigator: nav,
    location: { href: 'https://x.com/axoo_o/status/2112363173596783023' },
    document: {
      baseURI: 'https://x.com/axoo_o/status/2112363173596783023',
      querySelectorAll: () => []
    },
    postMessage: (m) => events.push(m),
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
      if (type === 'message') msgListeners.push(fn);
    },
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

/** 内存版 OPFS：getFileHandle/createWritable/getFile/removeEntry 全套，files 可检查 */
function makeOpfs() {
  const files = new Map(); // name -> Uint8Array
  const dir = {
    getFileHandle: async (name, opts) => ({
      name,
      createWritable: async () => {
        let buf = files.has(name) ? files.get(name) : new Uint8Array(0);
        return {
          write: async (data) => {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            const merged = new Uint8Array(buf.length + u8.length);
            merged.set(buf);
            merged.set(u8, buf.length);
            buf = merged;
          },
          close: async () => { files.set(name, buf); }
        };
      },
      getFile: async () => {
        const b = files.get(name);
        if (!b) throw new Error('NotFoundError');
        return {
          name,
          size: b.length,
          lastModified: Date.now(),
          arrayBuffer: async () => b.slice().buffer
        };
      }
    }),
    removeEntry: async (name) => { files.delete(name); },
    values: async function* () {
      for (const [n, b] of files) {
        yield { getFile: async () => ({ name: n, size: b.length, lastModified: Date.now() }) };
      }
    }
  };
  return { files, storage: { getDirectory: async () => dir } };
}

/** 向 hook 下发一条命令并取回回复 */
async function sendCmd(ctx, cmd, extra = {}) {
  const id = cmdEvents();
  const ev = { data: Object.assign({ __vf: 'cmd', cmd, id }, extra) };
  for (const fn of msgListeners) fn(ev);
  await sleep(30);
  return events.filter((e) => e.__vf === 'reply' && e.id === id).pop();
}
let cmdSeq = 0;
function cmdEvents() { return 'cmd' + ++cmdSeq; }

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

console.log('\n[5] 图片与文档地址不捕获');
{
  const ctx = makeCtx(async () => playResponse('image/jpeg'));
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await ctx.fetch('https://cdn.example.com/photo/big.JPEG?w=800');
  await ctx.fetch('https://cdn.example.com/doc/report.pdf');
  await sleep(20);
  ok(!events.some((e) => e.kind === 'media' && /\.jpe?g|\.pdf/i.test(e.data.url || '')), '图片与文档地址未上报');
}

/* ---------- [6] MSE 录制：磁盘溢写 ---------- */
console.log('\n[6] MSE 录制写入 OPFS，内存不留存');
{
  events.length = 0;
  msgListeners.length = 0;
  const opfs = makeOpfs();
  const ctx = makeCtx(async () => playResponse('text/html'), opfs.storage);
  // 必须在注入前就挂上原型方法，hook 才有得包
  ctx.MediaSource.prototype.addSourceBuffer = function (mime) {
    return { appendBuffer(d) {}, MIME: mime };
  };
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await sleep(20); // 等 getDirectory 完成

  // 页面按 MSE 播放：new MediaSource → addSourceBuffer → 逐片 appendBuffer
  vm.runInContext(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('video/mp4;codecs="avc1"');
  `, ctx);
  const MB = 1024 * 1024;
  const chunk = (mb) => new Uint8Array(mb * MB).fill(7);
  const run = (code) => vm.runInContext(code, ctx);
  run('sb.appendBuffer(new Uint8Array(4 * 1024 * 1024).fill(7))');
  run('sb.appendBuffer(new Uint8Array(4 * 1024 * 1024).fill(7))'); // 攒满 8MB → 写盘
  run('sb.appendBuffer(new Uint8Array(1 * 1024 * 1024).fill(7))'); // 尾巴 1MB 留内存
  await sleep(50); // 等写盘链完成

  ok(events.some((e) => e.kind === 'mse-open'), '发出 mse-open');
  const prog = events.filter((e) => e.kind === 'mse-progress');
  ok(prog.length === 3 && prog[2].data.total === 9 * MB, 'mse-progress 累计到 9MB', prog.length && String(prog[2].data.total));
  ok(opfs.files.size === 1, '攒满 8MB 才写盘，产生 1 个分片文件', [...opfs.files.keys()].join(','));

  const info = await sendCmd(ctx, 'info', { recId: 'r1' });
  ok(info && info.ok, 'info 正常返回');
  ok(info && info.info && info.info.parts === 2, '分段数 = 1 个盘上分片 + 1 个内存尾巴', info && info.info && String(info.info.parts));
  ok(info && info.info && info.info.bytes === 9 * MB, '体积 9MB', info && info.info && String(info.info.bytes));
  ok(info && info.info && info.info.buckets[0].spill === true, '标记为溢写模式');

  const c0 = await sendCmd(ctx, 'chunk', { recId: 'r1', index: 0 });
  ok(c0 && c0.ok && c0.data && c0.data.byteLength === 8 * MB, '第 0 段从盘上读回 8MB', c0 && c0.data && String(c0.data.byteLength));
  ok(c0 && !c0.last, '第 0 段不是最后一段');
  const c1 = await sendCmd(ctx, 'chunk', { recId: 'r1', index: 1 });
  ok(c1 && c1.ok && c1.data && c1.data.byteLength === 1 * MB && c1.last, '第 1 段是内存尾巴且标 last', c1 && c1.data && String(c1.data.byteLength));
  const c2 = await sendCmd(ctx, 'chunk', { recId: 'r1', index: 2 });
  ok(c2 && c2.ok && c2.done, '读完即 done');

  await sendCmd(ctx, 'drop', { recId: 'r1' });
  await sleep(30);
  ok(opfs.files.size === 0, 'drop 连盘上分片一起删', String(opfs.files.size));
}

/* ---------- [7] 不支持 OPFS 时退回内存模式 ---------- */
console.log('\n[7] 无 OPFS：退回内存模式，行为与旧版一致');
{
  events.length = 0;
  msgListeners.length = 0;
  const ctx = makeCtx(async () => playResponse('text/html'));
  ctx.MediaSource.prototype.addSourceBuffer = function (mime) {
    return { appendBuffer(d) {}, MIME: mime };
  };
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await sleep(20);
  vm.runInContext(`
    var ms2 = new MediaSource();
    var sb2 = ms2.addSourceBuffer('video/mp4');
    sb2.appendBuffer(new Uint8Array(3 * 1024 * 1024).fill(1));
  `, ctx);
  await sleep(20);
  const info = await sendCmd(ctx, 'info', { recId: 'r1' });
  ok(info && info.info && info.info.bytes === 3 * 1024 * 1024, '内存模式照常累计', info && info.info && String(info.info.bytes));
  ok(info && info.info && info.info.buckets[0].spill === false, '标记为内存模式');
  const c0 = await sendCmd(ctx, 'chunk', { recId: 'r1', index: 0 });
  ok(c0 && c0.ok && c0.data && c0.data.byteLength === 3 * 1024 * 1024 && c0.last, '单段内存直接可导出');
}

/* ---------- [8] 录制结束后的清理 ---------- */
console.log('\n[8] 录制结束：分片删掉，后续不再堆回来');
{
  events.length = 0;
  msgListeners.length = 0;
  winListeners.clear();
  const opfs = makeOpfs();
  const ctx = makeCtx(async () => playResponse('text/html'), opfs.storage);
  ctx.MediaSource.prototype.addSourceBuffer = function (mime) {
    return { appendBuffer(d) {}, MIME: mime };
  };
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await sleep(20);

  const run = (code) => vm.runInContext(code, ctx);
  run(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('video/mp4;codecs="avc1"');
    sb.appendBuffer(new Uint8Array(8 * 1024 * 1024).fill(7));
  `);
  await sleep(50);
  ok(opfs.files.size === 1, '先写下一个分片', String(opfs.files.size));

  // 页面卸载：分片应当清掉，内存里的录制也一起丢
  for (const fn of winListeners.get('pagehide') || []) fn({ persisted: false });
  await sleep(50);
  ok(opfs.files.size === 0, 'pagehide 清掉盘上分片', String(opfs.files.size));
  const gone = await sendCmd(ctx, 'info', { recId: 'r1' });
  ok(gone && gone.ok === false, '录制已从内存移除', gone && gone.error);

  // 丢弃之后再来的数据不许再落盘（页面还在播的情况）
  run('sb.appendBuffer(new Uint8Array(9 * 1024 * 1024).fill(7))');
  await sleep(50);
  ok(opfs.files.size === 0, '丢弃后的追加不再产生文件', String(opfs.files.size));

  // 新的 SourceBuffer 也不会重新挂上
  const before = events.filter((e) => e.kind === 'mse-open').length;
  run(`var sb2 = ms.addSourceBuffer('audio/mp4'); sb2.appendBuffer(new Uint8Array(9 * 1024 * 1024).fill(3));`);
  await sleep(50);
  ok(opfs.files.size === 0, '同一 MediaSource 上新增缓冲也不落盘', String(opfs.files.size));
  ok(events.filter((e) => e.kind === 'mse-open').length === before, '没有为死掉的录制新建记录');
}

/* ---------- [9] 进往返缓存的页面不清理 ---------- */
console.log('\n[9] BFCache（persisted）不误删');
{
  events.length = 0;
  msgListeners.length = 0;
  winListeners.clear();
  const opfs = makeOpfs();
  const ctx = makeCtx(async () => playResponse('text/html'), opfs.storage);
  ctx.MediaSource.prototype.addSourceBuffer = function (mime) {
    return { appendBuffer(d) {}, MIME: mime };
  };
  vm.runInContext(readFileSync(new URL('../content/inject.js', import.meta.url), 'utf8'), ctx);
  await sleep(20);
  vm.runInContext(`
    var ms = new MediaSource();
    var sb = ms.addSourceBuffer('video/mp4');
    sb.appendBuffer(new Uint8Array(8 * 1024 * 1024).fill(5));
  `, ctx);
  await sleep(50);
  for (const fn of winListeners.get('pagehide') || []) fn({ persisted: true });
  await sleep(30);
  ok(opfs.files.size === 1, '进缓存的分片保留', String(opfs.files.size));
  const still = await sendCmd(ctx, 'info', { recId: 'r1' });
  ok(still && still.ok && still.info.bytes === 8 * 1024 * 1024, '录制仍然可用', still && still.info && String(still.info.bytes));
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
