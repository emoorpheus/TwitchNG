import fs from 'node:fs';
import { loadAddon } from './load.mjs';
const I = loadAddon()._internals;
const raw = new Float32Array(fs.readFileSync('/tmp/a3.f32').buffer.slice(0));
const n = raw.length / 2, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = raw[2 * i]; R[i] = raw[2 * i + 1]; }
const store = new I.PcmStore(48000, 2); store.write(0, [L, R], n);
const out = {};
for (const s of [1.5, 2, 2.5]) for (const Dms of [12, 18, 24]) {
  const ws = new I.Wsola(48000, 2, 4); ws.D = Math.round(48 * Dms); ws.cap = 4 * ws.N + 2 * ws.D + 16;
  ws.wb = [new Float32Array(ws.cap), new Float32Array(ws.cap)]; ws.mono = new Float32Array(ws.cap); ws.reset(0);
  const hops = Math.floor((n - ws.N - ws.D - 10) / (ws.H * s)) - 2, o = [new Float32Array(hops * ws.H), new Float32Array(hops * ws.H)];
  let sum = 0, cnt = 0;
  for (let k = 0; k < hops; k++) { ws.step(store, s, o, k * ws.H); if (ws.lastCorr) { sum += ws.lastCorr; cnt++; } }
  out[`s${s}_D${Dms}`] = +(sum / cnt).toFixed(4);
}
console.log(JSON.stringify(out));
