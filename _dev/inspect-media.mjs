/**
 * _dev/inspect-media.mjs — 检查导出的 mp4 到底装了什么
 *
 * 用法: node _dev/inspect-media.mjs <文件.mp4> [更多文件...]
 *
 * 回答三个问题：
 *   1. 音频轨是什么编码、采样率、声道、码率（HE-AAC 会被单独标出来）
 *   2. 音频与视频的时间轴是否对齐、有没有重复或断裂的分片
 *   3. 音频分片总时长与视频差多少
 *
 * 只读文件，不改动任何东西。
 */
import { readFileSync } from 'node:fs';
import { parseBoxes } from '../lib/mp4merge.js';

const readU32 = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
const readU64 = (u8, p) => readU32(u8, p) * 4294967296 + readU32(u8, p + 4);
const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
const fixed = (n, d = 3) => Number(n).toFixed(d);

const FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AOT = { 1: 'AAC-LC', 2: 'AAC-LC', 5: 'HE-AAC (SBR)', 29: 'HE-AAC v2 (SBR+PS)', 23: 'AAC-LD', 42: 'xHE-AAC' };

/** 在 esds 负载里找 DecoderSpecificInfo(tag 0x05)，解出 AudioSpecificConfig */
function audioConfig(esds) {
  for (let i = 0; i + 2 < esds.length; i++) {
    if (esds[i] !== 0x05) continue;
    const len = esds[i + 1];
    const p = i + 2;
    if (len < 2 || p + 2 > esds.length) continue;
    const b0 = esds[p];
    const b1 = esds[p + 1];
    let aot = b0 >> 3;
    const freqIndex = ((b0 & 7) << 1) | (b1 >> 7);
    let rate = FREQ[freqIndex] || 0;
    if (freqIndex === 15 && p + 5 <= esds.length) {
      rate = ((b1 & 0x7f) << 17) | (esds[p + 2] << 9) | (esds[p + 3] << 1) | (esds[p + 4] >> 7);
    }
    const channels = (b1 >> 3) & 0x0f;
    // 显式 SBR 信令：AOT 为 5/29
    return { aot, label: AOT[aot] || ('AOT ' + aot), rate, channels, freqIndex };
  }
  return null;
}

function trackInfo(u8, trak) {
  const out = { id: 0, handler: '', timescale: 0, codec: '', w: 0, h: 0, asc: null };
  for (const t of parseBoxes(u8, trak.start + trak.header, trak.end)) {
    const b = t.start + t.header;
    if (t.type === 'tkhd') {
      const v1 = u8[b] === 1;
      out.id = readU32(u8, b + (v1 ? 20 : 12));
      const off = b + (v1 ? 88 : 76);
      if (off + 8 <= t.end) {
        out.w = readU32(u8, off) / 65536;
        out.h = readU32(u8, off + 4) / 65536;
      }
    } else if (t.type === 'mdia') {
      for (const m of parseBoxes(u8, t.start + t.header, t.end)) {
        const mb = m.start + m.header;
        if (m.type === 'mdhd') {
          out.timescale = readU32(u8, mb + (u8[mb] === 1 ? 20 : 12));
        } else if (m.type === 'hdlr') {
          out.handler = fourcc(u8, mb + 8);
        } else if (m.type === 'minf') {
          for (const s of parseBoxes(u8, m.start + m.header, m.end)) {
            if (s.type !== 'stbl') continue;
            for (const d of parseBoxes(u8, s.start + s.header, s.end)) {
              if (d.type !== 'stsd') continue;
              const first = parseBoxes(u8, d.start + d.header + 8, d.end)[0];
              if (!first) continue;
              out.codec = first.type;
              if (first.type === 'mp4a' || first.type === 'enca') {
                for (const e of parseBoxes(u8, first.start + first.header + 28, first.end)) {
                  if (e.type === 'esds') out.asc = audioConfig(u8.subarray(e.start + e.header + 4, e.end));
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** 遍历 moof，收集每条轨道每个分片的 tfdt 与样本数 */
function scanFragments(u8) {
  const per = new Map();  // trackId -> [{tfdt, samples, dur}]
  for (const b of parseBoxes(u8)) {
    if (b.type !== 'moof') continue;
    for (const traf of parseBoxes(u8, b.start + b.header, b.end)) {
      if (traf.type !== 'traf') continue;
      let id = 0;
      let tfdt = null;
      let defDur = 0;
      let samples = 0;
      for (const t of parseBoxes(u8, traf.start + traf.header, traf.end)) {
        const tb = t.start + t.header;
        if (t.type === 'tfhd') {
          id = readU32(u8, tb + 4);
          const flags = readU32(u8, tb) & 0xffffff;
          let q = tb + 8;
          if (flags & 0x01) q += 8;
          if (flags & 0x02) q += 4;
          if (flags & 0x08) { defDur = readU32(u8, q); q += 4; }
        } else if (t.type === 'tfdt') {
          tfdt = u8[tb] === 1 ? readU64(u8, tb + 4) : readU32(u8, tb + 4);
        } else if (t.type === 'trun') {
          samples += readU32(u8, tb + 4);
        }
      }
      if (!id) continue;
      if (!per.has(id)) per.set(id, []);
      per.get(id).push({ tfdt, samples, dur: defDur });
    }
  }
  return per;
}

function analyse(file) {
  let totalDup = 0;
  let totalBack = 0;
  const raw = readFileSync(file);
  const u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  console.log('\n' + file + '  (' + fixed(raw.length / 1048576, 1) + ' MB)');

  const top = parseBoxes(u8);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) {
    console.log('  找不到 moov —— 这不是一个可播放的 mp4，或者文件被截断');
    return;
  }
  const tracks = parseBoxes(u8, moov.start + moov.header, moov.end)
    .filter((b) => b.type === 'trak')
    .map((t) => trackInfo(u8, t))
    .filter((t) => t.id);

  const frags = scanFragments(u8);

  const span = (list, ts) => {
    const vals = list.map((f) => f.tfdt).filter((v) => v != null);
    if (!vals.length || !ts) return null;
    const start = Math.min(...vals) / ts;
    const last = list[list.length - 1];
    const end = (last.tfdt + (last.samples || 0) * (list.length > 1
      ? (list[1].tfdt - list[0].tfdt) / (list[0].samples || 1)
      : 0)) / ts;
    return { start, end: Number.isFinite(end) && end > start ? end : Math.max(...vals) / ts };
  };

  for (const t of tracks) {
    const kind = t.handler === 'soun' ? 'audio' : t.handler === 'vide' ? 'video' : t.handler;
    let line = '  轨道 ' + t.id + '  ' + kind + '  ' + (t.codec || '?');
    if (kind === 'video') line += '  ' + Math.round(t.w) + 'x' + Math.round(t.h) + '  ';
    if (t.asc) line += '  ' + t.asc.label + '  ' + t.asc.rate + ' Hz  ' + t.asc.channels + ' ch  ';
    line += '  timescale ' + t.timescale;
    console.log(line);

    const list = frags.get(t.id) || [];
    if (!list.length) { console.log('    没有分片（moof/traf 里找不到这条轨道）'); continue; }
    const sp = span(list, t.timescale) || { start: 0, end: 0 };
    const tf = list.map((f) => f.tfdt).filter((v) => v != null);
    const dup = new Set();
    let dupN = 0;
    for (const v of tf) { if (dup.has(v)) dupN++; dup.add(v); }
    let backN = 0;
    for (let i = 1; i < tf.length; i++) if (tf[i] < tf[i - 1]) backN++;
    totalDup += dupN;
    totalBack += backN;
    const samples = list.reduce((n, f) => n + (f.samples || 0), 0);
    console.log('    分片 ' + list.length + ' 段，样本 ' + samples + '，时间轴 ' +
      fixed(sp.start) + ' → ' + fixed(sp.end) + ' s，重复 tfdt ' + dupN + ' 处，回退 ' + backN + ' 处');

    if (t.asc && /SBR|PS/.test(t.asc.label)) {
      console.log('    · 源音频是 ' + t.asc.label + '：核心采样率 ' + t.asc.rate +
        ' Hz，高频由 SBR 扩展还原。主流播放器能解出完整带宽，这一项由源文件决定，与导出无关。');
    }
    if (t.asc && t.asc.channels === 1) {
      console.log('    · 单声道，与网页播放时的立体声相比会变窄。');
    }
  }

  const va = tracks.find((t) => t.handler === 'vide');
  const au = tracks.find((t) => t.handler === 'soun');
  if (va && au) {
    const vs = span(frags.get(va.id) || [], va.timescale);
    const as = span(frags.get(au.id) || [], au.timescale);
    if (vs && as) {
      const d = as.end - as.start - (vs.end - vs.start);
      console.log('  音频比视频' + (d >= 0 ? '长' : '短') + ' ' + fixed(Math.abs(d), 2) + ' s');
      if (Math.abs(d) > 1.5) console.log('    ! 差距超过 1.5 秒，说明有一侧的分片漏录或重复录了');
    }
  }

  if (totalDup) {
    console.log('  结论：有 ' + totalDup + ' 段分片被重复录制。播放器 seek 时会重新 append 已播过的段，');
    console.log('        视频重复只是跳帧，音频重复是同一段时间叠着播两遍——听感就是浑浊、回声。');
  } else if (totalBack) {
    console.log('  结论：时间轴有 ' + totalBack + ' 处回退，音频可能因此卡顿或错位。');
  } else {
    console.log('  结论：分片无重复、时间轴单调，音质问题不在录制环节。');
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法: node _dev/inspect-media.mjs <文件.mp4> [更多文件...]');
  process.exit(1);
}
for (const f of files) {
  try {
    analyse(f);
  } catch (e) {
    console.log('\n%s  解析失败: %s', f, e && e.message);
  }
}
