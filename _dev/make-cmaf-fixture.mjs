/**
 * _dev/make-cmaf-fixture.mjs — 用 Reddit 真实 HLS 数据生成本地夹具
 *
 * 落盘到 _dev/media/cmaf/，结构与 v.redd.it 一致：
 *   master: EXT-X-MEDIA(URI 在前) + EXT-X-STREAM-INF(AUDIO 组)
 *   子列表: EXT-X-MAP(BYTERANGE) + 首段带偏移、后续只写长度的 BYTERANGE
 * 只取 1 段视频 + 1 段音频，控制体积。
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://v.redd.it/d36t7r0slpwh1';
const Q =
  '?f=sd%2CsubsAll%2ChlsSpecOrder%2Cvp9&v=1&a=1795157008%2CMmRlNDgzYWUyNjBhZGQ4ZGRjMGZlYzgwOWUxNTkxMDNhYjBkYmEyMzI0N2QzNTEwNTM5NDA2MGM4YTVkOTZiMg%3D%3D';
const OUT = '_dev/media/cmaf';
mkdirSync(OUT, { recursive: true });

async function range(url, br) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Range: `bytes=${br.offset}-${br.offset + br.length - 1}` }
  });
  if (r.status !== 206) throw new Error('服务端未按 Range 返回：' + r.status);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== br.length) throw new Error(`长度不符 ${b.length}/${br.length}`);
  return b;
}

/** init 与分片拼成一个文件，返回 {file, playlist} */
async function build(name, pl, segCount, mime) {
  const initBr = pl.segments[0].map.byterange;
  const buf = [];
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD'];
  buf.push(await range(pl.segments[0].map.url, initBr));
  lines.push(`#EXT-X-MAP:URI="${name}.mp4",BYTERANGE="${initBr.length}@0"`);

  let offset = initBr.length;
  let dur = 0;
  for (const seg of pl.segments.slice(0, segCount)) {
    const b = await range(seg.url, seg.byterange);
    buf.push(b);
    dur += seg.duration || 0;
    lines.push(`#EXTINF:${seg.duration},`);
    // 第一段给绝对偏移，后续只写长度，逼解析器走「续上一段」分支
    lines.push(`#EXT-X-BYTERANGE:${b.length}${offset === initBr.length ? '@' + offset : ''}`);
    lines.push(`${name}.mp4`);
    offset += b.length;
  }
  lines.push('#EXT-X-ENDLIST');

  writeFileSync(`${OUT}/${name}.mp4`, Buffer.concat(buf.map((x) => Buffer.from(x))));
  writeFileSync(`${OUT}/${name}.m3u8`, lines.join('\n') + '\n', 'utf8');
  console.log(`${name}.mp4 ${offset}B  时长 ${dur.toFixed(2)}s  分片 ${segCount}  ${mime}`);
  return { name, dur, bytes: offset };
}

async function load(u) {
  const { parsePlaylist } = await import('../lib/m3u8.js');
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return parsePlaylist(await r.text(), u);
}

const vpl = await load(`${BASE}/CMAF_720.m3u8${Q}`);
const apl = await load(`${BASE}/CMAF_AUDIO_128.m3u8${Q}`);
const v = await build('CMAF_720', vpl, 2, 'video');
const a = await build('CMAF_AUDIO_128', apl, 2, 'audio');

const master = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-MEDIA:URI="CMAF_AUDIO_128.m3u8",TYPE=AUDIO,GROUP-ID="6",NAME="audio 0",DEFAULT=YES,AUTOSELECT=YES',
  '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=2606147,AVERAGE-BANDWIDTH=2088813,RESOLUTION=720x720,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="6"',
  'CMAF_720.m3u8',
  '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=1612888,AVERAGE-BANDWIDTH=1474601,RESOLUTION=720x720,FRAME-RATE=30,CODECS="vp09.00.30.08.01.01.01.01.00,mp4a.40.2",AUDIO="6"',
  'CMAF_720.m3u8',
  '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=317670,AVERAGE-BANDWIDTH=289705,RESOLUTION=220x220,FRAME-RATE=30,CODECS="vp09.00.11.08.01.01.01.01.00,mp4a.40.2",AUDIO="6"',
  'CMAF_720.m3u8'
].join('\n');
writeFileSync(`${OUT}/master.m3u8`, master + '\n', 'utf8');
console.log('master.m3u8 写好：720p 两套编码（avc/vp9）+ 220p，音频组 URI 写在最前');
console.log('视频 ' + v.bytes + 'B，音频 ' + a.bytes + 'B');
