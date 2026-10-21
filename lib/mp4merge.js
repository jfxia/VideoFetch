/**
 * lib/mp4merge.js — fMP4 音轨合并
 *
 * 用途：HLS 把音视频拆成两个播放列表（EXT-X-MEDIA / 独立 rendition）时，
 * 视频流与音频流各自经 mux.js 转成 fMP4，这里把两条流拼成一个文件：
 *   1. 合并 init：视频 moov 里追加音频 trak（轨道号重编号避免冲突）+ 对应 trex
 *   2. 分片交错：按 tfdt 起点把音频分片插进视频分片之间，顺序号统一重排
 *
 * 只做盒子层搬运，不重新编码，也不碰样本表。
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

const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

/** 遍历同一层级的盒子 */
export function parseBoxes(u8, start = 0, end = u8.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = readU32(u8, p);
    const type = fourcc(u8, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = readU64(u8, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, header, size, end: p + size });
    p += size;
  }
  return out;
}

function boxBytes(u8, b) {
  return u8.subarray(b.start, b.end);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 用新负载重封一层盒子 */
function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  writeU32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** 取 moov 内的子盒子 */
function moovChildren(init) {
  const top = parseBoxes(init);
  const map = {};
  for (const b of top) if (!map[b.type]) map[b.type] = b;
  if (!map.moov) throw new Error('init 段缺少 moov');
  return { top, map, children: parseBoxes(init, map.moov.start + map.moov.header, map.moov.end) };
}

function trackIdOf(u8, trak) {
  for (const t of parseBoxes(u8, trak.start + trak.header, trak.end)) {
    if (t.type !== 'tkhd') continue;
    const base = t.start + t.header;
    return readU32(u8, base + (u8[base] === 1 ? 20 : 12));
  }
  return 0;
}

function timescaleOf(u8, trak) {
  for (const t of parseBoxes(u8, trak.start + trak.header, trak.end)) {
    if (t.type !== 'mdia') continue;
    for (const m of parseBoxes(u8, t.start + t.header, t.end)) {
      if (m.type !== 'mdhd') continue;
      const base = m.start + m.header;
      return readU32(u8, base + (u8[base] === 1 ? 20 : 12)) || 0;
    }
  }
  return 0;
}

function handlerOf(u8, trak) {
  for (const t of parseBoxes(u8, trak.start + trak.header, trak.end)) {
    if (t.type !== 'mdia') continue;
    for (const m of parseBoxes(u8, t.start + t.header, t.end)) {
      if (m.type !== 'hdlr') continue;
      return fourcc(u8, m.start + m.header + 8);
    }
  }
  return '';
}

/** 改 tkhd 里的 track_ID */
function setTrackId(u8, trak, id) {
  for (const t of parseBoxes(u8, trak.start + trak.header, trak.end)) {
    if (t.type !== 'tkhd') continue;
    const base = t.start + t.header;
    writeU32(u8, base + (u8[base] === 1 ? 20 : 12), id);
    return true;
  }
  return false;
}

/** 读 init 里所有轨道：{id, timescale, handler} */
export function listTracks(init) {
  const { children } = moovChildren(init);
  const out = [];
  for (const c of children) {
    if (c.type !== 'trak') continue;
    const id = trackIdOf(init, c);
    if (!id) continue;
    out.push({ id, timescale: timescaleOf(init, c), handler: handlerOf(init, c) });
  }
  return out;
}

/**
 * 判断一段 MP4 字节里有没有音轨。
 * Reddit 的 DASH_720.mp4 这类分轨文件只有视频轨，需要另找音轨。
 * @returns {{found:boolean, video:boolean, audio:boolean}}
 */
export function mp4TrackInfo(u8) {
  if (!u8 || u8.length < 16) return { found: false, video: false, audio: false };
  const top = parseBoxes(u8);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { found: false, video: false, audio: false };
  let video = false;
  let audio = false;
  for (const c of parseBoxes(u8, moov.start + moov.header, moov.end)) {
    if (c.type !== 'trak') continue;
    const h = handlerOf(u8, c);
    if (h === 'vide') video = true;
    else if (h === 'soun') audio = true;
  }
  return { found: true, video, audio };
}

function trackScales(init) {
  const map = new Map();
  for (const t of listTracks(init)) map.set(t.id, t.timescale);
  return map;
}

/** 从 init 的 mvex 里取出 trex 盒子（按轨道号） */
function trexMap(init) {
  const out = new Map();
  let mvex = null;
  const { children } = moovChildren(init);
  for (const c of children) if (c.type === 'mvex') mvex = c;
  if (!mvex) return out;
  for (const b of parseBoxes(init, mvex.start + mvex.header, mvex.end)) {
    if (b.type !== 'trex') continue;
    const id = readU32(init, b.start + b.header + 4);
    out.set(id, boxBytes(init, b));
  }
  return out;
}

/** 把 fMP4 拆成 init 段与分片（moof+mdat 成对） */
export function splitFmp4(u8) {
  const top = parseBoxes(u8);
  const initParts = [];
  const frags = [];
  let cur = null;
  let gotFtyp = false;
  let gotMoov = false;
  for (const b of top) {
    if (b.type === 'moof') {
      if (cur) frags.push(concat(cur));
      cur = [boxBytes(u8, b)];
    } else if (b.type === 'mdat') {
      if (cur) {
        cur.push(boxBytes(u8, b));
        frags.push(concat(cur));
        cur = null;
      }
    } else if (!cur) {
      // 只认第一份 ftyp/moov：有些转封装器每段都会重吐 init
      if (b.type === 'ftyp' && !gotFtyp) {
        gotFtyp = true;
        initParts.push(boxBytes(u8, b));
      } else if (b.type === 'moov' && !gotMoov) {
        gotMoov = true;
        initParts.push(boxBytes(u8, b));
      }
    }
  }
  if (cur) frags.push(concat(cur));
  return { init: initParts.length ? concat(initParts) : null, fragments: frags };
}

const DEFAULT_FTYP = (() => {
  const payload = new Uint8Array(16);
  const brands = ['isom', 'iso5', 'iso6', 'mp41'];
  brands.forEach((b, i) => {
    for (let j = 0; j < 4; j++) payload[i * 4 + j] = b.charCodeAt(j);
  });
  writeU32(payload, 0, 0x200); // minor_version
  return box('ftyp', payload);
})();

/**
 * 合并两个 init 段。
 * @returns {{init:Uint8Array, videoTrackIds:number[], audioTrackId:number, audioTimescales:Map<number,number>}}
 */
export function mergeInits(videoInit, audioInit) {
  if (!videoInit) throw new Error('缺少视频 init');
  if (!audioInit) throw new Error('缺少音频 init');

  const v = moovChildren(videoInit);
  const a = moovChildren(audioInit);

  const videoTracks = v.children.filter((c) => c.type === 'trak');
  const audioTracks = a.children.filter((c) => c.type === 'trak');
  if (!audioTracks.length) throw new Error('音频流里没有轨道');

  // 音频轨道号：取音视频两边最大轨道号之后，避免和视频撞号
  let maxId = 0;
  const vIds = [];
  for (const t of videoTracks) {
    const id = trackIdOf(videoInit, t);
    vIds.push(id);
    if (id > maxId) maxId = id;
  }
  const audioSrcIds = audioTracks.map((t) => trackIdOf(audioInit, t));
  for (const id of audioSrcIds) if (id > maxId) maxId = id;

  const audioMap = new Map();
  const audioScales = new Map();
  let nextId = maxId + 1;
  if (nextId < 1) nextId = 1;

  const audioTrakBytes = [];
  for (let i = 0; i < audioTracks.length; i++) {
    const t = audioTracks[i];
    const oldId = audioSrcIds[i];
    const newId = nextId++;
    const copy = boxBytes(audioInit, t).slice();
    // 副本按独立缓冲重新定位后改 tkhd 的 track_ID
    setTrackId(copy, { start: 0, header: 8, end: copy.length }, newId);
    audioMap.set(oldId, newId);
    // 轨道号变了，timescale 也记到新号上
    audioScales.set(newId, timescaleOf(audioInit, t) || 48000);
    audioTrakBytes.push(copy);
  }
  const audioTrackId = audioMap.get(audioSrcIds[0]);

  const vTrex = trexMap(videoInit);
  const aTrex = trexMap(audioInit);
  const trexBytes = [];
  for (const [, bytes] of vTrex) trexBytes.push(bytes);
  // 音频 trex：按音频源轨道号复制，逐个改成新号
  let ai = 0;
  for (const [oldId, bytes] of aTrex) {
    const newId = audioMap.get(oldId);
    if (!newId) continue;
    const copy = bytes.slice();
    writeU32(copy, 12, newId); // trex: size(4)+type(4)+version/flags(4)+track_ID(4)
    trexBytes.push(copy);
    ai++;
  }
  if (ai === 0) {
    for (const newId of audioScales.keys()) {
      const p = new Uint8Array(24);
      writeU32(p, 4, newId);
      writeU32(p, 8, 1); // default_sample_description_index
      trexBytes.push(box('trex', p));
    }
  }

  // 其余 moov 子盒子：mvhd 必须排在 trak 之前，其余原样跟在后面
  let mvhd = null;
  const keep = [];
  for (const c of v.children) {
    if (c.type === 'trak' || c.type === 'mvex') continue;
    if (c.type === 'mvhd') mvhd = boxBytes(videoInit, c);
    else keep.push(boxBytes(videoInit, c));
  }

  const moovPayloads = [];
  if (mvhd) moovPayloads.push(mvhd);
  for (const t of videoTracks) moovPayloads.push(boxBytes(videoInit, t));
  for (const t of audioTrakBytes) moovPayloads.push(t);
  moovPayloads.push(...keep);

  const mvexPayload = concat(trexBytes);
  moovPayloads.push(box('mvex', mvexPayload));

  const moov = box('moov', concat(moovPayloads));
  const ftyp = v.map.ftyp ? boxBytes(videoInit, v.map.ftyp) : DEFAULT_FTYP;

  return { init: concat([ftyp, moov]), videoTrackIds: vIds, audioTrackId, audioMap, audioTimescales: audioScales };
}

/**
 * 把字节流切成「完整的 moof+mdat 单元」。
 * 网络/录制给到的分片可能在任意位置被截断，直接按到达顺序拼接没问题，
 * 但要在分片之间插入别的音轨就必须先凑成完整单元，否则音频会落进 mdat 中间。
 * @returns {{head:Uint8Array|null, units:Uint8Array[], rest:Uint8Array}}
 */
export function splitCompleteFragments(u8) {
  const units = [];
  const empty = new Uint8Array(0);
  if (!u8 || !u8.length) return { head: null, units, rest: empty };
  const boxes = parseBoxes(u8);
  let consumed = 0;
  let headEnd = -1;
  let i = 0;
  while (i < boxes.length) {
    const b = boxes[i];
    if (b.type !== 'moof') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < boxes.length && boxes[j].type !== 'mdat' && boxes[j].type !== 'moof') j++;
    if (j >= boxes.length || boxes[j].type !== 'mdat') break;
    if (headEnd < 0) headEnd = b.start;
    units.push(u8.subarray(b.start, boxes[j].end));
    consumed = boxes[j].end;
    i = j + 1;
  }
  const head = headEnd > 0 ? u8.subarray(0, headEnd) : null;
  return { head, units, rest: u8.subarray(consumed) };
}

/** 首盒子是不是完整的 moof —— 只有这种分片才能安全改写 */
function startsWithMoof(u8) {
  if (!u8 || u8.length < 16) return false;
  if (fourcc(u8, 4) !== 'moof') return false;
  const size = readU32(u8, 0);
  return size >= 8 && size <= u8.length;
}

/** 按映射改分片里的 tfhd 轨道号（音频轨道换成合并后的号） */
export function renumberTracks(u8, map) {
  if (!map || !map.size || !startsWithMoof(u8)) return u8;
  for (const b of parseBoxes(u8)) {
    if (b.type !== 'moof') break;
    for (const traf of parseBoxes(u8, b.start + b.header, b.end)) {
      if (traf.type !== 'traf') continue;
      for (const t of parseBoxes(u8, traf.start + traf.header, traf.end)) {
        if (t.type !== 'tfhd') continue;
        const p = t.start + t.header + 4;
        const id = readU32(u8, p);
        const to = map.get(id);
        if (to) writeU32(u8, p, to);
      }
    }
  }
  return u8;
}

/** 单轨道重编号（兼容旧调用） */
export function renumberTrack(u8, from, to) {
  return renumberTracks(u8, new Map([[from, to]]));
}

/** 改分片的 mfhd 顺序号 */
export function patchSeq(u8, seq) {
  if (!startsWithMoof(u8)) return u8;
  for (const b of parseBoxes(u8)) {
    if (b.type !== 'moof') break;
    for (const m of parseBoxes(u8, b.start + b.header, b.end)) {
      if (m.type !== 'mfhd') continue;
      writeU32(u8, m.start + m.header + 4, seq);
      break;
    }
    break;
  }
  return u8;
}

/** 分片首个 tfdt 的起点（秒）；不是完整分片时返回 null */
export function fragmentStartSec(u8, scales) {
  if (!startsWithMoof(u8)) return null;
  for (const b of parseBoxes(u8)) {
    if (b.type !== 'moof') break;
    for (const traf of parseBoxes(u8, b.start + b.header, b.end)) {
      if (traf.type !== 'traf') continue;
      let trackId = 0;
      let tfdt = null;
      for (const t of parseBoxes(u8, traf.start + traf.header, traf.end)) {
        if (t.type === 'tfhd') trackId = readU32(u8, t.start + t.header + 4);
        else if (t.type === 'tfdt') tfdt = t;
      }
      if (!tfdt) continue;
      const base = tfdt.start + tfdt.header;
      const val = u8[base] === 1 ? readU64(u8, base + 4) : readU32(u8, base + 4);
      const ts = scales.get(trackId) || 90000;
      return val / ts;
    }
  }
  return null;
}

/** 分片总时长（秒），用于交错时估算视频片尾 */
export function fragmentDurationSec(u8, scales) {
  let maxEnd = 0;
  for (const b of parseBoxes(u8)) {
    if (b.type !== 'moof') continue;
    for (const traf of parseBoxes(u8, b.start + b.header, b.end)) {
      if (traf.type !== 'traf') continue;
      let trackId = 0;
      let tfdt = 0;
      for (const t of parseBoxes(u8, traf.start + traf.header, traf.end)) {
        if (t.type === 'tfhd') trackId = readU32(u8, t.start + t.header + 4);
        else if (t.type === 'tfdt') {
          const base = t.start + t.header;
          tfdt = u8[base] === 1 ? readU64(u8, base + 4) : readU32(u8, base + 4);
        }
      }
      const ts = scales.get(trackId) || 90000;
      if (tfdt / ts > maxEnd) maxEnd = tfdt / ts;
    }
  }
  return maxEnd;
}

export { trackScales };
