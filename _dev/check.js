const vm = require('vm');
const fs = require('fs');
const path = require('path');

const modules = ['lib/m3u8.js', 'lib/remux.js', 'lib/crypto.js', 'lib/store.js', 'lib/settings.js', 'lib/fsdir.js', 'offscreen/engine.js', 'background/service-worker.js', 'settings/settings.js'];
const scripts = ['content/inject.js', 'content/content.js', 'lib/i18n.js', 'popup/popup.js'];

let fail = 0;
for (const f of modules) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
    console.log('OK  module  ' + f);
  } catch (e) {
    fail++;
    console.log('ERR module  ' + f + ' -> ' + e.message);
  }
}
for (const f of scripts) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('OK  script  ' + f);
  } catch (e) {
    fail++;
    console.log('ERR script  ' + f + ' -> ' + e.message);
  }
}
const mf = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
console.log('OK  manifest (v' + mf.manifest_version + ')');

// 校验 manifest 引用的文件都存在
const refs = new Set();
const walk = (o) => {
  if (typeof o === 'string') {
    if (/\.(js|html|css|png)$/.test(o)) refs.add(o);
  } else if (Array.isArray(o)) o.forEach(walk);
  else if (o && typeof o === 'object') Object.values(o).forEach(walk);
};
walk(mf);
for (const r of refs) {
  if (!fs.existsSync(r)) {
    fail++;
    console.log('MISSING  ' + r);
  }
}
console.log(fail ? '\n== ' + fail + ' problem(s) ==' : '\n== all good ==');
process.exit(fail ? 1 : 0);
