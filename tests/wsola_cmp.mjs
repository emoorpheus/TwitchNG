import fs from 'node:fs';
import { loadAddon } from './load.mjs';
const I = loadAddon()._internals;
const raw = new Float32Array(fs.readFileSync('/tmp/a3.f32').buffer.slice(0));
const n = raw.length / 2, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = raw[2 * i]; R[i] = raw[2 * i + 1]; }
const store = new I.PcmStore(48000, 2); store.write(0, [L, R], n);
const out = {};
for (const cs of [2, 4]) for (const s of [0.75, 1.25, 1.5, 2, 2.5]) {
  const ws = new I.Wsola(48000, 2, cs); ws.reset(0);
  const hops = Math.floor((n - ws.N - ws.D - 10) / (ws.H * s)) - 2, o = [new Float32Array(hops * ws.H), new Float32Array(hops * ws.H)];
  let sum = 0, cnt = 0, low = 0; const t0 = performance.now();
  for (let k = 0; k < hops; k++) { ws.step(store, s, o, k * ws.H); if (ws.lastCorr) { sum += ws.lastCorr; cnt++; if (ws.lastCorr < 0.5) low++; } }
  out[`cs${cs}_${s}`] = { meanCorr: +(sum / cnt).toFixed(4), pctBelow05: +(100 * low / cnt).toFixed(2), ms: +((performance.now() - t0) / (hops * ws.H / 48000)).toFixed(1) };
}
console.table(out);
