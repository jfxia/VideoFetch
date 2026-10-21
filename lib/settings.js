/**
 * lib/settings.js — 用户设置（存储位置 / 界面语言）
 *
 * 两个键：
 *   vf:save  { mode: 'downloads' | 'dir', sub: 'VideoFetch', dirName: '' }
 *            mode=downloads：走 chrome.downloads，filename 里带 sub 子目录
 *            mode=dir      ：写进用户在设置页亲手选的文件夹（句柄存在 lib/fsdir.js 的 IDB 里）
 *   vf:ui    { lang: 'auto' | 'en' | 'zh' }
 *
 * 引擎（offscreen）、后台（SW）、设置页共用这一份，免得各自读同一份数据时规则不一致。
 * chrome.storage 不存在时（Node 测试）返回默认值，不抛错。
 */

export const SAVE_DEFAULTS = { mode: 'downloads', sub: 'VideoFetch', dirName: '' };
export const UI_DEFAULTS = { lang: 'auto' };
export const DEFAULT_SUB = 'VideoFetch';

export const SAVE_KEY = 'vf:save';
export const UI_KEY = 'vf:ui';

const MAX_SUB = 60;

function local() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch {}
  return null;
}

/**
 * 子目录：只允许相对路径。
 * 绝对路径、盘符、`..` 一律削掉 —— chrome.downloads 本来也会拒绝，
 * 但被拒绝时是整个下载失败，不如在这里先修好。
 */
export function normSub(input) {
  let s = String(input == null ? '' : input);
  // 盘符要先去掉：留在后面会被当成非法字符剔掉冒号，变成「CUsers」
  s = s.replace(/^[a-zA-Z]:[\\/]/, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f<>:"|?*\\]/g, '');
  s = s.split('/').map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..').join('/');
  s = s.replace(/^\/+|\/+$/g, '');
  if (s.length > MAX_SUB) s = s.slice(0, MAX_SUB).replace(/\/+$/, '');
  return s;
}

/** 下载目录模式下，文件名要带的相对路径 */
export function subPath(sub) {
  const s = normSub(sub);
  return s ? s + '/' : '';
}

function pickSave(raw) {
  const s = Object.assign({}, SAVE_DEFAULTS, raw || {});
  s.sub = normSub(s.sub);
  if (s.mode !== 'dir') s.mode = 'downloads';
  // 说了用自定义文件夹却没选过，只能退回下载目录，否则没人知道该写哪儿
  if (s.mode === 'dir' && !s.dirName) s.mode = 'downloads';
  return s;
}

export async function getSave() {
  const st = local();
  if (!st) return pickSave(null);
  try {
    const got = await st.get(SAVE_KEY);
    return pickSave(got && got[SAVE_KEY]);
  } catch {
    return pickSave(null);
  }
}

export async function setSave(patch) {
  const cur = await getSave();
  const next = pickSave(Object.assign({}, cur, patch || {}));
  const st = local();
  if (st) {
    try {
      await st.set({ [SAVE_KEY]: next });
    } catch {}
  }
  return next;
}

export async function getUi() {
  const st = local();
  if (!st) return Object.assign({}, UI_DEFAULTS);
  try {
    const got = await st.get(UI_KEY);
    const v = Object.assign({}, UI_DEFAULTS, got && got[UI_KEY]);
    if (!['auto', 'en', 'zh'].includes(v.lang)) v.lang = 'auto';
    return v;
  } catch {
    return Object.assign({}, UI_DEFAULTS);
  }
}

export async function setUi(patch) {
  const cur = await getUi();
  const next = Object.assign({}, cur, patch || {});
  if (!['auto', 'en', 'zh'].includes(next.lang)) next.lang = 'auto';
  const st = local();
  if (st) {
    try {
      await st.set({ [UI_KEY]: next });
    } catch {}
  }
  return next;
}

/**
 * 语言设置还要镜像到 localStorage。
 * chrome.storage 是异步的，popup 打开时若等它回来才渲染，会先闪一帧中文/英文；
 * localStorage 同步可读，正好用来定首屏语言。
 */
export const LANG_MIRROR = 'vf:lang';

export function readLangMirror() {
  try {
    return localStorage.getItem(LANG_MIRROR) || '';
  } catch {
    return '';
  }
}

export function writeLangMirror(lang) {
  try {
    localStorage.setItem(LANG_MIRROR, String(lang || 'auto'));
  } catch {}
}
