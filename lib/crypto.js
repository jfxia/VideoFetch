/**
 * lib/crypto.js — HLS AES-128 解密
 */

const keyCache = new Map();

export function seqToIv(seq) {
  const iv = new Uint8Array(16);
  let n = seq >>> 0;
  const hi = Math.floor(seq / 4294967296) >>> 0;
  const view = new DataView(iv.buffer);
  view.setUint32(8, hi);
  view.setUint32(12, n);
  return iv;
}

export function parseIv(ivStr, seq) {
  if (!ivStr) return seqToIv(seq);
  let s = String(ivStr).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  s = s.padStart(32, '0').slice(-32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export async function fetchKey(uri, fetchImpl) {
  if (keyCache.has(uri)) return keyCache.get(uri);
  const p = (async () => {
    const res = await fetchImpl(uri);
    if (!res.ok) throw new Error(`密钥获取失败 HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // 有些服务返回 hex 文本形式的 16 字节密钥
    if (buf.length === 32) {
      const txt = new TextDecoder().decode(buf);
      if (/^[0-9a-fA-F]{32}$/.test(txt.trim())) {
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = parseInt(txt.substr(i * 2, 2), 16);
        return out;
      }
    }
    return buf;
  })();
  keyCache.set(uri, p);
  try {
    return await p;
  } catch (e) {
    keyCache.delete(uri);
    throw e;
  }
}

export function clearKeyCache() {
  keyCache.clear();
}

/** AES-128-CBC 解密（HLS 标准：PKCS#7 填充） */
export async function decryptAes128(data, keyBytes, iv) {
  const dataU8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  // 补齐到块边界，避免个别流未做标准填充时直接失败
  const padded = dataU8.length % 16 === 0 ? dataU8 : (() => {
    const p = new Uint8Array(Math.ceil(dataU8.length / 16) * 16);
    p.set(dataU8);
    return p;
  })();

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, padded);
    return new Uint8Array(out);
  } catch (e) {
    throw new Error('AES 解密失败（密钥/IV 不匹配或非标准填充）');
  }
}
