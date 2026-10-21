/**
 * _dev/test-pause.mjs — 暂停 / 继续 / 保存当前进度
 *
 * 用 _dev/serve.mjs 的 ?delay= 给分片加人工延迟，专门制造「下载到一半」的状态：
 *   点播 HLS 暂停后继续，成片必须和一次性下完完全一致（不能重复下载已落盘的分片）
 *   暂停后保存，拿到的是「截至当前进度」的部分文件，进度不虚报 100%
 *   直链 Range 分块暂停后继续，字节数要一模一样
 *   直播、录制类任务的行为边界
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8898/';
const updates = [];
const listeners = [];
let captured = null;
let pass = 0;
let fail = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}

/* ---------- mock 环境 ---------- */
globalThis.window = globalThis;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      if (msg && msg.type === 'task-update') updates.push({ ...msg.task });
      if (msg && msg.type === 'request-dump') return { ok: false, error: 'test: no page' };
      return { ok: true };
    },
    getContexts: async () => []
  },
  downloads: {
    download: async () => 42
  }
};

URL.createObjectURL = (b) => {
  captured = b;
  return 'blob:mock';
};
URL.revokeObjectURL = () => {};

const muxCode = readFileSync(new URL('../vendor/mux.min.js', import.meta.url), 'utf8');
new Function(muxCode)();

await import('../offscreen/engine.js');

/* ---------- 驱动 ---------- */
/** 投递消息并取回 sendResponse 的同步返回值 */
function call(msg) {
  let out = null;
  for (const fn of listeners) fn(msg, {}, (v) => (out = v));
  return out;
}

function start(task) {
  captured = null;
  return call({ target: 'offscreen', type: 'start', task: { id: task.id, concurrency: 4, status: 'queued', ...task } });
}

function lastOf(id) {
  return updates.filter((x) => x.id === id).pop();
}

function waitFor(id, pred, ms = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const u = lastOf(id);
      if (u && pred(u)) {
        clearInterval(iv);
        resolve(u);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('超时，最后状态 ' + JSON.stringify(u || null)));
      }
    }, 60);
  });
}

const settled = (u) => ['done', 'error', 'canceled', 'interrupted'].includes(u.status);

async function saveCaptured(name) {
  if (!captured) return 0;
  const buf = Buffer.from(await captured.arrayBuffer());
  writeFileSync('_dev/' + name, buf);
  return buf.length;
}

function duration(file) {
  try {
    return parseFloat(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
        encoding: 'utf8'
      }).trim()
    );
  } catch (e) {
    return -1;
  }
}

function decodeClean(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return String((r.stderr || '') + (r.status ? 'exit=' + r.status : '')).trim();
}

const tmp = [];

/* ---------- P1. 点播暂停 → 继续 ---------- */
console.log('\n[P1] HLS 点播：中途暂停，继续后成片与整段下载一致');
let fullSize = 0;
{
  start({ id: 'p1', kind: 'hls', url: BASE + 'slow/index.m3u8', title: '暂停续传', pageUrl: BASE, concurrency: 1 });
  await sleep(520);

  const pr = call({ target: 'offscreen', type: 'pause', taskId: 'p1' });
  ok(pr && pr.ok, '暂停请求被接受', JSON.stringify(pr));

  const u1 = await waitFor('p1', (u) => u.status === 'paused', 30000);
  ok(u1.status === 'paused', '状态落到 paused');
  ok(u1.segmentsDone > 0 && u1.segmentsDone < 5, '停在中间，不是 0 也不是全部', u1.segmentsDone + '/5');
  ok(u1.received > 0, '已下载 ' + ((u1.received || 0) / 1048576).toFixed(2) + 'MB');
  const frozen = u1.received;

  // 暂停期间不能再有数据进来
  await sleep(600);
  const u1b = lastOf('p1');
  ok(u1b.status === 'paused' && u1b.received === frozen, '暂停后不再产生流量');
  ok(u1b.progress < 100, '进度停在 ' + u1b.progress + '%');

  const rr = call({ target: 'offscreen', type: 'resume', taskId: 'p1' });
  ok(rr && rr.ok, '继续请求被接受', JSON.stringify(rr));

  const u2 = await waitFor('p1', settled, 60000);
  ok(u2.status === 'done', '继续后下载完成', u2.error || '');
  ok(u2.segmentsDone === 5, '全部 5 段都到了', String(u2.segmentsDone));
  ok(!u2.partial, '不是部分文件');

  const size = await saveCaptured('pause-resume.mp4');
  tmp.push('_dev/pause-resume.mp4');
  fullSize = size;
  const dur = duration('_dev/pause-resume.mp4');
  ok(Math.abs(dur - 10) < 0.6, '成片时长 ' + dur.toFixed(2) + 's（源 10s）');
  const err = decodeClean('_dev/pause-resume.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- P2. 暂停后保存快照：任务不结束，还能继续 ---------- */
console.log('\n[P2] 暂停后「保存」：落盘一份截至当前的快照，任务保留');
{
  start({ id: 'p2', kind: 'hls', url: BASE + 'slow/index.m3u8', title: '中途保存', pageUrl: BASE, concurrency: 1 });
  await sleep(520);
  call({ target: 'offscreen', type: 'pause', taskId: 'p2' });
  const u1 = await waitFor('p2', (u) => u.status === 'paused', 30000);
  ok(u1.status === 'paused', '先暂停住', u1.segmentsDone + '/5');

  const sr = call({ target: 'offscreen', type: 'save', taskId: 'p2' });
  ok(sr && sr.ok, '保存请求被接受', JSON.stringify(sr));

  const u2 = await waitFor('p2', (u) => !!u.snapAt, 60000);
  ok(u2.status === 'paused', '保存完仍是「已暂停」，任务没被结束', u2.status);
  ok(u2.snapSize > 0 && u2.snapSize < fullSize, '快照体积小于完整文件', (u2.snapSize / 1048576).toFixed(2) + 'MB < ' + (fullSize / 1048576).toFixed(2) + 'MB');
  ok(u2.progress < 100, '进度不虚报 100%（' + u2.progress + '%）');
  ok(/\(\d+%\)\.mp4$/.test(u2.snapName || ''), '文件名标了截至多少（跨语言，用百分比）', u2.snapName);

  await saveCaptured('pause-partial.mp4');
  tmp.push('_dev/pause-partial.mp4');
  const dur = duration('_dev/pause-partial.mp4');
  ok(dur > 0.5 && dur < 9.5, '部分成片时长 ' + dur.toFixed(2) + 's（完整 10s）');
  const err = decodeClean('_dev/pause-partial.mp4');
  ok(!err, '部分文件也能正常解码' + (err ? '：' + err.slice(0, 160) : ''));

  // 关键：保存之后还能继续，一直下到完整
  const rr = call({ target: 'offscreen', type: 'resume', taskId: 'p2' });
  ok(rr && rr.ok, '保存后仍可「继续」', JSON.stringify(rr));
  const u3 = await waitFor('p2', settled, 60000);
  ok(u3.status === 'done', '继续后把剩下的下完了', u3.error || '');
  ok(u3.segmentsDone === 5, '5 段齐全', String(u3.segmentsDone));

  const full = await saveCaptured('pause-after-snapshot.mp4');
  tmp.push('_dev/pause-after-snapshot.mp4');
  ok(full === fullSize, '最终文件与一次下完的一致', full + ' / ' + fullSize);
  const dur2 = duration('_dev/pause-after-snapshot.mp4');
  ok(Math.abs(dur2 - 10) < 0.6, '最终时长 ' + dur2.toFixed(2) + 's（快照改小的时长已改回全长）');
  const err2 = decodeClean('_dev/pause-after-snapshot.mp4');
  ok(!err2, '最终文件解码无报错' + (err2 ? '：' + err2.slice(0, 160) : ''));
}

/* ---------- P2b. 运行中直接点保存 ---------- */
console.log('\n[P2b] 下载中直接「保存」：先停稳再拍快照，之后还能继续');
{
  start({ id: 'p2b', kind: 'hls', url: BASE + 'slow/index.m3u8', title: '边下边存', pageUrl: BASE, concurrency: 1 });
  await sleep(520);
  const sr = call({ target: 'offscreen', type: 'save', taskId: 'p2b' });
  ok(sr && sr.ok, '保存请求被接受');

  const u1 = await waitFor('p2b', (u) => !!u.snapAt, 60000);
  ok(u1.status === 'paused', '保存后进入「已暂停」而不是结束', u1.status);
  ok(u1.snapSize > 0, '快照有内容', (u1.snapSize / 1048576).toFixed(2) + 'MB');
  ok(!u1.partial, '任务没被当成「部分文件」收尾');

  call({ target: 'offscreen', type: 'resume', taskId: 'p2b' });
  const u2 = await waitFor('p2b', settled, 60000);
  ok(u2.status === 'done', '继续后完成', u2.error || '');
  ok(u2.segmentsDone === 5, '5 段齐全', String(u2.segmentsDone));
  await saveCaptured('pause-save-running.mp4');
  tmp.push('_dev/pause-save-running.mp4');
  const dur = duration('_dev/pause-save-running.mp4');
  ok(Math.abs(dur - 10) < 0.6, '成片时长 ' + dur.toFixed(2) + 's');
}

/* ---------- P2c. 点一下暂停就要立刻有反馈 ---------- */
console.log('\n[P2c] 暂停的响应速度（在途请求卡住的情况）');
{
  // 每段 1.5s、并发 2：点暂停时一定有两个请求正卡在半路，旧实现会一直等到它们返回
  start({ id: 'p2c', kind: 'hls', url: BASE + 'slow/long.m3u8', title: '暂停速度', pageUrl: BASE, concurrency: 2 });
  await waitFor('p2c', (u) => (u.segmentsDone || 0) >= 2, 20000);
  await sleep(150);

  const t0 = Date.now();
  call({ target: 'offscreen', type: 'pause', taskId: 'p2c' });
  const snap = lastOf('p2c');
  ok(snap.status === 'pausing', '点下去立刻变成「暂停中」', snap.status);

  const u1 = await waitFor('p2c', (u) => u.status === 'paused', 8000);
  const dt = Date.now() - t0;
  ok(u1.status === 'paused', '随后落到「已暂停」');
  ok(dt < 1200, '从点击到真正停下 ' + dt + 'ms（在途请求 400ms 后掐断）');
  ok((u1.segmentsDone || 0) < 5, '没有把整部下完才发现暂停了', u1.segmentsDone + '/5');

  // 停下后不能再有新数据
  const frozen = u1.received;
  await sleep(600);
  ok((lastOf('p2c').received || 0) === frozen, '停下后不再产生流量');

  call({ target: 'offscreen', type: 'save', taskId: 'p2c' });
  await waitFor('p2c', (u) => !!u.snapAt, 30000);
  call({ target: 'offscreen', type: 'cancel', taskId: 'p2c' });
  const u2 = await waitFor('p2c', settled, 30000);
  ok(u2.status === 'canceled', '取消后会话释放', u2.status);
}

/* ---------- P2d. fMP4 直拼路线：中途存快照后继续 ---------- */
console.log('\n[P2d] fMP4 直拼：暂停后存快照，继续到完整');
{
  start({ id: 'p2d', kind: 'hls', url: BASE + 'slow/fmp4.m3u8', title: 'fMP4 快照', pageUrl: BASE, concurrency: 1 });
  await sleep(520);
  call({ target: 'offscreen', type: 'pause', taskId: 'p2d' });
  await waitFor('p2d', (u) => u.status === 'paused', 30000);

  call({ target: 'offscreen', type: 'save', taskId: 'p2d' });
  const u1 = await waitFor('p2d', (u) => !!u.snapAt, 30000);
  ok(u1.status === 'paused' && u1.snapSize > 0, '快照已生成', (u1.snapSize / 1048576).toFixed(2) + 'MB');
  await saveCaptured('pause-fmp4-partial.mp4');
  tmp.push('_dev/pause-fmp4-partial.mp4');
  const d1 = duration('_dev/pause-fmp4-partial.mp4');
  ok(d1 > 0.5 && d1 < 9.5, 'fMP4 快照时长 ' + d1.toFixed(2) + 's（完整 10s）');
  ok(!decodeClean('_dev/pause-fmp4-partial.mp4'), 'fMP4 快照能正常解码');

  call({ target: 'offscreen', type: 'resume', taskId: 'p2d' });
  const u2 = await waitFor('p2d', settled, 60000);
  ok(u2.status === 'done', '继续后完成', u2.error || '');
  await saveCaptured('pause-fmp4-full.mp4');
  tmp.push('_dev/pause-fmp4-full.mp4');
  const d2 = duration('_dev/pause-fmp4-full.mp4');
  ok(Math.abs(d2 - 10) < 0.6, '完整成片 ' + d2.toFixed(2) + 's');
  ok(!decodeClean('_dev/pause-fmp4-full.mp4'), '完整成片解码无报错');
}

/* ---------- P2e. 直链文件：暂停 → 存快照 → 继续 ---------- */
console.log('\n[P2e] 直链文件：暂停后存快照，继续到字节完整');
{
  const total = 10408910;
  start({ id: 'p2e', kind: 'file', url: BASE + 'file.mp4?delay=300', title: '直链快照', pageUrl: BASE, concurrency: 1 });
  await sleep(500);
  call({ target: 'offscreen', type: 'pause', taskId: 'p2e' });
  await waitFor('p2e', (u) => u.status === 'paused', 30000);

  call({ target: 'offscreen', type: 'save', taskId: 'p2e' });
  const u1 = await waitFor('p2e', (u) => !!u.snapAt, 30000);
  ok(u1.snapSize > 0 && u1.snapSize < total, '快照是截断的一部分', (u1.snapSize / 1048576).toFixed(2) + 'MB');
  await saveCaptured('pause-file-partial.mp4');
  tmp.push('_dev/pause-file-partial.mp4');

  call({ target: 'offscreen', type: 'resume', taskId: 'p2e' });
  const u2 = await waitFor('p2e', settled, 90000);
  ok(u2.status === 'done', '继续后完成', u2.error || '');
  const size = await saveCaptured('pause-file-full.mp4');
  tmp.push('_dev/pause-file-full.mp4');
  ok(size === total, '最终字节数与源文件一致', size + ' / ' + total);
}

/* ---------- P2f. 慢速链路：暂停必须掐断在途请求 ---------- */
console.log('\n[P2f] 慢速链路：点暂停要立刻停，不能等 4MB 分块下完（10s 那一档）');
{
  const total = 10408910;
  // 400KB/s：一块 4MB 要 5 秒。旧实现里在途请求掐不断，主循环又只能在分片落地后才醒来，
  // 于是点暂停之后还会继续下 5～10 秒。
  start({
    id: 'p2f', kind: 'file', url: BASE + 'file.mp4?rate=800000', title: '慢速暂停', pageUrl: BASE, concurrency: 2
  });
  await sleep(600);

  const tp = Date.now();
  const pr = call({ target: 'offscreen', type: 'pause', taskId: 'p2f' });
  ok(pr && pr.ok, '暂停请求被接受');

  const u1 = await waitFor('p2f', (u) => u.status === 'paused', 20000);
  const dt = Date.now() - tp;
  ok(u1.status === 'paused', '落到「已暂停」', u1.status);
  ok(dt < 1200, '点一下 ' + dt + 'ms 内真的停下（旧实现要等在途分块下完，数秒起步）');

  // 暂停中不能再往界面上推进度：数字一跳，用户就以为还在下
  const seq = updates.filter((u) => u.id === 'p2f');
  const at = seq.findIndex((u) => u.status === 'pausing');
  const climbing = seq.slice(at + 1).filter((u) => u.status === 'pausing' && u.received > seq[at].received);
  ok(climbing.length === 0, '「暂停中」不再上报新进度', climbing.length + ' 次');

  const frozen = u1.received;
  await sleep(700);
  ok((lastOf('p2f').received || 0) === frozen, '停下后不再产生流量');

  call({ target: 'offscreen', type: 'resume', taskId: 'p2f' });
  const u2 = await waitFor('p2f', settled, 120000);
  ok(u2.status === 'done', '继续后下完', u2.error || '');
  const size = await saveCaptured('pause-slow-resume.mp4');
  tmp.push('_dev/pause-slow-resume.mp4');
  ok(size === total, '字节数与源文件一致（没丢块也没重复）', size + ' / ' + total);
}

/* ---------- P2g. 慢速 HLS：分片下到一半时暂停 ---------- */
console.log('\n[P2g] 慢速 HLS：分片正文下到一半时暂停，也要立刻停');
{
  start({ id: 'p2g', kind: 'hls', url: BASE + 'slow/rate.m3u8', title: '慢速HLS', pageUrl: BASE, concurrency: 4 });
  await sleep(700);

  const tp = Date.now();
  call({ target: 'offscreen', type: 'pause', taskId: 'p2g' });
  const u1 = await waitFor('p2g', (u) => u.status === 'paused', 20000);
  const dt = Date.now() - tp;
  ok(u1.status === 'paused', '落到「已暂停」', (u1.segmentsDone || 0) + '/5');
  ok(dt < 1200, '点一下 ' + dt + 'ms 内停下（正文传到一半也要能掐断）');

  const frozen = u1.received;
  await sleep(600);
  ok((lastOf('p2g').received || 0) === frozen, '停下后不再产生流量');

  call({ target: 'offscreen', type: 'resume', taskId: 'p2g' });
  const u2 = await waitFor('p2g', settled, 120000);
  ok(u2.status === 'done', '继续后下完', u2.error || '');
  ok(u2.segmentsDone === 5, '5 段齐全', String(u2.segmentsDone));
  await saveCaptured('pause-rate-hls.mp4');
  tmp.push('_dev/pause-rate-hls.mp4');
  const dur = duration('_dev/pause-rate-hls.mp4');
  ok(Math.abs(dur - 10) < 0.6, '成片时长 ' + dur.toFixed(2) + 's（源 10s）');
}

/* ---------- P3. 直链 Range 分块：暂停 → 继续 ---------- */
console.log('\n[P3] 直链 MP4：Range 分块暂停后继续，字节数一致');
{
  const total = 10408910;
  start({
    id: 'p3', kind: 'file', url: BASE + 'file.mp4?delay=300', title: '直链续传', pageUrl: BASE, concurrency: 1
  });
  await sleep(500);
  const pr = call({ target: 'offscreen', type: 'pause', taskId: 'p3' });
  ok(pr && pr.ok, '暂停请求被接受');

  const u1 = await waitFor('p3', (u) => u.status === 'paused', 30000);
  ok(u1.status === 'paused', '状态 paused');
  ok(u1.received > 0 && u1.received < total, '停在中间', ((u1.received || 0) / 1048576).toFixed(2) + 'MB');

  call({ target: 'offscreen', type: 'resume', taskId: 'p3' });
  const u2 = await waitFor('p3', settled, 90000);
  ok(u2.status === 'done', '继续后完成', u2.error || '');

  const size = await saveCaptured('pause-file.mp4');
  tmp.push('_dev/pause-file.mp4');
  ok(size === total, '字节数与源文件一致', size + ' / ' + total);
}

/* ---------- P3b. fMP4 直拼路线：暂停 → 继续 ---------- */
console.log('\n[P3b] fMP4 直拼（EXT-X-MAP）：暂停后继续，分片不能丢也不能重');
{
  start({ id: 'p3b', kind: 'hls', url: BASE + 'slow/fmp4.m3u8', title: 'fMP4 续传', pageUrl: BASE, concurrency: 1 });
  await sleep(520);
  call({ target: 'offscreen', type: 'pause', taskId: 'p3b' });
  const u1 = await waitFor('p3b', (u) => u.status === 'paused', 30000);
  ok(u1.status === 'paused', '状态 paused', u1.segmentsDone + '/5');

  call({ target: 'offscreen', type: 'resume', taskId: 'p3b' });
  const u2 = await waitFor('p3b', settled, 60000);
  ok(u2.status === 'done', '继续后完成', u2.error || '');
  ok(u2.segmentsDone === 5, '5 段齐全', String(u2.segmentsDone));

  const size = await saveCaptured('pause-fmp4.mp4');
  tmp.push('_dev/pause-fmp4.mp4');
  ok(size > 1024 * 1024, '体积 ' + (size / 1048576).toFixed(2) + 'MB');
  const dur = duration('_dev/pause-fmp4.mp4');
  ok(Math.abs(dur - 10) < 0.6, '时长 ' + dur.toFixed(2) + 's（源 10s，没有重复也没缺段）');
  const err = decodeClean('_dev/pause-fmp4.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- P4. 直播：暂停 → 继续 ---------- */
console.log('\n[P4] 直播：暂停后不再录入，继续后接着录');
{
  start({ id: 'p4', kind: 'hls', url: BASE + 'ts/live.m3u8', title: '直播暂停', pageUrl: BASE });
  await sleep(800);
  const live1 = lastOf('p4');
  ok(live1 && live1.status === 'running' && live1.live === true, '正在录制');

  call({ target: 'offscreen', type: 'pause', taskId: 'p4' });
  const u1 = await waitFor('p4', (u) => u.status === 'paused', 30000);
  ok(u1.status === 'paused', '直播可以暂停');
  const frozen = u1.received;

  await sleep(700);
  const u1b = lastOf('p4');
  ok(u1b.status === 'paused' && (u1b.received || 0) === frozen, '暂停期间没有新增数据');

  call({ target: 'offscreen', type: 'resume', taskId: 'p4' });
  const u2 = await waitFor('p4', (u) => u.status === 'running', 10000);
  ok(u2.status === 'running', '继续后重新开始录制');

  call({ target: 'offscreen', type: 'cancel', taskId: 'p4' });
  const u3 = await waitFor('p4', settled, 30000);
  ok(u3.status === 'done', '停止即保存（直播语义不变）', u3.error || '');
  await saveCaptured('pause-live.mp4');
  tmp.push('_dev/pause-live.mp4');
}

/* ---------- P5. 录制类任务不支持暂停 ---------- */
console.log('\n[P5] blob 录制：暂停应被拒绝');
{
  start({ id: 'p5', kind: 'blob', recId: 'r-none', tabId: 1, title: '录制', pageUrl: BASE });
  const pr = call({ target: 'offscreen', type: 'pause', taskId: 'p5' });
  ok(pr && pr.ok === false, '录制任务拒绝暂停', JSON.stringify(pr));
  ok(/录制/.test((pr && pr.error) || ''), '错误文案说明原因', (pr && pr.error) || '');
  await waitFor('p5', settled, 30000);
}

/* ---------- P6. 暂停中取消：会话要释放 ---------- */
console.log('\n[P6] 暂停中取消：不留悬挂会话');
{
  start({ id: 'p6', kind: 'hls', url: BASE + 'slow/index.m3u8', title: '暂停后取消', pageUrl: BASE, concurrency: 1 });
  await sleep(500);
  call({ target: 'offscreen', type: 'pause', taskId: 'p6' });
  await waitFor('p6', (u) => u.status === 'paused', 30000);

  call({ target: 'offscreen', type: 'cancel', taskId: 'p6' });
  const u = await waitFor('p6', settled, 30000);
  ok(u.status === 'canceled', '状态 canceled', u.status);
  ok(u.fileSize == null || u.fileSize === 0, '没有产出文件');

  // 会话已经释放：再点继续应该被拒
  const rr = call({ target: 'offscreen', type: 'resume', taskId: 'p6' });
  ok(rr && rr.ok === false, '会话已清理，继续请求被拒', JSON.stringify(rr));
}

/* ---------- 收尾 ---------- */
for (const f of tmp) {
  try {
    unlinkSync(f);
  } catch (e) {}
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
