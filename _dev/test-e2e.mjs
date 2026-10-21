/**
 * _dev/test-e2e.mjs — 引擎核心链路实测
 * 用真实 ffmpeg 生成的 HLS 流（TS / fMP4 / AES-128 / master 多码率）跑通：
 * 播放列表解析 → 分片下载 → 解密 → 转封装 → 合并 → 输出 MP4
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';
import { fetchKey, decryptAes128, parseIv } from '../lib/crypto.js';

// ---- 在 Node 里加载浏览器版 mux.js（走 globalThis 分支）----
globalThis.window = globalThis;
const muxCode = readFileSync(new URL('../vendor/mux.min.js', import.meta.url), 'utf8');
new Function(muxCode)();

const BASE = 'http://127.0.0.1:8899/';
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

async function getText(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
  return r.text();
}

async function getBuf(u, range) {
  const opt = range ? { headers: { Range: 'bytes=' + range.offset + '-' + (range.offset + range.length - 1) } } : {};
  const r = await fetch(u, opt);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (range && r.status !== 206 && buf.length > range.length) {
    buf = buf.subarray(range.offset, range.offset + range.length);
  }
  return buf;
}

async function assemble(plUrl, outPath, variantIndex = 0) {
  let pl = parsePlaylist(await getText(plUrl), plUrl);
  if (pl.type === 'master') {
    const v = pl.variants[variantIndex];
    const vUrl = new URL(v.uri, plUrl).href;
    pl = parsePlaylist(await getText(vUrl), vUrl);
  }
  const planned = pl.endList ? pl.segments.reduce((a, s) => a + (s.duration || 0), 0) : 0;
  const asm = new Assembler(
    (m, lv) => console.log('    [' + (lv || 'info') + '] ' + m),
    null,
    planned
  );
  const parts = [];

  if (pl.hasMap) {
    const host = pl.segments.find((s) => s.map);
    const buf = await getBuf(new URL(host.map.url, plUrl).href);
    await asm.push(buf, { isInit: true });
    for (const p of asm.drain()) parts.push(p);
  }

  let t = 0;
  for (const seg of pl.segments) {
    let buf = await getBuf(new URL(seg.url, plUrl).href, seg.byterange);
    if (seg.key && seg.key.method === 'AES-128') {
      const kb = await fetchKey(seg.key.uri, (u) => fetch(u));
      buf = await decryptAes128(buf, kb, parseIv(seg.key.iv, seg.seq));
    }
    await asm.push(buf, { startTime: t });
    t += seg.duration;
    for (const p of asm.drain()) parts.push(p);
  }

  const blob = new Blob(parts);
  const ab = new Uint8Array(await blob.arrayBuffer());
  writeFileSync(outPath, Buffer.from(ab));
  return { size: ab.byteLength, mode: asm.mode, ext: asm.ext, produced: asm.produced, stats: asm.stats };
}

console.log('muxjs loaded:', typeof globalThis.muxjs === 'object' && !!globalThis.muxjs.mp4.Transmuxer);

/* ---------- 1. 解析 ---------- */
console.log('\n[1] master playlist 解析');
{
  const txt = await getText(BASE + 'master.m3u8');
  const pl = parsePlaylist(txt, BASE + 'master.m3u8');
  console.log('  mode:', pl.type, 'variants:', pl.variants.length);
  pl.variants.forEach((v) => console.log('    -', v.index, v.label, v.resolution, v.bandwidth, v.uri.split('/').slice(-2).join('/')));
  ok(pl.type === 'master', '识别为 master');
  ok(pl.variants.length === 3, '解析出 3 个变体');
  ok(pl.variants[0].resolution.height === 720, '按分辨率降序，首个为 720p');
  ok(pl.variants[0].label.includes('1280x720'), 'label 含分辨率', pl.variants[0].label);
}

console.log('\n[2] media playlist 解析');
{
  const txt = await getText(BASE + 'ts/index.m3u8');
  const pl = parsePlaylist(txt, BASE + 'ts/index.m3u8');
  console.log('  segments:', pl.segments.length, 'endList:', pl.endList, 'targetDur:', pl.targetDuration);
  ok(pl.type === 'media' && pl.segments.length === 5, '5 个分片');
  ok(pl.endList === true, '点播流 endList=true');
  ok(pl.hasMap === false, 'TS 流无 EXT-X-MAP');
  ok(Math.abs(pl.segments.reduce((a, s) => a + s.duration, 0) - 10) < 1, '总时长约 10s');
}

console.log('\n[3] 加密流解析');
{
  const txt = await getText(BASE + 'enc/index.m3u8');
  const pl = parsePlaylist(txt, BASE + 'enc/index.m3u8');
  ok(!!pl.segments[0].key, '识别 EXT-X-KEY');
  ok(pl.encrypted === 'AES-128', '标记为 AES-128');
  ok(pl.segments[0].key.uri === 'http://127.0.0.1:8899/key/k16.bin', '密钥 URI 正确', pl.segments[0].key.uri);
}

/* ---------- 2. TS → MP4 ---------- */
console.log('\n[4] TS 分片 → fMP4 转封装');
{
  const r = await assemble(BASE + 'ts/index.m3u8', '_dev/out-ts.mp4');
  console.log('  结果:', JSON.stringify({ size: r.size, mode: r.mode, ext: r.ext, produced: r.produced }));
  ok(r.mode === 'ts', '识别为 TS 输入');
  ok(r.ext === 'mp4', '输出扩展名 mp4');
  ok(r.size > 50 * 1024, '输出体积合理', r.size + 'B');
  ok(r.stats.video === true, '包含视频轨');
  ok(r.stats.audio === true, '包含音频轨');
}

/* ---------- 3. fMP4 直拼 ---------- */
console.log('\n[5] fMP4 分片直拼（EXT-X-MAP + .m4s）');
{
  const txt = await getText(BASE + 'fmp4/index.m3u8');
  const pl = parsePlaylist(txt, BASE + 'fmp4/index.m3u8');
  ok(pl.hasMap === true, '识别 EXT-X-MAP');
  const r = await assemble(BASE + 'fmp4/index.m3u8', '_dev/out-fmp4.mp4');
  console.log('  结果:', JSON.stringify({ size: r.size, mode: r.mode, ext: r.ext }));
  ok(r.mode === 'mp4', '识别为 fMP4 输入');
  ok(r.size > 50 * 1024, '输出体积合理', r.size + 'B');
}

/* ---------- 4. 解密 + 转封装 ---------- */
console.log('\n[6] AES-128 解密 + 转封装');
{
  const r = await assemble(BASE + 'enc/index.m3u8', '_dev/out-enc.mp4');
  console.log('  结果:', JSON.stringify({ size: r.size, mode: r.mode, ext: r.ext }));
  ok(r.size > 30 * 1024, '解密后体积合理', r.size + 'B');
  ok(r.stats.video === true, '解密后含视频轨');
}

/* ---------- 5. master 选流 ---------- */
console.log('\n[7] master 多码率选流');
{
  const r0 = await assemble(BASE + 'master.m3u8', '_dev/out-v0.mp4', 0);
  const r1 = await assemble(BASE + 'master.m3u8', '_dev/out-v1.mp4', 1);
  console.log('  variant0(720p):', r0.size, ' variant1(360p):', r1.size);
  ok(r0.size > r1.size, '720p 输出大于 360p');
}

console.log('\n[8] 直播流判定（无 EXT-X-ENDLIST）');
{
  const txt = await getText(BASE + 'ts/live.m3u8');
  const pl = parsePlaylist(txt, BASE + 'ts/live.m3u8');
  ok(pl.type === 'media', '识别为 media');
  ok(pl.endList === false, 'endList=false → 直播');
  ok(pl.segments.length === 5, '解析出 5 段');
}

console.log('\n[9] EXT-X-BYTERANGE 分段（同文件 Range 请求）');
{
  const txt = await getText(BASE + 'ts/range.m3u8');
  const pl = parsePlaylist(txt, BASE + 'ts/range.m3u8');
  console.log('  byterange[0]:', JSON.stringify(pl.segments[0].byterange), ' 共', pl.segments.length, '段');
  ok(pl.segments.length === 5, '5 个 byterange 段');
  ok(pl.segments[0].byterange && pl.segments[0].byterange.offset === 0, '首段 offset=0');
  ok(pl.segments[1].byterange.offset === pl.segments[0].byterange.length, '次段 offset 接续');
  const r = await assemble(BASE + 'ts/range.m3u8', '_dev/out-range.mp4');
  console.log('  结果:', JSON.stringify({ size: r.size, mode: r.mode }));
  ok(r.size > 50 * 1024, 'BYTERANGE 合并成功', r.size + 'B');
}

console.log('\n[10] CMAF：EXT-X-MEDIA 音频组 + EXT-X-MAP 的 BYTERANGE 续段');
{
  const mTxt = await getText(BASE + 'cmaf/master.m3u8');
  const master = parsePlaylist(mTxt, BASE + 'cmaf/master.m3u8');
  ok(master.type === 'master', 'master 解析成功');
  ok(master.variants.length === 3, '3 个变体', master.variants.length);
  const aud = (master.mediaGroups || []).filter((m) => String(m.TYPE).toUpperCase() === 'AUDIO');
  ok(aud.length === 1 && /CMAF_AUDIO_128\.m3u8$/.test(aud[0].uri), '音频组地址解析正确（URI 写在行首）', aud[0] && aud[0].uri);
  ok(master.variants[0].audioGroup === '6', '变体挂上 AUDIO 组', master.variants[0].audioGroup);

  const aTxt = await getText(BASE + 'cmaf/CMAF_AUDIO_128.m3u8');
  const apl = parsePlaylist(aTxt, BASE + 'cmaf/CMAF_AUDIO_128.m3u8');
  ok(apl.type === 'media' && apl.hasMap, '音频列表带 EXT-X-MAP');
  ok(apl.segments[0].map.byterange.offset === 0, 'init 段缺 offset 时取 0');
  ok(apl.segments[0].byterange.offset === 833, '首段绝对偏移 833');
  ok(
    apl.segments[1].byterange.offset === 833 + apl.segments[0].byterange.length,
    '只写长度的段接着上一段排',
    JSON.stringify(apl.segments[1].byterange)
  );

  const vTxt = await getText(BASE + 'cmaf/CMAF_720.m3u8');
  const vpl = parsePlaylist(vTxt, BASE + 'cmaf/CMAF_720.m3u8');
  ok(!vpl.encrypted && vpl.segments.length === 2, '视频列表 2 段且未加密');
}

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
