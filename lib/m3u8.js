/**
 * lib/m3u8.js — HLS 播放列表解析
 * 支持：master/media、多码率变体、EXT-X-KEY(AES-128)、EXT-X-MAP(fMP4 init)、
 *       EXT-X-BYTERANGE、EXT-X-MEDIA-SEQUENCE、EXT-X-DISCONTINUITY、EXT-X-ENDLIST(直播判定)
 */

export function resolveUrl(uri, base) {
  if (!uri) return '';
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** 解析 `A=B,C="d,e",F=0x1` 形式属性串 */
export function parseAttrs(str) {
  const out = {};
  if (!str) return out;
  const re = /([A-Za-z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

function parseResolution(res) {
  if (!res) return null;
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(res);
  if (!m) return null;
  return { width: +m[1], height: +m[2] };
}

/** offset 为 null 表示「续上一段」，由调用方补 */
function parseByteRange(str) {
  if (!str) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(str).trim());
  if (!m) return null;
  return { length: +m[1], offset: m[2] != null ? +m[2] : null };
}

function getLines(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * 解析任意 m3u8 文本
 * @returns {{type:'master'|'media'|'invalid', variants:Array, segments:Array, targetDuration:number,
 *            mediaSequence:number, endList:boolean, hasMap:boolean, encrypted:string|null}}
 */
export function parsePlaylist(text, baseUrl) {
  const lines = getLines(text);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    return { type: 'invalid', variants: [], segments: [], endList: true, hasMap: false, encrypted: null };
  }

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  let pending = null;
  let mediaGroups = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttrs(line.slice(18));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      // 音频/字幕 rendition 的地址是相对 master 解析的
      a.uri = resolveUrl(a.URI || '', baseUrl);
      mediaGroups.push(a);
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      pending = null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) {
      const res = parseResolution(pending.RESOLUTION);
      variants.push({
        uri: resolveUrl(line, baseUrl),
        bandwidth: parseInt(pending.BANDWIDTH || '0', 10) || 0,
        averageBandwidth: parseInt(pending['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
        codecs: pending.CODECS || '',
        resolution: res,
        name: pending.NAME || '',
        audioGroup: pending.AUDIO || '',
        raw: pending
      });
      pending = null;
    }
  }

  // 按分辨率/码率降序
  variants.sort((a, b) => {
    const ah = a.resolution ? a.resolution.height : 0;
    const bh = b.resolution ? b.resolution.height : 0;
    if (bh !== ah) return bh - ah;
    return b.bandwidth - a.bandwidth;
  });

  // 为无分辨率的变体补充可读标签
  variants.forEach((v, idx) => {
    v.index = idx;
    if (!v.label) {
      v.label = v.resolution ? `${v.resolution.height}p` : (v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : `码率#${idx + 1}`);
      if (v.resolution && v.bandwidth) {
        v.label = `${v.resolution.width}x${v.resolution.height} · ${(v.bandwidth / 1000).toFixed(0)}kbps`;
      }
    }
  });

  return {
    type: 'master',
    variants,
    mediaGroups,
    segments: [],
    endList: true,
    hasMap: false,
    encrypted: null,
    targetDuration: 0
  };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  const seenKeys = new Set();
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let currentKey = null;
  let currentMap = null;
  let lastEnd = 0;
  let seq = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let pendingDiscontinuity = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice(22)) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
      seq = mediaSequence;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else if (a.KEYFORMAT && a.KEYFORMAT !== 'identity' && !/urn:uuid/.test(a.KEYFORMAT)) {
        currentKey = { method: 'UNSUPPORTED', keyFormat: a.KEYFORMAT };
      } else {
        currentKey = {
          method,
          uri: resolveUrl(a.URI, baseUrl),
          iv: a.IV || null,
          keyFormat: a.KEYFORMAT || 'identity'
        };
        if (currentKey.uri) seenKeys.add(currentKey.uri);
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const br = parseByteRange(a.BYTERANGE);
      // init 段不参与「续上一段」，缺 offset 就是文件开头
      if (br && br.offset == null) br.offset = 0;
      currentMap = { url: resolveUrl(a.URI, baseUrl), byterange: br };
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17));
      continue;
    }
    if (line.startsWith('#EXT')) continue;
    if (line.startsWith('#')) continue;

    // 片段 URI
    const url = resolveUrl(line, baseUrl);
    let byterange = pendingRange;
    if (byterange) {
      // 只有 `长度@偏移` 才给绝对偏移；只写长度时接着上一段往后排
      if (byterange.offset == null) byterange = { length: byterange.length, offset: lastEnd };
      lastEnd = byterange.offset + byterange.length;
    } else {
      lastEnd = 0; // 整文件分片：后面的 BYTERANGE 不该承接它
    }

    segments.push({
      url,
      duration: pendingDuration,
      seq: seq++,
      key: currentKey,
      map: currentMap,
      byterange,
      discontinuity: pendingDiscontinuity
    });

    pendingDuration = 0;
    pendingRange = null;
    pendingDiscontinuity = false;
  }

  let encrypted = null;
  if (segments.some((s) => s.key && s.key.method === 'AES-128')) encrypted = 'AES-128';
  if (segments.some((s) => s.key && s.key.method === 'SAMPLE-AES')) encrypted = 'SAMPLE-AES';
  if (segments.some((s) => s.key && s.key.method === 'UNSUPPORTED')) encrypted = 'UNSUPPORTED';

  return {
    type: segments.length ? 'media' : 'invalid',
    variants: [],
    segments,
    targetDuration,
    mediaSequence,
    endList,
    hasMap: segments.some((s) => !!s.map),
    encrypted,
    keys: [...seenKeys]
  };
}

/** 从 media playlist 估算总时长（秒） */
export function totalDuration(playlist) {
  return (playlist.segments || []).reduce((a, s) => a + (s.duration || 0), 0);
}
