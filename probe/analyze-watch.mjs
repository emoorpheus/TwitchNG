#!/usr/bin/env node
// analyze-watch.mjs - summarize a `sttv-cdp.mjs watch` jsonl per speed segment (Node >= 18).
//   node analyze-watch.mjs watch.jsonl [--from ISO] [--to ISO] [--json out.json] [--freeze 3]
// Per segment of one selected speed: real rate = sum(dUiMs) / sum(dTvNow) over the steady part (after v2b is
// active; 1x: after 3 s), UI freezes (no progress while playing) longer than --freeze s, time until v2b active and
// until the measured rate is within 10 % of the target, dropped-frame share, heap, engine events by type.
import fs from 'node:fs';
const argv = process.argv.slice(2), opt = { freeze: 3 }, pos = [];
for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? (opt[argv[i].slice(2)] = argv[++i]) : pos.push(argv[i]);
if (!pos[0]) { console.error('usage: node analyze-watch.mjs watch.jsonl [--from ISO] [--to ISO] [--json out.json]'); process.exit(1); }
const FREEZE = +opt.freeze * 1000, KEY = /fail|release|step_down|net_|timeline_mismatch|restore|giveup|kick|absorb|hold|gate_|recover|error/;
const rows = fs.readFileSync(pos[0], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
  .filter((r) => r && r.at && (!opt.from || r.at >= opt.from) && (!opt.to || r.at <= opt.to));
const S = rows.filter((r) => typeof r.tvNow === 'number' && typeof r.speed === 'number');
const errors = rows.filter((r) => r.error).length, connects = rows.filter((r) => r.connect).length;
const segs = [];
for (const r of S) {
  let g = segs[segs.length - 1];
  if (!g || g.speed !== r.speed || r.pageReloaded) segs.push(g = { speed: r.speed, rows: [] });
  g.rows.push(r);
}
const r1 = (x, d = 1) => (x === null || x === undefined || !isFinite(x) ? null : +x.toFixed(d));
function seg(g) {
  const R = g.rows, t0 = R[0].tvNow, out = { speed: g.speed, from: R[0].at, to: R[R.length - 1].at, durS: r1((R[R.length - 1].tvNow - t0) / 1000) };
  const act = R.find((r) => r.v2b === 'active');
  out.v2bActiveAfterS = g.speed === 1 ? null : act ? r1((act.tvNow - t0) / 1000) : 'never';
  const steadyFrom = g.speed === 1 ? t0 + 3000 : act ? act.tvNow : Infinity;
  let ui = 0, dt = 0, jumps = 0, frz = 0, frzMax = 0, frzN = 0, okAt = null, okRun = 0;
  for (let i = 1; i < R.length; i++) {
    const a = R[i - 1], b = R[i], d = b.tvNow - a.tvNow, du = b.uiMs - a.uiMs;
    if (!(d > 0) || typeof a.uiMs !== 'number' || typeof b.uiMs !== 'number') continue;
    const playing = !b.paused && !a.paused;
    if (playing && Math.abs(du) < 30) { frz += d; if (frz > frzMax) frzMax = frz; } else { if (frz > FREEZE) frzN++; frz = 0; }
    const inst = du / d, sane = du >= 0 && du <= g.speed * d * 3 + 2000;
    if (!sane) { jumps++; continue; }
    if (okAt === null) { okRun = playing && Math.abs(inst - g.speed) <= 0.1 * g.speed ? okRun + 1 : 0; if (okRun >= 3) okAt = b.tvNow; }
    if (a.tvNow >= steadyFrom && playing) { ui += du; dt += d; }
  }
  if (frz > FREEZE) frzN++;
  out.rate = dt > 2000 ? r1(ui / dt, 3) : null; out.rateErrPct = out.rate === null ? null : r1((out.rate / g.speed - 1) * 100);
  out.steadyS = r1(dt / 1000); out.rateOkAfterS = okAt === null ? 'never' : r1((okAt - t0) / 1000); out.seekJumps = jumps;
  out.freezeMaxS = r1(frzMax / 1000); out.freezesOverLimit = frzN;
  const q0 = R.find((r) => r.q && r.q.total), q1 = [...R].reverse().find((r) => r.q && r.q.total);
  out.droppedPct = q0 && q1 && q1.q.total > q0.q.total ? r1(((q1.q.dropped - q0.q.dropped) / (q1.q.total - q0.q.total)) * 100) : null;
  const hs = R.map((r) => r.heapMB).filter((x) => typeof x === 'number');
  out.heapMB = hs.length ? { first: hs[0], last: hs[hs.length - 1], max: Math.max(...hs) } : null;
  const ev = {}; R.forEach((r) => (r.ev || []).forEach((e) => { ev[e.type] = (ev[e.type] || 0) + 1; }));
  out.events = Object.fromEntries(Object.entries(ev).filter(([k]) => KEY.test(k)));
  out.warns = R.filter((r) => r.warn).map((r) => r.at.slice(11, 19) + ' ' + r.warn);
  out.verdicts = [...new Set(R.map((r) => r.verdict).filter(Boolean))];
  out.levels = [...new Set(R.map((r) => r.lvl).filter(Boolean))];
  return out;
}
const res = segs.filter((g) => g.rows.length > 1).map(seg);
// heap trend over the last 30 min of the window (least squares, MB/min)
const H = S.filter((r) => typeof r.heapMB === 'number'), tEnd = H.length ? H[H.length - 1].tvNow : 0, W = H.filter((r) => r.tvNow >= tEnd - 1800000);
let slope = null;
if (W.length > 10) {
  const n = W.length, mx = W.reduce((s, r) => s + r.tvNow, 0) / n, my = W.reduce((s, r) => s + r.heapMB, 0) / n;
  const sxy = W.reduce((s, r) => s + (r.tvNow - mx) * (r.heapMB - my), 0), sxx = W.reduce((s, r) => s + (r.tvNow - mx) ** 2, 0);
  slope = sxx ? r1((sxy / sxx) * 60000, 3) : null;
}
const summary = { file: pos[0], samples: S.length, errors, reconnects: connects, from: S[0] && S[0].at, to: S.length ? S[S.length - 1].at : null,
  heapSlopeLast30minMBperMin: slope, heapWindowMin: W.length ? r1((W[W.length - 1].tvNow - W[0].tvNow) / 60000) : 0, segments: res };
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(summary, null, 1));
console.log(`samples ${S.length}  errors ${errors}  reconnects ${connects}  ${summary.from || ''} .. ${summary.to || ''}  heap slope(last 30 min) ${slope} MB/min`);
console.log('speed  dur_s  v2b_on_s  rate   err%   ok_after_s  frz_max_s  frz>lim  drop%  heap(first/last/max)  events');
for (const s of res) console.log([String(s.speed).padEnd(5), String(s.durS).padStart(6), String(s.v2bActiveAfterS ?? '-').padStart(8), String(s.rate ?? '-').padStart(6),
  String(s.rateErrPct ?? '-').padStart(6), String(s.rateOkAfterS).padStart(10), String(s.freezeMaxS).padStart(9), String(s.freezesOverLimit).padStart(7),
  String(s.droppedPct ?? '-').padStart(6), (s.heapMB ? `${s.heapMB.first}/${s.heapMB.last}/${s.heapMB.max}` : '-').padStart(20), JSON.stringify(s.events),
  s.warns.length ? ' WARN ' + s.warns.join('; ') : ''].join(' '));
