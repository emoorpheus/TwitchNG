// Tiny ISO-BMFF helpers for the mse-hook tests (no dependency on the code under test).
const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts']);
export function boxes(u8, s = 0, e = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  while (s + 8 <= e) {
    let size = dv.getUint32(s), hs = 8;
    const type = String.fromCharCode(u8[s + 4], u8[s + 5], u8[s + 6], u8[s + 7]);
    if (size === 1) { size = Number(dv.getBigUint64(s + 8)); hs = 16; }
    if (size === 0) size = e - s;
    out.push({ type, start: s, end: s + size, hs });
    s += size;
  }
  return out;
}
export function walk(u8, fn, s = 0, e = u8.length, path = '') {
  for (const b of boxes(u8, s, e)) { const p = path + '/' + b.type; fn(b, p); if (CONT.has(b.type)) walk(u8, fn, b.start + b.hs, b.end, p); }
}
const u32 = (u8, p) => ((u8[p] << 24) >>> 0) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
export function timescales(u8) {
  const r = { mvhd: null, tracks: [] };
  let cur = null;
  walk(u8, (b, p) => {
    const v = u8[b.start + b.hs], ts = u32(u8, b.start + b.hs + 4 + (v === 1 ? 16 : 8));
    if (b.type === 'mvhd') r.mvhd = ts;
    if (b.type === 'trak') { cur = { handler: '?', mdhd: null }; r.tracks.push(cur); }
    if (b.type === 'hdlr' && cur && p.includes('/mdia/')) cur.handler = String.fromCharCode(...u8.subarray(b.start + b.hs + 8, b.start + b.hs + 12));
    if (b.type === 'mdhd' && cur) cur.mdhd = ts;
  });
  return r;
}
export function tfdts(u8) {
  const r = [];
  walk(u8, (b) => {
    if (b.type !== 'tfdt') return;
    const v = u8[b.start + b.hs];
    r.push(v === 1 ? u32(u8, b.start + b.hs + 4) * 2 ** 32 + u32(u8, b.start + b.hs + 8) : u32(u8, b.start + b.hs + 4));
  });
  return r;
}
// Moves every traf's tfdt by `sec` seconds in its own track timescale (simulates a VOD position far from 0).
export function shiftFrag(init, frag, sec) {
  const ids = {}; let cur = null;
  walk(init, (b) => {
    if (b.type === 'trak') cur = {};
    if (b.type === 'tkhd') { const v = init[b.start + b.hs]; cur.id = u32(init, b.start + b.hs + 4 + (v === 1 ? 16 : 8)); }
    if (b.type === 'mdhd') { const v = init[b.start + b.hs]; ids[cur.id] = u32(init, b.start + b.hs + 4 + (v === 1 ? 16 : 8)); }
  });
  const out = frag.slice(), dv = new DataView(out.buffer);
  let id = null;
  walk(out, (b) => {
    if (b.type === 'tfhd') id = u32(out, b.start + b.hs + 4);
    if (b.type === 'tfdt') {
      const v = out[b.start + b.hs], p = b.start + b.hs + 4, add = Math.round(sec * ids[id]);
      if (v === 1) { const t = Number(dv.getBigUint64(p)) + add; dv.setBigUint64(p, BigInt(t)); }
      else dv.setUint32(p, dv.getUint32(p) + add);
    }
  });
  return out;
}
