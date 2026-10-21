/**
 * _dev/serve.mjs — 本地测试服务器（支持 Range / 正确 MIME）
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('_dev/media');
const PORT = Number(process.argv[2] || 8898);
const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.bin': 'application/octet-stream',
  '.webm': 'video/webm'
};

http
  .createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const fp = path.join(ROOT, u);
    let st;
    try {
      st = statSync(fp);
      if (!st.isFile()) throw new Error('dir');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    // ?delay=毫秒：给分片加人工延迟，用来测暂停/续传的时序
    const q = new URL(req.url, 'http://x').searchParams;
    const delay = Number(q.get('delay') || 0);
    // ?rate=字节每秒：模拟慢速链路，用来复现「点了暂停还在下」
    const rate = Number(q.get('rate') || 0);
    const send = () => respond(req, res, fp, st, rate);
    if (delay > 0) setTimeout(send, delay);
    else send();
  })
  .listen(PORT, '127.0.0.1', () => console.log('test server on http://127.0.0.1:' + PORT));

function respond(req, res, fp, st, rate) {
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes'
      });
      return sendFile(fp, res, rate, { start, end });
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  return sendFile(fp, res, rate);
}

/** 限速：按「已发出字节 / rate」算应到时刻，提前到的先等一会儿 */
async function sendFile(fp, res, rate, opts) {
  if (!rate) return createReadStream(fp, opts).pipe(res);
  const rs = createReadStream(fp, opts);
  const t0 = Date.now();
  let sent = 0;
  res.on('close', () => {
    try {
      rs.destroy();
    } catch {}
  });
  try {
    for await (const chunk of rs) {
      sent += chunk.length;
      const wait = t0 + (sent / rate) * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch {
    try {
      res.end();
    } catch {}
  }
}
