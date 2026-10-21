/**
 * lib/fsdir.js — 写进「用户自己选的文件夹」
 *
 * chrome.downloads 只能落在浏览器的默认下载目录里，filename 传绝对路径会被拒。
 * 想真的写到别处，只能走 File System Access：在设置页（有用户手势）弹一次目录选择器，
 * 把拿到的 FileSystemDirectoryHandle 存进 IDB —— 句柄可结构化克隆，Chrome 允许这么存。
 *
 * 之后 offscreen 引擎（同一个 chrome-extension:// 源）再来取这个句柄直接写文件。
 * 写之前必须查权限：授权是按源记的、会持久化，但用户可能在 chrome://settings 里撤掉。
 * 查不到 readwrite 就退回浏览器下载目录，不要静默失败。
 */

const DB_NAME = 'vf-dir';
const DB_VER = 1;
const STORE = 'kv';
const KEY = 'save-dir';

function hasIdb() {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
  } catch {
    return false;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!hasIdb()) return reject(new Error('no-idb'));
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open-failed'));
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('idb-put-failed'));
      tx.onabort = () => reject(tx.error || new Error('idb-put-aborted'));
    });
  } finally {
    db.close();
  }
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error || new Error('idb-get-failed'));
    });
  } finally {
    db.close();
  }
}

async function idbDel(key) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('idb-del-failed'));
    });
  } finally {
    db.close();
  }
}

/** 弹出目录选择器（只能从用户手势里调，且必须是有窗口的页面，offscreen 里不行） */
export async function pickDir() {
  if (typeof showDirectoryPicker !== 'function') {
    const e = new Error('no-picker');
    e.code = 'no-picker';
    throw e;
  }
  try {
    return await showDirectoryPicker({ id: 'vf-save', mode: 'readwrite', startIn: 'downloads' });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) throw e;
    // startIn 在某些版本里不认，去掉再试一次
    return showDirectoryPicker({ id: 'vf-save', mode: 'readwrite' });
  }
}

export async function saveDirHandle(handle) {
  await idbPut(KEY, handle);
  return handle;
}

export async function loadDirHandle() {
  try {
    return await idbGet(KEY);
  } catch {
    return null;
  }
}

export async function clearDirHandle() {
  try {
    await idbDel(KEY);
  } catch {}
}

/** 'granted' | 'prompt' | 'denied' | 'none'（没有句柄） */
export async function permState(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return handle ? 'granted' : 'none';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

/** 只能在用户手势里调；引擎侧没有手势，只能查不能要 */
export async function requestPerm(handle) {
  if (!handle) return false;
  const cur = await permState(handle);
  if (cur === 'granted') return true;
  if (typeof handle.requestPermission !== 'function') return false;
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return false;
    // 权限之类的问题不该被当成「不存在」，往上抛
    throw e;
  }
}

/** 同名不覆盖：name.mp4 → name (2).mp4 */
export async function uniqueName(dir, name) {
  const n = String(name || 'video.mp4');
  if (!(await exists(dir, n))) return n;
  const m = /^(.*?)(\.[^.\\/]+)?$/.exec(n);
  const base = m[1] || n;
  const ext = m[2] || '';
  for (let i = 2; i < 500; i++) {
    const cand = base + ' (' + i + ')' + ext;
    if (!(await exists(dir, cand))) return cand;
  }
  return base + ' ' + Date.now() + ext;
}

/**
 * 把 blob 写进目录。返回真正用的文件名（可能与传入的不同）。
 * 用 createWritable 直接写 blob，不经过 <a download>，也就没有「浏览器默认目录」这层限制。
 *
 * 写入串行化：两个任务同时保存同一个目录时，uniqueName 会双双看到「不重名」，
 * 然后两次 createWritable 落到同一个文件上互相截断。排队写完一个再算下一个。
 */
let writeChain = Promise.resolve();

export function writeBlobTo(dir, name, blob) {
  const run = writeChain.then(() => writeNow(dir, name, blob));
  writeChain = run.catch(() => {});
  return run;
}

async function writeNow(dir, name, blob) {
  const finalName = await uniqueName(dir, name);
  const fh = await dir.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    try {
      await w.abort();
    } catch {}
    throw e;
  }
  return finalName;
}
