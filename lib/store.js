/**
 * lib/store.js — 分片临时存储
 * 优先写入 OPFS（Origin Private File System），避免大文件挤爆内存；不可用时回退内存数组。
 */
export class ChunkStore {
  constructor() {
    this.parts = [];
    this.size = 0;
    this.writer = null;
    this.handle = null;
    this.dir = null;
    this.useOpfs = false;
    this.chain = Promise.resolve();
    this.cachedBlob = null;
    this.closed = false;
    this.snaps = [];
  }

  async init() {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      this.dir = await root.getDirectoryHandle('vf-temp', { create: true });
      const name = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin';
      this.handle = await this.dir.getFileHandle(name, { create: true });
      this.writer = await this.handle.createWritable({ keepExistingData: false });
      this.useOpfs = true;
    } catch (e) {
      this.useOpfs = false;
      this.writer = null;
      this.handle = null;
    }
  }

  /** 顺序追加（内部串行化，保证写入顺序与调用顺序一致） */
  append(u8) {
    if (!u8 || !u8.byteLength) return Promise.resolve();
    this.size += u8.byteLength;
    if (!this.useOpfs || !this.writer) {
      this.parts.push(u8);
      return Promise.resolve();
    }
    const chunk = u8;
    this.chain = this.chain.then(async () => {
      try {
        await this.writer.write(chunk);
      } catch (e) {
        // 写失败则降级到内存
        this.useOpfs = false;
        this.parts.push(chunk);
      }
    });
    return this.chain;
  }

  /** 丢弃已写入的数据，重新开一个空文件（续传失败时从头再来） */
  async reset() {
    try {
      if (this.writer) {
        await this.writer.close().catch(() => {});
        this.writer = null;
      }
      if (this.handle && this.dir) {
        await this.dir.removeEntry(this.handle.name).catch(() => {});
      }
    } catch (e) {}
    this.parts = [];
    this.size = 0;
    this.cachedBlob = null;
    this.chain = Promise.resolve();
    this.handle = null;
    this.writer = null;
    this.useOpfs = false;
    await this.init();
  }

  /**
   * 覆盖开头的一小段（改了 moov 里的时长，要写回去）。
   * 只在中途保存、数据已经写完的时候调用，之后不会再追加。
   */
  async patchHead(bytes) {
    if (!bytes || !bytes.length) return false;
    await this.chain;
    if (!this.useOpfs || !this.writer) {
      const first = this.parts[0];
      if (!first || first.length < bytes.length) return false;
      const merged = new Uint8Array(first);
      merged.set(bytes, 0);
      this.parts[0] = merged;
      this.cachedBlob = null;
      return true;
    }
    try {
      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }
      const w = await this.handle.createWritable({ keepExistingData: true });
      await w.write({ type: 'write', position: 0, data: bytes });
      await w.close();
      this.cachedBlob = null;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 返回 Blob（OPFS 下为 File 对象，零拷贝） */
  async toBlob(mime) {
    await this.chain;
    if (this.cachedBlob) return this.cachedBlob;
    if (this.useOpfs && this.handle) {
      try {
        if (this.writer) {
          await this.writer.close();
          this.writer = null;
        }
        this.cachedBlob = await this.handle.getFile();
        return this.cachedBlob;
      } catch (e) {
        this.useOpfs = false;
      }
    }
    this.cachedBlob = new Blob(this.parts, { type: mime || 'application/octet-stream' });
    return this.cachedBlob;
  }

  /**
   * 关闭写流，再以「保留原内容、从末尾继续写」的方式重新打开。
   * OPFS 的 createWritable 默认从 0 开始覆盖，所以必须 seek 到当前大小。
   */
  async reopenForAppend() {
    if (!this.useOpfs || !this.handle) return;
    try {
      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }
      const w = await this.handle.createWritable({ keepExistingData: true });
      if (typeof w.seek !== 'function') throw new Error('no seek');
      await w.seek(this.size);
      this.writer = w;
    } catch (e) {
      // 退不回追加模式就把已有内容收进内存，后面继续写内存——宁可占内存，也不能丢数据
      try {
        const f = await this.handle.getFile();
        this.parts = [new Uint8Array(await f.arrayBuffer())];
      } catch (e2) {}
      if (this.writer) {
        await this.writer.close().catch(() => {});
        this.writer = null;
      }
      this.useOpfs = false;
    }
  }

  /**
   * 导出一份独立的快照副本，之后还能接着往原文件写。
   * 不能直接把工作文件交出去：它还会继续变大，也会被 patchHead 改头，
   * 已经触发的下载会读到脏数据。
   */
  async snapshotBlob(mime) {
    await this.chain;
    const type = mime || 'application/octet-stream';

    if (this.useOpfs && this.handle && this.dir) {
      try {
        if (this.writer) {
          await this.writer.close();
          this.writer = null;
        }
        const src = await this.handle.getFile();
        if (src.size > 0) {
          const name = 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin';
          const h = await this.dir.getFileHandle(name, { create: true });
          const w = await h.createWritable();
          await src.stream().pipeTo(w);
          const copy = await h.getFile();
          this.snaps = this.snaps || [];
          this.snaps.push(h);
          this.cachedBlob = null;
          await this.reopenForAppend();
          return copy;
        }
      } catch (e) {
        // 复制失败就退回直接交工作文件（至少内容是对的）
        try {
          const f = await this.handle.getFile();
          await this.reopenForAppend();
          return f;
        } catch (e2) {}
      }
    }

    // 内存路线：parts 里的 Uint8Array 从不原地修改（patchHead 是换元素），切片即可
    this.cachedBlob = null;
    return new Blob(this.parts.slice(), { type });
  }

  /** 快照副本是给浏览器下载读的，读完（默认 3 分钟）就删，别占着磁盘 */
  releaseSnapshots(ms) {
    const list = this.snaps;
    if (!list || !list.length) return;
    this.snaps = [];
    setTimeout(() => {
      for (const h of list) {
        try {
          this.dir && this.dir.removeEntry(h.name).catch(() => {});
        } catch {}
      }
    }, ms || 180000);
  }

  async dispose() {
    try {
      if (this.writer) {
        await this.writer.close().catch(() => {});
        this.writer = null;
      }
      if (this.handle && this.dir) {
        await this.dir.removeEntry(this.handle.name).catch(() => {});
      }
    } catch (e) {}
    this.parts = [];
    this.size = 0;
    this.cachedBlob = null;
    this.snaps = [];
  }
}

export async function cleanupAllTemp() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('vf-temp', { recursive: true });
  } catch (e) {}
}
