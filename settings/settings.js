/**
 * settings/settings.js — 设置页
 *
 * 两件事：
 *   1) 视频存到哪：浏览器下载目录（可加子目录）或用户自己选的文件夹
 *   2) 界面语言：跟随浏览器 / English / 简体中文（默认英文）
 *
 * 目录选择器必须在这里弹：popup 一失焦就关，选择框还没回来页面就没了。
 * 选完的句柄交给 lib/fsdir.js 存进 IDB，引擎从那边取来写文件。
 */

import {
  getSave, setSave, getUi, setUi, normSub,
  writeLangMirror, readLangMirror, DEFAULT_SUB
} from '../lib/settings.js';
import {
  pickDir, saveDirHandle, loadDirHandle, clearDirHandle, permState, requestPerm
} from '../lib/fsdir.js';

const $ = (id) => document.getElementById(id);
const t = (k, v) => VFI18N.t(k, v);

let save = { mode: 'downloads', sub: DEFAULT_SUB, dirName: '' };
let handle = null;
let perm = 'none';

/* ---------------- 语言 ---------------- */

function langName(l) {
  return l === 'zh' ? '简体中文' : 'English';
}

function applyLang(choice) {
  VFI18N.setLang(choice);
  VFI18N.applyDom(document);
  $('lang-auto').textContent = t('set.langAuto', { lang: langName(VFI18N.browserLang()) });
  document.title = t('set.title');
}

/* ---------------- 渲染 ---------------- */

async function render() {
  // 保存位置
  $('mode-downloads').checked = save.mode === 'downloads';
  $('mode-dir').checked = save.mode === 'dir';
  $('opt-downloads').classList.toggle('on', save.mode === 'downloads');
  $('opt-dir').classList.toggle('on', save.mode === 'dir');
  $('opt-downloads').classList.toggle('dim', save.mode !== 'downloads');
  $('opt-dir').classList.toggle('dim', save.mode !== 'dir');

  if (document.activeElement !== $('sub')) $('sub').value = save.sub || '';

  // 自定义文件夹
  if (!handle) {
    perm = 'none';
    $('dir-name').textContent = t('set.noDir');
  } else {
    perm = await permState(handle);
    $('dir-name').textContent = handle.name || '—';
  }
  const pill = $('perm');
  const map = {
    granted: ['pill-ok', t('set.permGranted')],
    prompt: ['pill-warn', t('set.permPrompt')],
    denied: ['pill-warn', t('set.permDenied')],
    none: ['pill-none', t('set.permNone')]
  };
  const [cls, txt] = map[perm] || map.none;
  pill.className = 'pill ' + cls;
  pill.textContent = txt;

  $('btn-pick').textContent = handle ? t('set.change') : t('set.pick');
  $('btn-reauth').hidden = !handle || perm === 'granted';
  $('btn-forget').hidden = !handle;

  // 语言
  const ui = await getUi();
  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.checked = r.value === ui.lang;
    r.closest('.lang').classList.toggle('on', r.checked);
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

/* ---------------- 事件 ---------------- */

async function chooseDir() {
  try {
    const picked = await pickDir();
    handle = picked;
    await saveDirHandle(picked);
    const granted = await requestPerm(picked);
    save = await setSave({ mode: 'dir', dirName: picked.name || '' });
    toast(granted ? t('set.dirPicked', { name: picked.name }) : t('set.permFail'));
  } catch (e) {
    const name = String((e && e.name) || '');
    if (name === 'AbortError') return;           // 用户自己取消的，不算错
    if (e && e.code === 'no-picker') toast(t('set.pickerMissing'));
    else toast(String((e && e.message) || e));
  }
  await render();
}

function bind() {
  $('mode-downloads').addEventListener('change', async () => {
    save = await setSave({ mode: 'downloads' });
    await render();
  });

  $('mode-dir').addEventListener('change', async () => {
    if (!handle) {
      await chooseDir();
      // 没选成（取消 / 没权限）：退回下载目录，别让单选框停在一个用不了的状态
      if (!handle) {
        $('mode-downloads').checked = true;
        save = await setSave({ mode: 'downloads' });
        await render();
      }
    } else {
      save = await setSave({ mode: 'dir', dirName: handle.name || '' });
      const granted = await requestPerm(handle);
      if (!granted) toast(t('set.permFail'));
      await render();
    }
  });

  $('btn-pick').addEventListener('click', chooseDir);

  $('btn-reauth').addEventListener('click', async () => {
    if (!handle) return;
    const ok = await requestPerm(handle);
    toast(ok ? t('set.permGranted') : t('set.permFail'));
    await render();
  });

  $('btn-forget').addEventListener('click', async () => {
    await clearDirHandle();
    handle = null;
    perm = 'none';
    save = await setSave({ mode: 'downloads', dirName: '' });
    toast(t('set.dirCleared'));
    await render();
  });

  $('btn-open-folder').addEventListener('click', () => {
    try {
      chrome.downloads.showDefaultFolder();
    } catch {}
  });

  const sub = $('sub');
  const commitSub = async () => {
    const want = sub.value;
    const fixed = normSub(want);
    save = await setSave({ sub: fixed || DEFAULT_SUB });
    if (sub.value !== save.sub) sub.value = save.sub;
    if (normSub(want) === '' && want.trim()) toast(t('set.subNote'));
  };
  sub.addEventListener('change', commitSub);
  sub.addEventListener('blur', commitSub);
  sub.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sub.blur();
  });

  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const ui = await setUi({ lang: r.value });
      writeLangMirror(ui.lang);
      applyLang(ui.lang);
      await render();
      toast(t('set.saved'));
    });
  });
}

/* ---------------- 启动 ---------------- */

(async function boot() {
  applyLang(readLangMirror() || 'auto');
  bind();

  save = await getSave();
  handle = await loadDirHandle();
  const ui = await getUi();
  writeLangMirror(ui.lang);
  applyLang(ui.lang);

  // 存了「自定义文件夹」但句柄没了：给出明确说明，而不是让它静默退回下载目录
  await render();
  if (save.dirName && !handle) toast(t('set.dirMissing'));
})();
