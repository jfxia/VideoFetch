/**
 * _dev/test-merge.mjs — fMP4 音轨合并测试
 * 用真实「音视频分离」的 HLS（EXT-X-MEDIA 音轨）验证：
 *   1. 能解析出 AUDIO 组并定位到音频播放列表
 *   2. 两路各自转封装后，init 能合并成双轨 moov
 *   3. 分片交错后输出文件含视频+音频两条轨，且可完整解码
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';
import { splitFmp4, mergeInits, renumberTracks, patchSeq, fragmentStartSec, tidyFragments, parseBoxes } from '../lib/mp4merge.js';
import { collectTrackScales, normalizeAudioConfig } from '../lib/mp4time.js';

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

console.log('\n[5] 录制路线：播放器重复 append 的分片');

const cat = (...arrs) => {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// 4 秒、每秒一片的音视频混流：拿它模拟播放器 seek 回看时的 append 序列
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
  '-frag_duration', '1000000',
  '-f', 'mp4', '_dev/dup-src.mp4'
]);
const dupSrc = new Uint8Array(readFileSync('_dev/dup-src.mp4'));
const dup = splitFmp4(dupSrc);
ok(dup.fragments.length === 4, '夹具 4 个分片', dup.fragments.length + '');

// 先 0、2、1、3（乱序），再回头 1、2（重复）
const order = [0, 2, 1, 3, 1, 2];
const noisy = order.map((i) => dup.fragments[i]);

const dsc = collectTrackScales(dup.init);
const tidy = tidyFragments(dup.init, noisy);
ok(tidy.fragments.length === 4, '整理后剩 4 段', tidy.fragments.length + '');
ok(tidy.dropped === 2, '丢掉 2 段重复', tidy.dropped + '');
const tidyTimes = tidy.fragments.map((f) => fragmentStartSec(f, dsc));
ok(
  tidyTimes.every((t, i) => i === 0 || t > tidyTimes[i - 1]),
  '按 tfdt 排成时间顺序',
  tidyTimes.map((t) => t.toFixed(2)).join(' ')
);

const dupLogs = [];
const dupAsm = new Assembler((m) => dupLogs.push(m), null, 0);
await dupAsm.push(cat(dup.init, ...noisy));
const dupOut = cat(...dupAsm.drain(true));
writeFileSync('_dev/dup-out.mp4', Buffer.from(dupOut));
ok(dupAsm.stats.dups === 2, '装配器丢掉 2 段重复分片', dupAsm.stats.dups + '');

const moofCount = (u8) => parseBoxes(u8).filter((b) => b.type === 'moof').length;
ok(moofCount(dupOut) === 4, '输出里只有 4 个分片', moofCount(dupOut) + '');

const dupDur = parseFloat(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '_dev/dup-out.mp4'], {
    encoding: 'utf8'
  }).trim()
);
ok(dupDur > 3.8 && dupDur < 4.4, '时长仍是 4s（没被重复分片拉长）', dupDur.toFixed(2) + 's');

let dupErr = '';
try {
  execFileSync('ffmpeg', ['-v', 'error', '-i', '_dev/dup-out.mp4', '-f', 'null', '-'], { stdio: 'pipe' });
} catch (e) {
  dupErr = String(e.stderr || e.message);
}
ok(!dupErr, '重复分片去掉后可完整解码' + (dupErr ? '：' + dupErr.slice(0, 160) : ''));

// 独立音轨同样会被重复 append：整理掉之后，成片音频应与源逐字节等价
const aRawDup = new Uint8Array(readFileSync('_dev/media/cmaf/CMAF_AUDIO_128.mp4'));
const aPart = splitFmp4(aRawDup);
const vRawDup = new Uint8Array(readFileSync('_dev/media/cmaf/CMAF_720.mp4'));
const vPart = splitFmp4(vRawDup);

const aLogs = [];
const aAsm = new Assembler((m) => aLogs.push(m), null, 0);
aAsm.setAudioTrack({
  init: aPart.init,
  fragments: [aPart.fragments[1], aPart.fragments[0], aPart.fragments[1], aPart.fragments[0]]
});
await aAsm.push(cat(vPart.init, vPart.fragments[0], vPart.fragments[1]));
writeFileSync('_dev/dup-merged.mp4', Buffer.from(cat(...aAsm.drain(true))));
ok(aLogs.some((m) => /音轨整理/.test(m)), '日志说明音轨被整理过', aLogs.filter((m) => /音轨整理/.test(m))[0] || '');

const pcm = (file) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'], {
    maxBuffer: 1 << 26
  });
const md5 = (b) => createHash('md5').update(b).digest('hex');
const srcPcm = md5(pcm('_dev/media/cmaf/CMAF_AUDIO_128.mp4'));
const gotPcm = md5(pcm('_dev/dup-merged.mp4'));
ok(srcPcm === gotPcm, '音频 PCM 与源文件完全一致', gotPcm.slice(0, 12));

console.log('\n[6] 音频编码标注：声称 HE-AAC 但 SBR 没有翻倍');

// ffmpeg 写的标准 ASC：AAC-LC 48kHz 2ch + 「显式无 SBR」同步扩展
const ASC_LC = [0x11, 0x90, 0x56, 0xe5, 0x00];
// 同一路码流却标成 AOT 5（HE-AAC），扩展采样率又填回 48kHz —— 无效标注
const ASC_BAD = [0x29, 0x91, 0x88, 0x00, 0x00];

/** 把夹具 init 里的 ASC 换成指定字节，返回副本与位置 */
const initWith = (bytes) => {
  const copy = Uint8Array.from(aPart.init);
  for (let i = 0; i + ASC_LC.length <= copy.length; i++) {
    if (ASC_LC.every((v, k) => copy[i + k] === v)) {
      copy.set(bytes, i);
      return { init: copy, at: i };
    }
  }
  throw new Error('夹具 init 里找不到预期的 ASC');
};

const bad = initWith(ASC_BAD);
ok(
  ASC_BAD.every((v, k) => bad.init[bad.at + k] === v),
  '构造出一份标错编码的 init',
  ASC_BAD.map((v) => v.toString(16)).join(' ')
);

const notes = normalizeAudioConfig(bad.init);
ok(notes.length === 1, '识别出无效标注并改写', notes[0] || '无输出');
ok(
  ASC_LC.every((v, k) => bad.init[bad.at + k] === v),
  'ASC 改回真实的 AAC-LC',
  Array.from(bad.init.subarray(bad.at, bad.at + ASC_LC.length), (v) => v.toString(16)).join(' ')
);
ok(
  Buffer.compare(Buffer.from(bad.init), Buffer.from(aPart.init)) === 0,
  '除 ASC 外一个字节都没动'
);
ok(normalizeAudioConfig(bad.init).length === 0, '重复调用不再改动（幂等）');
ok(normalizeAudioConfig(Uint8Array.from(aPart.init)).length === 0, '正常 AAC-LC 的 init 原样保留');

// 端到端：标错的音轨走一遍合并，产出文件里的标注应当已经正确
const ascAsm = new Assembler(() => {}, null, 0);
ascAsm.setAudioTrack({ init: initWith(ASC_BAD).init, fragments: [aPart.fragments[0], aPart.fragments[1]] });
await ascAsm.push(cat(vPart.init, vPart.fragments[0], vPart.fragments[1]));
const ascOut = cat(...ascAsm.drain(true));
writeFileSync('_dev/asc-out.mp4', Buffer.from(ascOut));

let stillBad = false;
for (let i = 0; i + ASC_BAD.length <= ascOut.length; i++) {
  if (ASC_BAD.every((v, k) => ascOut[i + k] === v)) stillBad = true;
}
ok(!stillBad, '合并产物里没有残留的错误标注');
ok(ascAsm.audioNotes.some((n) => /编码标注/.test(n)), '装配记录里留下说明', ascAsm.audioNotes[0] || '');

const ascProfile = execFileSync(
  'ffprobe',
  ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=profile', '-of', 'csv=p=0', '_dev/asc-out.mp4'],
  { encoding: 'utf8' }
).trim();
ok(/LC/i.test(ascProfile), 'ffprobe 读到的音频 profile 是 AAC-LC', ascProfile);

let ascErr = '';
try {
  execFileSync('ffmpeg', ['-v', 'error', '-i', '_dev/asc-out.mp4', '-f', 'null', '-'], { stdio: 'pipe' });
} catch (e) {
  ascErr = String(e.stderr || e.message);
}
ok(!ascErr, '改写后仍可完整解码' + (ascErr ? '：' + ascErr.slice(0, 160) : ''));

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
