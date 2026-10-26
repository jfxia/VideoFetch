/**
 * fix-media.mjs — 修补已导出的文件（离线，只改容器，不动码流）
 *
 * 两件事：
 *  1. 音频 esds 里的 AudioSpecificConfig 声称是 HE-AAC（AOT 5/29）却把
 *     「扩展采样率」写成和核心采样率相同——SBR 本来该是核心的两倍。
 *     这种标注无效，解码器各按各的理解处理。改成真实的编码类型（AAC-LC）。
 *  2. mvhd/tkhd/mdhd 的时长按源清单写成了完整时长，但录制可能只覆盖一部分，
 *     导致播放器在没内容的地方空转。改成实际内容的末尾。
 *
 * 用法：node _dev/fix-media.mjs <输入.mp4> [输出.mp4]
 */
import { readFileSync, writeFileSync } from 'node:fs';
// 与扩展共用同一份实现，避免两处逻辑各改各的
import { normalizeAudioConfig } from '../lib/mp4time.js';

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64 = (b, p) => u32(b, p) * 4294967296 + u32(b, p + 4);
const w32 = (b, p, v) => { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; };
const w64 = (b, p, v) => { w32(b, p, Math.floor(v / 4294967296)); w32(b, p + 4, v >>> 0); };
const typ = (b, p) => String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);

function boxes(b, s, e) {
  const out = [];
  let p = s;
  while (p + 8 <= e) {
    let size = u32(b, p);
    const t = typ(b, p);
    let header = 8;
    if (size === 1) { size = u64(b, p + 8); header = 16; }
    if (size < 8) break;
    out.push({ type: t, start: p, size, header, end: p + size });
    p += size;
  }
  return out;
}

function find(b, box, t, depth = 0) {
  const out = [];
  if (depth > 6) return out;
  for (const c of boxes(b, box.start + box.header, box.end)) {
    if (c.type === 'mdat' || c.type === 'moof') continue;
    if (c.type === t) out.push(c);
    else {
      // 采样描述盒（mp4a）内部还有一层子盒，头部直接跟在 28 字节的固定字段之后
      if (c.type === 'stsd') {
        for (const e of boxes(b, c.start + c.header + 8, c.end)) {
          if (e.type === 'mp4a' || e.type === 'avc1') {
            for (const g of boxes(b, e.start + e.header + 28, e.end)) {
              if (g.type === t) out.push(g);
            }
          }
        }
        continue;
      }
      for (const y of find(b, c, t, depth + 1)) out.push(y);
    }
  }
  return out;
}

/* ---------------- 二、修时长 ---------------- */

function fragmentEnd(b) {
  const per = new Map();   // trackId -> 秒
  for (const moof of boxes(b, 0, b.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(b, moof.start + moof.header, moof.end)) {
      if (traf.type !== 'traf') continue;
      let id = 0, tfdt = 0, defDur = 0, dur = 0, samples = 0, hasDur = false;
      for (const c of boxes(b, traf.start + traf.header, traf.end)) {
        const p = c.start + c.header;
        if (c.type === 'tfhd') {
          id = u32(b, p + 4);
          const fl = u32(b, p) & 0xffffff;
          let q = p + 8;
          if (fl & 0x01) q += 8;
          if (fl & 0x02) q += 4;
          if (fl & 0x08) defDur = u32(b, q);
        } else if (c.type === 'tfdt') {
          tfdt = b[p] === 1 ? u64(b, p + 4) : u32(b, p + 4);
        } else if (c.type === 'trun') {
          const fl = u32(b, p) & 0xffffff;
          samples = u32(b, p + 4);
          let q = p + 8;
          if (fl & 0x01) q += 4;
          if (fl & 0x04) q += 4;
          for (let i = 0; i < samples; i++) {
            if (fl & 0x100) { dur += u32(b, q); q += 4; hasDur = true; }
            if (fl & 0x200) q += 4;
            if (fl & 0x400) q += 4;
            if (fl & 0x800) q += 4;
          }
        }
      }
      if (!id) continue;
      const total = hasDur ? dur : defDur * samples;
      const prev = per.get(id) || 0;
      per.set(id, Math.max(prev, tfdt + total));
    }
  }
  return per;
}

function fixDuration(b) {
  const notes = [];
  const end = fragmentEnd(b);
  if (!end.size) return notes;

  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov');
  const mvhd = boxes(b, moov.start + moov.header, moov.end).find((x) => x.type === 'mvhd');
  if (!mvhd) return notes;

  const v = b[mvhd.start + mvhd.header];
  const tsAt = mvhd.start + mvhd.header + 4 + (v === 1 ? 16 : 8);
  const mvTs = u32(b, tsAt);
  const durAt = tsAt + 4;

  // 每条轨各自的时长按它自己的时间刻度换算
  const traks = boxes(b, moov.start + moov.header, moov.end).filter((x) => x.type === 'trak');
  let maxSec = 0;
  for (const trak of traks) {
    const tkhd = find(b, trak, 'tkhd')[0];
    const mdhd = find(b, trak, 'mdhd')[0];
    if (!tkhd || !mdhd) continue;
    const tid = u32(b, tkhd.start + tkhd.header + (b[tkhd.start + tkhd.header] === 1 ? 20 : 12));
    const mtsAt = mdhd.start + mdhd.header + 4 + (b[mdhd.start + mdhd.header] === 1 ? 16 : 8);
    const mts = u32(b, mtsAt);
    const ticks = end.get(tid) || 0;
    if (!mts || !ticks) continue;
    const s = ticks / mts;
    if (s > maxSec) maxSec = s;
  }

  if (!maxSec) return notes;
  const before = (v === 1 ? u64(b, durAt) : u32(b, durAt)) / mvTs;
  if (v === 1) w64(b, durAt, Math.round(maxSec * mvTs));
  else w32(b, durAt, Math.round(maxSec * mvTs));
  notes.push(`总时长 ${before.toFixed(2)}s → ${maxSec.toFixed(2)}s`);

  for (const trak of traks) {
    const tkhd = find(b, trak, 'tkhd')[0];
    const mdhd = find(b, trak, 'mdhd')[0];
    if (!tkhd || !mdhd) continue;
    const tid = u32(b, tkhd.start + tkhd.header + (b[tkhd.start + tkhd.header] === 1 ? 20 : 12));
    const ticks = end.get(tid) || 0;
    const mtsAt = mdhd.start + mdhd.header + 4 + (b[mdhd.start + mdhd.header] === 1 ? 16 : 8);
    const mts = u32(b, mtsAt);
    if (!mts || !ticks) continue;

    const mdV = b[mdhd.start + mdhd.header];
    if (mdV === 1) w64(b, mtsAt + 4, ticks); else w32(b, mtsAt + 4, ticks);

    const tkV = b[tkhd.start + tkhd.header];
    // tkhd 里 track_ID 之后的保留字段占 4 字节，时长在它后面
    const tkDurAt = tkhd.start + tkhd.header + (tkV === 1 ? 28 : 20);
    if (tkV === 1) w64(b, tkDurAt, ticks); else w32(b, tkDurAt, ticks);
    notes.push(`轨道 ${tid} 时长 → ${(ticks / mts).toFixed(2)}s`);
  }
  return notes;
}

/* ---------------- 主流程 ---------------- */

const src = process.argv[2];
if (!src) {
  console.error('用法：node _dev/fix-media.mjs <输入.mp4> [输出.mp4]');
  process.exit(1);
}
const dst = process.argv[3] || src.replace(/\.mp4$/i, '') + '.fixed.mp4';

const buf = readFileSync(src);
const b = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log('输入:', src);
for (const note of normalizeAudioConfig(b)) console.log('  ' + note);
for (const note of fixDuration(b)) console.log('  ' + note);

writeFileSync(dst, b);
console.log('输出:', dst);
