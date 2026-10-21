'use strict';

const $ = (id) => document.getElementById(id);
const t = (k, v) => VFI18N.t(k, v);
const tr = (s) => VFI18N.trRuntime(s);

let tabId = null;
let pageUrl = '';
let items = [];
let tasks = [];
let diag = null;
let currentView = 'sources';

const probeCache = new Map();  // url -> probe result
const probing = new Set();
const chosen = new Map();       // 分组键 -> 下拉选项下标
const blobInfo = new Map();    // recId -> info

/* ---------------- 工具 ---------------- */

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtSize(n) {
  if (!n || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(n) {
  if (!n || n <= 0) return '';
  return fmtSize(n) + '/s';
}

function fmtDuration(s) {
  if (!s || s <= 0) return '';
  if (s < 60) return t('unit.sec', { n: Math.max(1, Math.round(s)) });
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return m ? t('unit.hm', { h, m }) : t('unit.h', { h });
  return t('unit.min', { n: m });
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

let toastTimer = null;
function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = el('div');
    t.id = 'toast';
    t.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:44px;background:#1f2328;color:#fff;font-size:12.5px;' +
      'padding:8px 12px;border-radius:8px;z-index:99;box-shadow:0 6px 20px rgba(0,0,0,.25);' +
      'transition:opacity .2s;opacity:0;word-break:break-all;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.style.opacity = '0';
  }, 2600);
}

/* 交给系统默认程序打开已落盘的文件。文件被移走或删掉时，退回「在文件夹中显示」 */
function downloadsOpen(id) {
  return new Promise((resolve, reject) => {
    chrome.downloads.open(id, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve();
    });
  });
}

async function openSaved(id) {
  if (id == null) {
    chrome.downloads.showDefaultFolder();
    return;
  }
  try {
    await downloadsOpen(id);
  } catch {
    toast(t('toast.openFail'));
    try {
      chrome.downloads.show(id);
    } catch {
      chrome.downloads.showDefaultFolder();
    }
  }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bootLang();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  pageUrl = tab ? tab.url || '' : '';

  bindEvents();
  await reload();
  runProbes();
}

/**
 * 语言：先按 localStorage 的镜像定首屏（同步，不会先闪一下另一种语言），
 * 再用 chrome.storage 里的真值校正一次（镜像可能过期：清缓存、改过设置没打开 popup…）。
 */
function bootLang() {
  let choice = 'auto';
  try {
    choice = localStorage.getItem('vf:lang') || 'auto';
  } catch {}
  VFI18N.setLang(choice);
  VFI18N.applyDom(document);

  try {
    chrome.storage.local
      .get('vf:ui')
      .then((got) => {
        const lang = (got && got['vf:ui'] && got['vf:ui'].lang) || 'auto';
        if (lang === VFI18N.choice) return;
        VFI18N.setLang(lang);
        VFI18N.applyDom(document);
        renderSources();
        renderTasks();
        if (currentView === 'diag') renderDiag();
      })
      .catch(() => {});
  } catch {}
}

function showView(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('view-sources').hidden = name !== 'sources';
  $('view-tasks').hidden = name !== 'tasks';
  $('view-diag').hidden = name !== 'diag';
  $('btn-diag').classList.toggle('on', name === 'diag');
  if (name === 'diag') {
    renderDiag();
    reload();
  }
}

function bindEvents() {
  $('btn-refresh').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : tabId;
    probeCache.clear();
    await reload();
    runProbes();
  });

  $('btn-clear').addEventListener('click', async () => {
    if (currentView === 'tasks') {
      await send({ target: 'sw', type: 'clear-tasks' });
      tasks = tasks.filter(isAlive);
      renderTasks();
    } else {
      items = [];
      probeCache.clear();
      await send({ target: 'sw', type: 'clear', tabId });
      renderSources();
    }
  });

  $('btn-settings').addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }).catch(() => {});
    }
  });

  $('btn-diag').addEventListener('click', () => {
    showView(currentView === 'diag' ? 'sources' : 'diag');
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'popup') return;
    if (msg.type === 'refresh') reload();
    if (msg.type === 'task-update') {
      const t = msg.task;
      const i = tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) tasks[i] = t;
      else tasks.unshift(t);
      renderTasks();
    }
  });
}

async function reload() {
  if (tabId == null) return;
  const r = await send({ target: 'sw', type: 'list', tabId });
  if (!r || !r.ok) {
    $('src-hint').textContent = t('err.readFail', { e: tr((r && r.error) || t('err.unknown')) });
    return;
  }
  items = r.items || [];
  tasks = r.tasks || [];
  diag = r.diag || null;
  renderSources();
  renderTasks();
  if (currentView === 'diag') renderDiag();
  refreshBlobInfo();
}

/** blob 源：向页面查询已录制体量 */
async function refreshBlobInfo() {
  const targets = items.filter((i) => i.type === 'blob' && i.recId && !blobInfo.has(i.recId));
  for (const it of targets) {
    const r = await send({ target: 'sw', type: 'blob-info', tabId, frameId: it.frameId, recId: it.recId });
    if (r && r.ok && r.info) {
      blobInfo.set(it.recId, r.info);
      renderSources();
    }
  }
}

/* ---------------- 清晰度探测 ---------------- */

async function runProbes() {
  const targets = items.filter((i) => i.type === 'hls' && !probeCache.has(i.url) && !probing.has(i.url));
  let cursor = 0;
  const CONC = 3;

  async function worker() {
    while (cursor < targets.length) {
      const it = targets[cursor++];
      probing.add(it.url);
      const r = await send({ target: 'sw', type: 'probe', url: it.url, pageUrl: it.pageUrl });
      probing.delete(it.url);
      probeCache.set(it.url, r && r.ok ? r : { ok: false, error: tr((r && r.error) || '') || 'probe-failed' });
      renderSources();
    }
  }

  await Promise.all(new Array(Math.min(CONC, targets.length)).fill(0).map(worker));
}

/* ---------------- 视频源渲染 ---------------- */

/** 同一视频的多档变体共用路径里的长数字 ID，用它聚类成一张卡片 */
function groupKeyOf(item) {
  if (item.type === 'blob') return 'blob:' + (item.recId || item.url);
  try {
    const x = new URL(item.url);
    const seg = x.pathname.split('/').filter(Boolean);
    for (let i = 0; i < seg.length; i++) {
      if (/^\d{8,}$/.test(seg[i])) return x.hostname + '/' + seg[i];
    }
  } catch (e) {}
  return item.url;
}

/** 从 URL 里读分辨率高度，读不到返回 0 */
function heightOf(u) {
  const s = String(u || '');
  const m = /[\/_-](\d{2,4})x(\d{2,4})(?:[\/_.-]|$)/.exec(s);
  if (m) return parseInt(m[2], 10) || 0;
  const p = /[\/_-](\d{3,4})p(?:[\/_.-]|$)/.exec(s);
  return p ? parseInt(p[1], 10) : 0;
}

/** 带非媒体 content-type 的直链是噪音（JSON 接口、网页、图片） */
function isNoise(item) {
  if (item.type !== 'file') return false;
  const mime = String(item.mime || '').toLowerCase();
  const hasExt = /\.(mp4|m4v|webm|mkv|mov|flv|f4v|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i.test(item.url);
  if (!mime) return !hasExt;
  return !/^(video|audio)\/|octet-stream/i.test(mime);
}

/** 文件名里带 audio 字样的，多数是从视频里拆出来的独立音轨（Reddit: CMAF_AUDIO_128.mp4） */
const AUDIO_URL_RE = /(?:^|[\/_.-])audio(?:[\/_.-]|$)/i;
const AUDIO_EXT_RE = /\.(m4a|mp3|aac|oga|opus|flac|wav)(?:[?#]|$)/i;
const VIDEO_CODEC_RE = /avc1|avc3|hvc1|hev1|vp0?8|vp0?9|av01|dvhe|dvh1/i;

function urlPathOf(u) {
  try {
    return new URL(u).pathname;
  } catch (e) {
    return String(u || '');
  }
}

/**
 * 纯音频源：下下来只有声音没有画面。
 * 它们在页面里和视频并列出现（Reddit 的 CMAF_AUDIO_64.mp4 / CMAF_AUDIO_128.m3u8），
 * 混在视频列表里只会让人误选，所以要单独归到一处。
 */
function isAudioOnly(item) {
  if (!item || item.type === 'blob') return false;
  if (/^audio\//i.test(String(item.mime || ''))) return true;
  const p = urlPathOf(item.url);
  const base = p.split('/').pop() || '';
  if (AUDIO_EXT_RE.test(p)) return true;
  // 「audio-video.mp4」这种名字里同时有 video 的不算，避免把视频误判成音轨
  if (AUDIO_URL_RE.test(base) && !/video/i.test(base)) return true;
  if (item.type !== 'hls') return false;
  const r = probeCache.get(item.url);
  if (!r || !r.ok || r.type !== 'master') return false;
  const vs = r.variants || [];
  // 只有全部档位都明确给出视频编码、且没有一个是视频，才敢判定
  if (!vs.length || !vs.every((v) => v.codecs)) return false;
  return vs.every((v) => !VIDEO_CODEC_RE.test(v.codecs));
}

/** 变体的有效高度：引擎返回的是 {width,height} 对象，测试/旧数据可能是 "1920x1080" 字符串 */function variantHeight(v) {
  const r = v && v.resolution;
  if (r && typeof r === 'object') {
    const w = parseInt(r.width, 10) || 0;
    const h = parseInt(r.height, 10) || 0;
    // 竖屏视频按短边计档位（1080x1920 也是 1080p）
    if (w && h) return Math.min(w, h);
    return h || w || 0;
  }
  const s = String(r || '');
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(s);
  if (m) return Math.min(parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
  return heightOf((v && v.uri) || '');
}

/** 编码器优先级：同一个分辨率常同时给 avc 与 vp9/av1，优先选兼容性最好的 */
function codecRank(codecs) {
  const c = String(codecs || '').toLowerCase();
  if (/avc1|avc3/.test(c)) return 0;
  if (/hvc1|hev1/.test(c)) return 1;
  if (/vp09|vp9/.test(c)) return 2;
  if (/av01/.test(c)) return 3;
  return 4;
}

/**
 * 同一分辨率的多套编码只留一个选项。
 * Reddit 这类站点 720p 会同时给 H.264 与 VP9 两路，下拉里重复出现只会让人选错。
 */
function dedupeVariants(vs) {
  const best = new Map();
  for (const v of vs) {
    const h = variantHeight(v);
    const key = h ? 'h' + h : 'u' + (v.uri || '');
    const cur = best.get(key);
    if (!cur) {
      best.set(key, v);
      continue;
    }
    const dr = codecRank(v.codecs) - codecRank(cur.codecs);
    if (dr < 0 || (dr === 0 && (v.bandwidth || 0) > (cur.bandwidth || 0))) best.set(key, v);
  }
  return [...best.values()];
}

/** 把一组的成员摊平成下拉选项：HLS 各档在前，直链变体在后 */
function buildOptions(group) {
  const opts = [];
  for (const it of group.items) {
    if (it.type === 'hls') {
      const p = probeCache.get(it.url);
      const raw = p && p.ok && p.variants ? p.variants : null;
      const vs = raw ? dedupeVariants(raw) : null;
      const ok = p && p.ok;
      if (vs && vs.length > 1) {
        vs.forEach((v, i) => {
          const h = variantHeight(v);
          opts.push({
            label: (v.label || (h ? h + 'p' : t('quality.n', { n: i + 1 }))) + ' · HLS',
            item: it,
            variant: v.index != null ? v.index : i,
            uri: v.uri || '',
            height: h,
            rank: 0
          });
        });
      } else if (ok) {
        opts.push({ label: t('quality.original'), item: it, variant: 0, height: 0, rank: 1 });
      } else {
        // 解析失败时排到最后，避免盖过可用的直链变体
        opts.push({ label: t('quality.unparsed'), item: it, variant: 0, height: 0, rank: 5 });
      }
    } else if (it.type === 'blob') {
      opts.push({ label: t('opt.record'), item: it, variant: null, height: 0, rank: 4 });
    } else if (it.type === 'dash') {
      opts.push({ label: t('opt.dash', { mime: it.mime || 'stream' }), item: it, variant: null, height: 0, rank: 3 });
    } else {
      const h = heightOf(it.url);
      const ext = ((/\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(it.url) || [])[1] || 'file').toUpperCase();
      const size = it.size ? ' · ' + fmtSize(it.size) : '';
      opts.push({
        label: (h ? h + 'p' : t('tag.direct')) + ' · ' + ext + size,
        item: it,
        variant: null,
        height: h,
        rank: 2
      });
    }
  }
  opts.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (b.height || 0) - (a.height || 0)));
  return opts;
}

function tagOfOption(opt) {
  const it = opt.item;
  if (it.type === 'blob') return ['blob', 'BLOB'];
  if (it.type === 'dash') return ['file', 'DASH'];
  if (it.type === 'hls') {
    const p = probeCache.get(it.url);
    return p && p.ok && p.live ? ['live', t('tag.live')] : ['hls', 'HLS'];
  }
  if (/audio\//i.test(it.mime || '')) return ['file', t('tag.audio')];
  const ext = ((/\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(it.url) || [])[1] || '').toUpperCase();
  return ['file', ext || t('tag.direct')];
}

function pickOption(group) {
  const idx = chosen.get(group.key);
  if (idx != null && idx >= 0 && idx < group.options.length) return { opt: group.options[idx], index: idx };
  return { opt: group.options[0], index: 0 };
}

function durationOf(group) {
  for (const it of group.items) {
    if (it.type !== 'hls') continue;
    const p = probeCache.get(it.url);
    if (p && p.ok && p.duration) return p.duration;
  }
  return 0;
}

function renderSources() {
  const list = $('src-list');
  const hint = $('src-hint');

  // 隐藏 master playlist 的子播放列表，避免同一视频重复出现
  const childUrls = new Set();
  probeCache.forEach((r) => {
    if (r && r.ok && r.type === 'master') {
      (r.variants || []).forEach((v) => childUrls.add(v.uri));
    }
  });

  const visible = items.filter((i) => !isNoise(i) && !(i.type === 'hls' && childUrls.has(i.url)));

  // 按视频聚类：一个视频 = 一张卡片
  const groups = [];
  const seen = new Map();
  for (const it of visible) {
    const k = groupKeyOf(it);
    let g = seen.get(k);
    if (!g) {
      g = { key: k, items: [], ts: 0 };
      seen.set(k, g);
      groups.push(g);
    }
    g.items.push(it);
    if ((it.ts || 0) > g.ts) g.ts = it.ts || 0;
  }
  for (const g of groups) g.options = buildOptions(g);

  groups.sort((a, b) => {
    const aBlob = a.items.every((x) => x.type === 'blob') ? 1 : 0;
    const bBlob = b.items.every((x) => x.type === 'blob') ? 1 : 0;
    if (aBlob !== bBlob) return aBlob - bBlob; // 录制流垫底，优先给可直接下载的地址
    return b.ts - a.ts;
  });

  // 纯音频源单独收起来：整组都是音轨才归到那里，混着的卡片仍按视频展示
  const videoGroups = [];
  const audioGroups = [];
  for (const g of groups) (g.items.every(isAudioOnly) ? audioGroups : videoGroups).push(g);

  $('badge-src').textContent = String(videoGroups.length || audioGroups.length);
  list.textContent = '';

  if (!videoGroups.length && !audioGroups.length) {
    hint.classList.remove('hide');
    hint.innerHTML = '';
    hint.appendChild(el('div', null, t('src.empty')));
    if (diag && !diag.hooked) {
      hint.appendChild(el('div', 'note', t('src.noHook')));
    } else if (diag && diag.global && diag.global.seen > 0 && !diag.global.media) {
      hint.appendChild(el('div', 'note', t('src.checkedN', { n: diag.global.seen })));
    } else {
      hint.appendChild(el('div', 'note', t('src.playThenRefresh')));
    }
    hint.appendChild(el('div', 'note', t('src.diagHint')));
    return;
  }
  hint.classList.add('hide');

  for (const g of videoGroups) list.appendChild(groupCard(g));

  if (audioGroups.length) {
    if (!videoGroups.length) {
      // 整页只有音轨，直接摊开，不用再点一次
      for (const g of audioGroups) list.appendChild(groupCard(g, { audio: true }));
    } else {
      const wrap = el('div', 'src-more');
      const box = el('div', 'audio-list');
      box.hidden = true;
      const btn = el('button', 'link-btn', t('audio.more', { n: audioGroups.length }));
      btn.addEventListener('click', () => {
        box.hidden = !box.hidden;
        btn.textContent = box.hidden
          ? t('audio.more', { n: audioGroups.length })
          : t('audio.less', { n: audioGroups.length });
      });
      wrap.appendChild(btn);
      wrap.appendChild(box);
      for (const g of audioGroups) box.appendChild(groupCard(g, { audio: true }));
      list.appendChild(wrap);
    }
  }
}

function groupCard(group, opts = {}) {
  const audioOnly = !!opts.audio;
  const first = group.items[0];
  const { opt, index } = pickOption(group);
  const card = el('div', 'item');
  const row = el('div', 'row');

  const tagOf = (o) => (audioOnly ? ['aud', t('tag.audio')] : tagOfOption(o));
  const btnText = (o) => (audioOnly ? t('btn.downloadAudio') : o.item.type === 'blob' ? t('btn.export') : t('btn.download'));

  const [tagCls, tagText] = tagOf(opt);
  const tagEl = el('span', 'tag ' + tagCls, tagText);
  row.appendChild(tagEl);

  const info = el('div', 'info');
  const title = el('div', 'title');
  title.textContent = first.title || hostOf(first.url) || t('title.untitled');
  info.appendChild(title);

  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, hostOf(first.url)));
  if (group.options.length > 1) meta.appendChild(el('span', 'dot', t('quality.count', { n: group.options.length })));
  const dur = durationOf(group);
  if (dur) meta.appendChild(el('span', 'dot', fmtDuration(dur)));
  const idm = /\/(\d{8,})(?:\/|$)/.exec(first.url);
  if (idm) meta.appendChild(el('span', 'dot', '#' + idm[1].slice(-6)));
  if (audioOnly) meta.appendChild(el('span', 'dot', t('meta.audioOnly')));
  if (opt.item.type === 'blob') {
    const bi = blobInfo.get(opt.item.recId);
    meta.appendChild(el('span', 'dot', bi && bi.bytes ? t('meta.recorded', { size: fmtSize(bi.bytes) }) : t('meta.waitPlay')));
  }
  info.appendChild(meta);
  row.appendChild(info);
  card.appendChild(row);

  const ops = el('div', 'ops');
  let sel = null;
  if (group.options.length > 1) {
    sel = document.createElement('select');
    sel.className = 'variant';
    group.options.forEach((o, i) => {
      const op = document.createElement('option');
      op.value = String(i);
      op.textContent = o.label;
      sel.appendChild(op);
    });
    sel.value = String(index);
    ops.appendChild(sel);
  } else {
    ops.appendChild(el('div', 'meta', ''));
  }

  /** 以 DOM 当前选中项为准取选项，避免拿到渲染时的旧快照 */
  function currentOption() {
    if (sel) {
      const i = Number(sel.value);
      if (group.options[i]) return group.options[i];
    }
    return pickOption(group).opt;
  }

  const btn = el('button', 'btn', btnText(opt));

  function syncCard(o) {
    const [cls, txt] = tagOf(o);
    tagEl.className = 'tag ' + cls;
    tagEl.textContent = txt;
    btn.textContent = btnText(o);
  }

  if (sel) {
    sel.addEventListener('change', () => {
      chosen.set(group.key, Number(sel.value));
      syncCard(currentOption());
    });
  }
  btn.addEventListener('click', async () => {
    // 必须在点击这一刻取选中项：用户改了下拉却没触发重渲染时，闭包里的 opt 是旧的
    const cur = currentOption();
    const isBlob = cur.item.type === 'blob';
    btn.disabled = true;
    btn.textContent = t('btn.starting');
    try {
      await startDownload(cur.item, cur.variant, cur.uri);
    } finally {
      btn.disabled = false;
      btn.textContent = isBlob ? t('btn.export') : t('btn.download');
    }
  });
  ops.appendChild(btn);
  card.appendChild(ops);

  return card;
}

/* ---------------- 发起下载 ---------------- */

async function startDownload(item, variant, variantUri) {
  const kind = item.type === 'hls' ? 'hls' : item.type === 'blob' ? 'blob' : 'file';

  if (kind === 'blob') {
    const r = await send({ target: 'sw', type: 'blob-info', tabId, frameId: item.frameId, recId: item.recId });
    if (!r || !r.ok) {
      toast(t('toast.recFail', { e: tr((r && r.error) || t('err.unknown')) }));
      return;
    }
    const bytes = (r.info && r.info.bytes) || 0;
    if (!bytes) {
      toast(t('toast.noRecData'));
      return;
    }
    if (bytes < 200 * 1024) {
      toast(t('toast.recTooSmall', { size: fmtSize(bytes) }));
      return;
    }
  }

  const v = kind === 'hls' ? (variant != null ? variant : 0) : null;

  const r = await send({
    target: 'sw',
    type: 'start',
    kind,
    url: item.url,
    title: item.title || hostOf(item.url) || 'video',
    pageUrl: item.pageUrl || pageUrl,
    tabId,
    frameId: item.frameId || 0,
    recId: item.recId || null,
    mime: item.mime || '',
    variant: v,
    variantUri: kind === 'hls' ? (variantUri || '') : ''
  });

  if (!r || !r.ok) {
    toast(t('toast.startFail', { e: tr((r && r.error) || t('err.unknown')) }));
    return;
  }
  switchToTasks();
  if (r.engine && r.engine.ok === false) {
    toast(t('toast.engineWarn', { e: tr(r.engine.error || '') }));
  }
}

function switchToTasks() {
  currentView = 'tasks';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'tasks'));
  $('view-sources').hidden = true;
  $('view-tasks').hidden = false;
  reload();
}

/* ---------------- 任务渲染 ---------------- */

const STATUS_KEY = {
  queued: 'status.queued',
  running: 'status.running',
  pausing: 'status.pausing',
  paused: 'status.paused',
  saving: 'status.saving',
  done: 'status.done',
  error: 'status.error',
  canceled: 'status.canceled',
  interrupted: 'status.interrupted'
};

function statusText(s) {
  return STATUS_KEY[s] ? t(STATUS_KEY[s]) : s;
}

/** 还没结束的任务（含暂停中/保存中） */
const LIVE_STATUS = ['running', 'queued', 'pausing', 'paused', 'saving'];
const isAlive = (t) => LIVE_STATUS.includes(t.status);

/* ---------------- 诊断视图 ---------------- */

function shortUrl(u, max) {
  const s = String(u || '');
  try {
    const x = new URL(s);
    const p = x.pathname || '/';
    const m = max || 44;
    return x.hostname + (p.length > m ? p.slice(0, m) + '…' : p);
  } catch {
    const m = max || 56;
    return s.length > m ? s.slice(0, m) + '…' : s;
  }
}

function renderDiag() {
  const box = $('diag-box');
  box.textContent = '';
  if (!diag) {
    box.appendChild(el('div', 'diag-note', t('diag.empty')));
    return;
  }
  const g = diag.global || {};
  const addNote = (s) => box.appendChild(el('div', 'diag-note', s));
  const addTitle = (s) => box.appendChild(el('div', 'diag-title', s));
  const addRow = (k, v, cls) => {
    const r = el('div', 'diag-row');
    r.appendChild(el('span', 'diag-k', k));
    r.appendChild(el('span', 'diag-v' + (cls ? ' ' + cls : ''), v));
    box.appendChild(r);
  };

  addTitle(t('diag.inject'));
  if (diag.hooked) {
    addRow(t('diag.status'), t('diag.injected', { n: diag.hooks.length }), 'ok');
    diag.hooks.forEach((h) => addRow(t('diag.frame', { n: h.frameId }), shortUrl(h.url)));
  } else {
    addRow(t('diag.status'), t('diag.notDetected'), 'warn');
    addNote(t('diag.injectNote'));
  }

  addTitle(t('diag.net'));
  addRow(t('diag.seen'), t('diag.count', { n: g.seen || 0 }));
  addRow(t('diag.mediaHits'), t('diag.count', { n: g.media || 0 }), g.media ? 'ok' : '');
  const orph =
    t('diag.count', { n: g.orphan || 0 }) +
    (g.orphanResolved ? t('diag.orphanResolved', { n: g.orphanResolved }) : '');
  addRow(t('diag.orphan'), orph);

  addTitle(t('diag.ignored'));
  const ig = (diag.ignored || []).slice().reverse();
  if (!ig.length) {
    addNote(t('diag.none'));
  } else {
    ig.forEach((x) => {
      const d = el('div', 'diag-item');
      const u = el('div', 'diag-url', x.url);
      u.title = t('diag.copy', { url: x.url });
      d.appendChild(u);
      d.appendChild(el('div', 'diag-ct', (x.ct || t('diag.ctNone')) + '  ·  ' + x.type));
      d.addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(x.url);
          toast(t('toast.copied'));
        } catch (e) {}
      });
      box.appendChild(d);
    });
  }
}

function renderTasks() {
  const list = $('task-list');
  const hint = $('task-hint');
  const active = tasks.filter(isAlive);
  $('badge-task').textContent = String(active.length);

  list.textContent = '';
  if (!tasks.length) {
    hint.classList.remove('hide');
    $('foot-info').textContent = t('foot.waiting');
    return;
  }
  hint.classList.add('hide');

  for (const t of tasks) {
    list.appendChild(taskCard(t));
  }

  const running = tasks.find((t) => t.status === 'running');
  if (running) {
    const speed = fmtSpeed(running.speed);
    $('foot-info').textContent =
      (active.length > 1 ? t('foot.nTasks', { n: active.length }) : '') +
      (speed ? t('foot.totalSpeed', { speed }) : t('foot.downloading'));
  } else if (tasks.some((t) => t.status === 'paused' || t.status === 'pausing')) {
    $('foot-info').textContent = t('foot.paused');
  } else {
    $('foot-info').textContent = t('foot.count', { n: tasks.length });
  }
}

function taskCard(task) {
  const card = el('div', 'task');
  const alive = task.status === 'running' || task.status === 'queued' || task.status === 'pausing' || task.status === 'paused' || task.status === 'saving';

  const head = el('div', 'head');
  const name = el('div', 'tname', task.title || t('title.untitled'));
  name.title = task.title || '';
  head.appendChild(name);

  const pct = el('div', 'pct');
  if (task.status === 'done') pct.textContent = t('pct.done');
  else if (task.status === 'error') pct.textContent = t('pct.fail');
  else if (task.status === 'pausing') pct.textContent = t('pct.pause');
  else if (task.status === 'paused') pct.textContent = task.progress > 0 ? Math.round(task.progress) + '%' : t('pct.pause');
  else if (task.status === 'saving') pct.textContent = t('pct.save');
  else if (task.progress === -1 || task.progress == null) pct.textContent = '…';
  else pct.textContent = Math.round(task.progress) + '%';
  if (task.status === 'done') pct.classList.add('status-done');
  if (task.status === 'error') pct.classList.add('status-error');
  if (task.status === 'paused' || task.status === 'pausing') pct.classList.add('status-paused');
  if (task.status === 'saving') pct.classList.add('status-saving');
  head.appendChild(pct);
  card.appendChild(head);

  const bar = el('div', 'bar');
  const fill = el('i');
  const indeterminate = (task.progress === -1 || task.progress == null) && task.status === 'running';
  if (indeterminate) bar.classList.add('indet');
  if (task.status === 'paused' || task.status === 'pausing') bar.classList.add('paused');
  fill.style.width = (task.progress > 0 ? Math.min(100, task.progress) : 0) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  const sub = el('div', 'sub');
  const left = el('span');
  const right = el('span');

  const parts = [];
  if (alive || task.status === 'saving') {
    if (task.variantLabel) parts.push(task.variantLabel);
    if (task.live) parts.push(t('sub.live'));
    if (task.segmentsTotal) parts.push(t('sub.segments', { a: task.segmentsDone || 0, b: task.segmentsTotal }));
    if (task.received) parts.push(fmtSize(task.received));
    left.textContent = parts.join(' · ') || t('sub.connecting');
    if (task.status === 'paused' && task.snapError) right.title = tr(task.snapError);
    if (task.status === 'pausing') right.textContent = t('sub.stopping');
    else if (task.status === 'saving') right.textContent = t('sub.savingNow');
    else if (task.status === 'paused') {
      right.textContent = task.snapError
        ? t('sub.pausedSnapFail')
        : task.snapAt
          ? t('sub.pausedSnap', { size: fmtSize(task.snapSize) })
          : t('sub.paused');
    } else right.textContent = fmtSpeed(task.speed) || statusText(task.status);
  } else if (task.status === 'done') {
    left.textContent = '';
    const head = [];
    if (task.variantLabel) head.push(task.variantLabel);
    if (task.fileSize) head.push(fmtSize(task.fileSize));
    left.textContent = head.join(' · ');
    // 只在确实读到音轨时才标一句：读不到不代表没有（moov 缺失、直播、合并前的中间态都可能）
    if (task.hasAudio) left.appendChild(el('span', 'track-ok', t('sub.audioYes')));
    if (task.live) left.appendChild(el('span', null, ' · ' + t('sub.live')));
    if (task.partial && !task.live) {
      left.appendChild(el('span', 'track-part', t('sub.upTo', { n: Math.round(task.progress || 0) })));
    }
    if (task.savedTo === 'dir' && task.dirName) {
      left.appendChild(el('span', 'track-part', t('sub.savedToDir', { dir: task.dirName })));
    } else if (task.saveWarn) {
      left.appendChild(el('span', 'track-none', ' · ' + t('set.fallback')));
    }
    right.textContent = t('sub.saved');
  } else if (task.status === 'error' || task.status === 'interrupted') {
    left.textContent = '';
    left.style.color = 'var(--live)';
    left.textContent = task.error ? tr(task.error) : task.status === 'interrupted' ? t('sub.interrupted') : t('sub.failed');
    left.style.whiteSpace = 'nowrap';
    left.style.overflow = 'hidden';
    left.style.textOverflow = 'ellipsis';
    left.style.maxWidth = '250px';
    right.textContent = '';
  } else {
    left.textContent = task.received ? fmtSize(task.received) : '';
    right.textContent = statusText(task.status);
  }

  sub.appendChild(left);
  sub.appendChild(right);
  card.appendChild(sub);

  const acts = el('div', 'acts');

  if (alive) {
    // 录制类任务的数据在页面侧，暂停等于放弃，所以只给「停止并保存」
    if (task.kind !== 'blob') {
      const paused = task.status === 'paused';
      const pausing = task.status === 'pausing';
      const saving = task.status === 'saving';
      const pb = el('button', 'btn ghost sm', paused ? t('btn.resume') : pausing ? t('btn.pausing') : t('btn.pause'));
      pb.title = paused ? t('title.resumeBtn') : t('title.pauseBtn');
      pb.disabled = pausing || saving;
      pb.addEventListener('click', async () => {
        pb.disabled = true;
        pb.textContent = paused ? t('btn.resuming') : t('btn.pausing');
        // 本地先切状态：卡片立刻变，不用等后台回话（回话后再按真实状态重渲染）
        const local = tasks.find((x) => x.id === task.id);
        if (local) {
          local.status = paused ? 'running' : 'pausing';
          if (paused) local.speed = 0;
          renderTasks();
        }
        const r = await send({ target: 'sw', type: paused ? 'resume' : 'pause', taskId: task.id });
        if (!r || r.ok === false) {
          toast((r && tr(r.error)) || t('toast.opFail'));
          reload();
        }
      });
      acts.appendChild(pb);

      if (!task.live) {
        const sb = el('button', 'btn ghost sm', saving ? t('btn.saving') : t('btn.save'));
        sb.title = t('title.saveBtn');
        sb.disabled = saving;
        sb.addEventListener('click', async () => {
          sb.disabled = true;
          sb.textContent = t('btn.saving');
          const r = await send({ target: 'sw', type: 'save', taskId: task.id });
          if (!r || r.ok === false) {
            toast((r && tr(r.error)) || t('toast.saveFail'));
            reload();
          }
        });
        acts.appendChild(sb);
      }

      if (task.status === 'paused' && task.snapAt) {
        if (task.snapSavedTo === 'dir') {
          // 写进自定义文件夹时没有 downloadId，浏览器打不开那个目录，只报位置
          const tag = el('span', 'meta', task.snapDirName || '');
          tag.title = t('title.dirSave');
          acts.appendChild(tag);
        } else {
          const ob = el('button', 'btn ghost sm', t('btn.openSnap'));
          ob.title = task.snapName || t('title.openSnap');
          ob.addEventListener('click', () => openSaved(task.snapDownloadId));
          acts.appendChild(ob);
        }
      }
    }

    const b = el('button', 'btn ghost sm', task.live || task.kind === 'blob' ? t('btn.stopSave') : t('btn.cancel'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = t('btn.working');
      await send({ target: 'sw', type: 'cancel', taskId: task.id });
    });
    acts.appendChild(b);
  } else if (task.status === 'done') {
    // 存进自定义文件夹时没有 downloadId，浏览器也没法替我们打开那个目录：
    // 就不放按钮了，目录名已经在副标题里
    if (task.savedTo !== 'dir') {
      if (task.downloadId != null) {
        const ob = el('button', 'btn ghost sm', t('btn.openFile'));
        ob.title = t('title.openFile');
        ob.addEventListener('click', () => openSaved(task.downloadId));
        acts.appendChild(ob);
      }
      const b = el('button', 'btn ghost sm', t('btn.openFolder'));
      b.addEventListener('click', () => {
        if (task.downloadId != null) chrome.downloads.show(task.downloadId);
        else chrome.downloads.showDefaultFolder();
      });
      acts.appendChild(b);
    }
  }
  if (acts.children.length) card.appendChild(acts);

  return card;
}

/* ---------------- 启动 ---------------- */

init();
