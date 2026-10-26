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

const ASC_FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const ASC_AOT = { 1: 'AAC-Main', 2: 'AAC-LC', 3: 'AAC-SSR', 4: 'AAC-LTP', 5: 'HE-AAC', 29: 'HE-AACv2' };

/** 按位读 AudioSpecificConfig */
function readAsc(asc) {
  let bit = 0;
  const rd = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const byte = asc[bit >> 3] || 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const aot = rd(5);
  const freqIdx = rd(4);
  const channels = rd(4);
  const info = { aot, freqIdx, channels, rate: ASC_FREQ[freqIdx] || 0, extRate: 0, coreAot: 0 };
  if (aot === 5 || aot === 29) {
    info.extRate = ASC_FREQ[rd(4)] || 0;
    info.coreAot = rd(5);
  }
  return info;
}

/** 在 esds 的 payload 里定位 DecoderSpecificInfo（tag 0x05） */
function findAsc(initU8, esds) {
  const end = esds.end;
  for (let i = esds.start + esds.header + 4; i < end - 2; i++) {
    if (initU8[i] !== 0x05) continue;
    let q = i + 1;
    let len = 0;
    while (initU8[q] & 0x80) {
      len = (len << 7) | (initU8[q] & 0x7f);
      q++;
    }
    len = (len << 7) | initU8[q];
    q++;
    if (len > 0 && q + len <= end) return { at: q, len };
  }
  return null;
}

/**
 * 修正音频 esds 里自相矛盾的编码声明。
 *
 * 有的源把 ASC 写成 AOT 5（HE-AAC）却把「扩展采样率」填成和核心采样率相同。
 * 真 SBR 必须是核心的两倍，写同一个值是无效标注：码流里并没有 SBR 数据，
 * 但解码器仍会按 HE-AAC 走一遍 SBR 解码链，各家处理不一致，听感发闷、浑浊。
 * 这里改写成码流真实的 AAC-LC，并补上「显式声明无 SBR」的同步扩展。
 *
 * @returns {string[]} 实际做过的改动（空数组表示没有需要修的）
 */
export function normalizeAudioConfig(initU8) {
  const notes = [];
  if (!initU8 || initU8.length < 16) return notes;

  const top = [...boxes(initU8, 0, initU8.length)];
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return notes;

  for (const trak of boxes(initU8, moov.start + moov.header, moov.end)) {
    if (trak.type !== 'trak') continue;
    const parts = [...boxes(initU8, trak.start + trak.header, trak.end)];
    const mdia = parts.find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const mid = [...boxes(initU8, mdia.start + mdia.header, mdia.end)];

    const hdlr = mid.find((b) => b.type === 'hdlr');
    if (!hdlr) continue;
    const kind = String.fromCharCode(
      initU8[hdlr.start + hdlr.header + 8],
      initU8[hdlr.start + hdlr.header + 9],
      initU8[hdlr.start + hdlr.header + 10],
      initU8[hdlr.start + hdlr.header + 11]
    );
    if (kind !== 'soun') continue;

    const minf = mid.find((b) => b.type === 'minf');
    if (!minf) continue;
    const stbl = [...boxes(initU8, minf.start + minf.header, minf.end)].find((b) => b.type === 'stbl');
    if (!stbl) continue;
    const stsd = [...boxes(initU8, stbl.start + stbl.header, stbl.end)].find((b) => b.type === 'stsd');
    if (!stsd) continue;

    // stsd 里 entry_count(4) 之后是 sample entry，其子盒从固定字段（28 字节）之后开始
    const entry = [...boxes(initU8, stsd.start + stsd.header + 8, stsd.end)][0];
    if (!entry) continue;
    const kids = [...boxes(initU8, entry.start + entry.header + 28, entry.end)];
    const esds = kids.find((b) => b.type === 'esds');
    if (!esds) continue;

    const loc = findAsc(initU8, esds);
    if (!loc) continue;

    const info = readAsc(initU8.subarray(loc.at, loc.at + loc.len));
    const label =
      (ASC_AOT[info.aot] || 'AOT ' + info.aot) + ' ' + info.rate + ' Hz' +
      (info.extRate ? ' → ' + info.extRate + ' Hz' : '') + ' ' + info.channels + ' ch';

    // 只处理「声称 SBR 但扩展采样率没翻倍」这一种无效标注，其余原样保留
    if (!(info.aot === 5 || info.aot === 29) || info.extRate !== info.rate) continue;
    if (loc.len < 2) continue;

    const core = info.coreAot === 5 || info.coreAot === 29 ? 2 : info.coreAot || 2;
    let bits =
      core.toString(2).padStart(5, '0') +
      info.freqIdx.toString(2).padStart(4, '0') +
      info.channels.toString(2).padStart(4, '0') + '000';
    // 4 字节以上的 ASC 追一段同步扩展（0x2b7, AOT=5, sbrPresent=0），
    // 明说这条流不带 SBR。ffmpeg 自己写 5 字节 ASC 就是这个形式，
    // 长度不变，所以 esds / stsd 的尺寸字段都不用动。
    if (loc.len >= 4) bits += '0101011011100101';

    const bytes = new Uint8Array(loc.len);
    for (let i = 0; i < loc.len; i++) {
      const chunk = bits.slice(i * 8, i * 8 + 8);
      bytes[i] = chunk ? parseInt(chunk.padEnd(8, '0'), 2) : 0;
    }
    const hex = (u8) => Array.from(u8, (v) => v.toString(16).padStart(2, '0')).join(' ');
    const before = hex(initU8.subarray(loc.at, loc.at + loc.len));
    initU8.set(bytes, loc.at);
    notes.push('音频编码标注 ' + label + ' 无效（SBR 未翻倍），改写为 ' + hex(bytes) + '（原 ' + before + '）');
  }
  return notes;
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
