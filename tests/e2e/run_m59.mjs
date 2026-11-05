// E2E for 1.3.5: webOS 25 emulation (LG M59LA, TV report on Twitch NG 1.0.0 / engine 1.3.4).
//  * the NATIVE pipeline freezes at any playbackRate != 1 (real rate 0 + 'waiting'; on the TV: 0.25-2x froze after a
//    v2b restore / quality change, clips crawled) -> the bridge's stall check (page_m59.html, like webosCompatBridge)
//    ends the VOD (Play_PannelEndStart) or reloads it; every such write is recorded in __m59.bad
//  * a MediaSource (v2b) element: the rate reads back, the media stays 1.0 (RATE_IGNORED as before; v2b keeps it at 1)
//  * __m59.freezeNext: the next native loadedmetadata gets stuck (rate 0) until a seek >= 1 s later (restore stuck)
// Usage: node run_m59.mjs                                                 -> 1.3.5 (all scenarios)
//        ENGINE_DIR=<old kit>/sttv-speed OUT=/tmp/m59_134.json node run_m59.mjs  -> 1.3.4 repro (S0-S2, S9)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { KIT, TD } from '../_paths.mjs';
const DIR = KIT + 'tests/e2e/';
const ED = (process.env.ENGINE_DIR || KIT + 'sttv-speed').replace(/\/?$/, '/');
const OUT = process.env.OUT || DIR + 'result_m59.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const ctx = await browser.newContext();
const ENG = new Set(['sttv-speed.js', 'sttv-v2b.js', 'sttv-hls.min.js']);
await ctx.route('https://sttv.test/**', route => {
  const name = new URL(route.request().url()).pathname.slice(1), f = (ENG.has(name) ? ED : DIR) + name;
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.mp4') ? 'video/mp4' : 'application/javascript', body = fs.readFileSync(f);
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (m && type === 'video/mp4') {
    const a = +m[1], b = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    return route.fulfill({ status: 206, body: body.subarray(a, b + 1), headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${body.length}` } });
  }
  route.fulfill({ status: 200, body, headers: { 'content-type': type, 'accept-ranges': 'bytes' } });
});
// 1.3.6 S11: TV-like prefetch time (Caedrel 1080p60: 2 segments = 15.5 MB in 2.4 s) while segDelayMs > 0
let segDelayMs = 0;
await ctx.route(/\.ts(\?.*)?$/, async route => { if (segDelayMs) await sleep(segDelayMs); return route.continue(); });
await ctx.addInitScript(() => {
  try { localStorage.setItem('STTV_SPEED_DEBUG', '1'); localStorage.setItem('STTV_SPEED_V2B', 'auto'); } catch (e) {}
  const P = HTMLMediaElement.prototype, dr = Object.getOwnPropertyDescriptor(P, 'playbackRate'), dd = Object.getOwnPropertyDescriptor(P, 'defaultPlaybackRate');
  const ctD = Object.getOwnPropertyDescriptor(P, 'currentTime');
  const mse = new Set(), oc = URL.createObjectURL;
  URL.createObjectURL = function (o) { const u = oc.call(URL, o); try { if (o instanceof MediaSource) mse.add(u); } catch (e) {} return u; };
  const M = window.__m59 = { bad: [], freezes: 0, stuckN: 0, unstuck: 0, stuck: null, freezeNext: false };
  const isMse = v => mse.has(v.currentSrc || v.src);
  const req = new WeakMap(), reqD = new WeakMap();
  // what the media really does with a requested rate
  function real(v, x, why) {
    const src = v.currentSrc || v.src;
    if (v.id === 'sttv_main' && src && !isMse(v) && x !== 1 && x > 0) {
      M.bad.push({ t: performance.now(), rate: x, why, ct: +ctD.get.call(v).toFixed(2), src: String(src).slice(0, 40) });
      if (dr.get.call(v) !== 0) { dr.set.call(v, 0); M.freezes++; setTimeout(() => v.dispatchEvent(new Event('waiting')), 0); }
      return;
    }
    if (M.stuck && M.stuck.v === v) return;                  // a stuck pipeline ignores the rate
    if (dr.get.call(v) !== 1) dr.set.call(v, 1);
  }
  Object.defineProperty(P, 'playbackRate', { configurable: true, enumerable: true,
    get() { return req.has(this) ? req.get(this) : dr.get.call(this); },
    set(x) { x = +x; req.set(this, x); real(this, x, 'rate'); this.dispatchEvent(new Event('ratechange')); } });
  Object.defineProperty(P, 'defaultPlaybackRate', { configurable: true, enumerable: true,
    get() { return reqD.has(this) ? reqD.get(this) : dd.get.call(this); },
    set(x) { reqD.set(this, +x); } });
  // load algorithm: playbackRate = defaultPlaybackRate (a native reload with default 2 starts frozen on webOS 25)
  window.addEventListener('loadstart', e => { const v = e.target; if (!(v instanceof HTMLMediaElement)) return;
    if (M.stuck && M.stuck.v === v) M.stuck = null;
    const d = reqD.has(v) ? reqD.get(v) : 1; req.set(v, d); real(v, d, 'default'); }, true);
  window.addEventListener('loadedmetadata', e => { const v = e.target;
    if (!M.freezeNext || v.id !== 'sttv_main' || isMse(v)) return;
    M.freezeNext = false; M.stuck = { v, at: performance.now() }; M.stuckN++; dr.set.call(v, 0);
    setTimeout(() => v.dispatchEvent(new Event('waiting')), 0); }, true);
  window.addEventListener('seeking', e => { const v = e.target;
    if (M.stuck && M.stuck.v === v && performance.now() - M.stuck.at >= 1000) { M.stuck = null; M.unstuck++; real(v, req.has(v) ? req.get(v) : 1, 'unstick'); } }, true);
  window.__rr = v => dr.get.call(v);
  window.__s = []; window.__ev = [];
  const seen = new WeakSet();
  setInterval(() => {
    const v = document.getElementById('sttv_main'), S = window.STTVSpeed;
    if (S) for (const e of S.events(400)) if (!seen.has(e)) { seen.add(e); window.__ev.push(e); }
    if (!v || !S) return;
    const I = S._internals;
    window.__s.push({ p: performance.now(), ct: v.currentTime, raw: ctD.get.call(v), rr: dr.get.call(v), paused: v.paused, rs: v.readyState,
      mse: isMse(v), v2b: I && I.v2b.state, sp: I && I.v2b.speed, src: !!(v.currentSrc || v.src) });
  }, 100);
});
const page = await ctx.newPage();
const logs = [], perr = [];
page.on('console', m => { if (logs.length < 6000) logs.push(m.text().slice(0, 240)); });
page.on('pageerror', e => { perr.push(e.message); logs.push('PAGEERROR ' + e.message); });
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const T0 = Date.now(), marks = [], R = [];
const pnow = () => page.evaluate(() => performance.now());
async function mark(name) { const p = await pnow(); marks.push({ name, p }); console.log(((Date.now() - T0) / 1000).toFixed(1) + 's mark', name); return p; }
function check(name, ok, info) { R.push({ name, ok: !!ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 360) : '')); }
const st = () => page.evaluate(() => { const s = STTVSpeed.status(); return { v2b: s.v2b.state, speed: s.v2b.speed, eng: s.engine && s.engine.state, pipe: s.pipe.pipe, ct: s.video.ct }; });
async function waitFor(fn, arg, ms, label) {
  try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; }
  catch (e) { console.log('TIMEOUT', label, JSON.stringify(await st().catch(() => null))); return false; }
}
const vs = s => STTVSpeed._internals.v2b.speed === s && STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch;
// observation window: content slope, minimum position, frozen time, real element rate
async function win(ms) {
  const a = await pnow(); await sleep(ms); const b = await pnow();
  return page.evaluate(([a, b]) => {
    const s = window.__s.filter(x => x.p >= a && x.p <= b && x.src);
    if (s.length < 2) return { n: s.length };
    const f = s[0], l = s[s.length - 1];
    let frozen = 0; for (let i = 1; i < s.length; i++) if (!s[i].paused && Math.abs(s[i].ct - s[i - 1].ct) < 0.001) frozen += s[i].p - s[i - 1].p;
    return { n: s.length, slope: +((l.ct - f.ct) / ((l.p - f.p) / 1000)).toFixed(3), ct0: +f.ct.toFixed(2), ct1: +l.ct.toFixed(2),
      minCt: +Math.min(...s.filter(x => x.rs >= 2).map(x => x.ct)).toFixed(2), frozenMs: Math.round(frozen), rrMax: Math.max(...s.map(x => x.rr)), rrMin: Math.min(...s.map(x => x.rr)),
      v2b: l.v2b, mse: l.mse };
  }, [a, b]);
}
const since = p => page.evaluate(p => ({ bad: window.__m59.bad.filter(x => x.t >= p), end: window.__bridge.endStart.filter(x => x.at >= p),
  ev: window.__ev.filter(e => e.t >= p).map(e => [e.type, e.data]), reloads: window.__bridge.hardReloads, jams: window.__bridge.jams }), p);
const evTypes = x => x.ev.map(e => e[0]);
// content position the viewer sees: samples with data at the playhead (rs >= 2); a src reload reads 0 until the resume seek
const minCtSince = p => page.evaluate(p => { const s = window.__s.filter(x => x.p >= p && x.src && !x.paused && x.rs >= 2); return s.length ? Math.min(...s.map(x => x.ct)) : null; }, p);
const near = (x, y, tol) => typeof x === 'number' && Math.abs(x - y) <= tol;

await page.goto('https://sttv.test/page_m59.html');
await waitFor(() => window.Android && window.Android.StartAuto && window.STTVSpeed && STTVSpeed._ctl.hookedObj === window.Android, null, 15000, 'hook');
const VER = await page.evaluate(() => STTVSpeed.status().version);
const NEW = VER !== '1.3.4';
console.log('engine', VER, path.relative(KIT, ED) || '.');
// cached rate cap from earlier sessions on this TV: the native pipeline ignores playbackRate (report: rate_cap ignored)
await page.evaluate(() => { window.__variant = '720p30'; STTVSpeed._internals.capPut('native', { v: 'ignored', sp: [2], ratio: 1 }); });
// ---- S0 VOD at native 1x from 1000 s
await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
check('S0 VOD plays natively at 1x from the resume point', await waitFor(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1001 && !v.paused; }, null, 45000, 'native play'));
await mark('S0 native 1x'); await sleep(2000);
// ---- S1 2x -> v2b takeover
let p = await mark('S1 2x');
await page.evaluate(() => Android.setPlaybackSpeed(2));
const s1ok = await waitFor(vs, 2, 60000, 'v2b 2x');
await sleep(3000);
let w1 = await win(8000), x = await since(p);
check('S1 v2b active at 2x, content 2x', s1ok && near(w1.slope, 2, 0.15), w1);
check('S1 no native rate write != 1 (before / during the takeover)', x.bad.length === 0, x.bad.slice(0, 3));
// ---- S2 fuse (5 stalls) -> restore to native 1x: must play on from the position, no freeze, no end / reload
await sleep(3000);
const pos2 = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
p = await mark('S2 5 stalls -> fuse -> restore 1x');
// 1.3.6: S2 is the fuse on a GOOD link - pin the measured throughput (with the sandbox's real link speed the 1.3.5 step-down
// rule decided between step-down and fuse: flaky)
await page.evaluate(() => { const b = STTVSpeed._internals.v2b; b.bwEst = 50e6; b.bwN = 5; for (let i = 0; i < 5; i++) STTVSpeed._internals.v2bHlsError({ details: 'bufferStalledError' }); });
await waitFor(() => STTVSpeed._internals.v2b.state === 'idle' && !STTVSpeed._internals.v2b.restoring, null, 20000, 'restored');
let w2 = await win(14000); x = await since(p);
check('S2 restored native element: no playbackRate != 1 written (report T5/T6: froze at 0.25-2x)', x.bad.length === 0, x.bad.slice(0, 3));
check('S2 native 1x plays on (content slope 1, frozen < 2 s)', near(w2.slope, 1, 0.12) && w2.frozenMs < 2000, w2);
check('S2 no jump back, no Play_PannelEndStart, no bridge reload', w2.minCt >= pos2 - 2 && x.end.length === 0 && x.reloads === 0, { pos2, minCt: w2.minCt, end: x.end, reloads: x.reloads, jams: x.jams });
if (NEW) check('S2 v2b_restore_ok', evTypes(x).includes('v2b_restore_ok'), x.ev.filter(e => /restore/.test(e[0])));
if (NEW) {
  // ---- S3 user retry after the fuse
  p = await mark('S3 retry 1.5x -> 2x');
  await page.evaluate(() => Android.setPlaybackSpeed(1.5));
  let ok = await waitFor(vs, 1.5, 45000, 'retry 1.5');
  await page.evaluate(() => Android.setPlaybackSpeed(2));
  ok = ok && await waitFor(vs, 2, 30000, 'retry 2');
  await sleep(2000); x = await since(p);
  check('S3 user request after the fuse -> v2b again at 2x, no native write', ok && x.bad.length === 0, { ok, bad: x.bad.length });
  // ---- S4 quality change (external src) -> native reload -> re-engage at 2x
  await sleep(4000);
  const pre4 = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
  p = await mark('S4 quality change 480p30');
  await page.evaluate(() => Android.__switchVariant('480p30'));
  await waitFor(() => STTVSpeed._internals.v2b.state === 'idle', null, 10000, 'released');
  const s4ok = await waitFor(vs, 2, 45000, 're-engaged 2x');
  await sleep(2000);
  const w4 = await win(6000); x = await since(p);
  const var4 = await page.evaluate(() => STTVSpeed._internals.v2b.variant);
  const min4 = await minCtSince(p);
  check('S4 quality change: v2b re-engaged at 2x on 480p30 (report T7)', s4ok && near(w4.slope, 2, 0.15) && var4 && var4.video === '480p30', { w4, var4 });
  check('S4 no native write != 1, no end / reload, no jump back', x.bad.length === 0 && x.end.length === 0 && x.reloads === 0 && min4 >= pre4 - 2, { bad: x.bad.slice(0, 2), end: x.end, reloads: x.reloads, pre4, min4 });
  // ---- S5 bridge hard reload (mv.load) while v2b plays -> absorbed
  await sleep(2000);
  p = await mark('S5 mv.load() while active');
  await page.evaluate(() => document.getElementById('sttv_main').load());
  await sleep(3000);
  const w5 = await win(5000); x = await since(p);
  check('S5 bridge mv.load() absorbed: v2b stays, still 2x (report T10)', evTypes(x).includes('v2b_absorb_load') && !evTypes(x).includes('v2b_release') && w5.v2b === 'active' && near(w5.slope, 2, 0.2), { w5, ev: x.ev.filter(e => /absorb|kick|release|restore/.test(e[0])) });
  // ---- S6 slow link at 2x: a counted stall -> step down to a variant the link can carry (report T8)
  await sleep(2000);
  p = await mark('S6 step-down (bwEst 2 Mbit/s + stall)');
  await page.evaluate(() => { const b = STTVSpeed._internals.v2b; b.bwEst = 2e6; b.bwN = 5; b.seekAt = -1e9; b.activeAt -= 60000;
    STTVSpeed._internals.v2bHlsError({ details: 'bufferStalledError' }); });
  const s6ok = await waitFor(() => STTVSpeed._internals.v2b.variant && STTVSpeed._internals.v2b.variant.video === '360p30' && STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch, null, 30000, 'step down 360p30');
  await sleep(2000);
  const w6 = await win(6000); x = await since(p);
  const sd = x.ev.find(e => e[0] === 'v2b_step_down'), td = x.ev.find(e => e[0] === 'toast' && /360p30/.test(String(e[1])));
  check('S6 step-down 480p30 -> 360p30 at 2x, plays on at 2x, toast', s6ok && sd && near(w6.slope, 2, 0.15) && !!td && x.bad.length === 0, { sd: sd && sd[1], toast: td && td[1], w6 });
  // ---- S7 WAN outage 25 s at 2x -> no fallback, no release, plays on
  await sleep(3000);
  const pre7 = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
  p = await mark('S7 WAN off 25 s');
  await ctx.setOffline(true); await sleep(25000); await ctx.setOffline(false);
  await mark('S7 WAN back');
  const s7ok = await waitFor(() => { const v = document.getElementById('sttv_main'); return STTVSpeed._internals.v2b.state === 'active' && !v.paused && v.readyState >= 3; }, null, 60000, 'after outage');
  await sleep(3000);
  const w7 = await win(6000); x = await since(p);
  const min7 = await minCtSince(p);
  check('S7 WAN outage: v2b keeps the VOD (no fail / release / end), 2x again, no jump back', s7ok && !evTypes(x).some(t => t === 'v2b_fail' || t === 'v2b_release') && x.end.length === 0 && near(w7.slope, 2, 0.2) && min7 >= pre7 - 2,
    { w7, pre7, min7, end: x.end, net: x.ev.filter(e => /kick|absorb|net_recover|engine_retry|v2b_fail|release|hls_warn/.test(e[0])).slice(0, 12) });
  // ---- S8 restore to 1x with a stuck native pipeline -> nudge
  await sleep(2000);
  if (!(await page.evaluate(vs, 2))) { await page.evaluate(() => Android.setPlaybackSpeed(2)); await waitFor(vs, 2, 45000, 'S8 v2b 2x'); await sleep(5000); }
  const pos8 = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
  p = await mark('S8 1x restore, stuck native pipeline');
  await page.evaluate(() => { window.__m59.freezeNext = true; Android.setPlaybackSpeed(1); });
  const s8ok = await waitFor(p => window.__ev.some(e => e.t >= p && e.type === 'v2b_restore_ok'), p, 25000, 'restore ok');
  const w8 = await win(6000); x = await since(p);
  const stuck = await page.evaluate(() => { window.__m59.freezeNext = false; return { stuckN: window.__m59.stuckN, unstuck: window.__m59.unstuck }; });
  check('S8 stuck restore: v2b_restore_stuck -> nudge -> v2b_restore_ok, native 1x plays, no end', s8ok && evTypes(x).includes('v2b_restore_stuck') && near(w8.slope, 1, 0.12) && x.end.length === 0 && w8.minCt >= pos8 - 2,
    { stuck, w8, ev: x.ev.filter(e => /restore/.test(e[0])) });
  // ---- S11 (1.3.6, TV run 2026-11-05 T6): menu burst 0.25 / 1.5 / 1 right after a restore whose native pipeline has
  // not resumed yet. 1.3.5 engaged a takeover on the stuck element (restore watchdog stopped), the final 1x found no
  // hls.js yet (prefetch) and left it stuck until the bridge's stall reload (TV: position 00:00)
  await sleep(2000);
  if (!(await page.evaluate(vs, 2))) { await page.evaluate(() => Android.setPlaybackSpeed(2)); await waitFor(vs, 2, 45000, 'S11 v2b 2x'); await sleep(5000); }
  const pos11 = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
  const hr11 = await page.evaluate(() => window.__bridge.hardReloads);
  p = await mark('S11 stuck restore + burst 0.25 / 1.5 / 1 (TV T6)');
  await page.evaluate(() => { window.__m59.freezeNext = true; Android.setPlaybackSpeed(1); });
  await waitFor(p => window.__ev.some(e => e.t >= p && e.type === 'v2b_restored'), p, 15000, 'S11 restored');
  segDelayMs = 2500;
  await sleep(2500);
  await page.evaluate(() => Android.setPlaybackSpeed(0.25)); await sleep(1200);
  await page.evaluate(() => Android.setPlaybackSpeed(1.5)); await sleep(600);
  await page.evaluate(() => Android.setPlaybackSpeed(1));
  await sleep(3000); segDelayMs = 0;
  await sleep(9000);
  const w11 = await win(6000); x = await since(p);
  const min11 = await minCtSince(p), hr11b = await page.evaluate(() => window.__bridge.hardReloads);
  const et11 = evTypes(x), iOk = et11.indexOf('v2b_restore_ok'), iEng = et11.indexOf('v2b_engage');
  await page.evaluate(() => { window.__m59.freezeNext = false; });
  check('S11 burst after a stuck restore: no takeover before the restore is confirmed (v2b_restore_ok)', iOk >= 0 && (iEng < 0 || iEng > iOk),
    x.ev.filter(e => /restore|engage|switch|set_speed/.test(e[0])).slice(0, 16));
  check('S11 native 1x plays on from the position: no bridge reload / end, no jump back (TV: 00:00)',
    near(w11.slope, 1, 0.12) && w11.frozenMs < 2000 && min11 >= pos11 - 2 && x.end.length === 0 && hr11b === hr11,
    { pos11, min11, w11, end: x.end, reloads: hr11b - hr11, jams: x.jams });
  // ---- S10 relaunch / visibility diagnostics
  p = await pnow();
  await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
  await sleep(500); x = await since(p);
  check('S10 webOSRelaunch -> event relaunch {speed, v2b, engine}', evTypes(x).includes('relaunch'), x.ev.find(e => e[0] === 'relaunch'));
}
// ---- S9 clip (MP4, no v2b) at 2x: the native element must stay at 1x and keep playing
await page.evaluate(() => Android.stopVideo()); await sleep(1500);
await page.evaluate(() => Android.StartAuto('https://sttv.test/clip.mp4', '', 3, 0, 0));
const s9play = await waitFor(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1 && !v.paused; }, null, 20000, 'clip plays');
p = await mark('S9 clip 2x');
await page.evaluate(() => Android.setPlaybackSpeed(2));
await sleep(1500);
const w9 = await win(9000); x = await since(p);
check('S9 clip at 2x: no native write != 1 (report: 2x crawled at 1.08x without sound / 1.5x froze)', s9play && x.bad.length === 0, x.bad.slice(0, 3));
check('S9 clip keeps playing at 1x (no freeze, no end)', near(w9.slope, 1, 0.12) && w9.frozenMs < 1500 && x.end.length === 0, { w9, end: x.end });
if (NEW) check('S9 toast: clips do not change speed on this TV', x.ev.some(e => e[0] === 'toast' && /клип|clips/i.test(String(e[1]))), x.ev.filter(e => e[0] === 'toast' || e[0] === 'rate_hold'));
const fin = await page.evaluate(() => ({ status: STTVSpeed.status(), bridge: window.__bridge, m59: { bad: window.__m59.bad, freezes: window.__m59.freezes, stuckN: window.__m59.stuckN, unstuck: window.__m59.unstuck },
  counts: window.__ev.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}) }));
check('page errors 0', perr.length === 0, perr.slice(0, 3));
console.log('v2b status', JSON.stringify(fin.status.v2b).slice(0, 900));
console.log('events', JSON.stringify(fin.counts));
console.log('bridge log tail', JSON.stringify(fin.bridge.log.slice(-12)));
const pass = R.filter(r => r.ok).length;
console.log(`RESULT ${VER}: ${pass}/${R.length} PASS`);
fs.writeFileSync(OUT, JSON.stringify({ version: VER, engineDir: path.relative(KIT, ED) || '.', results: R, marks, fin, logs: logs.slice(-1500) }, null, 1));
await page.close(); await browser.close();
process.exit(0);
