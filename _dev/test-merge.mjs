/**
 * _dev/test-merge.mjs — fMP4 音轨合并测试
 * 用真实「音视频分离」的 HLS（EXT-X-MEDIA 音轨）验证：
 *   1. 能解析出 AUDIO 组并定位到音频播放列表
 *   2. 两路各自转封装后，init 能合并成双轨 moov
 *   3. 分片交错后输出文件含视频+音频两条轨，且可完整解码
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';
import { splitFmp4, mergeInits, renumberTracks, patchSeq, fragmentStartSec } from '../lib/mp4merge.js';

const BASE = 'http://127.0.0.1:8898/';
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

const muxCode = readFileSync(new URL('../vendor/mux.min.js', import.meta.url), 'utf8');
new Function(muxCode)();

const getBuf = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
  return new Uint8Array(await r.arrayBuffer());
};

async function assemble(url) {
  const txt = new TextDecoder().decode(await getBuf(url));
  const pl = parsePlaylist(txt, url);
  const chunks = [];
  const planned = pl.segments.reduce((a, s) => a + (s.duration || 0), 0);
  const asm = new Assembler((m, lv) => {
    if (lv === 'warn') console.log('    [warn] ' + m);
  }, null, planned);
  for (const seg of pl.segments) {
    const u8 = await getBuf(seg.url);
    await asm.push(u8, {});
    for (const c of asm.drain()) chunks.push(c);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return { pl, bytes: all };
}

console.log('[1] 解析分离音轨的 master');
const masterUrl = BASE + 'sepa/sep_master.m3u8';
const master = parsePlaylist(new TextDecoder().decode(await getBuf(masterUrl)), masterUrl);
ok(master.type === 'master', '识别为 master');
ok(master.variants.length === 1, '1 个视频档位');
const v0 = master.variants[0];
ok(v0.audioGroup === 'group_aud', '档位带 AUDIO 组', v0.audioGroup);
const audioGroup = (master.mediaGroups || []).find((g) => g.TYPE === 'AUDIO' && g['GROUP-ID'] === v0.audioGroup);
ok(!!audioGroup, '找到 EXT-X-MEDIA 音频组');
ok(!!audioGroup && !!audioGroup.URI, '音频组带 URI', audioGroup && audioGroup.URI);
const audioUrl = new URL(audioGroup.URI, masterUrl).href;
ok(/1\.m3u8$/.test(audioUrl), '音频播放列表地址', audioUrl);

console.log('\n[2] 两路分别转封装');
const video = await assemble(v0.uri);
const audio = await assemble(audioUrl);
ok(video.bytes.length > 100 * 1024, '视频 fMP4 ' + (video.bytes.length / 1024).toFixed(0) + 'KB');
ok(audio.bytes.length > 20 * 1024, '音频 fMP4 ' + (audio.bytes.length / 1024).toFixed(0) + 'KB');

const vSplit = splitFmp4(video.bytes);
const aSplit = splitFmp4(audio.bytes);
ok(!!vSplit.init, '视频 init 提取成功');
ok(vSplit.fragments.length === video.pl.segments.length, '视频分片数对应', vSplit.fragments.length + '');
ok(!!aSplit.init, '音频 init 提取成功');
ok(aSplit.fragments.length > 0, '音频分片数', aSplit.fragments.length + '');

console.log('\n[3] 合并 init 与交错分片');
const merged = mergeInits(vSplit.init, aSplit.init);
ok(merged.init.length > vSplit.init.length, '合并后 init 含两轨', merged.init.length + 'B / 视频 ' + vSplit.init.length + 'B');
ok(merged.audioTrackId !== merged.videoTrackIds[0], '音频轨道号与视频错开', 'audio=' + merged.audioTrackId);

const aScales = merged.audioTimescales;
const vScales = new Map();
// 视频 timescale 从 init 里读
const { listTracks } = await import('../lib/mp4merge.js');
for (const t of listTracks(vSplit.init)) vScales.set(t.id, t.timescale);

const t0 = Date.now();
const out = [];
out.push(merged.init);
let seq = 1;
// 按时间顺序交错：视频片写出后，把起点不晚于它的音频片插入
let ai = 0;
const audioFrags = aSplit.fragments.map((f) => {
  const copy = f.slice();
  renumberTracks(copy, merged.audioMap);
  return { buf: copy, t: fragmentStartSec(copy, aScales) };
});
for (const vf of vSplit.fragments) {
  const vStart = fragmentStartSec(vf, vScales);
  const vCopy = vf.slice();
  patchSeq(vCopy, seq++);
  out.push(vCopy);
  while (ai < audioFrags.length && audioFrags[ai].t <= vStart + 0.001) {
    const af = audioFrags[ai++];
    patchSeq(af.buf, seq++);
    out.push(af.buf);
  }
}
while (ai < audioFrags.length) {
  const af = audioFrags[ai++];
  patchSeq(af.buf, seq++);
  out.push(af.buf);
}

let total = 0;
for (const b of out) total += b.length;
const file = new Uint8Array(total);
let o = 0;
for (const b of out) {
  file.set(b, o);
  o += b.length;
}
writeFileSync('_dev/merged.mp4', file);
console.log('  写出 _dev/merged.mp4 ' + (file.length / 1024).toFixed(0) + 'KB，耗时 ' + (Date.now() - t0) + 'ms');

console.log('\n[4] ffprobe 校验输出');
const probe = (args) =>
  execFileSync('ffprobe', ['-v', 'error', ...args, '_dev/merged.mp4'], { encoding: 'utf8' }).trim();
const streams = probe(['-show_entries', 'stream=index,codec_type,codec_name,width,height,sample_rate,channels', '-of', 'csv=p=0'])
  .split('\n')
  .filter(Boolean);
console.log('  流: ' + streams.join(' | '));
ok(streams.length === 2, '两条轨道', streams.length + '');
ok(streams.some((s) => /,h264,video/.test(s)), '含 H.264 视频轨');
ok(streams.some((s) => /,aac,audio/.test(s)), '含 AAC 音频轨');
ok(streams.some((s) => /,640,360/.test(s)), '视频分辨率 640x360');

const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0']));
ok(dur > 9, '总时长 ' + dur.toFixed(2) + 's（源 10s）');

let decodeErr = '';
try {
  execFileSync('ffmpeg', ['-v', 'error', '-i', '_dev/merged.mp4', '-f', 'null', '-'], { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  decodeErr = String(e.stderr || e.message);
}
ok(!decodeErr, '完整解码无报错' + (decodeErr ? '：' + decodeErr.slice(0, 200) : ''));

const audioDur = parseFloat(
  probe(['-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0']) || '0'
);
ok(audioDur > 8.5, '音频轨时长 ' + audioDur.toFixed(2) + 's');

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
