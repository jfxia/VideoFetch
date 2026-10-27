/**
 * _dev/test-store.mjs — 分片临时存储与临时文件清理
 * 用内存版 OPFS 跑 lib/store.js，验证：
 *   1. 工作文件写到 vf-temp/，dispose 后删除
 *   2. 「保存」的快照是独立副本，读完（releaseSnapshots）才删
 *   3. sweepTemp 只收没人认领的残片，暂停中的任务与刚写的文件不动
 *   4. cleanupAllTemp 清空整个目录（引擎启动时用）
 */
import vm from 'node:vm';

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

/* ---------- 内存版 OPFS ---------- */
function makeOpfs() {
  const dirs = new Map(); // dirName -> Map(fileName -> {buf, mtime})

  const fileHandle = (name, entry) => ({
    name,
    kind: 'file',
    async createWritable(opts) {
      const keep = !!(opts && opts.keepExistingData);
      let buf = keep ? entry.buf.slice() : new Uint8Array(0);
      let pos = keep ? buf.length : 0;
      const put = (at, u8) => {
        const end = at + u8.length;
        if (end > buf.length) {
          const nb = new Uint8Array(end);
          nb.set(buf);
          buf = nb;
        }
        buf.set(u8, at);
        pos = end;
      };
      return {
        async write(data, maybe) {
          if (data && data.type === 'write') {
            put(data.position || 0, data.data instanceof Uint8Array ? data.data : new Uint8Array(data.data));
          } else {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            put(typeof maybe === 'number' ? maybe : pos, u8);
          }
        },
        async seek(p) { pos = p; },
        async truncate(n) { buf = buf.slice(0, n); pos = n; },
        async close() { entry.buf = buf; entry.mtime = Date.now(); }
      };
    },
    async getFile() {
      return {
        name,
        size: entry.buf.length,
        lastModified: entry.mtime,
        arrayBuffer: async () => entry.buf.slice().buffer,
        // 只实现 store 用到的 pipeTo：把内容整块写进目标
        stream: () => ({
          pipeTo: async (dest) => {
            if (entry.buf.length) await dest.write(entry.buf.slice());
            await dest.close();
          }
        })
      };
    }
  });

  const makeDir = (files) => ({
    _files: files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!(opts && opts.create)) throw new Error('NotFoundError');
        files.set(name, { buf: new Uint8Array(0), mtime: Date.now() });
      }
      return fileHandle(name, files.get(name));
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new Error('NotFoundError');
    },
    entries() {
      return (async function* () {
        for (const [n, e] of files) {
          yield [n, { kind: 'file', name: n, getFile: async () => ({ name: n, size: e.buf.length, lastModified: e.mtime }) }];
        }
      })();
    }
  });

  const root = {
    async getDirectoryHandle(name, opts) {
      if (!dirs.has(name)) {
        if (!(opts && opts.create)) throw new Error('NotFoundError');
        dirs.set(name, new Map());
      }
      return makeDir(dirs.get(name));
    },
    async removeEntry(name) {
      if (!dirs.delete(name)) throw new Error('NotFoundError');
    }
  };

  return { root, dirs, storage: { getDirectory: async () => root } };
}

let opfs = makeOpfs();
// Node 自带只读的 navigator，这里要覆盖成 OPFS 桩
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: opfs.storage },
  configurable: true,
  writable: true
});
const { ChunkStore, cleanupAllTemp, sweepTemp } = await import('../lib/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempFiles = () => opfs.dirs.get('vf-temp') || new Map();
const names = () => [...tempFiles().keys()];
const age = (name, ms) => { const e = tempFiles().get(name); if (e) e.mtime = Date.now() - ms; };
const count = (prefix) => names().filter((n) => n.startsWith(prefix)).length;

/* ---------- [1] 工作文件的写入与删除 ---------- */
console.log('[1] 工作文件');
{
  const s = new ChunkStore();
  await s.init();
  ok(s.useOpfs === true, '走 OPFS 路线');
  ok(count('c-') === 1, '建了一个工作文件', names().join(','));
  await s.append(new Uint8Array([1, 2, 3]));
  await s.append(new Uint8Array([4, 5, 6]));
  ok(s.size === 6, '体积累计正确', String(s.size));
  const b = await s.toBlob('video/mp4');
  ok(b.size === 6, '读回内容长度一致', String(b.size));
  await s.dispose();
  ok(count('c-') === 0, 'dispose 后工作文件已删除', names().join(',') || '空');
  ok(opfs.dirs.has('vf-temp'), '目录本身留着（省得每次都重建）');
}

/* ---------- [2] 快照副本 ---------- */
console.log('\n[2] 「保存」的快照副本');
{
  const s = new ChunkStore();
  await s.init();
  await s.append(new Uint8Array([1, 2, 3, 4]));
  const snap = await s.snapshotBlob('video/mp4');
  ok(snap.size === 4, '快照内容是当前进度', String(snap.size));
  ok(count('s-') === 1, '另存了一份 s- 副本', names().join(','));
  await s.append(new Uint8Array([5, 6]));
  ok(s.size === 6, '任务继续往下写', String(s.size));
  ok(snap.size === 4, '快照不被后续写入污染', String(snap.size));
  s.releaseSnapshots(0);
  await sleep(20);
  ok(count('s-') === 0, '读完后快照删除', names().join(','));
  ok(count('c-') === 1, '工作文件仍在（任务没结束）');
  await s.dispose();
  ok(tempFiles().size === 0, '收尾后目录清空', names().join(',') || '空');
}

/* ---------- [3] reset 换文件 ---------- */
console.log('\n[3] reset');
{
  const s = new ChunkStore();
  await s.init();
  await s.append(new Uint8Array([1, 2]));
  const old = names()[0];
  await s.reset();
  ok(s.size === 0, '数据清零');
  ok(count('c-') === 1, '只留一个新的工作文件', names().join(','));
  ok(names()[0] !== old, '旧文件换掉了');
  await s.dispose();
}

/* ---------- [4] sweepTemp 只收没人认领的 ---------- */
console.log('\n[4] 扫尾');
{
  const live = new ChunkStore();
  await live.init();
  await live.append(new Uint8Array([9, 9, 9]));
  const liveName = names().find((n) => n.startsWith('c-'));
  await sleep(5);
  age(liveName, 3 * 3600e3); // 假装这个任务已经跑了三小时

  // 模拟没人收的残片：引擎中断留下的工作文件、上一轮没删掉的快照
  tempFiles().set('c-1000-orphan.bin', { buf: new Uint8Array(10), mtime: Date.now() - 2 * 3600e3 });
  tempFiles().set('s-1000-orphan.bin', { buf: new Uint8Array(10), mtime: Date.now() - 2 * 3600e3 });
  tempFiles().set('c-2000-fresh.bin', { buf: new Uint8Array(10), mtime: Date.now() });

  const removed = await sweepTemp({ maxAgeMs: 10 * 60 * 1000, snapMaxAgeMs: 30 * 60 * 1000 });
  ok(removed === 2, '删掉两个残片', String(removed));
  ok(names().includes(liveName), '在用的工作文件保留');
  ok(!names().includes('c-1000-orphan.bin'), '无人认领的工作文件已删');
  ok(!names().includes('s-1000-orphan.bin'), '过期快照已删');
  ok(names().includes('c-2000-fresh.bin'), '刚写的文件不删');

  const b = await live.toBlob('video/mp4');
  ok(b.size === 3, '在用的存储没被扫坏', String(b.size));
  await live.dispose();
  ok(count('c-') === 1, '只剩那个新鲜文件', names().join(','));
  tempFiles().delete('c-2000-fresh.bin');
}

/* ---------- [5] 启动清空 ---------- */
console.log('\n[5] cleanupAllTemp');
{
  tempFiles().set('c-3000-left.bin', { buf: new Uint8Array(4), mtime: Date.now() });
  await cleanupAllTemp();
  ok(!opfs.dirs.has('vf-temp'), '整个目录被清掉', [...opfs.dirs.keys()].join(',') || '空');
  const s = new ChunkStore();
  await s.init();
  ok(s.useOpfs === true && count('c-') === 1, '之后再建仍然可用');
  await s.dispose();
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
