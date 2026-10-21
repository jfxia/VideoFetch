import { readFileSync, writeFileSync } from 'node:fs';
import { parsePlaylist } from '../lib/m3u8.js';
import { Assembler } from '../lib/remux.js';
import { splitFmp4, listTracks, parseBoxes } from '../lib/mp4merge.js';
const BASE = 'http://127.0.0.1:8898/';
const muxCode = readFileSync(new URL('../vendor/mux.min.js', import.meta.url), 'utf8');
new Function(muxCode)();
const getBuf = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
async function assemble(url) {
  const pl = parsePlaylist(new TextDecoder().decode(await getBuf(url)), url);
  const chunks = [];
  const asm = new Assembler(() => {}, null, 10);
  for (const seg of pl.segments) {
    await asm.push(await getBuf(seg.url), {});
    chunks.push(...asm.drain());
  }
  let n = 0; for (const c of chunks) n += c.length;
  const all = new Uint8Array(n); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}
const v = await assemble(BASE + 'sepa/0.m3u8');
const a = await assemble(BASE + 'sepa/1.m3u8');
const vs = splitFmp4(v), as = splitFmp4(a);
console.log('video total', v.length, 'init', vs.init && vs.init.length, 'frags', vs.fragments.length);
console.log('audio total', a.length, 'init', as.init && as.init.length, 'frags', as.fragments.length);
console.log('video init boxes', vs.init ? parseBoxes(vs.init).map(b => b.type + ':' + b.size).join(',') : 'none');
console.log('audio init boxes', as.init ? parseBoxes(as.init).map(b => b.type + ':' + b.size).join(',') : 'none');
console.log('video tracks', JSON.stringify(listTracks(vs.init)));
console.log('audio tracks', JSON.stringify(listTracks(as.init)));
const f0 = vs.fragments[0];
console.log('frag0 boxes', parseBoxes(f0).map(b => b.type + ':' + b.size).join(','));
