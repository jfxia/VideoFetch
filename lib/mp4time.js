/**
 * lib/mp4time.js — fMP4 时间轴修复
 *
 * mux.js 转封装出来的 tfdt 保留了 TS 原始 PTS（通常从 1.4s 之类的位置起跑），
 * 导致合并文件开头有一段空白、总时长偏大。这里做两件事：
 *   1. 把所有 moof/traf/tfdt 的 baseMediaDecodeTime 整体平移到 0 起点
 *   2. 按计划时长修正 moov 内 mvhd / tkhd / mdhd 的 duration
 */

const readU32 = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
const readU64 = (u8, p) => readU32(u8, p) * 4294967296 + readU32(u8, p + 4);
const writeU32 = (u8, p, v) => {
  u8[p] = (v >>> 24) & 255;
  u8[p + 1] = (v >>> 16) & 255;
  u8[p + 2] = (v >>> 8) & 255;
  u8[p + 3] = v & 255;
};
const writeU64 = (u8, p, v) => {
  writeU32(u8, p, Math.floor(v / 4294967296) >>> 0);
  writeU32(u8, p + 4, v >>> 0);
};

function* boxes(u8, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = readU32(u8, p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = readU64(u8, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    yield { type, start: p, header, size, end: p + size };
    p += size;
  }
}

/** 解析 moov，返回 Map<trackId, timescale> */
export function collectTrackScales(initU8) {
  const map = new Map();
  if (!initU8) return map;
  for (const b of boxes(initU8, 0, initU8.length)) {
    if (b.type !== 'moov') continue;
    for (const trak of boxes(initU8, b.start + b.header, b.end)) {
      if (trak.type !== 'trak') continue;
      let trackId = 0;
      let timescale = 0;
      for (const t of boxes(initU8, trak.start + trak.header, trak.end)) {
        if (t.type === 'tkhd') {
          const base = t.start + t.header;
          trackId = readU32(initU8, base + (initU8[base] === 1 ? 20 : 12));
        } else if (t.type === 'mdia') {
          for (const m of boxes(initU8, t.start + t.header, t.end)) {
            if (m.type === 'mdhd') {
              const base = m.start + m.header;
              timescale = readU32(initU8, base + (initU8[base] === 1 ? 20 : 12));
            }
          }
        }
      }
      if (trackId && timescale) map.set(trackId, timescale);
    }
  }
  return map;
}

/**
 * 扫描一个分片里所有 tfdt，首次调用时确定全流起始秒数，之后统一平移。
 * @param {Uint8Array} u8
 * @param {Map<number,number>} scales
 * @param {{baseSec:number|null, endSec:number}} state
 */
export function shiftTfdt(u8, scales, state) {
  if (!u8 || u8.length < 16) return;
  const targets = [];
  for (const b of boxes(u8, 0, u8.length)) {
    if (b.type !== 'moof') continue;
    for (const traf of boxes(u8, b.start + b.header, b.end)) {
      if (traf.type !== 'traf') continue;
      let trackId = 0;
      let tfdt = null;
      for (const t of boxes(u8, traf.start + traf.header, traf.end)) {
        if (t.type === 'tfhd') trackId = readU32(u8, t.start + t.header + 4);
        else if (t.type === 'tfdt') tfdt = t;
      }
      if (!tfdt) continue;
      const base = tfdt.start + tfdt.header;
      const ver = u8[base];
      const timescale = scales.get(trackId) || 90000;
      const value = ver === 1 ? readU64(u8, base + 4) : readU32(u8, base + 4);
      const sec = value / timescale;
      if (state.baseSec === null || sec < state.baseSec) state.baseSec = sec;
      targets.push({ base, ver, value, timescale });
      if (sec > state.endSec) state.endSec = sec;
    }
  }

  if (state.baseSec === null) return;
  const baseSec = state.baseSec;

  for (const t of targets) {
    const shift = Math.round(baseSec * t.timescale);
    let nv = t.value - shift;
    if (nv < 0) nv = 0;
    if (t.ver === 1) writeU64(u8, t.base + 4, nv);
    else writeU32(u8, t.base + 4, nv);
  }
}

/** 修正 moov 内各层 duration（秒） */
export function patchInitDuration(initU8, seconds) {
  if (!initU8 || !seconds || seconds <= 0) return;
  const top = [...boxes(initU8, 0, initU8.length)];
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return;

  let movieTs = 1000;
  const inner = [...boxes(initU8, moov.start + moov.header, moov.end)];
  const mvhd = inner.find((b) => b.type === 'mvhd');
  if (mvhd) {
    const base = mvhd.start + mvhd.header;
    if (initU8[base] === 0) {
      movieTs = readU32(initU8, base + 12) || 1000;
      writeU32(initU8, base + 16, Math.round(seconds * movieTs));
    } else {
      movieTs = readU32(initU8, base + 20) || 1000;
      writeU64(initU8, base + 24, Math.round(seconds * movieTs));
    }
  }

  for (const trak of inner.filter((b) => b.type === 'trak')) {
    const parts = [...boxes(initU8, trak.start + trak.header, trak.end)];

    const tkhd = parts.find((b) => b.type === 'tkhd');
    if (tkhd) {
      const base = tkhd.start + tkhd.header;
      if (initU8[base] === 0) writeU32(initU8, base + 20, Math.round(seconds * movieTs));
      else writeU64(initU8, base + 28, Math.round(seconds * movieTs));
    }

    const mdia = parts.find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const ms = [...boxes(initU8, mdia.start + mdia.header, mdia.end)];
    const mdhd = ms.find((b) => b.type === 'mdhd');
    if (!mdhd) continue;
    const base = mdhd.start + mdhd.header;
    if (initU8[base] === 0) {
      const ts = readU32(initU8, base + 12) || 90000;
      writeU32(initU8, base + 16, Math.round(seconds * ts));
    } else {
      const ts = readU32(initU8, base + 20) || 90000;
      writeU64(initU8, base + 24, Math.round(seconds * ts));
    }
  }
}
