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
    // AOT 5/29 是显式 SBR 信令：紧随其后的 4 bit 才是输出采样率，
    // 前面那个 rate 只是核心采样率（SBR 之前），别拿它判断音质
    let outRate = 0;
    if ((aot === 5 || aot === 29) && p + 2 < esds.length) {
      const extIdx = ((b1 & 0x07) << 1) | (esds[p + 2] >> 7);
      if (extIdx !== 15) outRate = FREQ[extIdx] || 0;
    }
    return { aot, label: AOT[aot] || ('AOT ' + aot), rate, outRate, channels, freqIndex };
  }
  return null;
}

/** esds 的 DecoderConfigDescriptor 里带着编码器声明的码率 */
function esdsBitrate(esds) {
  for (let i = 0; i + 13 < esds.length; i++) {
    if (esds[i] !== 0x04) continue;
    const p = i + 2;
    if (p + 13 > esds.length) continue;
    return { max: readU32(esds, p + 5), avg: readU32(esds, p + 9) };
  }
  return null;
}

function trackInfo(u8, trak) {
  const out = { id: 0, handler: '', timescale: 0, codec: '', w: 0, h: 0, asc: null, esds: null };
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
                  if (e.type === 'esds') {
                    const payload = u8.subarray(e.start + e.header + 4, e.end);
                    out.asc = audioConfig(payload);
                    out.esds = esdsBitrate(payload);
                  }
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

/** 遍历 moof，收集每条轨道每个分片的 tfdt、样本数与 mdat 字节数 */
function scanFragments(u8) {
  const per = new Map();  // trackId -> [{tfdt, samples, dur, bytes}]
  const top = parseBoxes(u8);
  for (let i = 0; i < top.length; i++) {
    const b = top[i];
    if (b.type !== 'moof') continue;

    // 分片后面紧跟的 mdat 才是这一段的数据量
    let mdatBytes = 0;
    for (let j = i + 1; j < top.length; j++) {
      if (top[j].type === 'mdat') {
        mdatBytes = top[j].end - top[j].start - top[j].header;
        break;
      }
      if (top[j].type === 'moof') break;
    }

    const rows = [];
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
      rows.push({ id, tfdt, samples, dur: defDur });
    }

    // 一个 moof 里有多条 traf 时分不清各自的字节，只统计单轨分片
    for (const r of rows) {
      if (!per.has(r.id)) per.set(r.id, []);
      per.get(r.id).push({ tfdt: r.tfdt, samples: r.samples, dur: r.dur, bytes: rows.length === 1 ? mdatBytes : 0 });
    }
  }
  return per;
}

/** 相邻分片之间算出来的码率（kbps），按 tfdt 排序后取差值 */
function bitratePoints(list, ts) {
  if (!list.length || !ts) return [];
  const sorted = [...list].filter((f) => f.tfdt != null && f.bytes).sort((a, b) => a.tfdt - b.tfdt);
  if (!sorted.length) return [];

  // 每段时长用相邻 tfdt 的差值；末段没有下一段，沿用它前面那段的
  const spans = sorted.map((f, i) => (sorted[i + 1] ? (sorted[i + 1].tfdt - f.tfdt) / ts : 0));
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i] > 0.01) continue;
    const prev = spans.slice(0, i).reverse().find((v) => v > 0.01);
    if (prev) spans[i] = prev;
  }

  const pts = [];
  for (let i = 0; i < sorted.length; i++) {
    if (!(spans[i] > 0.01)) continue;
    pts.push({ t: sorted[i].tfdt / ts, kbps: (sorted[i].bytes * 8) / spans[i] / 1000 });
  }
  return pts;
}

function analyse(file) {
  let totalDup = 0;
  let totalBack = 0;
  let totalJump = 0;
  let lowRate = 0;
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
    // 排序后再取首尾：文件里的分片顺序可能是乱的，按到达顺序算会得出「只有 10 秒」这种假象
    const sorted = list.filter((f) => f.tfdt != null).sort((a, b) => a.tfdt - b.tfdt);
    if (!sorted.length || !ts) return null;
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    const step = prev ? (last.tfdt - prev.tfdt) / ts : 0;
    return { start: sorted[0].tfdt / ts, end: last.tfdt / ts + (step > 0 ? step : 0) };
  };

  for (const t of tracks) {
    const kind = t.handler === 'soun' ? 'audio' : t.handler === 'vide' ? 'video' : t.handler;
    let line = '  轨道 ' + t.id + '  ' + kind + '  ' + (t.codec || '?');
    if (kind === 'video') line += '  ' + Math.round(t.w) + 'x' + Math.round(t.h) + '  ';
    if (t.asc) {
      const hz = t.asc.outRate > t.asc.rate ? t.asc.rate + ' Hz（SBR 输出 ' + t.asc.outRate + '）' : t.asc.rate + ' Hz';
      line += '  ' + t.asc.label + '  ' + hz + '  ' + t.asc.channels + ' ch  ';
    }
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

    const pts = bitratePoints(list, t.timescale);
    if (pts.length >= 2) {
      const kbs = pts.map((p) => p.kbps).sort((a, b) => a - b);
      const avg = kbs.reduce((a, b) => a + b, 0) / kbs.length;
      if (kind === 'audio') lowRate = Math.min(lowRate || 1e9, kbs[0]);
      let line = '    码率 平均 ' + avg.toFixed(1) + ' kbps，最低 ' + kbs[0].toFixed(1) +
        '，最高 ' + kbs[kbs.length - 1].toFixed(1);
      if (t.esds && t.esds.avg) line += '（容器声明 ' + Math.round(t.esds.avg / 1000) + ' kbps）';
      console.log(line);

      const jumps = [];
      for (let i = 1; i < pts.length; i++) {
        const r = pts[i].kbps / (pts[i - 1].kbps || 1);
        if (r > 1.6 || r < 0.62) {
          jumps.push(fixed(pts[i].t, 1) + 's ' + pts[i - 1].kbps.toFixed(0) + '→' + pts[i].kbps.toFixed(0));
        }
      }
      if (jumps.length) {
        console.log('    码率跳变 ' + jumps.length + ' 处：' + jumps.slice(0, 6).join('，') +
          (jumps.length > 6 ? ' …' : ''));
        totalJump += jumps.length;
      }
    }

    if (t.asc && /SBR|PS/.test(t.asc.label)) {
      console.log('    · 源音频是 ' + t.asc.label + '：核心采样率 ' + t.asc.rate + ' Hz' +
        (t.asc.outRate > t.asc.rate ? '，SBR 还原到 ' + t.asc.outRate + ' Hz' : '') +
        '。这是源文件的编码方式，导出不重新编码；能否听出高频取决于播放器是否处理 SBR。');
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
  } else if (totalJump >= 3) {
    console.log('  结论：分片顺序没问题，但音频码率在一路里跳了 ' + totalJump + ' 次，说明录进了几个不同档位的分片。');
    console.log('        混着播时最低那档会把整条音轨的听感拖下去。');
  } else if (lowRate && lowRate < 48) {
    console.log('  结论：分片顺序没问题，但音频码率最低只有 ' + lowRate.toFixed(1) + ' kbps。');
    console.log('        这是源或档位本身的质量，不是导出过程造成的。');
  } else if (totalBack) {
    console.log('  结论：时间轴有 ' + totalBack + ' 处回退，音频可能因此卡顿或错位。');
  } else {
    console.log('  结论：分片无重复、时间轴单调、码率平稳。数据层面正常，');
    console.log('        若听感仍与网页不同，先把同一个文件用浏览器打开对比，那一步能区分是数据问题还是解码器差异。');
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
