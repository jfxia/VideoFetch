/**
 * offscreen/engine.js — 下载引擎
 *
 * 职责：分片并发下载 / AES-128 解密 / TS→fMP4 转封装 / 直播轮询 / 合并落盘 / 触发保存
 * 运行在 offscreen document（有 DOM、Blob、OPFS、WebCrypto 的环境）
 */
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';
import { splitFmp4, mp4TrackInfo, listTracks } from '../lib/mp4merge.js';
import { patchInitDuration } from '../lib/mp4time.js';
import { fetchKey, decryptAes128, parseIv, clearKeyCache } from '../lib/crypto.js';
import { ChunkStore, cleanupAllTemp } from '../lib/store.js';
import { getSave, subPath } from '../lib/settings.js';
import { loadDirHandle, permState, writeBlobTo } from '../lib/fsdir.js';

const sessions = new Map(); // taskId -> ctl
const DEFAULT_CONCURRENCY = 8;
/** 暂停时的收尾上限：在途请求最多再等这么久，超时直接丢弃（续传重下） */
const DRAIN_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 防盗链用的 Referer：按主机登记，同主机优先，取不到退回最近一次 */
const REF = { byHost: new Map(), last: '' };

function setReferer(url, referer) {
  if (!referer) return;
  REF.last = referer;
  try {
    REF.byHost.set(new URL(url).host, referer);
  } catch {}
}

function refererFor(url) {
  try {
    return REF.byHost.get(new URL(url).host) || REF.last || '';
  } catch {
    return REF.last || '';
  }
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

function sendMsg(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function report(ctl, patch) {
  Object.assign(ctl.task, patch);
  sendMsg({ target: 'sw', type: 'task-update', task: { ...ctl.task } });
}

let lastTick = 0;
function reportProgress(ctl, patch, force) {
  // 暂停中：数字继续在内部校准（好让「已暂停」报的是真实进度），但不再推给界面。
  // 否则用户点了暂停还在看着分段数往上跳，观感就是「没停下来」。
  if (ctl.pauseReq && !ctl.stop) {
    Object.assign(ctl.task, patch);
    return;
  }
  const now = Date.now();
  if (!force && now - lastTick < 450) return;
  lastTick = now;
  Object.assign(ctl.task, patch);
  sendMsg({ target: 'sw', type: 'task-update', task: { ...ctl.task } });
}

function tickSpeed(ctl, received) {
  const now = Date.now();
  if (!ctl.meter) ctl.meter = { t: now, b: received, speed: 0 };
  const dt = (now - ctl.meter.t) / 1000;
  if (dt >= 1) {
    const inst = (received - ctl.meter.b) / dt;
    ctl.meter.speed = ctl.meter.speed ? ctl.meter.speed * 0.4 + inst * 0.6 : inst;
    ctl.meter.t = now;
    ctl.meter.b = received;
  }
  return Math.max(0, Math.round(ctl.meter.speed));
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

function isAbort(e) {
  return !!e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
}

const sig = (ctl) => (ctl && ctl.ab ? ctl.ab.signal : undefined);

/**
 * 暂停/保存时给在途请求留一点收尾时间，超时就掐断。
 * 不掐的话，一条卡住的连接会让「暂停」等上几十秒，用户看着就是「点了没反应」。
 */
function armAbort(ctl, ms = 400) {
  const ab = ctl && ctl.ab;
  if (!ab) return;
  clearTimeout(ctl.abTimer);
  ctl.abTimer = setTimeout(() => {
    if (ctl.ab === ab && !ab.signal.aborted) {
      try {
        ab.abort();
      } catch {}
    }
  }, ms);
}

function disarmAbort(ctl) {
  if (!ctl) return;
  clearTimeout(ctl.abTimer);
  ctl.abTimer = null;
}

async function httpGet(url, opts = {}) {
  const { signal, ...rest } = opts;
  const base = { method: 'GET', cache: 'no-store', ...rest };
  if (signal) base.signal = signal;
  // Referer 是 fetch 的禁止头，写在 headers 里会被丢掉；
  // 只能走 referrer 选项，且跨站时浏览器只保留 origin。
  const ref = refererFor(url);
  if (ref && !base.referrer) {
    base.referrer = ref;
    base.referrerPolicy = 'strict-origin-when-cross-origin';
  }
  let res;
  try {
    res = await fetch(url, { ...base, credentials: 'include' });
  } catch (e) {
    // 暂停掐断的请求别再换凭据重试一遍
    if (isAbort(e)) throw e;
    res = await fetch(url, { ...base, credentials: 'omit' });
  }
  if (res.ok || res.status === 206) return res;
  if (res.status === 401 || res.status === 403) {
    try {
      const r2 = await fetch(url, { ...base, credentials: 'omit' });
      if (r2.ok || r2.status === 206) return r2;
    } catch (e) {
      if (isAbort(e)) throw e;
    }
  }
  if (res.status === 403 || res.status === 401) {
    throw new Error(`HTTP ${res.status}（站点启用了防盗链，扩展没能提供正确的来源）`);
  }
  throw new Error(`HTTP ${res.status}`);
}

async function loadPlaylist(url, referer, signal) {
  const res = await httpGet(url, { headers: { Accept: '*/*' }, signal });
  const text = await res.text();
  const pl = parsePlaylist(text, url);
  if (pl.type === 'invalid') {
    throw new Error('播放列表解析失败：' + text.slice(0, 60).replace(/\s+/g, ' '));
  }
  return pl;
}

async function fetchSegment(seg, ctl) {
  const log = (ctl && ctl.log) || (() => {});
  const signal = ctl && ctl.ab ? ctl.ab.signal : undefined;
  const headers = {};
  if (seg.byterange) {
    headers.Range = `bytes=${seg.byterange.offset}-${seg.byterange.offset + seg.byterange.length - 1}`;
  }
  const res = await httpGet(seg.url, { headers, signal });
  let buf = new Uint8Array(await res.arrayBuffer());
  // 服务端/代理忽略 Range 时回整文件，需自行截取，否则会拼出重复数据
  if (seg.byterange && res.status !== 206 && buf.length > seg.byterange.length) {
    buf = buf.subarray(seg.byterange.offset, seg.byterange.offset + seg.byterange.length);
  }
  if (seg.key && seg.key.method === 'AES-128') {
    if (!seg.key.uri) throw new Error('AES-128 密钥地址缺失');
    const kb = await fetchKey(seg.key.uri, (u) => httpGet(u, { signal }));
    const iv = parseIv(seg.key.iv, seg.seq);
    buf = await decryptAes128(buf, kb, iv);
  } else if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
    throw new Error('不支持的加密方式：' + seg.key.method);
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* 顺序并发池：并发下载 + 严格按序交付                                    */
/* ------------------------------------------------------------------ */

/**
 * 顺序并发池：并发下载 + 严格按序交付
 *
 * opts.drain：收到停止信号后不再发新请求，但把「已经在路上的」那几块交付完再退出。
 * 暂停要用 drain（丢掉的块纯属浪费），取消要立即断（drain=false）。
 * opts.drainMs：drain 的时间上限，超过就丢掉没交付的块（续传时重下，不会错位）。
 * opts.onIdle：把「叫醒等待」的函数交给调用方——暂停时直接叫醒，
 *   否则主循环要等到下一块下载完才会看见停止信号，慢链路上就是「点了暂停还在下」。
 */
async function runOrdered(items, worker, concurrency, onItem, shouldStop, opts) {
  const drain = !!(opts && opts.drain);
  const drainMs = opts && opts.drainMs != null ? opts.drainMs : 1500;
  const results = new Map();
  // 预取窗口：已完成但还没交付的分片最多压在手上几个。
  // 不设上限的话，下载比「转封装 + 写盘」快时结果会无限堆积，
  // 内存一路涨，暂停时还得把这一大堆慢慢写完才肯停。
  const window = concurrency + 2;
  let nextFetch = 0;
  let cursor = 0;
  let inFlight = 0;
  let wake = null;
  let fatal = null;
  let halted = false;
  let haltAt = 0;

  const poke = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const fill = () => {
    if (halted) return;
    while (inFlight < concurrency && nextFetch < items.length && nextFetch - cursor < window) {
      const idx = nextFetch++;
      inFlight++;
      Promise.resolve()
        .then(() => worker(items[idx], idx))
        .then(
          (v) => results.set(idx, { v }),
          (e) => {
            // 被暂停掐断的请求不算失败，也不交付：续传时这一段会重新下
            if (isAbort(e) && shouldStop && shouldStop()) {
              results.set(idx, { aborted: true });
              return;
            }
            results.set(idx, { e });
            if (/401|403|404/.test(String(e && e.message))) fatal = e;
          }
        )
        .finally(() => {
          inFlight--;
          fill();
          poke();
        });
    }
  };

  // 已经收到停止信号就别再发新请求（暂停常常正好发生在开跑前一瞬）
  if (!(shouldStop && shouldStop())) fill();
  while (cursor < items.length) {
    if (!halted && shouldStop && shouldStop()) {
      halted = true;
      haltAt = Date.now();
      if (!drain) break;
    }
    if (results.has(cursor)) {
      const r = results.get(cursor);
      results.delete(cursor);
      const idx = cursor;
      cursor++;
      fill();
      if (r.aborted) continue;
      if (r.e) {
        if (fatal) throw fatal;
        throw r.e;
      }
      await onItem(r.v, idx);
      continue;
    }
    // 已发出的都交付完了，剩下的不再发起
    if (halted && cursor >= nextFetch) break;
    if (inFlight === 0 && nextFetch >= items.length) break;
    // drain 超时：没交付的块不再等（游标没前进，续传会重下，不会错位）
    if (halted && Date.now() - haltAt > drainMs) break;
    await new Promise((res) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (wake === fire) wake = null;
        res();
      };
      const left = halted ? Math.max(0, drainMs - (Date.now() - haltAt)) : 0;
      const timer = halted ? setTimeout(fire, left) : null;
      wake = fire;
      if (opts && opts.onIdle) opts.onIdle(fire);
    });
  }
}

/* ------------------------------------------------------------------ */
/* 暂停 / 继续的控制流                                                  */
/* ------------------------------------------------------------------ */

/**
 * 暂停不是失败：用独立错误把控制流从流水线里带出来，交回 drive()，
 * 这样已经写进临时存储的数据不会被 finalize 掉，也不会被当成出错。
 */
class PauseSignal extends Error {
  constructor() {
    super('paused');
    this.pause = true;
  }
}

function stopNow(ctl) {
  return ctl.stop || ctl.pauseReq;
}

/** 暂停要把已发出的分片收完（drain）；取消/保存要立刻断 */
function stopOpts(ctl) {
  return {
    drain: !ctl.stop,
    drainMs: DRAIN_MS,
    // 暂停时直接叫醒等待中的交付循环：不用等下一块下载完才看见停止信号
    onIdle: (wake) => {
      ctl.idleWake = wake;
    }
  };
}

/** 叫醒交付循环（如果它正卡在等分片） */
function wakeIdle(ctl) {
  const fn = ctl && ctl.idleWake;
  ctl.idleWake = null;
  if (fn) {
    try {
      fn();
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 装配落地                                                            */
/* ------------------------------------------------------------------ */

async function flushAsm(ctl, final) {
  const out = ctl.asm.drain(final);
  for (const u8 of out) {
    await ctl.store.append(u8);
  }
}

/** 下载并推入 EXT-X-MAP 指定的 init 段（fMP4 的 moov 都在这段里） */
async function fetchMapInit(ctl, pl) {
  const host = pl.segments.find((s) => s.map);
  if (!host) return null;
  const m = host.map;
  const buf = await fetchSegment({ url: m.url, byterange: m.byterange, key: null, seq: 0 }, ctl);
  return buf;
}

async function pushMapSegment(ctl, pl) {
  if (!pl.segments.find((s) => s.map)) return;
  try {
    const buf = await fetchMapInit(ctl, pl);
    if (!buf) return;
    await ctl.asm.push(buf, { isInit: true });
    await flushAsm(ctl);
    ctl.mapDone = true;
  } catch (e) {
    ctl.log('init 段下载失败：' + e.message, 'warn');
  }
}

/** 档位短标签：优先「1080p」，竖屏取短边 */
function shortLabel(v) {
  const r = v && v.resolution;
  if (r && r.width && r.height) return Math.min(r.width, r.height) + 'p';
  return (v && v.label) || '';
}

/**
 * 找该档位对应的独立音轨。
 * HLS 把音频单独放一条 rendition 时，视频 playlist 里没有音轨，
 * 必须按 master 的 AUDIO 组把音频播放列表也下载下来，否则成片无声。
 */
function audioUriFor(masterPl, variant) {
  if (!masterPl || !variant || !variant.audioGroup) return '';
  const groups = masterPl.mediaGroups || [];
  const hit = groups.find(
    (m) =>
      String(m.TYPE || '').toUpperCase() === 'AUDIO' &&
      m['GROUP-ID'] === variant.audioGroup &&
      m.uri
  );
  return hit ? hit.uri : '';
}

/** 下载整条独立音轨，转封装后拆出 init 与分片，供装配器交错合并 */
async function assembleAudioTrack(ctl, uri) {
  let pl = await loadPlaylist(uri, ctl.task.pageUrl, sig(ctl));
  if (pl.type === 'master') {
    const v = pl.variants && pl.variants[0];
    if (!v) return null;
    pl = await loadPlaylist(v.uri, ctl.task.pageUrl, sig(ctl));
  }
  if (pl.type !== 'media' || !pl.segments || !pl.segments.length) return null;
  if (!pl.endList) return { live: true };

  const planned = pl.segments.reduce((a, s) => a + (s.duration || 0), 0);
  const asm = new Assembler(ctl.log, null, planned);
  const chunks = [];
  let bytes = 0;

  reportProgress(ctl, { audio: 'pulling' }, true);

  // 音轨的 moov 在 EXT-X-MAP 指向的 init 段里，不先喂进去，分片拆不出轨道表
  if (pl.hasMap) {
    const init = await fetchMapInit(ctl, pl);
    if (init) {
      await asm.push(init, { isInit: true });
      for (const c of asm.drain()) chunks.push(c);
    }
  }

  await runOrdered(
    pl.segments,
    (seg) => fetchSegment(seg, ctl),
    Math.min(4, ctl.concurrency),
    async (buf) => {
      await asm.push(buf, {});
      for (const c of asm.drain()) chunks.push(c);
      bytes += buf.byteLength;
    },
    () => stopNow(ctl),
    stopOpts(ctl)
  );

  let n = 0;
  for (const c of chunks) n += c.length;
  if (!n) return null;
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const { init, fragments } = splitFmp4(all);
  if (!init) {
    ctl.log('音轨流出里没有 moov（init 段缺失），无法合并', 'warn');
    return null;
  }
  if (!fragments.length) {
    ctl.log('音轨流没有可用分片，无法合并', 'warn');
    return null;
  }
  return { init, fragments, bytes };
}

function pickVariant(pl, index, uri, wantHeight) {
  if (!pl.variants || !pl.variants.length) return null;
  // 优先按 URI 精确匹配：即使 master 顺序变了也不会错档
  if (uri) {
    const hit = pl.variants.find((v) => v.uri === uri);
    if (hit) return hit;
  }
  // 按目标清晰度挑选（直链转 HLS 时用）
  if (wantHeight) {
    let best = null;
    let bestDiff = Infinity;
    for (const v of pl.variants) {
      const r = v.resolution;
      const h = r ? Math.min(r.width || 0, r.height || 0) : 0;
      if (!h) continue;
      const d = Math.abs(h - wantHeight);
      if (d < bestDiff) {
        bestDiff = d;
        best = v;
      }
    }
    if (best) return best;
  }
  if (index != null && pl.variants[index]) return pl.variants[index];
  return pl.variants[0];
}

/** 只读取开头一小段，用于判断 MP4 是否含音轨 */
async function readHead(url, n, signal) {
  const res = await httpGet(url, { headers: { Range: `bytes=0-${n - 1}` }, signal });
  if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (got >= n) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }
  const out = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return out;
}

/**
 * 分轨直链（如 Reddit 的 DASH_720.mp4）只有画面没有声音。
 * 检测到这种情况就改走同一视频的 HLS，音轨由 HLS 那一路补回来。
 */
async function maybeSwitchToHls(ctl) {
  const task = ctl.task;
  const m = /\/DASH[_A-Za-z0-9-]*?(\d{3,4})p?\.mp4(?:[?#]|$)/i.exec(task.url) || /\/DASH[^/]*\.mp4(?:[?#]|$)/i.exec(task.url);
  if (!m) return;

  let info;
  try {
    info = mp4TrackInfo(await readHead(task.url, 512 * 1024, sig(ctl)));
  } catch (e) {
    if (isAbort(e)) throw new PauseSignal();
    return;
  }
  if (!info.found || info.audio) return;

  const u = new URL(task.url);
  const alt = u.origin + u.pathname.replace(/[^/]*$/, '') + 'HLSPlaylist.m3u8';
  try {
    const p = await loadPlaylist(alt, task.pageUrl, sig(ctl));
    if (p.type !== 'master' && p.type !== 'media') throw new Error('不是播放列表');
  } catch (e) {
    if (isAbort(e)) throw new PauseSignal();
    ctl.log('该直链只含画面没有音轨，且没有可用的 HLS 版本', 'warn');
    return;
  }

  task.url = alt;
  task.kind = 'hls';
  task.wantHeight = m[1] ? parseInt(m[1], 10) : 0;
  ctl.log('该直链不含音轨，改走同一视频的 HLS 流以保留声音');
}

/* ------------------------------------------------------------------ */
/* HLS 点播                                                            */
/* ------------------------------------------------------------------ */

async function runVod(ctl, pl, from) {
  const segs = pl.segments;
  const total = segs.length;
  const first = Math.max(0, Math.min(from || 0, total));
  const concurrency = ctl.concurrency;
  let startTime = ctl.vodTime || 0;
  let received = ctl.vodBytes || 0;

  ctl.vodCursor = first;
  reportProgress(
    ctl,
    { status: 'running', segmentsTotal: total, segmentsDone: first, received, progress: Math.round((first / total) * 100) },
    true
  );

  if (pl.hasMap && !ctl.mapDone) await pushMapSegment(ctl, pl);

  await runOrdered(
    segs.slice(first),
    (seg) => fetchSegment(seg, ctl),
    concurrency,
    async (buf, i) => {
      const idx = first + i;
      const seg = segs[idx];
      await ctl.asm.push(buf, { startTime });
      startTime += seg.duration || 0;
      await flushAsm(ctl);
      received += buf.byteLength;
      // 断点位点：继续时从下一段接着下，不重复拉已经落盘的分片
      ctl.vodCursor = idx + 1;
      ctl.vodTime = startTime;
      ctl.vodBytes = received;
      reportProgress(ctl, {
        received,
        progress: Math.min(99, Math.round(((idx + 1) / total) * 100)),
        segmentsDone: idx + 1,
        segmentsTotal: total,
        speed: tickSpeed(ctl, received)
      });
    },
    () => stopNow(ctl),
    stopOpts(ctl)
  );

  // 用户点暂停就停在这；但如果刚好最后一段也下完了，就别停在 99% 的「已暂停」上
  if (ctl.pauseReq && !ctl.stop && (ctl.vodCursor || 0) < total) throw new PauseSignal();
}

/* ------------------------------------------------------------------ */
/* HLS 直播                                                            */
/* ------------------------------------------------------------------ */

/** 直播轮询之间的等待：暂停/取消要能立刻打断，不用等满一个周期 */
async function sleepUnless(ms, fn) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(Math.min(200, ms - (Date.now() - t0)));
  }
}

async function runLive(ctl, playlistUrl, firstPl) {
  const seen = ctl.liveSeen || (ctl.liveSeen = new Set());
  const concurrency = Math.min(4, ctl.concurrency);
  let startTime = ctl.liveTime || 0;
  let received = ctl.liveBytes || 0;
  let pl = firstPl || ctl.hlsPl || null;
  let rounds = 0;

  ctl.phase = 'hls-live';
  ctl.partialOk = true;
  reportProgress(ctl, { status: 'running', live: true, progress: -1, segmentsDone: seen.size }, true);

  while (!stopNow(ctl)) {
    if (rounds > 0 || !pl) {
      try {
        pl = await loadPlaylist(playlistUrl, ctl.task.pageUrl, sig(ctl));
      } catch (e) {
        ctl.log('直播列表刷新失败，重试：' + e.message, 'warn');
        await sleepUnless(1500, () => stopNow(ctl));
        rounds++;
        continue;
      }
    }
    rounds++;

    if (pl.hasMap && !ctl.mapDone) await pushMapSegment(ctl, pl);

    const fresh = pl.segments.filter((s) => !seen.has(s.seq + '|' + s.url));
    for (const s of fresh) seen.add(s.seq + '|' + s.url);

    if (fresh.length) {
      await runOrdered(
        fresh,
        (seg) => fetchSegment(seg, ctl),
        concurrency,
        async (buf, idx) => {
          await ctl.asm.push(buf, { startTime });
          startTime += fresh[idx].duration || 0;
          await flushAsm(ctl);
          received += buf.byteLength;
          ctl.liveTime = startTime;
          ctl.liveBytes = received;
          reportProgress(
            ctl,
            { received, progress: -1, live: true, segmentsDone: seen.size, speed: tickSpeed(ctl, received) },
            true
          );
        },
        () => stopNow(ctl),
        stopOpts(ctl)
      );
    }

    if (stopNow(ctl)) break;
    const wait = Math.max(1200, Math.round((pl.targetDuration || 4) * 350));
    await sleepUnless(wait, () => stopNow(ctl));
  }

  if (ctl.pauseReq && !ctl.stop) throw new PauseSignal();
}

/* ------------------------------------------------------------------ */
/* 直链文件（MP4 / WEBM / MP3 …）                                       */
/* ------------------------------------------------------------------ */

const SEG_SIZE = 4 * 1024 * 1024;

async function runFile(ctl) {
  const task = ctl.task;
  const url = task.url;
  const concurrency = ctl.concurrency;

  ctl.phase = 'file';

  if (!ctl.store) {
    ctl.store = new ChunkStore();
    await ctl.store.init();
  }

  // 探测只做一次：续传时沿用首次拿到的长度与 Range 能力
  if (!ctl.fileProbed) {
    let size = 0;
    let ranges = false;
    try {
      const probe = await fetch(url, {
        headers: { Range: 'bytes=0-1' },
        credentials: 'include',
        cache: 'no-store',
        signal: sig(ctl)
      });
      if (probe.status === 206) {
        ranges = true;
        const cr = probe.headers.get('content-range') || '';
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
      } else if (probe.ok) {
        size = parseInt(probe.headers.get('content-length') || '0', 10) || 0;
        ranges = /bytes/i.test(probe.headers.get('accept-ranges') || '');
      }
    } catch (e) {
      if (isAbort(e)) throw new PauseSignal();
      ctl.log('文件探测失败，直接流式下载：' + e.message, 'warn');
    }
    ctl.fileSize = size;
    ctl.fileRanges = ranges;
    ctl.fileProbed = true;
  }

  const size = ctl.fileSize || 0;
  const ranges = !!ctl.fileRanges;
  let received = ctl.fileBytes || 0;

  reportProgress(
    ctl,
    {
      status: 'running',
      total: size,
      received,
      progress: size ? Math.min(99, Math.round((received / size) * 100)) : received ? -1 : 0
    },
    true
  );

  if (ranges && size > SEG_SIZE * 2) {
    const n = Math.ceil(size / SEG_SIZE);
    const from = Math.min(ctl.fileSeg || 0, n);
    const idxs = [];
    for (let i = from; i < n; i++) idxs.push(i);
    ctl.fileSeg = from;
    await runOrdered(
      idxs,
      async (i) => {
        const start = i * SEG_SIZE;
        const end = Math.min(size - 1, start + SEG_SIZE - 1);
        const res = await httpGet(url, { headers: { Range: `bytes=${start}-${end}` }, signal: sig(ctl) });
        return new Uint8Array(await res.arrayBuffer());
      },
      concurrency,
      async (buf, k) => {
        await ctl.store.append(buf);
        received += buf.byteLength;
        // 断点位点：按下标记，继续时跳过已落盘的分块
        ctl.fileSeg = from + k + 1;
        ctl.fileBytes = received;
        reportProgress(ctl, {
          received,
          progress: Math.min(99, Math.round((received / size) * 100)),
          speed: tickSpeed(ctl, received)
        });
      },
      () => stopNow(ctl),
      stopOpts(ctl)
    );
    if (ctl.pauseReq && !ctl.stop && (ctl.fileSeg || 0) < n) throw new PauseSignal();
  } else {
    // 流式：能带上 Range 就从已下载的位置续，不能就只能从头再来
    const headers = received > 0 ? { Range: `bytes=${received}-` } : {};
    let res;
    try {
      res = await httpGet(url, { headers, signal: sig(ctl) });
    } catch (e) {
      if (isAbort(e)) throw new PauseSignal();
      throw e;
    }
    if (received > 0 && res.status !== 206) {
      ctl.log('服务器不支持断点续传，从头重新下载', 'warn');
      await ctl.store.reset();
      received = 0;
      ctl.fileBytes = 0;
    }
    if (!size) {
      size = received + (parseInt(res.headers.get('content-length') || '0', 10) || 0);
      ctl.fileSize = size;
    }
    const reader = res.body.getReader();
    while (true) {
      if (ctl.stop) {
        try {
          await reader.cancel();
        } catch (e) {}
        throw new Error('已取消');
      }
      if (ctl.pauseReq) {
        try {
          await reader.cancel();
        } catch (e) {}
        break;
      }
      const { done, value } = await reader.read().catch((e) => {
        // 暂停把连接掐了：不是失败，是「先停在这儿」
        if (isAbort(e)) throw ctl.stop ? new Error('已取消') : new PauseSignal();
        throw e;
      });
      if (done) break;
      const u8 = new Uint8Array(value);
      await ctl.store.append(u8);
      received += u8.byteLength;
      ctl.fileBytes = received;
      reportProgress(ctl, {
        received,
        total: size || received,
        progress: size ? Math.min(99, Math.round((received / size) * 100)) : -1,
        speed: tickSpeed(ctl, received)
      });
    }
    if (ctl.pauseReq && !ctl.stop) throw new PauseSignal();
  }

  ctl.task.fileExt = guessExt(url, ctl.task.mime);
}

/** 文件名里带 audio 的（CMAF_AUDIO_128.mp4）其实是纯音轨 */
function isAudioName(u) {
  let base = '';
  try {
    base = new URL(u).pathname.split('/').pop() || '';
  } catch (e) {
    base = String(u || '').split('?')[0].split('/').pop() || '';
  }
  return /(?:^|[_.-])audio(?:[_.-]|$)/i.test(base) && !/video/i.test(base);
}

function guessExt(url, mime) {
  const s = String(url || '');
  const m = /\.(mp4|m4v|webm|mkv|mov|flv|mp3|m4a|aac|ogg|opus|wav|ts)(?:[?#]|$)/i.exec(s);
  if (m) {
    const ext = m[1].toLowerCase();
    if ((ext === 'mp4' || ext === 'm4v') && isAudioName(s)) return 'm4a';
    return ext;
  }
  const t = String(mime || '').toLowerCase();
  if (/webm/.test(t)) return 'webm';
  if (/matroska/.test(t)) return 'mkv';
  if (/mpeg/.test(t) && /audio/.test(t)) return 'mp3';
  if (/audio\/mp4|m4a/.test(t)) return 'm4a';
  if (/aac/.test(t)) return 'aac';
  if (/ogg|opus/.test(t)) return 'ogg';
  if (/wav/.test(t)) return 'wav';
  if (/^audio\//.test(t)) return 'm4a';
  return 'mp4';
}

/* ------------------------------------------------------------------ */
/* blob / MediaSource 录制搬运                                          */
/* ------------------------------------------------------------------ */

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function findSessionByRec(recId) {
  for (const ctl of sessions.values()) {
    if (ctl.task.recId === recId) return ctl;
  }
  return null;
}

async function runBlob(ctl) {
  ctl.store = new ChunkStore();
  await ctl.store.init();
  ctl.asm = new Assembler(ctl.log, null, 0);
  ctl.chain = Promise.resolve();

  reportProgress(ctl, { status: 'running', progress: -1 }, true);

  // MSE 站点常把音视频塞进两条 SourceBuffer，只搬最大的那条必然丢声音
  let buckets = [];
  try {
    const info = await sendMsg({
      target: 'sw',
      type: 'blob-info',
      tabId: ctl.task.tabId,
      frameId: ctl.task.frameId || 0,
      recId: ctl.task.recId
    });
    if (info && info.ok && info.info && info.info.buckets) buckets = info.info.buckets;
  } catch {}

  const tag = (b) => String(b.mime || '').toLowerCase();
  const isAudio = (b) => /^audio\//.test(tag(b)) || /mp4a|opus|vorbis|ac-3|ec-3/.test(tag(b));
  const isVideo = (b) => /^video\//.test(tag(b)) || /avc1|hvc1|hev1|vp0?8|vp0?9|av01/.test(tag(b));
  const audioB = buckets.find((b) => b.bytes > 0 && isAudio(b) && !isVideo(b)) || null;
  const videoB = buckets.find((b) => b.bytes > 0 && isVideo(b)) || null;

  if (audioB && videoB) {
    try {
      ctl.dumpTarget = 'audio';
      ctl.audioAsm = new Assembler(ctl.log, null, 0);
      ctl.audioChunks = [];
      await requestDump(ctl, audioB.key);

      let n = 0;
      for (const c of ctl.audioChunks) n += c.length;
      if (n > 0) {
        const all = new Uint8Array(n);
        let o = 0;
        for (const c of ctl.audioChunks) {
          all.set(c, o);
          o += c.length;
        }
        const { init, fragments } = splitFmp4(all);
        if (init && fragments.length && ctl.asm.setAudioTrack({ init, fragments })) {
          ctl.log('已收集录制中的独立音轨 ' + Math.round(n / 1024) + 'KB');
        }
      }
    } catch (e) {
      ctl.log('音轨缓冲搬运失败，仅导出视频轨：' + (e && e.message ? e.message : e), 'warn');
    } finally {
      ctl.audioAsm = null;
      ctl.audioChunks = null;
    }
  }

  ctl.dumpTarget = 'video';
  await requestDump(ctl, videoB ? videoB.key : undefined);
}

/** 让页面把指定缓冲（或最大的那条）搬过来，等到 done 为止 */
async function requestDump(ctl, bucket) {
  ctl.recDone = false;
  ctl.recError = null;
  const r = await sendMsg({
    target: 'sw',
    type: 'request-dump',
    tabId: ctl.task.tabId,
    frameId: ctl.task.frameId || 0,
    recId: ctl.task.recId,
    bucket: bucket == null ? undefined : bucket
  });
  if (r && r.ok === false) throw new Error(r.error || '页面无法提供录制数据');

  const t0 = Date.now();
  while (!ctl.recDone && !ctl.stop) {
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('录制数据搬运超时');
    await sleep(120);
  }
  await ctl.chain;
  if (ctl.recError) throw new Error(ctl.recError);
}

function onRecChunk(data) {
  const ctl = findSessionByRec(data.recId);
  if (!ctl) return;
  ctl.chain = ctl
    .chain
    .then(async () => {
      if (data.error) {
        ctl.recError = data.error;
        ctl.recDone = true;
        return;
      }
      if (data.done) {
        ctl.recDone = true;
        if (data.mime) ctl.recMime = data.mime;
        return;
      }
      if (!data.b64) return;
      const u8 = b64ToU8(data.b64);
      const toAudio = ctl.dumpTarget === 'audio' && ctl.audioAsm;
      const target = toAudio ? ctl.audioAsm : ctl.asm;
      await target.push(u8, {});
      const out = target.drain();
      if (toAudio) {
        for (const c of out) ctl.audioChunks.push(c);
      } else {
        for (const c of out) await ctl.store.append(c);
      }
      ctl.recBytes = (ctl.recBytes || 0) + u8.byteLength;
      reportProgress(ctl, { received: ctl.recBytes, progress: -1, live: true });
    })
    .catch((e) => {
      ctl.recError = String((e && e.message) || e);
      ctl.recDone = true;
    });
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

/**
 * 只生成文件名本身，不带目录：目录由「保存位置」设置决定
 * （浏览器的下载目录 + 子目录，或者用户自己选的文件夹）。
 */
function buildFilename(task, ext, tag) {
  let base = (task.title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  if (!base) base = 'video';
  if (base.length > 90) base = base.slice(0, 90);
  if (!new RegExp('\\.' + ext + '$', 'i').test(base)) base += '.' + ext;
  // 快照文件名要能和完整版区分开：xxx (40%).mp4
  // 不用中文标记：文件名跨语言，界面语言一变就不好认
  if (tag) base = base.replace(new RegExp('\\.' + ext + '$', 'i'), tag + '.' + ext);
  return base;
}

/**
 * 成片里到底有哪些轨道。
 * TS 路线看 mux.js 给出的类型，fMP4 路线直接读 init 里的 trak handler。
 */
function trackKinds(asm) {
  const st = (asm && asm.stats) || {};
  let video = !!st.video;
  let audio = !!st.audio || !!st.audioMerged;
  if (asm && asm.initRef) {
    try {
      const ts = listTracks(asm.initRef);
      video = video || ts.some((t) => t.handler === 'vide');
      audio = audio || ts.some((t) => t.handler === 'soun');
    } catch {}
  }
  return { video, audio };
}

function detectAudio(asm) {
  return trackKinds(asm).audio;
}

/**
 * 落盘。两条路：
 *   downloads —— chrome.downloads，文件名带子目录（只能落在浏览器下载目录里）
 *   dir       —— 用户在设置里选的文件夹，直接 createWritable 写进去
 * 自定义文件夹不可用（句柄丢了 / 权限被撤）时退回 downloads，并把原因带回去让卡片说明。
 */
async function saveBlob(ctl, blob, ext, tag) {
  const name = buildFilename(ctl.task, ext, tag);
  const save = await getSave();

  if (save.mode === 'dir') {
    let why = '';
    try {
      const dir = await loadDirHandle();
      if (!dir) why = 'no-handle';
      else if ((await permState(dir)) !== 'granted') why = 'no-perm';
      else {
        const finalName = await writeBlobTo(dir, name, blob);
        ctl.log('已写入自定义文件夹「' + (dir.name || '') + '」：' + finalName);
        return { filename: finalName, downloadId: null, savedTo: 'dir', dirName: dir.name || '', saveWarn: '' };
      }
    } catch (e) {
      why = String((e && e.message) || e) || 'write-failed';
    }
    ctl.log('自定义文件夹不可用（' + why + '），改存到浏览器下载目录', 'warn');
    return saveToDownloads(ctl, blob, name, save, why);
  }

  return saveToDownloads(ctl, blob, name, save, '');
}

async function saveToDownloads(ctl, blob, name, save, saveWarn) {
  const filename = subPath(save.sub) + name;
  const objUrl = URL.createObjectURL(blob);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({ url: objUrl, filename, saveAs: false });
  } catch (e) {
    // 兜底：在 offscreen 里构造 <a download> 触发
    try {
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e2) {
      throw new Error('保存失败：' + (e && e.message ? e.message : e));
    }
  }
  setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
  return { filename, downloadId, savedTo: 'downloads', dirName: '', saveWarn: saveWarn || '' };
}

/**
 * 按已下到哪儿改写 moov 里的时长。
 * 不改的话播放器会以为后面还有内容，进度条走到一半就卡住；
 * 反过来，中途保存过快照之后再下完，也得按全长改回来。
 */
async function patchHeadDuration(ctl, sec) {
  const ref = ctl.asm && ctl.asm.initRef;
  if (!ref || !ctl.store) return;
  if (!(sec > 0.2)) return;
  try {
    const copy = new Uint8Array(ref);
    patchInitDuration(copy, sec);
    if (await ctl.store.patchHead(copy)) {
      ctl.headPatched = sec;
      ctl.log('已把成片时长改成实际下载到的 ' + sec.toFixed(1) + ' 秒');
    }
  } catch (e) {}
}

/**
 * 把临时存储里的数据取成 Blob。
 * snapshot=true 时走 store.snapshotBlob()：拿到的是一份独立副本，
 * 任务继续下载不会污染已经交给浏览器的那份文件。
 */
async function collectOutput(ctl, snapshot) {
  const task = ctl.task;
  const read = async (store, mime) => {
    if (!store) return null;
    return snapshot && store.snapshotBlob ? store.snapshotBlob(mime) : store.toBlob(mime);
  };

  let blob;
  let ext;

  if (ctl.asm && ctl.asm.mode === 'ts' && (ctl.asm.remuxFailed || ctl.asm.produced === 0)) {
    ext = 'ts';
    const src = ctl.asm.rawStore || null;
    blob = src ? await read(src, 'video/mp2t') : await read(ctl.store, 'video/mp2t');
    if (!src) ctl.log('转封装失败且无原始流备份，输出文件可能无法播放', 'warn');
  } else if (ctl.asm) {
    // 只有音轨的流（站点把声音单独拆出来）按 m4a 存，别让人拿到一个「看着像视频」的 mp4
    const kinds = trackKinds(ctl.asm);
    const audioOnly = kinds.audio && !kinds.video && ctl.asm.mode !== 'aac';
    ext = audioOnly ? 'm4a' : ctl.asm.ext;
    const mime = ext === 'aac' ? 'audio/aac' : ext === 'm4a' ? 'audio/mp4' : 'video/mp4';
    blob = await read(ctl.store, mime);
  } else {
    ext = task.fileExt || guessExt(task.url, task.mime);
    blob = await read(ctl.store, 'application/octet-stream');
  }

  if (!blob || blob.size === 0) throw new Error('未下载到任何数据');
  return { blob, ext };
}

async function finalize(ctl, opts) {
  const task = ctl.task;
  const partial = !!(opts && opts.partial);

  if (ctl.asm) {
    await flushAsm(ctl, true);
    task.hasAudio = detectAudio(ctl.asm);
    // 与 hasAudio 区分：只有真的把另一条音轨并进来才算「合并过」
    task.audioMerged = !!(ctl.asm.stats && ctl.asm.stats.audioMerged);
    if (partial) {
      await patchHeadDuration(ctl, ctl.vodTime || ctl.liveTime || 0);
    } else if (ctl.headPatched) {
      // 中途存过快照，时长被改小过，完整了要改回全长
      await patchHeadDuration(ctl, ctl.vodTime || ctl.liveTime || ctl.planned || ctl.headPatched);
    }
  }

  const { blob, ext } = await collectOutput(ctl, false);

  const saved = await saveBlob(ctl, blob, ext);
  report(ctl, {
    status: 'done',
    // 中途保存：进度停在真实位置，别让卡片显示 100% 骗人
    progress: partial ? Math.max(1, Math.min(99, Math.round(task.progress || 0))) : 100,
    partial: partial,
    segmentsDone: ctl.vodCursor || task.segmentsDone,
    snapAt: 0,
    snapSize: 0,
    snapProgress: 0,
    received: blob.size,
    total: partial ? task.total || blob.size : blob.size,
    speed: 0,
    filename: saved.filename,
    downloadId: saved.downloadId,
    savedTo: saved.savedTo,
    dirName: saved.dirName,
    saveWarn: saved.saveWarn,
    fileSize: blob.size,
    outputExt: ext
  });

  // 延迟清理临时文件，避免影响已触发但未完成的下载
  setTimeout(() => {
    ctl.store && ctl.store.dispose();
    if (ctl.asm && ctl.asm.rawStore) ctl.asm.rawStore.dispose();
  }, 30000);
}

/**
 * 拍一张「截至当前」的快照并落盘，任务**不结束**：
 * session、断点位点、临时数据全留着，用户点「继续」还能接着下。
 */
async function snapshotTask(ctl) {
  if (ctl.snapshotting) return;
  ctl.snapshotting = true;
  ctl.snapshotReq = false;
  const task = ctl.task;

  try {
    report(ctl, { status: 'saving', speed: 0 });
    // mux.js 里可能还剩不到一个分片的尾巴没吐出来
    if (ctl.asm) await flushAsm(ctl, true);
    await patchHeadDuration(ctl, ctl.vodTime || ctl.liveTime || 0);

    const { blob, ext } = await collectOutput(ctl, true);
    if (ctl.canceled) return;
    const pct = Math.max(1, Math.min(99, Math.round(task.progress || 0)));
    const saved = await saveBlob(ctl, blob, ext, ' (' + pct + '%)');
    const kinds = ctl.asm ? trackKinds(ctl.asm) : { audio: false, video: false };

    report(ctl, {
      status: 'paused',
      speed: 0,
      snapAt: Date.now(),
      snapName: saved.filename,
      snapSize: blob.size,
      snapProgress: pct,
      snapHasAudio: !!kinds.audio,
      snapDownloadId: saved.downloadId,
      snapSavedTo: saved.savedTo,
      snapDirName: saved.dirName
    });

    // 快照副本（OPFS 下是另一份文件）留给浏览器读，读完了再删
    if (ctl.store && ctl.store.releaseSnapshots) ctl.store.releaseSnapshots(180000);
  } catch (e) {
    // 任务在这期间被取消了：别再往回写「已暂停」，否则卡片会诈尸
    if (!ctl.canceled) {
      report(ctl, { status: 'paused', speed: 0, snapError: String((e && e.message) || e) });
    }
  } finally {
    ctl.snapshotting = false;
  }
}

/* ------------------------------------------------------------------ */
/* 任务调度                                                            */
/* ------------------------------------------------------------------ */

function newCtl(task) {
  return {
    task,
    stop: false,        // 取消 / 停止并保存：立刻断，不再收尾
    canceled: false,
    pauseReq: false,    // 暂停请求：在途分片给一点收尾时间，然后停
    paused: false,      // 已经停下来，会话与临时数据都留着
    snapshotReq: false, // 停下之后要导出一份「截至当前」的快照
    snapshotting: false,
    busy: false,        // 流水线是否正在跑
    ab: null,           // 本轮请求的 AbortController：暂停时掐断卡住的连接
    idleWake: null,     // 交付循环正在等分片时的「叫醒」函数
    runs: 0,            // 跑过几轮，>0 表示这一轮是「继续」
    concurrency: Math.min(16, Math.max(1, task.concurrency || DEFAULT_CONCURRENCY)),
    log: (m, lv) => console[lv === 'warn' ? 'warn' : 'log']('[VF] ' + m)
  };
}

async function pipeline(ctl, resume) {
  const task = ctl.task;
  if (task.kind === 'blob') return runBlob(ctl);
  // 已经定过路线就照原路线续传，别重头解析（否则已下载的数据白扔）
  if (ctl.phase === 'hls-vod' || ctl.phase === 'hls-live') return startHls(ctl, resume);
  if (ctl.phase === 'file') return runFile(ctl);
  if (task.kind === 'hls') return startHls(ctl, false);
  await maybeSwitchToHls(ctl);
  if (task.kind === 'hls') return startHls(ctl, false);
  return runFile(ctl);
}

/**
 * 跑一轮流水线并收尾。
 * 「暂停」和「结束」的区别全在 finally：暂停只把会话标成 paused，
 * store 和断点位点原样保留，用户点继续就再跑一轮。
 */
async function drive(ctl) {
  const task = ctl.task;
  const resume = (ctl.runs || 0) > 0;
  ctl.runs = (ctl.runs || 0) + 1;
  ctl.busy = true;
  ctl.paused = false;
  ctl.pauseReq = false;
  disarmAbort(ctl);
  ctl.ab = typeof AbortController !== 'undefined' ? new AbortController() : null;
  clearKeyCache();

  let pausedOut = false;
  try {
    await pipeline(ctl, resume);

    if (ctl.canceled) {
      report(ctl, { status: 'canceled', speed: 0 });
      if (ctl.store) ctl.store.dispose();
      return;
    }
    if (ctl.stop && ctl.partialOk) {
      await finalize(ctl, { partial: true });
      return;
    }
    await finalize(ctl);
  } catch (e) {
    if (e && e.pause) {
      pausedOut = true;
      return;
    }
    if (ctl.canceled) {
      report(ctl, { status: 'canceled', speed: 0 });
      if (ctl.store) ctl.store.dispose();
    } else if (ctl.stop && (task.live || ctl.partialOk)) {
      // 中途停下（直播停止）：把已有部分封装保存
      try {
        await finalize(ctl, { partial: true });
      } catch (e2) {
        report(ctl, { status: 'error', error: String(e2.message || e2), speed: 0 });
        if (ctl.store) ctl.store.dispose();
      }
    } else {
      report(ctl, { status: 'error', error: String((e && e.message) || e), speed: 0 });
      if (ctl.store) ctl.store.dispose();
    }
    console.warn('[VF] 任务失败', e);
  } finally {
    ctl.busy = false;
    ctl.idleWake = null;
    disarmAbort(ctl);
    if (pausedOut && !ctl.canceled) {
      // 暂停期间用户又点了继续：直接接着跑，不用先回一次「已暂停」
      if (ctl.resumePending) {
        ctl.resumePending = false;
        drive(ctl);
        return;
      }
      ctl.paused = true;
      report(ctl, { status: 'paused', speed: 0 });
      if (ctl.snapshotReq) await snapshotTask(ctl);
      return; // 关键：不删 session，断点数据继续留着
    }
    ctl.resumePending = false;
    ctl.snapshotReq = false;
    sessions.delete(task.id);
  }
}

async function startTask(task) {
  const ctl = newCtl(task);
  sessions.set(task.id, ctl);
  report(ctl, { status: 'running', startedAt: Date.now() });
  drive(ctl).catch((e) => console.warn('[VF] 调度异常', e));
}

/**
 * 暂停。
 * 状态先切成「暂停中」（卡片立刻有反馈），再让流水线停在分片边界；
 * 在途请求给 400ms 收尾，超时就 abort —— 否则一条卡住的连接能让暂停看起来完全没生效。
 */
function pauseTask(taskId) {
  const ctl = sessions.get(taskId);
  if (!ctl) return { ok: false, error: '任务已结束' };
  // 录制数据在页面侧的 SourceBuffer 里，暂停等于把这段丢掉
  if (ctl.task.kind === 'blob') return { ok: false, error: '录制任务不支持暂停，可直接停止并保存' };
  if (ctl.snapshotting) return { ok: false, error: '正在保存快照，稍等一下' };
  if (ctl.canceled) return { ok: false, error: '任务正在结束' };
  if (ctl.pauseReq || ctl.paused) return { ok: true };

  ctl.pauseReq = true;
  ctl.resumePending = false;
  report(ctl, { status: 'pausing', speed: 0 });
  // 先把正在等分片的交付循环叫醒：慢链路上下一块可能还要好几秒才到，
  // 光等它自然返回，用户看到的就是「点了暂停还在下」。
  wakeIdle(ctl);
  armAbort(ctl, 400);
  return { ok: true };
}

function resumeTask(taskId) {
  const ctl = sessions.get(taskId);
  if (!ctl) return { ok: false, error: '任务已不在后台，请重新开始下载' };
  if (ctl.snapshotting) return { ok: false, error: '正在保存快照，稍等一下' };
  if (ctl.canceled) return { ok: false, error: '任务正在结束' };

  disarmAbort(ctl);

  if (ctl.busy) {
    // 这一轮还在收尾（或者在拍快照）：停稳后立刻接着跑
    ctl.resumePending = true;
    report(ctl, { status: 'running' });
    return { ok: true };
  }

  ctl.pauseReq = false;
  ctl.stop = false;
  ctl.paused = false;
  report(ctl, { status: 'running', snapAt: 0, snapSize: 0, snapProgress: 0, snapError: '' });
  drive(ctl).catch((e) => console.warn('[VF] 续传异常', e));
  return { ok: true };
}

/**
 * 保存当前进度。
 * 和「取消」的区别：导出一份截至现在的文件，但任务**不结束** ——
 * 会话、断点、临时数据都留着，点「继续」还能接着把剩下的下完。
 */
function saveTask(taskId) {
  const ctl = sessions.get(taskId);
  if (!ctl) return { ok: false, error: '任务已结束' };
  if (ctl.snapshotting) return { ok: true };
  if (ctl.canceled) return { ok: false, error: '任务正在结束' };
  if (ctl.task.kind === 'blob') return { ok: false, error: '录制任务请用「停止并保存」' };
  if (!ctl.store) return { ok: false, error: '还没有下到可保存的数据' };

  ctl.snapshotReq = true;
  report(ctl, { status: 'saving', speed: 0 });

  if (ctl.busy) {
    // 先停稳再拍快照，否则会拍到正在写的尾巴
    ctl.pauseReq = true;
    wakeIdle(ctl);
    armAbort(ctl, 400);
    return { ok: true };
  }
  ctl.paused = true;
  snapshotTask(ctl).catch(() => {});
  return { ok: true };
}


/**
 * HLS 的分片、独立音轨常挂在和播放列表不同的主机上，
 * 主规则只覆盖了播放列表那个域，这里把其余主机逐个补上。
 */
async function armSegmentHosts(ctl, urls) {
  const ref = ctl.task.referer;
  if (!ref) return;
  const seen = new Set();
  try {
    seen.add(new URL(ctl.task.url).host);
  } catch {}
  for (const u of urls) {
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      continue;
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    await sendMsg({ target: 'sw', type: 'arm-referer', taskId: ctl.task.id, url: u, referer: ref });
  }
}

async function startHls(ctl, resume) {
  const task = ctl.task;
  let playlistUrl = ctl.playlistUrl || task.url;
  let audioUrl = ctl.audioUrl || '';
  let pl = null;

  if (resume && ctl.hlsPl) {
    // 续传：子列表可能带时效签名，重新取一次；段序不会变，断点索引照旧
    try {
      const fresh = await loadPlaylist(playlistUrl, task.pageUrl, sig(ctl));
      if (fresh.type === 'media' && fresh.segments.length) pl = fresh;
    } catch (e) {
      ctl.log('播放列表刷新失败，沿用上次解析结果：' + e.message, 'warn');
    }
    if (!pl) pl = ctl.hlsPl;
    ctl.hlsPl = pl;
  } else {
    pl = await loadPlaylist(playlistUrl, task.pageUrl, sig(ctl));

    if (pl.type === 'master') {
      const master = pl;
      const v = pickVariant(pl, task.variant, task.variantUri, task.wantHeight);
      if (!v) throw new Error('该 m3u8 没有可用清晰度');
      task.variantLabel = shortLabel(v);
      audioUrl = audioUriFor(master, v);
      playlistUrl = v.uri;
      pl = await loadPlaylist(playlistUrl, task.pageUrl, sig(ctl));
    }

    if (pl.type !== 'media' || !pl.segments.length) throw new Error('播放列表中没有媒体分片');
    if (pl.encrypted === 'SAMPLE-AES') throw new Error('该流使用 SAMPLE-AES 加密，暂不支持');

    ctl.partialOk = !pl.endList;
    task.live = !pl.endList;
    task.encrypted = pl.encrypted || '';
    ctl.playlistUrl = playlistUrl;
    ctl.audioUrl = audioUrl;
    ctl.hlsPl = pl;
    ctl.phase = pl.endList ? 'hls-vod' : 'hls-live';

    await armSegmentHosts(ctl, pl.segments.slice(0, 24).map((s) => s.url).concat(audioUrl ? [audioUrl] : []));

    ctl.store = new ChunkStore();
    await ctl.store.init();
    const planned = pl.endList ? pl.segments.reduce((a, s) => a + (s.duration || 0), 0) : 0;
    ctl.planned = planned;
    ctl.asm = new Assembler(ctl.log, null, planned);
    if (ctl.store.useOpfs) {
      ctl.rawStore = new ChunkStore();
      await ctl.rawStore.init();
      ctl.asm.rawStore = ctl.rawStore;
    }
  }

  if (task.live) {
    await runLive(ctl, playlistUrl, pl);
    return;
  }

  // 点播：视频流里没音轨时补拉独立音轨，合并成一个文件（成功一次就不再拉）
  if (audioUrl && !ctl.audioTrack) {
    try {
      const at = await assembleAudioTrack(ctl, audioUrl);
      // 音轨还没拉完就被暂停了：这条音轨等续传时整条重拉，别记成「已尝试过」
      if (ctl.pauseReq && !ctl.stop) throw new PauseSignal();
      if (at && at.live) ctl.log('直播音轨暂不与视频合并，成片可能无声', 'warn');
      else if (at && ctl.asm.setAudioTrack(at)) {
        ctl.audioTrack = at;
        ctl.log('已拉取独立音轨 ' + Math.round((at.bytes || 0) / 1024) + 'KB');
      } else {
        ctl.log('独立音轨解析失败，成片可能无声', 'warn');
      }
    } catch (e) {
      if (e && e.pause) throw e;
      ctl.log('音轨下载失败：' + (e && e.message ? e.message : e), 'warn');
    }
  }
  await runVod(ctl, pl, ctl.vodCursor || 0);
}

function cancelTask(taskId) {
  const ctl = sessions.get(taskId);
  if (!ctl) return;
  ctl.stop = true;
  ctl.pauseReq = false;
  ctl.snapshotReq = false;
  wakeIdle(ctl);
  disarmAbort(ctl);
  // 取消不等在途请求：反正已经下的这些不要了，别为了几条慢连接让按钮再挂十秒
  try {
    if (ctl.ab && !ctl.ab.signal.aborted) ctl.ab.abort();
  } catch {}
  // 直播/录制：停止即保存；点播：视为取消
  if (ctl.task.live || ctl.task.kind === 'blob') ctl.partialOk = true;
  else ctl.canceled = true;

  // 已经暂停住了：没有流水线在跑，得在这里收尾，否则会话永远留在内存里
  if (!ctl.busy) {
    ctl.paused = false;
    (async () => {
      try {
        if (ctl.canceled) {
          report(ctl, { status: 'canceled', speed: 0 });
          if (ctl.store) ctl.store.dispose();
        } else {
          await finalize(ctl, { partial: true });
        }
      } catch (e) {
        report(ctl, { status: 'error', error: String((e && e.message) || e), speed: 0 });
        if (ctl.store) ctl.store.dispose();
      } finally {
        sessions.delete(taskId);
      }
    })();
  }
}

/* ------------------------------------------------------------------ */
/* 探测（供 popup 取清晰度列表）                                        */
/* ------------------------------------------------------------------ */

async function probe(msg) {
  try {
    setReferer(msg.url, msg.referer);
    const pl = await loadPlaylist(msg.url, msg.pageUrl);
    if (pl.type === 'master') {
      return {
        ok: true,
        type: 'master',
        variants: pl.variants.map((v, i) => ({
          index: i,
          label: v.label,
          bandwidth: v.bandwidth,
          codecs: v.codecs,
          resolution: v.resolution,
          uri: v.uri
        }))
      };
    }
    if (pl.type === 'media') {
      const dur = pl.segments.reduce((a, s) => a + (s.duration || 0), 0);
      return {
        ok: true,
        type: 'media',
        live: !pl.endList,
        segments: pl.segments.length,
        duration: Math.round(dur),
        encrypted: pl.encrypted || '',
        variants: [{ index: 0, label: pl.hasMap ? 'fMP4' : 'TS', bandwidth: 0, resolution: null }]
      };
    }
    return { ok: false, error: '不是 HLS 播放列表' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/** 直链源嗅探时没拿到 content-length 的，用 HEAD 补取大小，不认 HEAD 的退 Range */
async function probeSize(msg) {
  try {
    setReferer(msg.url, msg.referer);
    let r = await fetch(msg.url, { method: 'HEAD' });
    let len = parseInt(r.headers && r.headers.get('content-length') || '0', 10) || 0;
    if (!len) {
      r = await fetch(msg.url, { headers: { Range: 'bytes=0-1' } });
      if (r.status !== 206) return { ok: false, error: '服务器不响应大小探测' };
      const cr = r.headers && r.headers.get('content-range');
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      if (!m) return { ok: false, error: '响应缺少 content-range' };
      len = +m[1];
    }
    if (len <= 0) return { ok: false, error: '拿不到大小' };
    return { ok: true, size: len };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'start') {
    if (msg.task && msg.task.referer) setReferer(msg.task.url, msg.task.referer);
    startTask(msg.task);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'cancel') {
    cancelTask(msg.taskId);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'pause') {
    sendResponse(pauseTask(msg.taskId));
    return;
  }
  if (msg.type === 'resume') {
    sendResponse(resumeTask(msg.taskId));
    return;
  }
  if (msg.type === 'save') {
    sendResponse(saveTask(msg.taskId));
    return;
  }
  if (msg.type === 'rec-chunk') {
    onRecChunk(msg.data || {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'probe') {
    probe(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'probe-size') {
    probeSize(msg).then(sendResponse);
    return true;
  }
});

sendMsg({ target: 'sw', type: 'engine-ready' });
cleanupAllTemp();
