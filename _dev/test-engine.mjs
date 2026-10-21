/**
 * _dev/test-engine.mjs — 引擎集成测试
 * mock 掉 chrome.* API，直接跑真实下载引擎的全部流程：
 *   HLS 点播 / 直链多线程 / AES 加密 / 直播停止保存
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';

const BASE = 'http://127.0.0.1:8898/';
const updates = [];
const downloads = [];
const listeners = [];
let captured = null;
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
    download: async (o) => {
      downloads.push(o);
      return 42;
    }
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


/** ffmpeg 全量解码：退出码为 0 且 stderr 无输出才算干净 */
function decodeClean(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const err = String((r.stderr || '') + (r.status ? 'exit=' + r.status : '')).trim();
  return err;
}

/* ---------- 驱动 ---------- */
function fire(msg) {
  for (const fn of listeners) fn(msg, {}, () => {});
}

function start(task) {
  captured = null;
  fire({ target: 'offscreen', type: 'start', task: { id: task.id, concurrency: 8, status: 'queued', ...task } });
}

function waitState(id, ms = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const u = updates.filter((x) => x.id === id).pop();
      if (u && ['done', 'error', 'canceled'].includes(u.status)) {
        clearInterval(iv);
        resolve(u);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('超时，最后状态 ' + JSON.stringify(u || null)));
      }
    }, 100);
  });
}

async function saveCaptured(name) {
  if (!captured) return null;
  const buf = Buffer.from(await captured.arrayBuffer());
  writeFileSync('_dev/' + name, buf);
  return buf.length;
}

/* ---------- 1. HLS 点播（TS → MP4） ---------- */
console.log('\n[E1] HLS 点播：master 选 360p → TS 转封装');
{
  start({ id: 't1', kind: 'hls', url: BASE + 'master.m3u8', title: '测试视频A', pageUrl: BASE, variant: 1 });
  const u = await waitState('t1');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.outputExt === 'mp4', '输出 mp4', u.outputExt);
  ok(u.fileSize > 1024 * 1024, '输出体积 ' + (u.fileSize / 1048576).toFixed(2) + 'MB');
  ok(/^VideoFetch\/.+\.mp4$/.test(u.filename || ''), '文件名规范', u.filename);
  ok(u.downloadId === 42, '触发下载且拿到 downloadId');
  const sz = await saveCaptured('eng-hls.mp4');
  ok(sz === u.fileSize, '落地字节数一致', sz + 'B');
}

/* ---------- 2. 直链 MP4（Range 多线程） ---------- */
console.log('\n[E2] 直链 MP4：Range 分块并发下载');
{
  start({ id: 't2', kind: 'file', url: BASE + 'file.mp4', title: '直链测试', pageUrl: BASE });
  const u = await waitState('t2');
  ok(u.status === 'done', '任务完成', u.error || '');
  const sz = await saveCaptured('eng-file.mp4');
  ok(sz > 9 * 1024 * 1024, '文件完整 ' + (sz / 1048576).toFixed(2) + 'MB');
  ok(/\.mp4$/.test(u.filename || ''), '扩展名正确', u.filename);
}

/* ---------- 3. AES-128 加密流 ---------- */
console.log('\n[E3] AES-128 加密 HLS 解密下载');
{
  start({ id: 't3', kind: 'hls', url: BASE + 'enc/index.m3u8', title: '加密测试', pageUrl: BASE });
  const u = await waitState('t3');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.fileSize > 500 * 1024, '解密后体积 ' + (u.fileSize / 1024).toFixed(0) + 'KB');
  await saveCaptured('eng-enc.mp4');
}

/* ---------- 4. 直播：跑一会再停 ---------- */
console.log('\n[E4] 直播流：录制 3 秒后停止并保存');
{
  start({ id: 't4', kind: 'hls', url: BASE + 'ts/live.m3u8', title: '直播测试', pageUrl: BASE });
  await new Promise((r) => setTimeout(r, 3000));
  const mid = updates.filter((x) => x.id === 't4').pop();
  ok(mid && mid.status === 'running', '仍在录制中', mid ? '已收 ' + ((mid.received || 0) / 1024).toFixed(0) + 'KB' : '');
  ok(mid && mid.live === true, '标记为直播');
  fire({ target: 'offscreen', type: 'cancel', taskId: 't4' });
  const u = await waitState('t4', 30000);
  ok(u.status === 'done', '停止后自动保存', u.status + ' ' + (u.error || ''));
  const sz = await saveCaptured('eng-live.mp4');
  ok(sz > 200 * 1024, '录像体积 ' + ((sz || 0) / 1024).toFixed(0) + 'KB');
}

/* ---------- 5. 错误处理 ---------- */
console.log('\n[E5] 异常输入');
{
  start({ id: 't5', kind: 'hls', url: BASE + 'not-exist.m3u8', title: '坏地址', pageUrl: BASE });
  const u = await waitState('t5', 20000);
  ok(u.status === 'error', '404 正确报错', u.error);
}

/* ---------- 6. 清晰度索引必须对应真实分辨率 ---------- */
console.log('\n[E6] master 档位索引 → 实际输出分辨率');
{
  // master 里故意乱序：720 / 360 / 1080 / 480，解析后应按高度降序
  const expect = [1080, 720, 480, 360];
  for (let i = 0; i < expect.length; i++) {
    const id = 'sel' + i;
    start({ id, kind: 'hls', url: BASE + 'sel/master.m3u8', title: '档位' + i, pageUrl: BASE, variant: i });
    const u = await waitState(id);
    ok(u.status === 'done', 'variant=' + i + ' 下载完成', u.error || '');
    await saveCaptured('eng-sel' + i + '.mp4');
    let h = 0;
    try {
      h = parseInt(
        execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=height', '-of', 'csv=p=0', '_dev/eng-sel' + i + '.mp4'],
          { encoding: 'utf8' }).trim(), 10) || 0;
    } catch (e) {
      h = -1;
    }
    ok(h === expect[i], 'variant=' + i + ' 实际高度 ' + expect[i] + 'p', '实测 ' + h + 'p');
  }

  // URI 精确匹配优先于索引：故意给错误的索引，靠 URI 纠正回来
  start({
    id: 'selUri', kind: 'hls', url: BASE + 'sel/master.m3u8', title: 'URI 纠正',
    pageUrl: BASE, variant: 0, variantUri: BASE + 'v480/index.m3u8'
  });
  const uu = await waitState('selUri');
  ok(uu.status === 'done', 'URI 匹配任务完成', uu.error || '');
  await saveCaptured('eng-sel-uri.mp4');
  let hu = 0;
  try {
    hu = parseInt(
      execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=height', '-of', 'csv=p=0', '_dev/eng-sel-uri.mp4'],
        { encoding: 'utf8' }).trim(), 10) || 0;
  } catch (e) {
    hu = -1;
  }
  ok(hu === 480, '按 URI 命中 480p 而非索引 0 的 1080p', '实测 ' + hu + 'p');
}

/* ---------- 7. 独立音轨（EXT-X-MEDIA）必须合并进成片 ---------- */
console.log('\n[E7] 音视频分离的 HLS：音轨合并');
{
  start({ id: 'sep', kind: 'hls', url: BASE + 'sepa/sep_master.m3u8', title: '分离音轨', pageUrl: BASE });
  const u = await waitState('sep');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.hasAudio === true, '任务标记含音轨');
  ok(u.audioMerged === true, '音轨来自独立 rendition 合并');
  await saveCaptured('eng-sep.mp4');

  const probeS = (args) =>
    execFileSync('ffprobe', ['-v', 'error', ...args, '_dev/eng-sep.mp4'], { encoding: 'utf8' }).trim();
  const streams = probeS(['-show_entries', 'stream=codec_name,codec_type', '-of', 'csv=p=0'])
    .split('\n')
    .map((x) => x.replace(/\r/g, ''))
    .filter(Boolean);
  ok(streams.some((x) => /,video$/.test(x)), '成片含视频轨', streams.join(' | '));
  ok(streams.some((x) => /,audio$/.test(x)), '成片含音频轨', streams.join(' | '));

  const adur = parseFloat(
    probeS(['-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0']) || '0'
  );
  ok(adur > 8.5, '音频轨时长 ' + adur.toFixed(2) + 's（源 10s）');

  const err = decodeClean('_dev/eng-sep.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- 8. 分轨直链（DASH_video.mp4）自动改走 HLS 补音轨 ---------- */
console.log('\n[E8] 无音轨直链：自动切换到同源 HLS');
{
  start({ id: 'dash', kind: 'file', url: BASE + 'reddit/abc/DASH_720.mp4', title: '分轨直链', pageUrl: BASE });
  const u = await waitState('dash');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.hasAudio === true, '补到了音轨');
  await saveCaptured('eng-dash.mp4');

  const probeD = (args) =>
    execFileSync('ffprobe', ['-v', 'error', ...args, '_dev/eng-dash.mp4'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((x) => x.replace(/\r/g, ''))
      .filter(Boolean);
  const types = probeD(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0']);
  ok(types.includes('video'), '含视频轨', types.join('|'));
  ok(types.includes('audio'), '含音频轨', types.join('|'));
  const dim = probeD(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])[0] || '';
  ok(/,720$/.test(dim), '保持 720p 档位', dim);

  const err = decodeClean('_dev/eng-dash.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- 9. MSE 录制：音视频分两条 SourceBuffer 时必须合并 ---------- */
console.log('\n[E9] MSE 录制：两条缓冲合并成带声音的成片');
{
  // 用真实流造出两条「录制缓冲」：一条纯视频、一条纯音频
  const buildFmp4 = async (u) => {
    const pl = parsePlaylist(await (await fetch(u)).text(), u);
    const asm = new Assembler(() => {}, null, 10);
    const out = [];
    for (const seg of pl.segments) {
      await asm.push(new Uint8Array(await (await fetch(seg.url)).arrayBuffer()), {});
      out.push(...asm.drain());
    }
    return Buffer.concat(out.map((c) => Buffer.from(c)));
  };
  const vBuf = await buildFmp4(BASE + 'sepa/0.m3u8');
  const aBuf = await buildFmp4(BASE + 'sepa/1.m3u8');
  const chunkify = (buf, n = 200 * 1024) => {
    const list = [];
    for (let i = 0; i < buf.length; i += n) list.push(buf.subarray(i, i + n).toString('base64'));
    return list;
  };
  const vChunks = chunkify(vBuf);
  const aChunks = chunkify(aBuf);
  const REC = 'rec-merge-1';

  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg && msg.type === 'task-update') {
      updates.push({ ...msg.task });
      return { ok: true };
    }
    if (msg && msg.type === 'blob-info') {
      return {
        ok: true,
        info: {
          bytes: vBuf.length + aBuf.length,
          buffers: 2,
          buckets: [
            { key: 1, mime: 'video/mp4; codecs="avc1.42c01e"', bytes: vBuf.length, parts: vChunks.length },
            { key: 2, mime: 'audio/mp4; codecs="mp4a.40.2"', bytes: aBuf.length, parts: aChunks.length }
          ]
        }
      };
    }
    if (msg && msg.type === 'request-dump') {
      const key = msg.bucket == null ? 1 : msg.bucket;
      const chunks = key === 2 ? aChunks : vChunks;
      setTimeout(() => {
        chunks.forEach((b64, i) =>
          fire({ target: 'offscreen', type: 'rec-chunk', data: { recId: msg.recId, index: i, b64 } })
        );
        fire({ target: 'offscreen', type: 'rec-chunk', data: { recId: msg.recId, done: true } });
      }, 0);
      return { ok: true };
    }
    return { ok: true };
  };

  start({ id: 'rmerge', kind: 'blob', recId: REC, title: '录制合并', pageUrl: BASE, tabId: 1 });
  const u = await waitState('rmerge', 60000);
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.hasAudio === true, '标记已合并音轨');
  await saveCaptured('eng-recmerge.mp4');

  const lines = (args) =>
    execFileSync('ffprobe', ['-v', 'error', ...args, '_dev/eng-recmerge.mp4'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((x) => x.replace(/\r/g, ''))
      .filter(Boolean);
  const types = lines(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0']);
  ok(types.includes('video') && types.includes('audio'), '成片含视频与音频', types.join('|'));

  const err = decodeClean('_dev/eng-recmerge.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- 10. 视频流自带音轨时不得重复合并 ---------- */
console.log('\n[E10] 视频流已含音轨：忽略独立音轨');
{
  start({ id: 'dup', kind: 'hls', url: BASE + 'sepa/dup_master.m3u8', title: '重复音轨', pageUrl: BASE });
  const u = await waitState('dup');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(!u.audioMerged, '未重复合并独立音轨', 'audioMerged=' + u.audioMerged);
  ok(u.hasAudio === true, '本来就有声音，标记含音轨');
  await saveCaptured('eng-dup.mp4');

  const kinds = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', '_dev/eng-dup.mp4'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .map((x) => x.replace(/\r/g, ''))
    .filter(Boolean);
  ok(kinds.filter((x) => x === 'audio').length === 1, '只有一条音轨', kinds.join('|'));
  ok(kinds.filter((x) => x === 'video').length === 1, '只有一条视频轨', kinds.join('|'));
  const err = decodeClean('_dev/eng-dup.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- 11. CMAF：音轨 moov 在 EXT-X-MAP 里（Reddit 这类）---------- */
console.log('\n[E11] CMAF 分离音轨：EXT-X-MAP + BYTERANGE 续段');
{
  start({ id: 'cmaf', kind: 'hls', url: BASE + 'cmaf/master.m3u8', title: 'CMAF 音轨', pageUrl: BASE });
  const u = await waitState('cmaf');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.hasAudio === true, '任务标记含音轨', 'hasAudio=' + u.hasAudio);
  await saveCaptured('eng-cmaf.mp4');

  const lines = (args) =>
    execFileSync('ffprobe', ['-v', 'error', ...args, '_dev/eng-cmaf.mp4'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((x) => x.replace(/\r/g, ''))
      .filter(Boolean);
  const types = lines(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0']);
  ok(types.includes('video'), '成片含视频轨', types.join('|'));
  ok(types.includes('audio'), '成片含音频轨（EXT-X-MAP 的 moov 已喂给音轨装配器）', types.join('|'));

  const adur = parseFloat(
    lines(['-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0'])[0] || '0'
  );
  ok(adur > 7.5, '音频轨时长 ' + adur.toFixed(2) + 's（源 8s，BYTERANGE 续段偏移正确）');

  const dim = lines(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])[0] || '';
  ok(/,720$/.test(dim), '档位 720p', dim);

  const err = decodeClean('_dev/eng-cmaf.mp4');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

/* ---------- 12. 纯音频流：单独下载时按 m4a 落盘 ---------- */
console.log('\n[E12] 纯音频 HLS：存成 m4a，不冒充视频');
{
  start({ id: 'aud', kind: 'hls', url: BASE + 'cmaf/CMAF_AUDIO_128.m3u8', title: '纯音频', pageUrl: BASE });
  const u = await waitState('aud');
  ok(u.status === 'done', '任务完成', u.error || '');
  ok(u.outputExt === 'm4a', '扩展名 m4a', u.outputExt);
  ok(/\.m4a$/.test(u.filename || ''), '文件名后缀 m4a', u.filename);
  ok(u.hasAudio === true, '标记含音轨', 'hasAudio=' + u.hasAudio);
  await saveCaptured('eng-audio.m4a');

  const types = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', '_dev/eng-audio.m4a'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .map((x) => x.replace(/\r/g, ''))
    .filter(Boolean);
  ok(types.length === 1 && types[0] === 'audio', '只有音频轨，没有空视频轨', types.join('|'));

  const err = decodeClean('_dev/eng-audio.m4a');
  ok(!err, '完整解码无报错' + (err ? '：' + err.slice(0, 160) : ''));
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
