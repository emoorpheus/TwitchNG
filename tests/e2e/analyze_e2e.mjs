// Analyses result_<decoder>.json: A/V sync error per phase, effective video rate, events, decoder->timeline mapping.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const taps = R.taps, S = R.samples, marks = R.marks, evs = R.final.events;
const BASE = 72.033; // first PTS of 360p seg0 (independent of the add-on; from v0_head.ts)
function contentAt(X) {
  let lo = 0, hi = taps.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (taps[m].when <= X) lo = m; else hi = m - 1; }
  const t = taps[lo]; if (!t) return null; const d = t.len / t.sr;
  if (X < t.when || X >= t.when + d) return null;
  return t.c0 + (X - t.when) * (t.c1 - t.c0) / d;
}
const anchors = evs.filter(e => e.type === 'anchor').map(e => e.t);
const out = [];
for (let i = 0; i < marks.length; i++) {
  const p0 = marks[i].p, p1 = i + 1 < marks.length ? marks[i + 1].p : Infinity;
  const errs = [], pts = [];
  for (const s of S) {
    if (s.p < p0 || s.p >= p1) continue;
    if (!s.paused && !s.seeking) pts.push([s.p / 1000, s.ct]);
    if (!s.anch || s.ctxT == null || s.paused || s.seeking) continue;
    if (anchors.some(a => s.p >= a && s.p < a + 1000)) continue;
    const c = contentAt(s.ctxT - (s.lat || 0));
    if (c != null) errs.push(c - s.ct);
  }
  let rate = null;
  if (pts.length > 20) {
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0; for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    rate = +(sxy / sxx).toFixed(4);
  }
  const n = errs.length, mean = n ? errs.reduce((a, b) => a + b, 0) / n : 0;
  const std = n ? Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  out.push({ phase: marks[i].name, n, meanMs: +(mean * 1000).toFixed(1), stdMs: +(std * 1000).toFixed(1), p95AbsMs: n ? +(abs[Math.floor(n * 0.95)] * 1000).toFixed(1) : null, maxAbsMs: n ? +(abs[n - 1] * 1000).toFixed(1) : null, videoRate: rate });
}
console.table(out);
const counts = {}; for (const e of evs) counts[e.type] = (counts[e.type] || 0) + 1;
console.log('events:', JSON.stringify(counts));
console.log('resync/fail/underrun details:', JSON.stringify(evs.filter(e => /resync|fail|underrun|error|strike|fallback|refetch/.test(e.type)).slice(0, 20)));
console.log('during (1.25x after resume):', JSON.stringify({ realMuted: R.during.realMuted, appMuted: R.during.appMuted, state: R.during.status.engine && R.during.status.engine.state, decoder: R.during.status.engine && R.during.status.engine.decoder, lat: R.during.status.engine && R.during.status.engine.latency }));
console.log('final (1x):', JSON.stringify({ engine: R.final.status.engine, realMuted: R.final.realMuted, appMuted: R.final.appMuted, ownMuted: R.final.ownMuted, rate: R.final.rate }));
// decoder -> content timeline mapping check against ffmpeg decode of the same audio_only segment(s)
const sd = R.storeDump, sr = sd.sr, t = sd.t, i0 = Math.floor(t / 10);
const base = sd.audioUrl.replace(/[^\/]*$/, '');
const files = [];
for (const i of [i0, i0 + 1]) {
  const f = `/tmp/e2e_seg${i}.ts`;
  if (!fs.existsSync(f)) execFileSync('curl', ['-sS', '-m', '30', '-o', f, base + i + '.ts']);
  files.push(f);
}
execFileSync('bash', ['-c', `cat ${files.join(' ')} > /tmp/e2e_cat.ts`]);
const st = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', files[0]]).toString());
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', '/tmp/e2e_cat.ts', '-f', 'f32le', '-ac', '2', '-ar', String(sr), 'pipe:1'], { maxBuffer: 1 << 28 });
const f32 = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), N = f32.length / 2, L = new Float32Array(N);
for (let i = 0; i < N; i++) L[i] = f32[2 * i];
const off = Math.round((t - (st - BASE)) * sr), W = 24000, A = sd.L.slice(20000, 20000 + W);
let best = { lag: 0, c: -2 };
for (let lag = -3000; lag <= 3000; lag++) {
  let sxy = 0, sxx = 0, syy = 0; const o = off + 20000 + lag;
  if (o < 0 || o + W > N) continue;
  for (let k = 0; k < W; k++) { const x = A[k], y = L[o + k]; sxy += x * y; sxx += x * x; syy += y * y; }
  const c = sxy / Math.sqrt(sxx * syy + 1e-12);
  if (c > best.c) best = { lag, c };
}
console.log('mapping check:', JSON.stringify({ decoder: sd.decoder, audioKind: sd.kind, baseRef: sd.baseRef, segStartPts: st, lagSamples: best.lag, lagMs: +(best.lag / sr * 1000).toFixed(2), corr: +best.c.toFixed(5) }));
