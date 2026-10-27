/**
 * VideoFetch - Service Worker
 * 职责：媒体请求嗅探 / 列表状态维护 / offscreen 下载引擎调度 / 消息路由
 */

const MEDIA_EXT = /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|f4v|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|m4f|cmf[at]|ism|dash)(?:[?#]|$)/i;
const HLS_MIME = /(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|vnd\.apple\.mpegURL)|audio\/(mpegurl|x-mpegurl))/i;
const VIDEO_MIME = /^(video|audio)\//i;

/** @type {Map<number, Map<string, any>>} */
const mediaByTab = new Map();
/** @type {Map<string, any>} */
const tasks = new Map();
let tasksLoaded = null;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function normKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url);
  }
}

/** 资源身份：协议 + 主机 + 路径。查询串里的签名（微博 ssig/Expires 每次都变）不参与 */
function resourceKeyOf(url) {
  const s = String(url || '');
  if (s.startsWith('blob:')) return '';
  try {
    const u = new URL(s);
    if (u.pathname.length <= 1) return '';
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sanitizeName(name, fallback = 'video') {
  let n = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  if (!n) n = fallback;
  if (n.length > 110) n = n.slice(0, 110);
  return n;
}

function notifyPopup() {
  chrome.runtime.sendMessage({ target: 'popup', type: 'refresh' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 任务持久化（storage.session，SW 重启后恢复）                          */
/* ------------------------------------------------------------------ */

async function loadTasks() {
  if (tasksLoaded) return tasksLoaded;
  tasksLoaded = (async () => {
    try {
      const got = await chrome.storage.session.get('vf:tasks');
      for (const t of got['vf:tasks'] || []) {
        if (t.status === 'running' || t.status === 'queued') {
          // SW 重启后，引擎可能已不存在，标记为可恢复
          t.status = 'interrupted';
        } else if (t.status === 'pausing' || t.status === 'saving') {
          // 过渡态不该留在存储里：引擎没了，就停在「已暂停」，让用户自己决定继续还是取消
          t.status = 'paused';
        }
        tasks.set(t.id, t);
      }
    } catch {}
  })();
  return tasksLoaded;
}

async function saveTasks() {
  try {
    const arr = [...tasks.values()].slice(-40).map((t) => ({
      id: t.id, kind: t.kind, title: t.title, status: t.status,
      progress: t.progress, speed: t.speed, received: t.received, total: t.total,
      error: t.error, filename: t.filename, createdAt: t.createdAt, pageUrl: t.pageUrl,
      savedTo: t.savedTo, dirName: t.dirName, saveWarn: t.saveWarn
    }));
    await chrome.storage.session.set({ 'vf:tasks': arr });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* 记录每个标签页的注入情况、网络请求统计、以及被丢弃的可疑请求，       */
/* 用于排查“页面明明在播却抓不到”。                                     */
/* ------------------------------------------------------------------ */

/** @type {Map<number, any>} */
const diagByTab = new Map();

function diagOf(tabId) {
  let d = diagByTab.get(tabId);
  if (!d) {
    d = { tabId, hooks: [], net: { total: 0, media: 0, orphan: 0 }, ignored: [], page: 0, mse: 0 };
    diagByTab.set(tabId, d);
  }
  return d;
}

function diagHook(tabId, frameId, url) {
  const d = diagOf(tabId);
  const key = frameId + '|' + String(url || '').split('#')[0];
  if (d.hooks.some((h) => h.key === key)) return;
  d.hooks.push({ key, frameId, url: String(url || '').slice(0, 200), ts: Date.now() });
  if (d.hooks.length > 12) d.hooks.shift();
}

function diagIgnored(tabId, url, ct, type) {
  if (!tabId || tabId < 0) return;
  const looksMedia =
    /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|m4s|ts)(?:[?#]|$)/i.test(url) ||
    /(video|audio|mpegurl|octet-stream)/i.test(ct || '');
  if (!looksMedia) return;
  const d = diagOf(tabId);
  const key = url.split('#')[0];
  if (d.ignored.some((x) => x.url === key)) return;
  d.ignored.push({ url: key.slice(0, 300), ct: (ct || '').slice(0, 60), type, ts: Date.now() });
  if (d.ignored.length > 20) d.ignored.shift();
}

/** tabId 拿不到（Service Worker / Worker 代发）时，按发起方来源反查归属标签页 */async function resolveTabByUrl(documentUrl, initiator) {
  const patterns = [];
  for (const s of [documentUrl, initiator]) {
    if (!s) continue;
    try {
      patterns.push(new URL(s).origin + '/*');
    } catch {}
  }
  for (const p of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: p });
      if (!tabs.length) continue;
      const active = tabs.find((t) => t.active && !t.incognito);
      return (active || tabs.find((t) => !t.incognito) || tabs[0]).id;
    } catch {}
  }
  return -1;
}

function diagSnapshot(tabId) {
  const d = tabId >= 0 ? diagOf(tabId) : null;
  return {
    tabId,
    hooked: !!(d && d.hooks.length),
    hooks: d ? d.hooks.slice(-8).map((h) => ({ frameId: h.frameId, url: h.url })) : [],
    net: d ? d.net : { total: 0, media: 0, orphan: 0 },
    ignored: d ? d.ignored.slice(-12) : [],
    global: Object.assign({}, netStats)
  };
}

/* ------------------------------------------------------------------ */
/* 媒体列表                                                            */
/* ------------------------------------------------------------------ */

async function getTabMap(tabId) {
  if (!mediaByTab.has(tabId)) {
    let arr = [];
    try {
      const k = 'vf:tab:' + tabId;
      const got = await chrome.storage.session.get(k);
      arr = got[k] || [];
    } catch {}
    const m = new Map();
    for (const it of arr) m.set(normKey(it.url), it);
    mediaByTab.set(tabId, m);
  }
  return mediaByTab.get(tabId);
}

async function persistTab(tabId) {
  const m = mediaByTab.get(tabId);
  if (!m) return;
  try {
    const arr = [...m.values()].filter((i) => !i.stale).slice(-80);
    await chrome.storage.session.set({ ['vf:tab:' + tabId]: arr });
  } catch {}
}

/** 非媒体扩展名：图片、文档、压缩包，任何通道上报都不该进列表 */
const NON_MEDIA_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?|heic|pdf|zip|rar|7z|gz|docx?|xlsx?|pptx?|txt|xml|html?|css|js|mjs|json|woff2?|ttf|eot)(?:[?#]|$)/i;

/** 非媒体 content-type 的直链属于噪音（JSON 接口、脚本、图片） */
function isJunkItem(it) {
  if (!it || !it.url) return true;
  if (NON_MEDIA_EXT.test(it.url)) return true;
  if (it.type !== 'file') return false;
  const mt = String(it.mime || '').toLowerCase();
  if (/^image\//.test(mt)) return true;
  if (mt && !/^(video|audio)\/|octet-stream|mp2t/.test(mt)) return true;
  return false;
}

async function addMedia(tabId, patch) {
  if (tabId == null || tabId < 0 || !patch.url) return null;
  // 明确不是媒体的 content-type 直接丢弃：JSON 接口、HTML、图片都不该出现在列表里
  if (isJunkItem({ type: patch.type, mime: patch.mime, url: patch.url })) return null;
  const m = await getTabMap(tabId);
  const key = normKey(patch.url);
  const old = m.get(key);
  if (old) {
    if (patch.mime && !old.mime) old.mime = patch.mime;
    if (patch.size && !old.size) old.size = patch.size;
    if (patch.type === 'hls' && old.type !== 'hls') old.type = 'hls';
    return old;
  }
  // 同一资源路径的第二次抓取（页面预取 + 播放器各取一次，签名参数不同）
  // 是同一个文件。用新地址顶掉旧条目，否则列表里出现两张一模一样的卡。
  // 两次都有大小且对不上（差 1% 以上）时不算同一个文件，防误并。
  const resKey = resourceKeyOf(patch.url);
  if (resKey) {
    for (const [, v] of m) {
      if (v.stale || v.type !== (patch.type || 'file')) continue;
      if (resourceKeyOf(v.url) !== resKey) continue;
      if (v.size && patch.size && Math.abs(v.size - patch.size) > Math.max(v.size, patch.size) * 0.01) continue;
      if (patch.mime && !v.mime) v.mime = patch.mime;
      if (patch.size && !v.size) v.size = patch.size;
      v.url = patch.url;
      v.ts = Date.now();
      await persistTab(tabId);
      notifyPopup();
      updateBadge(tabId);
      return v;
    }
  }
  const item = {
    id: uid(),
    url: patch.url,
    type: patch.type || 'file',
    mime: patch.mime || '',
    size: patch.size || 0,
    title: patch.title || '',
    pageUrl: patch.pageUrl || '',
    host: safeHost(patch.url),
    frameId: patch.frameId ?? 0,
    from: patch.from || 'network',
    recId: patch.recId || null,
    ts: Date.now()
  };
  m.set(key, item);
  // blob 源会随每次播放反复出现，限制保留条数
  if (patch.type === 'blob') {
    const blobs = [...m.entries()].filter(([, v]) => v.type === 'blob');
    if (blobs.length > 6) {
      for (const [k] of blobs.slice(0, blobs.length - 6)) m.delete(k);
    }
  }
  if (m.size > 90) {
    const first = m.keys().next().value;
    if (first !== key) m.delete(first);
  }
  await persistTab(tabId);
  notifyPopup();
  updateBadge(tabId);
  return item;
}

function clearTab(tabId) {
  mediaByTab.delete(tabId);
  diagByTab.delete(tabId);
  chrome.storage.session.remove('vf:tab:' + tabId).catch(() => {});
  updateBadge(tabId);
}

/* ---------------- 图标角标 ---------------- */

const BADGE_COLOR = '#DE350B';
const BADGE_TEXT_COLOR = '#FFFFFF';
const BADGE_URL_RE = /(?:^|[\/_.-])audio(?:[\/_.-]|$)/i;
const BADGE_EXT_RE = /\.(m4a|mp3|aac|oga|opus|flac|wav)(?:[?#]|$)/i;

/** 与 popup 的 groupKeyOf 同一规则：路径里的长数字 ID 聚成一张卡片，红点按卡片数计 */
function badgeGroupKey(item) {
  if (item.type === 'blob') return 'blob:' + (item.recId || item.url);
  try {
    const x = new URL(item.url);
    const seg = x.pathname.split('/').filter(Boolean);
    for (let i = 0; i < seg.length; i++) {
      if (/^\d{8,}$/.test(seg[i])) return x.hostname + '/' + seg[i];
    }
  } catch {}
  return item.url;
}

/** 红点只数视频；纯音轨（按 mime 与文件名可判定时）不算 */
function isAudioOnlyItem(item) {
  if (!item || item.type === 'blob') return false;
  if (/^audio\//i.test(String(item.mime || ''))) return true;
  let p = '';
  try { p = new URL(item.url).pathname; } catch { p = String(item.url || ''); }
  if (BADGE_EXT_RE.test(p)) return true;
  const base = p.split('/').pop() || '';
  return BADGE_URL_RE.test(base) && !/video/i.test(base);
}

function videoGroupCount(tabId) {
  const m = mediaByTab.get(tabId);
  if (!m) return 0;
  const keys = new Set();
  for (const it of m.values()) {
    if (it.stale || isAudioOnlyItem(it)) continue;
    keys.add(badgeGroupKey(it));
  }
  return keys.size;
}

function updateBadge(tabId) {
  if (tabId == null || tabId < 0 || !chrome.action) return;
  const n = videoGroupCount(tabId);
  try {
    chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : '' });
    if (n > 0) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
      chrome.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT_COLOR });
    }
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 网络嗅探                                                            */
/* ------------------------------------------------------------------ */

function classify(url, contentType, contentLength) {
  const ct = (contentType || '').toLowerCase();
  if (HLS_MIME.test(ct)) return 'hls';
  if (/dash\+xml/i.test(ct)) return 'dash';
  if (SEGMENT_EXT.test(url) && !/x-mpegurl/i.test(ct)) return null;
  if (ct === 'video/mp2t' || ct === 'video/iso.segment') return null;
  if (VIDEO_MIME.test(ct)) {
    return /\.m3u8?(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
  }
  if (/(octet-stream|binary|mp4|mpegurl)/.test(ct) && MEDIA_EXT.test(url)) {
    return /\.m3u8?(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
  }
  if (/(text\/plain|application\/json|text\/html)/.test(ct)) {
    // 少数站点用 text/plain 返回 m3u8
    if (/\.m3u8?(?:[?#]|$)/i.test(url)) return 'hls';
    return null;
  }
  if (!ct && MEDIA_EXT.test(url)) {
    return /\.m3u8?(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
  }
  return null;
}

const pendingTitle = new Map();

async function pageTitle(tabId, pageUrl) {
  if (pendingTitle.has(tabId)) return pendingTitle.get(tabId);
  const p = (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.title || pageUrl || '';
    } catch {
      return pageUrl || '';
    }
  })();
  pendingTitle.set(tabId, p);
  p.finally(() => setTimeout(() => pendingTitle.delete(tabId), 5000));
  return p;
}

/** 全局网络统计：orphan = 没有 tabId 的请求（多由页面 Service Worker 代发） */
const netStats = { seen: 0, media: 0, orphan: 0, orphanResolved: 0 };

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, type, responseHeaders, frameId, initiator, documentUrl } = details;
    if (!/^https?:/i.test(url)) return;
    if (type === 'image' || type === 'stylesheet' || type === 'script' || type === 'font') return;

    let ct = '';
    let len = 0;
    for (const h of responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') ct = h.value || '';
      else if (name === 'content-length') len = parseInt(h.value || '0', 10) || 0;
    }

    const rawTabId = details.tabId;
    const known = rawTabId != null && rawTabId >= 0;
    netStats.seen++;
    if (!known) netStats.orphan++;

    const kind = classify(url, ct, len);
    const tooSmall = kind === 'file' && len > 0 && len < 24 * 1024;

    if (!kind || tooSmall) {
      // 明确像媒体却没被采纳，留证供诊断
      if (known) diagIgnored(rawTabId, url, ct, type);
      return;
    }

    const record = (id) => {
      if (id == null || id < 0) return;
      netStats.media++;
      const d = diagOf(id);
      d.net.total++;
      d.net.media++;
      pageTitle(id, documentUrl || initiator || '').then((title) => {
        addMedia(id, {
          url,
          type: kind,
          mime: ct.split(';')[0],
          size: len,
          title: title,
          pageUrl: documentUrl || initiator || '',
          frameId,
          from: 'network'
        });
      });
    };

    if (known) {
      record(rawTabId);
      return;
    }
    // 拿不到 tabId：可能是页面 Service Worker 代发的请求，按发起方反查归属
    resolveTabByUrl(documentUrl, initiator).then((id) => {
      if (id >= 0) {
        netStats.orphanResolved++;
        record(id);
      }
    });
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object', 'main_frame', 'sub_frame'] },
  ['responseHeaders', 'extraHeaders']
);

const lastTabUrl = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  lastTabUrl.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const prev = lastTabUrl.get(tabId);
  lastTabUrl.set(tabId, changeInfo.url);
  // 仅在真正跨站跳转时清空列表；SPA 路由变化（?v=xxx、pushState）保留已嗅探结果
  try {
    if (prev && new URL(prev).origin !== new URL(changeInfo.url).origin) clearTab(tabId);
  } catch {}
});

/* ------------------------------------------------------------------ */
/* offscreen 引擎                                                      */
/* ------------------------------------------------------------------ */

let creatingOffscreen = null;
let offscreenAlive = false;

async function ensureOffscreen() {
  if (offscreenAlive) return true;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return offscreenAlive;
  }
  creatingOffscreen = (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
      });
      if (contexts.length) {
        offscreenAlive = true;
        return;
      }
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS', 'BLOBS'],
        justification: '在后台线程执行视频分片的并发下载、AES 解密与 MP4 合并，需要 DOM/Blob 环境。'
      });
      offscreenAlive = true;
    } catch (e) {
      // 已存在时 createDocument 会抛错
      if (String(e && e.message).includes('Only a single offscreen')) offscreenAlive = true;
      else console.warn('[VF] offscreen 创建失败', e);
    } finally {
      creatingOffscreen = null;
    }
  })();
  await creatingOffscreen;
  return offscreenAlive;
}

/* ------------------------------------------------------------------ */
/* Referer 修正（部分 CDN 校验防盗链）                                   */
/*                                                                     */
/* 有些 CDN 只认「来源站域名」的 Referer，扩展自己发的 fetch 没有来源，   */
/* 直接被 403。Referer 是 fetch 的禁止头，只能靠 DNR 会话规则补。        */
/* 补完自检一次：真能拿到 2xx 才算数，否则退到 fetch 的 referrer 选项。  */
/* ------------------------------------------------------------------ */

let dnrSeq = 12000;
const dnrByTask = new Map(); // taskId -> [ruleId]

function trackRule(taskId, id) {
  const arr = dnrByTask.get(taskId) || [];
  if (!arr.includes(id)) arr.push(id);
  dnrByTask.set(taskId, arr);
}

/** 跨站请求浏览器只会带 origin，所以 Referer 取源站 origin 即可 */
function refererOf(pageUrl) {
  try {
    const p = new URL(pageUrl);
    if (!/^https?:$/i.test(p.protocol)) return '';
    return p.origin + '/';
  } catch {
    return '';
  }
}

async function probeReferer(url, referer, viaFetch) {
  const init = { headers: { Range: 'bytes=0-1' }, cache: 'no-store' };
  if (viaFetch) {
    init.referrer = referer;
    init.referrerPolicy = 'strict-origin-when-cross-origin';
  }
  for (const credentials of ['include', 'omit']) {
    try {
      const r = await fetch(url, { ...init, credentials });
      // 只要状态码，别把片子真拉下来
      try {
        await r.body?.cancel();
      } catch {}
      if (r.ok || r.status === 206) return true;
      if (r.status !== 401 && r.status !== 403) return false;
    } catch {}
  }
  return false;
}

/**
 * 给一个任务加 Referer。
 * 返回 { mode: 'same-origin' | 'dnr' | 'referrer' | 'none', referer }，随任务传给引擎。
 */
async function applyReferer(taskId, videoUrl, pageUrl) {
  const info = { mode: 'none', referer: '' };
  let page, target;
  try {
    page = new URL(pageUrl);
    target = new URL(videoUrl);
  } catch {
    return info;
  }
  if (!/^https?:$/i.test(page.protocol) || !/^https?:$/i.test(target.protocol)) return info;
  // 同源请求本来就带 Referer，不用管
  if (page.origin === target.origin) {
    info.mode = 'same-origin';
    return info;
  }

  const referer = page.origin + '/';
  info.referer = referer;
  const urlFilter = '|' + target.origin + '/';
  const resourceTypes = ['xmlhttprequest', 'media', 'other', 'object'];
  const id = dnrSeq++;

  // 覆盖范围从窄到宽试：只管非标签页请求 → 只管本扩展 → 不限
  const conds = [];
  if (chrome.declarativeNetRequest) conds.push({ urlFilter, resourceTypes, tabIds: [-1] });
  if (chrome.runtime.id) conds.push({ urlFilter, resourceTypes, initiatorDomains: [chrome.runtime.id] });
  conds.push({ urlFilter, resourceTypes });

  for (const condition of conds) {
    const rule = {
      id,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
      },
      condition
    };
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
    } catch (e) {
      console.warn('[VF] referer 规则注入失败', JSON.stringify(condition), e && e.message);
      continue;
    }
    if (await probeReferer(videoUrl, referer, false)) {
      trackRule(taskId, id);
      info.mode = 'dnr';
      return info;
    }
    // 装上但请求还是被拒，换下一种覆盖范围
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    } catch {}
  }

  // DNR 全部无效：改用 fetch 的 referrer 选项
  if (await probeReferer(videoUrl, referer, true)) {
    info.mode = 'referrer';
    return info;
  }
  console.warn('[VF] 防盗链 Referer 补不上', videoUrl);
  return info;
}

/**
 * 给任务补一条只管某个主机的 Referer 规则（HLS 分片常与播放列表不同域）。
 * 不探测，装上即可 —— 主规则已经验证过 DNR 能用。
 */
async function armHostReferer(taskId, url, referer) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (!referer || !/^https?:$/i.test(target.protocol)) return false;
  const id = dnrSeq++;
  const rule = {
    id,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
    },
    condition: {
      urlFilter: '|' + target.origin + '/',
      resourceTypes: ['xmlhttprequest', 'media', 'other', 'object'],
      tabIds: [-1]
    }
  };
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
  } catch (e) {
    delete rule.condition.tabIds;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
    } catch {
      return false;
    }
  }
  trackRule(taskId, id);
  return true;
}

async function releaseReferer(taskId) {
  const ids = dnrByTask.get(taskId);
  if (!ids || !ids.length) return;
  dnrByTask.delete(taskId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  /* ---- 来自 content script 的注入通报 ---- */
  if (msg.target === 'sw' && msg.type === 'hook-report') {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (tabId >= 0) diagHook(tabId, sender.frameId || 0, msg.data && msg.data.url);
    sendResponse({ ok: true });
    return true;
  }

  /* ---- 来自 content script 的页面内发现 ---- */
  if (msg.target === 'sw' && msg.type === 'page-media') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    const list = Array.isArray(msg.items) ? msg.items : [];
    (async () => {
      for (const it of list) {
        await addMedia(tabId, {
          url: it.url,
          type: it.type || 'file',
          mime: it.mime || '',
          title: sender.tab ? sender.tab.title : '',
          pageUrl: sender.tab ? sender.tab.url : msg.pageUrl,
          frameId: sender.frameId || 0,
          from: it.from || 'page',
          recId: it.recId || null
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* ---- 来自 content script 的 blob 录制数据 ---- */
  if (msg.target === 'sw' && msg.type === 'rec-chunk') {
    ensureOffscreen().then(() =>
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'rec-chunk', data: msg.data }).catch(() => {})
    );
    sendResponse({ ok: true });
    return true;
  }

  /* ---- 引擎发现分片在别的主机上，补一条规则 ---- */
  if (msg.target === 'sw' && msg.type === 'arm-referer') {
    armHostReferer(msg.taskId, msg.url, msg.referer)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  /* ---- 来自 offscreen 的进度 ---- */
  if (msg.target === 'sw' && msg.type === 'task-update') {
    const t = tasks.get(msg.task.id);
    if (t) Object.assign(t, msg.task);
    else tasks.set(msg.task.id, msg.task);
    saveTasks();
    chrome.runtime.sendMessage({ target: 'popup', type: 'task-update', task: msg.task }).catch(() => {});
    if (msg.task.status === 'done' || msg.task.status === 'error' || msg.task.status === 'canceled') {
      releaseReferer(msg.task.id);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.target === 'sw' && msg.type === 'engine-ready') {
    offscreenAlive = true;
    sendResponse({ ok: true });
    return true;
  }

  /* ---- offscreen 请求把页面录制数据搬回来 ---- */
  if (msg.target === 'sw' && msg.type === 'request-dump') {
    const { tabId, frameId, recId, bucket } = msg;
    (async () => {
      const fail = (error) =>
        chrome.runtime
          .sendMessage({ target: 'offscreen', type: 'rec-chunk', data: { recId, done: true, error } })
          .catch(() => {});
      try {
        if (tabId == null) return fail('缺少标签页信息');
        const r = await chrome.tabs.sendMessage(
          tabId,
          { target: 'cs', type: 'record-dump', recId, bucket },
          { frameId: frameId || 0 }
        );
        if (!r || !r.ok) fail((r && r.error) || '页面未返回录制数据');
      } catch (e) {
        fail('无法连接页面（可能已刷新）：' + (e && e.message ? e.message : e));
      }
    })();
    sendResponse({ ok: true });
    return true;
  }

  /* ---- 来自 popup ---- */
  if (msg.target === 'sw') {
    (async () => {
      try {
        switch (msg.type) {
          case 'list': {
            await loadTasks();
            const tabId = msg.tabId;
            const m = await getTabMap(tabId);
            // 顺手清掉历史遗留的非媒体条目（旧版本可能把 JSON 接口收了进来）
            const items = [];
            for (const [k, it] of m) {
              if (isJunkItem(it)) m.delete(k);
              else items.push(it);
            }
            sendResponse({
              ok: true,
              items: items.reverse(),
              tasks: [...tasks.values()].reverse(),
              diag: diagSnapshot(tabId)
            });
            break;
          }
          case 'clear': {
            clearTab(msg.tabId);
            sendResponse({ ok: true });
            break;
          }
          case 'remove-item': {
            const m = await getTabMap(msg.tabId);
            m.delete(normKey(msg.url));
            await persistTab(msg.tabId);
            sendResponse({ ok: true });
            break;
          }
          case 'start': {
            const task = {
              id: uid(),
              kind: msg.kind,
              title: sanitizeName(msg.title || 'video'),
              url: msg.url,
              pageUrl: msg.pageUrl,
              tabId: msg.tabId,
              frameId: msg.frameId || 0,
              recId: msg.recId || null,
              mime: msg.mime || '',
              variant: msg.variant != null ? msg.variant : null,
              variantUri: msg.variantUri || '',
              concurrency: msg.concurrency || 8,
              status: 'queued',
              progress: 0,
              received: 0,
              total: msg.total || 0,
              speed: 0,
              createdAt: Date.now(),
              filename: ''
            };
            tasks.set(task.id, task);
            await saveTasks();
            await ensureOffscreen();
            if (!offscreenAlive) throw new Error('后台下载引擎启动失败，请重试');
            const ref = await applyReferer(task.id, msg.url, msg.pageUrl);
            task.referer = ref.referer;
            task.refererMode = ref.mode;
            const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', task }).catch((e) => ({ ok: false, error: String(e) }));
            sendResponse({ ok: true, task, engine: r || null });
            break;
          }
          case 'cancel': {
            await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', taskId: msg.taskId }).catch(() => {});
            const t = tasks.get(msg.taskId);
            if (t && t.status !== 'done') { t.status = 'canceled'; saveTasks(); }
            await releaseReferer(msg.taskId);
            sendResponse({ ok: true });
            break;
          }
          case 'pause': {
            const r = await chrome.runtime
              .sendMessage({ target: 'offscreen', type: 'pause', taskId: msg.taskId })
              .catch((e) => ({ ok: false, error: String(e) }));
            // 引擎那边没有这个任务 = 后台重启过，别让卡片一直显示「下载中」
            if (r && r.ok === false && r.error === '任务已结束') {
              const t = tasks.get(msg.taskId);
              if (t && (t.status === 'running' || t.status === 'queued' || t.status === 'pausing')) {
                t.status = 'interrupted';
                t.error = '后台已重启，断点丢失';
                await saveTasks();
              }
            }
            sendResponse(r || { ok: false });
            break;
          }
          case 'resume': {
            await ensureOffscreen();
            const r = await chrome.runtime
              .sendMessage({ target: 'offscreen', type: 'resume', taskId: msg.taskId })
              .catch((e) => ({ ok: false, error: String(e) }));
            if (!r || !r.ok) {
              // 引擎已经不记得这个任务了（后台被回收/扩展重载）：别让卡片卡在「已暂停」
              const t = tasks.get(msg.taskId);
              if (t && t.status === 'paused') {
                t.status = 'interrupted';
                t.error = (r && r.error) || '后台已重启，断点丢失';
                await saveTasks();
              }
            }
            sendResponse(r || { ok: false });
            break;
          }
          case 'save': {
            await ensureOffscreen();
            const r = await chrome.runtime
              .sendMessage({ target: 'offscreen', type: 'save', taskId: msg.taskId })
              .catch((e) => ({ ok: false, error: String(e) }));
            if (r && r.ok === false && r.error === '任务已结束') {
              const t = tasks.get(msg.taskId);
              if (t && (t.status === 'paused' || t.status === 'saving' || t.status === 'pausing')) {
                t.status = 'interrupted';
                t.error = '后台已重启，断点丢失';
                await saveTasks();
              }
            }
            sendResponse(r || { ok: false });
            break;
          }
          case 'probe': {
            await ensureOffscreen();
            const pk = 'probe:' + uid();
            const ref = await applyReferer(pk, msg.url, msg.pageUrl);
            try {
              const r = await chrome.runtime.sendMessage({
                target: 'offscreen', type: 'probe', url: msg.url,
                pageUrl: msg.pageUrl, referer: ref.referer, refererMode: ref.mode
              }).catch((e) => ({ ok: false, error: String(e) }));
              sendResponse(r || { ok: false });
            } finally {
              await releaseReferer(pk);
            }
            break;
          }
          case 'probe-size': {
            // 直链源没拿到 content-length 的，HEAD/Range 补一次，结果回写媒体条目
            await ensureOffscreen();
            const psk = 'probe-size:' + uid();
            const psref = await applyReferer(psk, msg.url, msg.pageUrl);
            try {
              const r = await chrome.runtime.sendMessage({
                target: 'offscreen', type: 'probe-size', url: msg.url,
                pageUrl: msg.pageUrl, referer: psref.referer, refererMode: psref.mode
              }).catch((e) => ({ ok: false, error: String(e) }));
              if (r && r.ok && r.size >= 24 * 1024 && msg.tabId != null) {
                const mm = mediaByTab.get(msg.tabId);
                const it = mm && mm.get(normKey(msg.url));
                // 之前探测被错误体骗过写入的可疑小值也一并顶掉
                if (it && (!it.size || it.size < 24 * 1024)) {
                  it.size = r.size;
                  await persistTab(msg.tabId);
                }
              }
              sendResponse(r || { ok: false });
            } finally {
              await releaseReferer(psk);
            }
            break;
          }
          case 'blob-info': {
            const r = await chrome.tabs.sendMessage(msg.tabId, {
              target: 'cs', type: 'blob-info', recId: msg.recId
            }, { frameId: msg.frameId || 0 }).catch(() => null);
            sendResponse(r || { ok: false });
            break;
          }
          case 'record-start':
          case 'record-stop': {
            const r = await chrome.tabs.sendMessage(msg.tabId, {
              target: 'cs', type: msg.type, recId: msg.recId
            }, { frameId: msg.frameId || 0 }).catch(() => null);
            sendResponse(r || { ok: false });
            break;
          }
          case 'record-drop': {
            // 导出完成或用户放弃后，页面侧那份录制没有留的必要：
            // 让页面删掉落在站点磁盘区里的分片，同时撤掉列表里已经取不到数据的卡片
            const r = await chrome.tabs.sendMessage(msg.tabId, {
              target: 'cs', type: 'record-drop', recId: msg.recId
            }, { frameId: msg.frameId || 0 }).catch(() => null);
            if (msg.tabId != null && msg.recId) {
              const m = await getTabMap(msg.tabId);
              let hit = false;
              for (const [k, it] of m) {
                if (it.recId && it.recId === msg.recId) { m.delete(k); hit = true; }
              }
              if (hit) {
                await persistTab(msg.tabId);
                updateBadge(msg.tabId);
                notifyPopup();
              }
            }
            sendResponse(r || { ok: false });
            break;
          }
          case 'clear-tasks': {
            for (const [k, t] of tasks) {
              if (['done', 'error', 'canceled', 'interrupted'].includes(t.status)) tasks.delete(k);
            }
            await saveTasks();
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});
