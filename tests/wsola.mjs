// Offline WSOLA quality/perf test on real Twitch audio (3 contiguous segments, ~30 s).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadAddon } from './load.mjs';
import { KIT, TD } from './_paths.mjs';
const I = loadAddon()._internals;
const OUT = KIT + 'tests/wav/';
fs.mkdirSync(OUT, { recursive: true });
execFileSync('bash', ['-c', `cat ${TD}a100.ts ${TD}a101.ts ${TD}a102.ts > /tmp/a3.ts && ffmpeg -v error -y -i /tmp/a3.ts -f f32le -ac 2 -ar 48000 /tmp/a3.f32 && ffmpeg -v error -y -i /tmp/a3.ts -ac 2 -ar 48000 ${OUT}orig.wav`]);
const raw = new Float32Array(fs.readFileSync('/tmp/a3.f32').buffer.slice(0));
const n = raw.length / 2, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = raw[2 * i]; R[i] = raw[2 * i + 1]; }
const sr = 48000, store = new I.PcmStore(sr, 2);
store.write(0, [L, R], n);
function wav(file, planes, len) {
  const b = Buffer.alloc(44 + len * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + len * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(len * 4, 40);
  for (let i = 0; i < len; i++) for (let c = 0; c < 2; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(planes[c][i] * 32767))), 44 + i * 4 + c * 2);
  fs.writeFileSync(file, b);
}
const res = {};
for (const s of [0.75, 1.25, 1.5, 2.0, 2.5]) {
  const ws = new I.Wsola(sr, 2);
  ws.reset(0);
  const H = ws.H, hops = Math.floor((n - ws.N - ws.D - 10) / (H * s)) - 2;
  const out = [new Float32Array(hops * H), new Float32Array(hops * H)];
  const t0 = performance.now();
  for (let k = 0; k < hops; k++) ws.step(store, s, out, k * H);
  const ms = performance.now() - t0;
  wav(`${OUT}wsola_${s}.wav`, out, hops * H);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${OUT}orig.wav`, '-filter:a', s > 2 ? `atempo=${Math.sqrt(s)},atempo=${Math.sqrt(s)}` : `atempo=${s}`, `${OUT}atempo_${s}.wav`]);
  res[s] = { outSec: +(hops * H / sr).toFixed(3), inSec: +(ws.pos / sr).toFixed(3), cpuMsPerOutSec: +(ms / (hops * H / sr)).toFixed(2) };
}
// soft-correction scenario: speed modulated +-5% every 0.5 s (drift correction path)
{
  const ws = new I.Wsola(sr, 2); ws.reset(0);
  const H = ws.H, out = [new Float32Array(n), new Float32Array(n)]; let k = 0;
  while (ws.pos + 2 * ws.N + ws.D < n - H * 1.6 && (k + 1) * H <= n) { const s = 1.5 * (1 + 0.05 * Math.sign(Math.sin(k * H / sr * Math.PI * 2))); ws.step(store, s, out, k * H); k++; }
  wav(`${OUT}wsola_1.5_modulated.wav`, out, k * H);
}
console.log(JSON.stringify(res));
