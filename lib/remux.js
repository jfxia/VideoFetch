/**
 * lib/remux.js — 媒体分段装配器（流式）
 *
 * 输入形态：
 *   1. MPEG-TS 分片     → mux.js transmuxer 转 fMP4（阶段输出可直接落盘）
 *   2. fMP4 分片(.m4s)  → EXT-X-MAP init + 分片二进制直拼
 *   3. ADTS 音频分片    → 直拼（.aac）
 *
 * TS 路线保留原始 PTS（跨分片天然连续），随后把 tfdt 整体平移到 0 起点，
 * 并按播放列表总时长回填 moov 的 duration，避免"开头空白 + 时长异常"。
 * 转封装失败（HEVC/AC3 等 mux.js 不支持的编码）时，若已提供 rawStore 备份，
 * 自动降级为 TS 原始流输出（.ts）。
 */
import { collectTrackScales, shiftTfdt, patchInitDuration, normalizeAudioConfig } from './mp4time.js';
import { mergeInits, renumberTracks, patchSeq, fragmentStartSec, splitFmp4, parseBoxes, splitCompleteFragments, listTracks, tidyFragments, fragmentKey } from './mp4merge.js';

function fourcc(u8, off) {
  try {
    return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
  } catch {
    return '';
  }
}

export function sniffType(u8) {
  if (!u8 || u8.length < 8) return 'unknown';
  if (u8[0] === 0x47) {
    if (u8.length <= 188 || u8[188] === 0x47 || u8[192] === 0x47) return 'ts';
  }
  if (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) return 'aac';
  const cc = fourcc(u8, 4);
  if (cc === 'ftyp' || cc === 'styp' || cc === 'moov' || cc === 'moof' || cc === 'sidx' || cc === 'free' || cc === 'mdat') {
    return 'mp4';
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'mkv';
  for (let i = 1; i < Math.min(2048, Math.max(1, u8.length - 377)); i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return 'ts';
  }
  return 'unknown';
}

export class Assembler {
  /**
   * @param {(msg:string, level?:string)=>void} onLog
   * @param {{append:(u8:Uint8Array)=>Promise<void>}|null} rawStore 原始分片备份（TS 降级用）
   * @param {number} plannedDuration 播放列表总时长（秒），用于回填 moov duration
   */
  constructor(onLog, rawStore, plannedDuration) {
    this.log = onLog || (() => {});
    this.rawStore = rawStore || null;
    this.plannedDuration = plannedDuration || 0;
    this.mode = null;
    this.initParts = [];
    this.parts = [];
    this.buf = null;          // 待重切分片的缓冲（保证按完整 moof+mdat 单元输出）
    this.bytes = 0;
    this.produced = 0;
    this.transmuxer = null;
    this.initSeen = false;
    this.videoTrack = false;
    this.audioTrack = false;
    this.remuxFailed = false;
    this.segmentsPushed = 0;
    this.scales = null;
    this.tfdtState = { baseSec: null, endSec: 0 };
    this.durationPatched = false;
    this.initRef = null;      // 首个 init 的引用（drain 后仍可用）
    this.audio = null;        // 独立音轨：{init, fragments, map, scales, idx}
    this.seq = 0;             // 分片顺序号（音视频统一编号）
    this.audioNotes = [];
    this.seenFrag = null;     // 已输出的分片（轨道号+tfdt），录制路线用来去重
    this.dupFrag = 0;
  }

  /**
   * 挂上独立音轨（HLS 的 EXT-X-MEDIA 音频流），输出时与视频交错成一个文件。
   * @param {{init:Uint8Array, fragments:Uint8Array[]}} audio
   */
  setAudioTrack(audio) {
    if (!audio || !audio.init || !audio.fragments || !audio.fragments.length) return false;
    // 录制路线里同一条音轨会被重复 append，先按 tfdt 排好序再去重，
    // 否则成片里同一段时间叠着播两遍，听感就是回声/浑浊
    let frags = audio.fragments;
    try {
      const tidy = tidyFragments(audio.init, frags);
      if (tidy.dropped || tidy.moved) {
        this.log(
          '音轨整理：去掉 ' + tidy.dropped + ' 段重复分片，重排 ' + tidy.moved +
            ' 段（播放器 seek 时重复 append 所致）',
          'warn'
        );
        frags = tidy.fragments;
      }
    } catch {}
    this.audio = { init: audio.init, fragments: frags, map: null, scales: null, idx: 0, merged: false };
    return true;
  }

  _vScales() {
    if (!this.scales && this.initRef) {
      try {
        this.scales = collectTrackScales(this.initRef);
      } catch {
        this.scales = new Map();
      }
    }
    return this.scales || new Map();
  }

  /** 把音频分片按时间顺序吐到 out（直到起点超过 untilSec） */
  _flushAudioUntil(out, untilSec) {
    const a = this.audio;
    if (!a || !a.merged) return;
    while (a.idx < a.fragments.length) {
      const src = a.fragments[a.idx];
      const t = fragmentStartSec(src, a.scales);
      if (t == null) break;
      if (untilSec != null && t > untilSec) break;
      const copy = src.slice();
      renumberTracks(copy, a.map);
      patchSeq(copy, ++this.seq);
      out.push(copy);
      a.idx++;
    }
  }

  /**
   * 找到视频流的 init 并把音轨并进去。
   * TS 路线由 mux.js 单独给出 init；MSE 录制/EXT-X-MAP 路线里 init 只是普通分片，
   * 需要从 parts 里把它捞出来替换成合并后的版本。
   */
  _mergeAudio() {
    const a = this.audio;
    if (!a || a.merged) return;
    let init = this.initParts[0] || null;
    let prefixEnd = -1;

    if (!init) {
      // MSE / EXT-X-MAP 路线：init 混在数据流里，从缓冲头部找 moov
      const buf = this.buf;
      if (!buf || !buf.length) return;
      try {
        for (const b of parseBoxes(buf)) {
          if (b.type === 'moov') {
            prefixEnd = b.end;
            break;
          }
        }
      } catch {}
      if (prefixEnd <= 0) return;
      const s = splitFmp4(buf.subarray(0, prefixEnd));
      if (!s.init) return;
      init = s.init;
    }

    // 视频流本身已带音轨时不再合并，否则成片会出现两条音轨
    try {
      if (listTracks(init).some((t) => t.handler === 'soun')) {
        this.log('视频流已含音轨，忽略独立音轨', 'warn');
        this.audio = null;
        return;
      }
    } catch {}

    try {
      const m = mergeInits(init, a.init);
      a.map = m.audioMap;
      a.scales = m.audioTimescales;
      a.merged = true;
      this.initRef = m.init;
      if (prefixEnd > 0) {
        this.initParts.push(m.init);
        this.buf = this.buf.subarray(prefixEnd);
      } else {
        this.initParts[0] = m.init;
      }
      this.audioNotes.push('已合并独立音轨（轨道号 ' + m.audioTrackId + '）');
    } catch (e) {
      this.log('音轨合并失败，仅保留视频：' + (e && e.message ? e.message : e), 'warn');
      this.audio = null;
    }
  }

  get ext() {
    if (this.mode === 'aac') return 'aac';
    if (this.mode === 'ts' && this.remuxFailed) return 'ts';
    return 'mp4';
  }

  _ensureTs() {
    if (this.transmuxer) return;
    const M = typeof muxjs !== 'undefined' ? muxjs : (globalThis.muxjs || null);
    if (!M || !M.mp4 || !M.mp4.Transmuxer) throw new Error('转封装模块未加载');
    const t = new M.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
    t.on('data', (seg) => {
      // mux.js 每次 flush 都会重吐一遍 init，只保留第一份，否则输出里会叠多个 moov
      if (seg.initSegment && !this.initSeen) {
        this.initSeen = true;
        this.initParts.push(new Uint8Array(seg.initSegment));
        this.initRef = this.initParts[0];
      }
      if (seg.data && seg.data.byteLength) {
        const u8 = new Uint8Array(seg.data);
        this.parts.push(u8);
        this.bytes += u8.byteLength;
        this.produced += u8.byteLength;
      }
      if (seg.type === 'video' || seg.type === 'combined') this.videoTrack = true;
      if (seg.type === 'audio' || seg.type === 'combined') this.audioTrack = true;
    });
    t.on('error', (e) => this.log('转封装警告：' + (e && e.message ? e.message : e), 'warn'));
    this.transmuxer = t;
  }

  /**
   * @param {Uint8Array} u8
   * @param {{isInit?:boolean, startTime?:number}} opts
   */
  async push(u8, opts = {}) {
    if (!u8 || !u8.byteLength) return;

    if (!this.mode) {
      const t = sniffType(u8);
      if (t === 'mp4' || t === 'mkv') this.mode = 'mp4';
      else if (t === 'aac') this.mode = 'aac';
      else this.mode = 'ts';
      if (t === 'unknown') this.log('首片格式未知，按 TS 尝试解析', 'warn');
    }

    if (opts.isInit) {
      this.initParts.push(u8);
      if (!this.initRef) this.initRef = u8;
      return;
    }

    this.segmentsPushed++;

    if (this.mode === 'ts' && this.rawStore && !this.remuxFailed) {
      await this.rawStore.append(u8);
    }

    if (this.mode === 'mp4' || this.mode === 'aac') {
      this.parts.push(u8);
      this.bytes += u8.byteLength;
      this.produced += u8.byteLength;
      return;
    }

    if (this.remuxFailed) {
      this.parts.push(u8);
      this.bytes += u8.byteLength;
      return;
    }

    const before = this.parts.length;
    try {
      this._ensureTs();
      this.transmuxer.push(u8);
      this.transmuxer.flush();
    } catch (e) {
      this.log('TS 转封装异常：' + (e && e.message ? e.message : e), 'warn');
      this.remuxFailed = true;
      this.parts.push(u8);
      this.bytes += u8.byteLength;
      return;
    }

    // 时间轴归一：把 tfdt 平移掉原始 PTS 起点
    if (this.parts.length > before) {
      if (!this.scales) this.scales = collectTrackScales(this.initParts[0]);
      for (let i = before; i < this.parts.length; i++) {
        try {
          shiftTfdt(this.parts[i], this.scales, this.tfdtState);
        } catch {}
      }
    }

    if (this.produced === 0 && this.segmentsPushed >= 4) {
      this.remuxFailed = true;
      this.log('转封装无输出（可能为 HEVC/AC3 等编码），降级为原始 TS 流', 'warn');
      this.parts.length = 0;
      this.initParts.length = 0;
      if (this.audio) {
        this.audio = null;
        this.log('已降级为 TS 输出，独立音轨无法合并', 'warn');
      }
    }
  }

  /**
   * 同一个分片被录了两遍（录制路线里播放器 seek 后会重新 append 已播过的段）。
   * 后到的那份直接丢掉：留在文件里就是同一段时间播两次，视频看着跳帧、音频听着发浑。
   */
  _isRepeated(unit) {
    let key = null;
    try {
      key = fragmentKey(unit);
    } catch {}
    if (!key) return false;
    if (!this.seenFrag) this.seenFrag = new Set();
    if (this.seenFrag.has(key)) {
      this.dupFrag++;
      return true;
    }
    this.seenFrag.add(key);
    return false;
  }

  /**
   * 有的源把音频 ASC 写成 HE-AAC（AOT 5）却让「扩展采样率」等于核心采样率。
   * 真 SBR 必须翻倍，写同一个值是无效标注：码流里并没有 SBR 数据，解码器却
   * 按 HE-AAC 走一遍 SBR 链路，各家处理不一致，听感发闷、浑浊。
   * 改在 init 产出之前，中途保存拿到的 initRef 才是同一份。
   * 幂等：改过之后再扫一遍读到的已不是 AOT 5，自然跳过。
   */
  _fixAudioConfig(chunks) {
    for (const p of chunks) {
      if (!p || !p.length) continue;
      try {
        for (const note of normalizeAudioConfig(p)) {
          this.audioNotes.push(note);
          this.log(note, 'warn');
        }
      } catch {}
    }
  }

  /** 取走已就绪的数据（调用方负责落盘） */
  drain(final) {
    const out = [];

    // 先把到货的分片并进缓冲，后续要按完整 moof+mdat 单元重新切
    if (this.parts.length) {
      const parts = this.parts.filter((p) => p && p.length);
      this.parts.length = 0;
      if (parts.length) {
        const list = this.buf && this.buf.length ? [this.buf, ...parts] : parts;
        if (list.length === 1) {
          this.buf = list[0];
        } else {
          let n = 0;
          for (const p of list) n += p.length;
          const merged = new Uint8Array(n);
          let o = 0;
          for (const p of list) {
            merged.set(p, o);
            o += p.length;
          }
          this.buf = merged;
        }
      }
    }

    // 独立音轨：视频 init 就绪后把两条轨合成一个 moov
    if (this.audio && !this.audio.merged) this._mergeAudio();

    if (this.initParts.length) {
      this._fixAudioConfig(this.initRef ? [...this.initParts, this.initRef] : this.initParts);

      // 留一份 init 的副本：中途保存时要按「已下载多久」改写 moov 里的时长
      if (!this.initRef) {
        let n = 0;
        for (const p of this.initParts) n += p.length;
        const ref = new Uint8Array(n);
        let o = 0;
        for (const p of this.initParts) {
          ref.set(p, o);
          o += p.length;
        }
        this.initRef = ref;
      }
      if (!this.durationPatched) {
        this.durationPatched = true;
        const sec = this.plannedDuration || (this.tfdtState.endSec > 0 ? this.tfdtState.endSec : 0);
        if (sec > 0) {
          for (const p of this.initParts) {
            try {
              patchInitDuration(p, sec);
            } catch {}
          }
        }
      }
      out.push(...this.initParts);
      this.initParts.length = 0;
    }

    if (this.buf && this.buf.length) {
      if (this.mode === 'aac') {
        out.push(this.buf);
        this.buf = null;
      } else {
        const { head, units, rest } = splitCompleteFragments(this.buf);
        if (head) {
          // 直拼路线没有显式 init，头部这段就是 ftyp+moov，留个引用以便判断含不含音轨
          if (!this.initRef) this.initRef = head;
          this._fixAudioConfig([head]);
          out.push(head);
        }
        for (const unit of units) {
          if (this._isRepeated(unit)) continue;
          patchSeq(unit, ++this.seq);
          out.push(unit);
          if (this.audio && this.audio.merged) {
            const t = fragmentStartSec(unit, this._vScales());
            // 音频落后视频约一片即可，交错太密只会让顺序号频繁跳
            if (t != null) this._flushAudioUntil(out, t + 1);
          }
        }
        this.buf = rest && rest.length ? rest.slice() : null;
      }
    }

    if (final) {
      if (this.buf && this.buf.length) {
        out.push(this.buf);
        this.buf = null;
      }
      if (this.audio && this.audio.merged) this._flushAudioUntil(out, null);
      this.seenFrag = null;
    }
    return out;
  }

  get stats() {
    return {
      mode: this.mode,
      ext: this.ext,
      produced: this.produced,
      video: this.videoTrack,
      audio: this.audioTrack,
      audioMerged: !!(this.audio && this.audio.merged),
      dups: this.dupFrag,
      failed: this.remuxFailed,
      baseSec: this.tfdtState.baseSec,
      endSec: this.tfdtState.endSec
    };
  }
}
