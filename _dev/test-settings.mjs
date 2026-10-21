/**
 * _dev/test-settings.mjs — 设置（存储位置 / 界面语言）测试
 *
 * 覆盖四块：
 *   1) 子目录规整：绝对路径、盘符、`..`、非法字符都要被吃掉
 *   2) 设置的读写与兜底：没选过文件夹就不能停在 dir 模式
 *   3) 界面语言：中英词表对齐、占位符一致、英文是默认、引擎错误会翻译
 *   4) 写自定义文件夹：同名不覆盖、写进去的内容一字不差
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}

/* chrome.storage 桩：设置模块靠它持久化 */
const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in mem ? { [k]: mem[k] } : {}),
      set: async (o) => Object.assign(mem, o)
    }
  }
};

const S = await import('../lib/settings.js');
const F = await import('../lib/fsdir.js');
await import('../lib/i18n.js');
const I = globalThis.VFI18N;

/* ---------- 1. 子目录规整 ---------- */
console.log('\n[1] 子目录规整');
ok(S.normSub('VideoFetch') === 'VideoFetch', '普通名字原样保留');
ok(S.normSub('/abs/path/') === 'abs/path', '去掉首尾斜杠', S.normSub('/abs/path/'));
ok(S.normSub('C:\\Users\\me') === 'Usersme', '盘符与反斜杠被削掉', S.normSub('C:\\Users\\me'));
ok(S.normSub('a/../b') === 'a/b', '`..` 段被丢掉', S.normSub('a/../b'));
ok(S.normSub('../../etc') === 'etc', '前导 `..` 也丢', S.normSub('../../etc'));
ok(S.normSub('x'.repeat(100)).length === 60, '超长截断到 60', String(S.normSub('x'.repeat(100)).length));
ok(S.normSub('  Video  /  Shows ') === 'Video/Shows', '去掉每段空白', S.normSub('  Video  /  Shows '));
ok(S.normSub('') === '' && S.normSub(null) === '', '空值不会变成 undefined');
ok(S.normSub('a:b*c?') === 'abc', '非法字符被剔除', S.normSub('a:b*c?'));
ok(S.subPath('Video') === 'Video/', '下载目录前缀带斜杠');
ok(S.subPath('') === '', '空子目录不加前缀');

/* ---------- 2. 设置读写 ---------- */
console.log('\n[2] 设置读写与兜底');
{
  const d = await S.getSave();
  ok(d.mode === 'downloads' && d.sub === 'VideoFetch', '默认：浏览器下载目录 + VideoFetch 子目录', JSON.stringify(d));

  const a = await S.setSave({ sub: '/Shows/../Clips/' });
  ok(a.sub === 'Shows/Clips', '存进去之前先规整', a.sub);

  const b = await S.setSave({ mode: 'dir', dirName: 'D:/Videos' });
  ok(b.mode === 'dir' && b.dirName === 'D:/Videos', '自定义文件夹可以选中');

  const c = await S.setSave({ dirName: '' });
  ok(c.mode === 'downloads', '没有文件夹名时不留在 dir 模式（否则没人知道写哪儿）');

  const e = await S.setSave({ mode: 'nonsense', dirName: 'X' });
  ok(e.mode === 'downloads', '非法模式一律归到 downloads');

  const ui = await S.getUi();
  ok(ui.lang === 'auto', '语言默认跟随浏览器', ui.lang);
  const ui2 = await S.setUi({ lang: 'en' });
  ok(ui2.lang === 'en', '语言可以切到 en');
  const ui3 = await S.setUi({ lang: 'klingon' });
  ok(ui3.lang === 'auto', '不认识的语言值退回 auto');
}

/* ---------- 3. 界面语言 ---------- */
console.log('\n[3] 界面语言');
{
  const en = JSON.parse(readFileSync(join(ROOT, '_locales/en/messages.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(ROOT, '_locales/zh_CN/messages.json'), 'utf8'));
  ok(!!en.extName && !!en.extDesc && !!en.actionTitle, 'en 词表含 name/desc/actionTitle');
  ok(!!zh.extName && !!zh.extDesc && !!zh.actionTitle, 'zh_CN 词表同样齐全');
  ok(zh.extName.message.indexOf('网页视频下载器') >= 0, '中文名正确', zh.extName.message);

  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok(mf.default_locale === 'en', '默认语言是英文', mf.default_locale);
  const used = JSON.stringify(mf).match(/__MSG_(\w+)__/g) || [];
  ok(used.length >= 3, 'manifest 用了本地化占位', used.join(','));
  ok(used.every((u) => en[u.slice(6, -2)]), '占位都能在 en 里找到');
  ok(used.every((u) => zh[u.slice(6, -2)]), '占位都能在 zh 里找到');

  // 词表对齐：缺一条就会出现「界面里冒出个英文 key」
  const all = [];
  const samples = [
    'btn.download', 'status.paused', 'quality.count', 'foot.paused', 'set.saveTitle', 'diag.none'
  ];
  samples.forEach((k) => {
    I.setLang('en');
    const enText = I.t(k);
    I.setLang('zh');
    const zhText = I.t(k);
    all.push([k, enText, zhText]);
    ok(enText !== k && zhText !== k && enText !== zhText, '双语都有：' + k, enText + ' / ' + zhText);
  });
  I.setLang('en');

  // 占位符必须两边一致，否则某种语言会漏掉数字
  ok(I.t('quality.count', { n: 3 }) === '3 qualities', '占位符替换', I.t('quality.count', { n: 3 }));
  I.setLang('zh');
  ok(I.t('quality.count', { n: 3 }) === '3 个清晰度', '中文占位符替换', I.t('quality.count', { n: 3 }));
  ok(I.t('quality.count') === '{n} 个清晰度', '没给变量时保留占位符原样');

  // auto：中文浏览器 → 中文；其余 → 英文（默认）
  const setNav = (language) => Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
  setNav('zh-CN');
  ok(I.setLang('auto') === 'zh', 'auto + 中文浏览器 → zh');
  setNav('en-US');
  ok(I.setLang('auto') === 'en', 'auto + 英文浏览器 → en');
  setNav('ja-JP');
  ok(I.setLang('auto') === 'en', 'auto + 其他语言 → 英文（默认）');
  ok(I.setLang('zh') === 'zh', '手动指定优先于浏览器');

  // 引擎错误翻译
  I.setLang('en');
  ok(I.trRuntime('该 m3u8 没有可用清晰度') === 'This playlist has no usable quality level.', '引擎错误翻成英文');
  ok(I.trRuntime('播放列表解析失败：<html>') === 'Failed to parse the playlist: <html>', '带参数的错误保留参数');
  ok(I.trRuntime('Failed to fetch') === 'Failed to fetch', '本来就是英文的原样返回');
  ok(I.trRuntime('某个没收录的新错误') === '某个没收录的新错误', '没收录的错误不吞掉');
  ok(
    I.trRuntime('HTTP 403（站点启用了防盗链，扩展没能提供正确的来源）').indexOf('referrer') > 0,
    'HTTP 403 的括号说明也翻译',
    I.trRuntime('HTTP 403（站点启用了防盗链，扩展没能提供正确的来源）')
  );
  I.setLang('zh');
  ok(I.trRuntime('该 m3u8 没有可用清晰度') === '该 m3u8 没有可用清晰度', '中文界面不改动错误原文');

  // 静态 HTML 里的 data-i18n 键都必须存在
  for (const page of ['popup/popup.html', 'settings/settings.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)].map((m) => m[1]);
    const missing = [];
    for (const k of keys) {
      I.setLang('en');
      if (I.t(k) === k) missing.push(k);
    }
    ok(keys.length > 5, page + ' 有本地化标记', String(keys.length));
    ok(missing.length === 0, page + ' 的键都在词表里', missing.join(',') || 'ok');
    I.setLang('zh');
    const missingZh = keys.filter((k) => I.t(k) === k);
    ok(missingZh.length === 0, page + ' 的中文键也都齐', missingZh.join(',') || 'ok');
  }
  I.setLang('en');
}

/* ---------- 4. 写自定义文件夹 ---------- */
console.log('\n[4] 写自定义文件夹');
{
  /** 最小目录句柄：getFileHandle 的行为按 Chrome 的规矩来 */
  function fakeDir(name) {
    const files = new Map();
    const dir = {
      name,
      files,
      async getFileHandle(fname, opts) {
        if (files.has(fname)) return files.get(fname);
        if (!opts || !opts.create) {
          const e = new Error('not found');
          e.name = 'NotFoundError';
          throw e;
        }
        const fh = {
          name: fname,
          data: null,
          async createWritable() {
            let buf = '';
            return {
              async write(b) {
                buf = b;
              },
              async close() {
                fh.data = buf;
              },
              async abort() {}
            };
          }
        };
        files.set(fname, fh);
        return fh;
      },
      async queryPermission() {
        return 'granted';
      }
    };
    return dir;
  }

  const dir = fakeDir('Videos');
  const big = new Blob([new Uint8Array(1024 * 1024)], { type: 'video/mp4' });
  const n1 = await F.writeBlobTo(dir, '影片 A.mp4', big);
  ok(n1 === '影片 A.mp4', '第一次用原名', n1);
  ok(dir.files.get(n1).data.size === big.size, '写入的 blob 完整', String(dir.files.get(n1).data.size));

  const n2 = await F.writeBlobTo(dir, '影片 A.mp4', new Blob(['x']));
  ok(n2 === '影片 A (2).mp4', '同名不覆盖，加序号', n2);
  const n3 = await F.writeBlobTo(dir, '影片 A.mp4', new Blob(['y']));
  ok(n3 === '影片 A (3).mp4', '继续递增', n3);
  ok(dir.files.size === 3, '三个文件各占一份', String(dir.files.size));

  const n4 = await F.writeBlobTo(dir, 'noext', new Blob(['z']));
  ok(n4 === 'noext', '没有扩展名也能存', n4);
  const n5 = await F.writeBlobTo(dir, 'noext', new Blob(['z']));
  ok(n5 === 'noext (2)', '无扩展名的序号加在末尾', n5);

  ok((await F.permState(dir)) === 'granted', '已授权的目录读到 granted');
  ok((await F.permState({ queryPermission: async () => 'prompt' })) === 'prompt', '未授权读到 prompt');
  ok((await F.permState(null)) === 'none', '没有句柄是 none');
  ok((await F.requestPerm({ queryPermission: async () => 'granted' })) === true, '已授权时 requestPerm 直接过');
  ok((await F.requestPerm({ queryPermission: async () => 'prompt' })) === false, '没有 requestPermission 就不假装成功');
  ok(
    (await F.requestPerm({
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'granted'
    })) === true,
    '用户点头后授权成功'
  );

  // 两个任务同时保存到同一个文件夹：不能算成同名再互相截断
  const dir2 = fakeDir('P');
  const [x, y] = await Promise.all([
    F.writeBlobTo(dir2, 'p.mp4', new Blob([new Uint8Array(10)])),
    F.writeBlobTo(dir2, 'p.mp4', new Blob([new Uint8Array(20)]))
  ]);
  ok(x === 'p.mp4' && y === 'p (2).mp4', '并发写同名会排队，拿到两个名字', x + ' / ' + y);
  ok(dir2.files.get(x).data.size === 10 && dir2.files.get(y).data.size === 20, '两份内容各归各位', String(dir2.files.size));

  // 关掉 input 时不弹框（选择器只能在用户手势里调）
  const p = await F.pickDir().then(
    () => 'resolved',
    (e) => e.code || e.name || String(e)
  );
  ok(p === 'no-picker', '没有选择器时报 no-picker 而不是崩掉', p);
}

/* ---------- 5. 引擎落盘走的是设置里的路径 ---------- */
console.log('\n[5] 引擎按设置决定落盘位置');
{
  const src = readFileSync(join(ROOT, 'offscreen/engine.js'), 'utf8');
  ok(/import\s*{[^}]*getSave[^}]*}\s*from\s*'\.\.\/lib\/settings\.js'/.test(src), '引擎引了设置模块');
  ok(/subPath\(save\.sub\)\s*\+\s*name/.test(src), '下载目录模式用子目录拼文件名');
  ok(/writeBlobTo\(dir,\s*name,\s*blob\)/.test(src), '自定义目录模式直接写句柄');
  ok(!/'VideoFetch\/'/.test(src), '不再写死 VideoFetch 前缀');
}

/* ---------- 6. 设置页：DOM 桩里真跑一遍 ---------- */
console.log('\n[6] 设置页能起来（DOM 桩）');
{
  const html = readFileSync(join(ROOT, 'settings/settings.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'settings/settings.js'), 'utf8');

  // 静态检查：settings.js 里用到的每个 id，HTML 里都得有
  const ids = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !new RegExp('id="' + id + '"').test(html));
  ok(ids.length > 8, '设置页引用了 ' + new Set(ids).size + ' 个元素');
  ok(missing.length === 0, '每个 id 在 HTML 里都存在', missing.join(',') || 'ok');

  const mkEl = (id) => {
    const cls = new Set();
    const e = {
      id,
      textContent: '',
      value: '',
      checked: false,
      hidden: false,
      title: '',
      className: '',
      dataset: {},
      children: [],
      style: {},
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, on) => (on ? cls.add(c) : cls.delete(c))
      },
      addEventListener() {},
      closest: () => mkEl(id + '-wrap')
    };
    return e;
  };
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, mkEl(id));
    return nodes.get(id);
  };
  const radios = ['auto', 'en', 'zh'].map((v) => {
    const r = mkEl('lang-' + v);
    r.value = v;
    return r;
  });

  globalThis.document = {
    title: '',
    documentElement: { lang: 'en' },
    activeElement: null,
    getElementById: get,
    querySelectorAll: (sel) => (sel === 'input[name="lang"]' ? radios : []),
    createElement: () => mkEl('x')
  };
  globalThis.localStorage = {
    _d: {},
    getItem(k) {
      return this._d[k] || null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    }
  };
  globalThis.indexedDB = undefined;
  chrome.downloads = { showDefaultFolder() {} };
  chrome.runtime = { getURL: (p) => p, openOptionsPage() {} };

  I.setLang('zh');
  // 前面几节写过存储：这里先把设置恢复成默认，再跑设置页，断言才有意义
  mem['vf:ui'] = { lang: 'zh' };
  mem['vf:save'] = { mode: 'downloads', sub: 'VideoFetch', dirName: '' };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
  await import('../settings/settings.js');
  await new Promise((r) => setTimeout(r, 60));

  ok(get('dir-name').textContent === '尚未选择文件夹', '没选文件夹时显示提示', get('dir-name').textContent);
  ok(get('perm').textContent === '未授权', '授权状态显示未授权', get('perm').textContent);
  ok(get('mode-downloads').checked === true, '默认选中浏览器下载文件夹');
  ok(get('btn-pick').textContent === '选择文件夹…', '按钮文案正确', get('btn-pick').textContent);
  ok(get('btn-forget').hidden === true, '没有文件夹时不显示「清除」');
  ok(radios.find((r) => r.value === 'zh').checked === true, '按存下来的语言勾选（zh）');
  ok(radios.filter((r) => r.checked).length === 1, '语言单选项只有一个被选中');
  ok(get('lang-auto').textContent.indexOf('跟随浏览器') === 0, '跟随浏览器带实际语言', get('lang-auto').textContent);
  ok(get('sub').value === 'VideoFetch', '子目录框填了默认值', get('sub').value);
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
