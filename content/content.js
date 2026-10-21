/**
 * content/content.js — 隔离世界桥接层
 * 1. 收集主世界上报的媒体地址 / blob 信息，批量转发给 Service Worker
 * 2. 响应 SW 指令：把主世界录制的媒体数据搬回扩展侧
 */
(function () {
  'use strict';
  if (window.__VF_CS__) return;
  window.__VF_CS__ = true;

  var seq = 0;
  var pending = new Map();
  var queue = [];
  var flushTimer = null;
  var MAX_CHUNK = 2 * 1024 * 1024;

  function sendToSW(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  function flush() {
    if (!queue.length) return;
    var items = queue.splice(0, queue.length);
    sendToSW({ target: 'sw', type: 'page-media', items: items });
  }

  function enqueue(item) {
    queue.push(item);
    if (queue.length >= 12) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flush(); }, 400);
  }

  function abToB64(buf) {
    var u8 = new Uint8Array(buf);
    var out = '';
    var CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return btoa(out);
  }

  function callMain(cmd, args, timeout) {
    return new Promise(function (resolve) {
      var id = 'q' + ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        resolve({ ok: false, error: '页面响应超时' });
      }, timeout || 10000);
      pending.set(id, { resolve: resolve, timer: timer });
      try {
        window.postMessage(Object.assign({ __vf: 'cmd', id: id, cmd: cmd }, args || {}), '*');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__vf !== 'reply') return;
    var p = pending.get(d.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(d.id);
    p.resolve(d);
  });

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__vf !== 'event') return;
    var data = d.data || {};
    if (d.kind === 'ready') {
      // 主世界 hook 已装载，报给后台用于诊断
      sendToSW({ target: 'sw', type: 'hook-report', data: { url: data.url || location.href } });
      return;
    }
    if (d.kind === 'media') {
      enqueue({
        url: data.url,
        type: data.type || 'file',
        mime: data.mime || '',
        from: data.from || 'page'
      });
    } else if (d.kind === 'blob') {
      enqueue({
        url: data.url,
        type: 'blob',
        mime: data.mime || '',
        recId: data.recId,
        from: data.kind === 'mediasource' ? 'mse' : 'blob'
      });
    } else if (d.kind === 'mse-progress') {
      // 录制过程中的体积变化，用于 popup 展示
      sendToSW({ target: 'sw', type: 'rec-progress', data: data });
    }
  });

  async function dumpRecord(recId, bucket) {
    var info = await callMain('info', { recId: recId });
    if (!info.ok) return info;

    var meta = info.info || {};
    var total = meta.parts || 1;
    var sent = 0;
    var bytes = 0;

    for (var i = 0; i < total; i++) {
      var r = await callMain('chunk', { recId: recId, index: i, bucket: bucket }, 25000);
      if (!r.ok) return r;
      if (r.done) break;
      if (!r.data) continue;

      var buf = r.data;
      if (buf.byteLength > MAX_CHUNK) {
        // 大块拆小，避免单条消息过大
        for (var off = 0; off < buf.byteLength; off += MAX_CHUNK) {
          var part = buf.slice(off, Math.min(off + MAX_CHUNK, buf.byteLength));
          await sendToSW({
            target: 'sw',
            type: 'rec-chunk',
            data: { recId: recId, index: sent++, mime: r.mime, b64: abToB64(part) }
          });
          bytes += part.byteLength;
        }
      } else {
        await sendToSW({
          target: 'sw',
          type: 'rec-chunk',
          data: { recId: recId, index: sent++, mime: r.mime, b64: abToB64(buf) }
        });
        bytes += buf.byteLength;
      }
      if (r.last) break;
    }

    await sendToSW({ target: 'sw', type: 'rec-chunk', data: { recId: recId, done: true, mime: meta.mime || '' } });
    return { ok: true, bytes: bytes, mime: meta.mime || '', truncated: !!meta.truncated };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'cs') return;

    if (msg.type === 'record-dump') {
      dumpRecord(msg.recId, msg.bucket).then(sendResponse, function (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
      return true;
    }

    if (msg.type === 'blob-info') {
      callMain('info', { recId: msg.recId }, 5000).then(sendResponse, function (e) {
        sendResponse({ ok: false, error: String(e) });
      });
      return true;
    }

    if (msg.type === 'record-drop') {
      callMain('drop', { recId: msg.recId }, 3000).then(sendResponse, function () { sendResponse({ ok: false }); });
      return true;
    }

    if (msg.type === 'ping') {
      sendResponse({ ok: true });
      return;
    }
  });
})();
