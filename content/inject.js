/**
 * content/inject.js — 注入到页面主世界（MAIN world）
 *
 * 目的：
 *  1. 记录页面用 fetch/XHR 拉取的媒体地址（blob 播放器底层往往是 m3u8）
 *  2. 记录 URL.createObjectURL 产生的 blob 地址与其真实载体
 *  3. 挂接 MediaSource / SourceBuffer，把真正塞进解码器的媒体数据录下来
 *     —— 这是对 blob: 播放源（含直播）唯一可靠的兜底手段
 *  4. 对外提供录制数据导出接口（postMessage 协议）
 */
(function () {
  'use strict';
  if (window.__VF_INSTALLED__) return;
  window.__VF_INSTALLED__ = true;

  var MAX_REC_BYTES = 400 * 1024 * 1024;
  var MEDIA_RE = /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|flv|f4v|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i;
  var SEG_RE = /\.(ts|m4s|cmfv|cmfa|m4f)(?:[?#]|$)/i;

  var reported = new Set();
  var RECS = new Map();       // recId -> record
  var STATIC_BLOBS = new Map(); // recId -> Blob
  var MS_REC = new WeakMap(); // MediaSource -> record
  var recSeq = 0;

  function emit(kind, data) {
    try {
      window.postMessage({ __vf: 'event', kind: kind, data: data }, '*');
    } catch (e) {}
  }

  function absUrl(u) {
    try {
      return new URL(u, document.baseURI).href;
    } catch (e) {
      return String(u);
    }
  }

  function report(url, extra) {
    try {
      if (!url) return;
      var s = String(url);
      if (s.indexOf('data:') === 0 || s.indexOf('blob:') === 0) return;
      var u = absUrl(s);
      if (!/^https?:/i.test(u)) return;
      if (reported.has(u)) return;
      if (SEG_RE.test(u) && !/m3u8/i.test(u)) return;
      // 扩展名缺失时的启发式：路径/查询里带 HLS 特征词（部分 CDN 用无扩展名 URL）
      var loose = /(?:^|[/?&=._-])(?:m3u8|m3u|mpegurl)(?:[/?&=._-]|$)/i.test(u);
      // 只有真正的媒体 content-type 才算数，否则每个 JSON/HTML 响应都会混进列表
      var mime = String((extra && extra.mime) || '').toLowerCase();
      var mediaMime = /^(video|audio)\//.test(mime) || /mpegurl|dash\+xml|mp2t|iso\.segment/.test(mime);
      if (!MEDIA_RE.test(u) && !loose && !mediaMime) return;
      if (reported.size > 400) return;
      reported.add(u);
      var payload = { url: u, type: guessType(u, (extra && extra.mime) || ''), from: 'page' };
      if (extra) for (var k in extra) payload[k] = extra[k];
      emit('media', payload);
    } catch (e) {}
  }

  /* ---------------- 接口响应体嗅探 ---------------- */
  // 站点通常在播放前先用 API 拿到视频清单（X 的 video_info.variants 就是），
  // 从 JSON 里直接提取地址比等播放器请求更可靠。
  function sniffJson(text) {
    try {
      if (!text || text.length > 4 * 1024 * 1024) return;
      if (text.indexOf('m3u8') < 0 && text.indexOf('.mp4') < 0) return;
      // JSON 里斜杠常被转义成 \/
      var s = text.replace(/\\\//g, '/');
      var re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
      var m;
      var n = 0;
      while ((m = re.exec(s)) && n < 40) {
        n++;
        report(m[0], { from: 'api' });
      }
    } catch (e) {}
  }

  function guessType(url, mime) {
    var m = (mime || '').toLowerCase();
    if (/mpegurl|m3u/.test(m)) return 'hls';
    if (/\.m3u8?(?:[?#]|$)/i.test(url)) return 'hls';
    if (/dash\+xml/.test(m)) return 'dash';
    return 'file';
  }

  /* ---------------- fetch ---------------- */
  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var url = null;
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) {}
        try {
          if (url) report(url, { via: 'fetch' });
        } catch (e) {}
        var p = origFetch.apply(this, arguments);
        try {
          return p.then(function (res) {
            try {
              var ct = res.headers.get('content-type') || '';
              if (ct && url) report(url, { mime: ct.split(';')[0], type: guessType(url, ct), via: 'fetch' });
              // 接口 JSON 里常带视频清单，顺带扒一遍（只处理 API 类请求，避免无谓开销）
              if (res.ok && /json/i.test(ct) && url && /(graphql|\/api\/|\.json\b)/i.test(url)) {
                var cl = parseInt(res.headers.get('content-length') || '0', 10);
                if (!cl || cl < 4 * 1024 * 1024) res.clone().text().then(sniffJson, function () {});
              }
            } catch (e) {}
            return res;
          });
        } catch (e) {
          return p;
        }
      };
    }
  } catch (e) {}

  /* ---------------- XHR ---------------- */
  try {
    var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR && XHR.open) {
      var origOpen = XHR.open;
      var origSend = XHR.send;
      XHR.open = function (method, url) {
        try {
          this.__vfUrl = url;
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XHR.send = function () {
        var self = this;
        try {
          report(self.__vfUrl, { via: 'xhr' });
          self.addEventListener('load', function () {
            try {
              var ct = self.getResponseHeader('content-type') || '';
              if (ct) report(self.__vfUrl, { mime: ct.split(';')[0], type: guessType(self.__vfUrl, ct), via: 'xhr' });
              if (/json/i.test(ct) && /(graphql|\/api\/|\.json\b)/i.test(self.__vfUrl || '')) {
                try {
                  if (self.responseType === '' || self.responseType === 'text') {
                    if (typeof self.responseText === 'string') sniffJson(self.responseText);
                  } else if (self.responseType === 'json' && self.response) {
                    sniffJson(JSON.stringify(self.response));
                  }
                } catch (e) {}
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}

  /* ---------------- createObjectURL ---------------- */
  try {
    var origCreate = URL.createObjectURL;
    if (origCreate) {
      URL.createObjectURL = function (obj) {
        var url = origCreate.apply(this, arguments);
        try {
          if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
            var rec = recFor(obj);
            emit('blob', { url: url, recId: rec.id, kind: 'mediasource', mime: rec.mime || '' });
          } else if (obj instanceof Blob && /^(video|audio)\//i.test(obj.type || '')) {
            var id = 's' + ++recSeq;
            STATIC_BLOBS.set(id, obj);
            emit('blob', { url: url, recId: id, kind: 'blob', mime: obj.type, size: obj.size });
          }
        } catch (e) {}
        return url;
      };
    }
  } catch (e) {}

  /* ---------------- MediaSource 录制 ---------------- */
  function recFor(ms) {
    var r = MS_REC.get(ms);
    if (!r) {
      r = {
        id: 'r' + ++recSeq,
        mime: '',
        buffers: new Map(),
        bufSeq: 0,
        total: 0,
        truncated: false,
        createdAt: Date.now()
      };
      MS_REC.set(ms, r);
      RECS.set(r.id, r);
      emit('mse-open', { recId: r.id });
    }
    return r;
  }

  try {
    var MSProto = window.MediaSource && window.MediaSource.prototype;
    if (MSProto && MSProto.addSourceBuffer) {
      var origAddSB = MSProto.addSourceBuffer;
      MSProto.addSourceBuffer = function (mime) {
        var sb = origAddSB.call(this, mime);
        try {
          var rec = recFor(this);
          if (!rec.mime) rec.mime = mime;
          var bucket = { mime: mime, parts: [], size: 0 };
          rec.buffers.set(++rec.bufSeq, bucket);
          rec.os = rec.os || [];
          rec.os.push({ t: Date.now(), k: rec.bufSeq, n: 0 });

          var origAppend = sb.appendBuffer;
          sb.appendBuffer = function (data) {
            try {
              if (data && rec.total < MAX_REC_BYTES) {
                var u8 = null;
                if (data instanceof ArrayBuffer) {
                  u8 = new Uint8Array(data.slice(0));
                } else if (ArrayBuffer.isView(data)) {
                  u8 = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                }
                if (u8 && u8.byteLength) {
                  bucket.parts.push(u8);
                  bucket.size += u8.byteLength;
                  rec.total += u8.byteLength;
                  if (rec.total >= MAX_REC_BYTES) rec.truncated = true;
                  emit('mse-progress', { recId: rec.id, total: rec.total, mime: rec.mime, truncated: rec.truncated });
                }
              }
            } catch (e) {}
            return origAppend.apply(this, arguments);
          };
        } catch (e) {}
        return sb;
      };
    }
  } catch (e) {}

  /* ---------------- 媒体元素 src 关联 ---------------- */
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          try {
            if (typeof v === 'string' && /^(https?:)?\/\//i.test(v)) {
              report(v, { from: 'player-src' });
            }
          } catch (e) {}
          return desc.set.call(this, v);
        }
      });
    }
  } catch (e) {}

  /* ---------------- 资源计时兜底 ---------------- */
  // 有些播放器的播放列表请求不走 window.fetch / XHR（在 worker 里、或早于本脚本执行），
  // 但一定会出现在 Resource Timing 里，这里定期扫一遍作为第三条通道。
  try {
    var perfSeen = new Set();
    var lastScan = 0;
    var scanPerf = function (force) {
      var now = Date.now();
      if (!force && now - lastScan < 800) return;
      lastScan = now;
      try {
        var es = performance.getEntriesByType('resource');
        var n = Math.min(es.length, 4000);
        for (var i = 0; i < n; i++) {
          var name = es[i].name;
          if (!name || perfSeen.has(name)) continue;
          perfSeen.add(name);
          if (name.indexOf('http') !== 0) continue;
          if (MEDIA_RE.test(name) || /(?:^|[/?&=._-])(?:m3u8|m3u)(?:[/?&=._-]|$)/i.test(name)) {
            report(name, { from: 'perf' });
          }
        }
      } catch (e) {}
    };
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        new PerformanceObserver(function () { scanPerf(false); }).observe({ entryTypes: ['resource'] });
      } catch (e) {}
    }
    setTimeout(function () { scanPerf(true); }, 1200);
    setInterval(function () { scanPerf(false); }, 2500);
  } catch (e) {}

  /* ---------------- 上线通报 ---------------- */
  // 让扩展侧知道 MAIN world 的 hook 确实装上了（诊断用）
  try {
    emit('ready', { url: location.href, href: document.baseURI });
  } catch (e) {}

  /* ---------------- 导出协议 ---------------- */
  function pickBucket(rec) {
    var best = null;
    var bestKey = 0;
    rec.buffers.forEach(function (b, k) {
      if (!best || b.size > best.size) {
        best = b;
        bestKey = k;
      }
    });
    return { bucket: best, key: bestKey };
  }

  function summarize(rec) {
    var pick = pickBucket(rec);
    var list = [];
    rec.buffers.forEach(function (b, k) {
      list.push({ key: k, mime: b.mime || '', bytes: b.size, parts: b.parts.length });
    });
    return {
      recId: rec.id,
      mime: rec.mime,
      total: rec.total,
      truncated: rec.truncated,
      createdAt: rec.createdAt,
      buffers: rec.buffers.size,
      parts: pick.bucket ? pick.bucket.parts.length : 0,
      bytes: pick.bucket ? pick.bucket.size : 0,
      bucketMime: pick.bucket ? pick.bucket.mime : '',
      buckets: list
    };
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__vf !== 'cmd') return;
    var id = d.id;
    var reply = function (payload) {
      try {
        payload.__vf = 'reply';
        payload.id = id;
        window.postMessage(payload, '*');
      } catch (e) {}
    };

    try {
      if (d.cmd === 'list') {
        reply({ ok: true, recs: Array.from(RECS.values()).map(summarize) });
        return;
      }
      if (d.cmd === 'info') {
        var rec = RECS.get(d.recId);
        if (rec) return reply({ ok: true, info: summarize(rec) });
        var blob = STATIC_BLOBS.get(d.recId);
        if (blob) return reply({ ok: true, info: { recId: d.recId, mime: blob.type, total: blob.size, bytes: blob.size, parts: 1, buffers: 1, static: true } });
        return reply({ ok: false, error: '记录不存在' });
      }
      if (d.cmd === 'chunk') {
        var st = STATIC_BLOBS.get(d.recId);
        if (st) {
          if (d.index > 0) return reply({ ok: true, done: true });
          st.arrayBuffer().then(function (ab) {
            reply({ ok: true, data: ab, mime: st.type, last: true });
          }, function (e) {
            reply({ ok: false, error: String(e) });
          });
          return;
        }
        var r2 = RECS.get(d.recId);
        if (!r2) return reply({ ok: false, error: '录制丢失（页面可能已刷新）' });
        var pick = d.bucket != null && r2.buffers.has(d.bucket)
          ? { bucket: r2.buffers.get(d.bucket), key: d.bucket }
          : pickBucket(r2);
        if (!pick.bucket) return reply({ ok: false, error: '暂无录制数据' });
        var i = d.index | 0;
        if (i >= pick.bucket.parts.length) return reply({ ok: true, done: true });
        reply({
          ok: true,
          data: pick.bucket.parts[i].slice().buffer,
          mime: pick.bucket.mime,
          last: i === pick.bucket.parts.length - 1,
          index: i
        });
        return;
      }
      if (d.cmd === 'drop') {
        RECS.delete(d.recId);
        STATIC_BLOBS.delete(d.recId);
        return reply({ ok: true });
      }
      reply({ ok: false, error: 'unknown cmd' });
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  });

  // 启动时把已有媒体元素里的 Blob（页面静态 blob）报一遍
  setTimeout(function () {
    try {
      var els = document.querySelectorAll('video, audio');
      for (var i = 0; i < els.length; i++) {
        var src = els[i].currentSrc || els[i].src || '';
        if (/^(https?:)?\/\//i.test(src)) report(src, { from: 'dom' });
      }
    } catch (e) {}
  }, 1200);
})();
