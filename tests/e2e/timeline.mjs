import fs from 'node:fs';
const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const [from, to, every] = [+process.argv[3], +process.argv[4], +(process.argv[5] || 200)];
const taps = R.taps;
function contentAt(X) { let lo = 0, hi = taps.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (taps[m].when <= X) lo = m; else hi = m - 1; } const t = taps[lo]; const d = t.len / t.sr; if (X < t.when || X >= t.when + d) return null; return t.c0 + (X - t.when) * (t.c1 - t.c0) / d; }
let last = -1e9;
for (const s of R.samples) {
  if (s.p < from || s.p > to || s.p - last < every) continue; last = s.p;
  const c = s.anch && s.ctxT != null ? contentAt(s.ctxT - (s.lat || 0)) : null;
  console.log(Math.round(s.p), 'ct', s.ct.toFixed(3), 'anch', s.anch ? 1 : 0, 'err', c == null ? '-' : ((c - s.ct) * 1000).toFixed(0) + 'ms', 'eff', s.eff == null ? '-' : s.eff.toFixed(3), s.paused ? 'P' : '', s.seeking ? 'S' : '');
}
for (const e of R.final.events) if (e.t >= from && e.t <= to) console.log('EV', e.t, e.type, JSON.stringify(e.data || ''));
