// E2E for v1.2 v2b (timeline compression) on a RATE_IGNORED TV emulation (playbackRate reads back but media stays 1.00x),
// with a xenking-like bridge (native HLS from blob: media playlist text). Usage:
//   node run_v2b.mjs [direct|luna|cors] -> result_v2b_<net>.json + console report
// cors: like luna, but the engine picks the path itself (direct XHR fails like CORS on the TV -> fallback to Luna)
// luna: web security ON (CORS like the TV), PalmServiceBridge -> deploy/service/sttv_media_fetch.js fetchMedia (node side),
//       STTV_SPEED_LUNA_CHUNK=256 KB so every video segment is assembled from several ranged Luna responses.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { KIT, TD } from '../_paths.mjs';
const DIR = KIT + 'tests/e2e/', SP = KIT + 'sttv-speed/';
const NET = process.argv[2] || 'direct';
for (const f of ['sttv-speed.js', 'sttv-v2b.js', 'sttv-hls.min.js']) fs.copyFileSync(SP + f, DIR + f);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// web security stays off in both modes: Chromium's built-in HLS (the stand-in for the TV's native player) refuses the
// cross-origin segments of a blob: manifest when it is on ("no supported sources"); the TV's native pipeline has no CORS.
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.route('https://sttv.test/**', route => {
  const f = DIR + new URL(route.request().url()).pathname.slice(1);
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript' });
});
const blocked = [];
const LUNA = NET === 'luna' || NET === 'cors';
if (LUNA) {
  // TV-like CORS at the network layer: page scripts cannot read the CDN (xhr -> aborted, fetch -> aborted except the
  // playlists the bridge emulation reads itself); media-element loads (native player) pass. sttv-speed must use Luna.
  await ctx.route(/^https:\/\/[^/]*(cloudfront\.net|ttvnw\.net|jtvnw\.net|twitch\.tv)\//, route => {
    const t = route.request().resourceType(), u = route.request().url();
    if (t === 'xhr' || (t === 'fetch' && !/\.m3u8(\?|$)/.test(u))) { if (blocked.length < 200) blocked.push(t + ' ' + u.slice(0, 110)); return route.abort('accessdenied'); }
    return route.continue();
  });
  const svc = createRequire(import.meta.url)(KIT + 'deploy/service/sttv_media_fetch.js');
  await ctx.exposeFunction('__lunaFetch', (uri, params) => new Promise(res => {
    if (!/^luna:\/\/com\.tbsniller\.smarttwitchwebostv\.hls\/fetchPlaylist$/.test(uri)) return res(JSON.stringify({ returnValue: false, errorCode: 'bad_uri' }));
    svc.fetchMedia(JSON.parse(params), r => res(JSON.stringify(r)));
  }));
  await ctx.addInitScript(({ force }) => {
    window.PalmSystem = { identifier: 'com.tbsniller.smarttwitchwebostv 1001' };
    window.__lunaCalls = 0; window.__lunaKB = 0;
    window.PalmServiceBridge = function () {
      var self = this;
      this.call = function (uri, params) { window.__lunaCalls++; window.__lunaFetch(uri, params).then(function (r) { window.__lunaKB += r.length / 1365; if (self.onservicecallback) self.onservicecallback(r); }); };
      this.cancel = function () { self.onservicecallback = null; };
    };
    if (force) localStorage.setItem('STTV_SPEED_NET', 'luna'); else localStorage.removeItem('STTV_SPEED_NET');
    localStorage.setItem('STTV_SPEED_LUNA_CHUNK', String(256 * 1024));
  }, { force: NET === 'luna' });
}
await ctx.addInitScript(() => {
  try { localStorage.setItem('STTV_SPEED_DEBUG', '1'); localStorage.setItem('STTV_SPEED_V2B', 'auto'); } catch (e) {}
  // RATE_IGNORED emulation (LG M59LA): property reads back, media keeps 1.00x
  const P = HTMLMediaElement.prototype, dr = Object.getOwnPropertyDescriptor(P, 'playbackRate'), dd = Object.getOwnPropertyDescriptor(P, 'defaultPlaybackRate');
  const req = new WeakMap(), reqD = new WeakMap();
  const def = (name, d, map) => Object.defineProperty(P, name, { configurable: true, enumerable: true,
    get() { return map.has(this) ? map.get(this) : d.get.call(this); },
    set(v) { map.set(this, +v); d.set.call(this, 1); this.dispatchEvent(new Event('ratechange')); } });
  def('playbackRate', dr, req); def('defaultPlaybackRate', dd, reqD);
  window.__realRate = v => dr.get.call(v);
  const ctD = Object.getOwnPropertyDescriptor(P, 'currentTime'), durD = Object.getOwnPropertyDescriptor(P, 'duration');
  window.__taps = [];
  // v1.3 opens a fresh AudioContext per v2b engine: tag taps + samples with the context they belong to (when restarts at 0)
  const cids = new WeakMap(); let ncid = 0;
  window.__cid = c => { if (!c) return null; if (!cids.has(c)) cids.set(c, ++ncid); return cids.get(c); };
  window.__sttvSpeedTap = function (c) {
    const e = window.STTVSpeed && STTVSpeed._ctl.engine;
    if (window.__taps.length < 60000) window.__taps.push({ when: c.when, c0: c.c0, c1: c.c1, len: c.len, sr: c.sr, k: e && e.ctx ? window.__cid(e.ctx) : null });
  };
  window.__s = [];
  setInterval(() => {
    const v = document.getElementById('sttv_main'), S = window.STTVSpeed, e = S && S._ctl.engine, I = S && S._internals;
    if (!v) return;
    let q = null; try { const pq = v.getVideoPlaybackQuality(); q = [pq.totalVideoFrames, pq.droppedVideoFrames]; } catch (x) {}
    window.__s.push({ p: performance.now(), ct: v.currentTime, et: ctD.get.call(v), rate: dr.get.call(v), paused: v.paused, seeking: v.seeking,
      anch: !!(e && e.anch), eng: e ? (e.dead ? 'dead' : e.pipe) : null, ctxT: e && e.ctx ? e.ctx.currentTime : null, lat: e ? e.latS : null,
      k: e && e.ctx ? window.__cid(e.ctx) : null,
      speed: S ? S._ctl.speed : null, v2b: I ? I.v2b.state : null, q, src: String(v.currentSrc || v.src).slice(0, 5),
      out: e && e.am ? e.am.outDb : null, cls: e && e.am ? e.am.cls : null, guard: e ? e.guard.active : null,
      rm: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted').get.call(v), vol: e && e.vol ? e.vol.gain.value : null,
      // v1.3.2: what the bridge UI reads (getMainDurationMs/gettime = video.duration/currentTime through the shim) + native
      dur: v.duration, edur: durD.get.call(v), ended: v.ended,
      sk: (() => { try { const r = v.seekable; return r.length ? r.end(r.length - 1) : null; } catch (x) { return null; } })() });
  }, 50);
});
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (logs.length < 4000) logs.push(m.text().slice(0, 240)); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const REF = +fs.readFileSync(TD + 'v360.m3u8', 'utf8').split(/\r?\n/).filter(l => l.startsWith('#EXTINF:')).reduce((a, l) => a + parseFloat(l.slice(8)), 0).toFixed(3);
const marks = [];
const T0 = Date.now();
async function mark(name) { const p = await page.evaluate(() => performance.now()); marks.push({ name, p }); console.log(((Date.now() - T0) / 1000).toFixed(1) + 's mark', name); }
const st = () => page.evaluate(() => { const s = STTVSpeed.status(); return { v2b: s.v2b.state, eng: s.engine && s.engine.state, pipe: s.pipe.pipe, ct: s.video.ct, verdict: s.verdict.summary }; });
async function waitFor(fn, arg, ms, label) {
  try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; }
  catch (e) { console.log('TIMEOUT', label, JSON.stringify(await st())); return false; }
}
const active = () => STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch;
await page.goto('https://sttv.test/page_v2b.html');
await waitFor(() => window.Android && window.Android.StartAuto && window.STTVSpeed && STTVSpeed._ctl.hookedObj === window.Android, null, 15000, 'hook');
await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
await waitFor(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1001 && !v.paused; }, null, 45000, 'native play');
await mark('P0 native 1x'); await sleep(3000);
console.log('pipe', JSON.stringify(await page.evaluate(() => STTVSpeed.pipe())));
await page.evaluate(() => Android.setPlaybackSpeed(1.5));
await mark('P1a 1.5x pre-flight + takeover');
await waitFor(active, null, 60000, 'v2b active 1.5');
await mark('P1 v2b 1.5x'); await sleep(15000);
await page.evaluate(() => Android.mseekTo(Math.round((document.getElementById('sttv_main').currentTime + 60) * 1000)));
await mark('P2a seek +60');
await waitFor(active, null, 30000, 'after seek');
await mark('P2 after seek'); await sleep(8000);
await page.evaluate(() => Android.setPlaybackSpeed(2));
await mark('P3a 2x respeed');
await waitFor(() => STTVSpeed._internals.v2b.speed === 2 && STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch, null, 30000, '2x');
await mark('P3 v2b 2x'); await sleep(15000);
let diag = null;
if (process.env.DIAG) {
  // v1.3 listening test while v2b plays at 2x: objective side only (headless has no ears)
  await mark('P3d audioDiag at 2x');
  diag = await page.evaluate(() => STTVSpeed.audioDiag());
  console.log('audioDiag', JSON.stringify(diag.tests.map(t => [t.id, t.name, t.renderedDb !== undefined ? t.renderedDb : t.audioCt, t.err || t.skipped || '', 'muted ' + t.elementMuted0 + '>' + t.elementMuted])), 'after', JSON.stringify(diag.after));
  const t3 = diag.tests.find(t => t.id === 3) || {};
  console.log(t3.elementMuted0 === true && t3.elementMuted === true && diag.after && diag.after.realMuted === false ? 'PASS' : 'FAIL',
    'diag test 3 holds the element mute against the bridge applyAudio(), restored after');
  await waitFor(active, null, 20000, 'active after diag');
  await mark('P3e after diag'); await sleep(5000);
}
await page.evaluate(() => Android.setPlaybackSpeed(1.25));
await mark('P4a 1.25x respeed');
await waitFor(() => STTVSpeed._internals.v2b.speed === 1.25 && STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch, null, 30000, '1.25x');
await mark('P4 v2b 1.25x'); await sleep(8000);
// v1.3.3: 0.25x (refused as unsupported_speed by 1.3.0 in the TV report) and 0.75x through v2b, then back to 1.25x
const vs = s => STTVSpeed._internals.v2b.speed === s && STTVSpeed._internals.v2b.state === 'active' && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch;
await page.evaluate(() => Android.setPlaybackSpeed(0.25));
await mark('P4b 0.25x respeed');
await waitFor(vs, 0.25, 30000, '0.25x');
await mark('P4c v2b 0.25x'); await sleep(10000);
await page.evaluate(() => Android.setPlaybackSpeed(0.75));
await mark('P4d 0.75x respeed');
await waitFor(vs, 0.75, 30000, '0.75x');
await mark('P4e v2b 0.75x'); await sleep(8000);
await page.evaluate(() => Android.setPlaybackSpeed(1.25));
await mark('P4f 1.25x respeed');
await waitFor(vs, 1.25, 30000, 'back to 1.25x');
await mark('P4g v2b 1.25x again'); await sleep(4000);
// v1.3.4 (TV report on 1.3.3): rapid speed changes -> one new pipeline per request, a stall each, the fuse, 1x + cooldown
const v2bSnap = () => page.evaluate(() => { const b = STTVSpeed._internals.v2b, v = document.getElementById('sttv_main');
  return { ct: v.currentTime, respeeds: b.respeeds, coalesced: b.coalesced, failures: b.failures, switchStalls: b.switchStalls, state: b.state, speed: b.speed,
    sessions: b.hook && b.hook.stats ? b.hook.stats.sessions : null }; });
// v1.3.4: raw element time (reads 0 while a switch re-attaches) vs what the app sees: Android.gettime() and the
// Play_ShowVideoStatus position (progress bar) - those must never show 00:00
const ctWatch = (on) => page.evaluate((on) => { if (on) { window.__minCt = Infinity; window.__minApp = Infinity; window.__minSt = Infinity; window.__ctIv = setInterval(() => {
    const v = document.getElementById('sttv_main'); if (!v.seeking && v.currentTime < window.__minCt) window.__minCt = v.currentTime;
    const g = Android.gettime() / 1000, g2 = Android.getsavedtime() / 1000; window.__minApp = Math.min(window.__minApp, g, g2);
    window.__statusPos = NaN; Android.getVideoStatus(false, 1); const sp = window.__statusPos / 1000; if (sp < window.__minSt) window.__minSt = sp; }, 40); return null; }
  clearInterval(window.__ctIv); return { raw: window.__minCt, app: window.__minApp, st: window.__minSt }; }, on);
const burst = {};
burst.b0 = await v2bSnap(); await ctWatch(true);
await mark('P4h burst 8 requests in 2.4 s');
for (const s of [2, 0.5, 1.5, 0.75, 2, 0.25, 1.5, 0.75]) { await page.evaluate(x => Android.setPlaybackSpeed(x), s); await sleep(300); }
burst.ok1 = await waitFor(vs, 0.75, 30000, 'burst -> 0.75x');
burst.b1 = await v2bSnap(); burst.min1 = await ctWatch(false);
await mark('P4i v2b 0.75x after burst'); await sleep(3000);
burst.b2 = await v2bSnap(); await ctWatch(true);
await mark('P4j burst 4 requests, 700 ms apart');
for (const s of [1.25, 2, 0.5, 1.25]) { await page.evaluate(x => Android.setPlaybackSpeed(x), s); await sleep(700); }
burst.ok2 = await waitFor(vs, 1.25, 30000, 'burst2 -> 1.25x');
burst.b3 = await v2bSnap(); burst.min2 = await ctWatch(false);
// a new pipeline stalls while it fills: 5 stalls right after a switch must not trip the fuse (grace window)
await page.evaluate(() => Android.setPlaybackSpeed(1.5));
await waitFor(vs, 1.5, 30000, 'grace 1.5x');
await page.evaluate(() => { for (let i = 0; i < 5; i++) STTVSpeed._internals.v2bHlsError({ details: 'bufferStalledError' }); });
burst.b4 = await v2bSnap();
await mark('P4k v2b 1.5x after 5 switch stalls'); await sleep(4000);
await page.evaluate(() => Android.setPlaybackSpeed(1.25));
await waitFor(vs, 1.25, 30000, 'back to 1.25x after grace');
await mark('P4l v2b 1.25x'); await sleep(3000);
await page.evaluate(() => document.getElementById('sttv_main').pause());
await mark('P5a paused'); await sleep(3000);
await page.evaluate(() => document.getElementById('sttv_main').play());
await waitFor(active, null, 20000, 'resume');
await mark('P5 resumed'); await sleep(6000);
const preQ = await page.evaluate(() => document.getElementById('sttv_main').currentTime);
await page.evaluate(() => Android.__switchVariant('480p30'));
await mark('P6a quality change (external src)');
await waitFor(() => STTVSpeed._internals.v2b.state === 'idle', null, 10000, 'released');
await waitFor(active, null, 45000, 're-engaged');
await mark('P6 re-engaged 480p'); await sleep(8000);
const pre1 = await page.evaluate(() => document.getElementById('sttv_main').currentTime), preSeeks = await page.evaluate(() => __bridge.resumeSeeks);
const holds0 = await page.evaluate(() => STTVSpeed._internals.v2b.holds);
await ctWatch(true);
await page.evaluate(() => Android.setPlaybackSpeed(1));
await mark('P7a restore 1x');
await waitFor(() => { const v = document.getElementById('sttv_main'); return STTVSpeed._internals.v2b.state === 'idle' && !STTVSpeed._internals.v2b.restoring && !v.paused && v.readyState >= 3; }, null, 20000, 'restored');
await sleep(500);
const restMin = await ctWatch(false), holds1 = await page.evaluate(() => ({ holds: STTVSpeed._internals.v2b.holds, hold: STTVSpeed._internals.v2b.hold, max: STTVSpeed._internals.v2b.holdMax }));
const post1 = await page.evaluate(() => ({ ct: document.getElementById('sttv_main').currentTime, src: document.getElementById('sttv_main').src.slice(0, 5), resumeSeeks: __bridge.resumeSeeks }));
await mark('P7 native 1x'); await sleep(6000);
await page.evaluate(() => Android.setPlaybackSpeed(1.5));
await waitFor(active, null, 40000, 'cached 1.5');
await mark('P8 v2b 1.5x (cached caps)'); await sleep(8000);
// v1.3.4: the fuse still trips on real stalls (outside the grace window); the user's next speed change retries v2b once
const fuse = { f0: await v2bSnap() };
// 1.3.5: at speed > 1 a stall on an unmeasured / slow link steps the quality down before the fuse counts it. The link
// estimate only takes downloads > 40 ms, so on fast local routes it may stay unknown (pre-release 05 run: 4 samples,
// step-down 480p30 -> 360p30, no fuse). Pin a measured fast link: these stalls are hiccups, the fuse must count them.
await page.evaluate(() => { const b = STTVSpeed._internals.v2b; b.bwEst = 50e6; b.bwN = Math.max(b.bwN, 3); });
await page.evaluate(() => { for (let i = 0; i < 5; i++) STTVSpeed._internals.v2bHlsError({ details: 'bufferStalledError' }); });
await mark('P8a 5 stalls outside the grace window -> fuse');
fuse.restored = await waitFor(() => STTVSpeed._internals.v2b.state === 'idle' && !STTVSpeed._internals.v2b.restoring, null, 20000, 'fuse -> restored');
fuse.f1 = await v2bSnap(); fuse.fail = await page.evaluate(() => STTVSpeed._internals.v2b.fail && STTVSpeed._internals.v2b.fail.reason);
fuse.tAfter = await page.evaluate(() => performance.now());
await page.evaluate(() => Android.setPlaybackSpeed(1.25));
await mark('P8b user request after the fuse -> retry');
fuse.retryOk = await waitFor(vs, 1.25, 45000, 'retry 1.25');
await page.evaluate(() => Android.setPlaybackSpeed(1.5));
fuse.back = await waitFor(vs, 1.5, 30000, 'retry -> 1.5');
await mark('P8c v2b 1.5x after the retry'); await sleep(5000);
// v1.3.2 (TV report on 1.3.1: VOD duration shown x S): play into the real end of the VOD at 1.5x -> 'ended' in content time
await page.evaluate(d => Android.mseekTo(Math.round((d - 25) * 1000)), REF);
await mark('P9a seek to end-25s');
await waitFor(() => document.getElementById('sttv_main').ended, null, 60000, 'ended');
const endState = await page.evaluate(() => { const v = document.getElementById('sttv_main'); return { ct: v.currentTime, dur: v.duration, ended: v.ended, v2b: STTVSpeed._internals.v2b.state, speed: STTVSpeed._internals.v2b.speed, eng: STTVSpeed._ctl.engine ? STTVSpeed._ctl.engine.state || (STTVSpeed._ctl.engine.dead ? 'dead' : 'alive') : null }; });
await mark('P9 ended'); await sleep(3000);
await page.evaluate(() => Android.stopVideo());
await mark('P10 stop'); await sleep(1500);
const fin = await page.evaluate(() => ({ status: STTVSpeed.status(), events: STTVSpeed.events(1000), bridge: window.__bridge, luna: window.__lunaCalls || 0, lunaMB: (window.__lunaKB || 0) / 1024 }));
const samples = await page.evaluate(() => window.__s), taps = await page.evaluate(() => window.__taps);
// ---- analysis
const tapsBy = {};
for (const t of taps) (tapsBy[t.k] = tapsBy[t.k] || []).push(t);
function contentAt(X, k) {
  const tk = tapsBy[k] || [];
  let lo = 0, hi = tk.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tk[m].when <= X) lo = m; else hi = m - 1; }
  const t = tk[lo]; if (!t) return null; const d = t.len / t.sr;
  if (X < t.when || X >= t.when + d) return null;
  return t.c0 + (X - t.when) * (t.c1 - t.c0) / d;
}
const slope = pts => { const n = pts.length; if (n < 20) return null; const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n; let sxy = 0, sxx = 0; for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; } return +(sxy / sxx).toFixed(3); };
// the phase's speed = the most frequent requested speed in its window (the next request lands a few samples before the next mark)
const modeOf = a => { const m = new Map(); let best = null, bn = 0; for (const x of a) { const n = (m.get(x) || 0) + 1; m.set(x, n); if (n > bn) { bn = n; best = x; } } return best; };
const rows = [];
for (let i = 0; i < marks.length; i++) {
  const p0 = marks[i].p + 1500, p1 = i + 1 < marks.length ? marks[i + 1].p : Infinity;
  const S = samples.filter(s => s.p >= p0 && s.p < p1 && !s.paused && !s.seeking);
  const errs = [];
  for (const s of S) { if (!s.anch || s.ctxT == null) continue; const c = contentAt(s.ctxT - (s.lat || 0), s.k); if (c != null) errs.push(c - s.ct); }
  const abs = errs.map(Math.abs).sort((a, b) => a - b), n = errs.length;
  const qa = S.find(s => s.q), qb = [...S].reverse().find(s => s.q), dt = qa && qb ? (qb.p - qa.p) / 1000 : 0;
  rows.push({ phase: marks[i].name, v2b: S.length ? S[S.length - 1].v2b : null, speed: S.length ? modeOf(S.map(s => s.speed)) : null, content: slope(S.map(s => [s.p / 1000, s.ct])), element: slope(S.map(s => [s.p / 1000, s.et])),
    fps: dt > 2 ? +((qb.q[0] - qa.q[0]) / dt).toFixed(1) : null, dropFps: dt > 2 ? +((qb.q[1] - qa.q[1]) / dt).toFixed(1) : null,
    syncN: n, syncMeanMs: n ? +(errs.reduce((a, b) => a + b, 0) / n * 1000).toFixed(1) : null, syncP95Ms: n ? +(abs[Math.floor(n * 0.95)] * 1000).toFixed(1) : null,
    anchPct: S.length ? Math.round(100 * S.filter(s => s.anch).length / S.length) : null,
    outDbP50: (() => { const o = S.filter(s => s.anch && s.out !== null).map(s => s.out).sort((a, b) => a - b); return o.length ? o[o.length >> 1] : null; })(),
    guard: S.some(s => s.guard) ? 'ON' : '-', elMuted: S.some(s => s.rm) ? 'MUTED' : '-',
    dur: (() => { const d = S.map(s => s.dur).filter(Number.isFinite).sort((a, b) => a - b); return d.length ? +d[d.length >> 1].toFixed(2) : null; })(),
    durNative: (() => { const d = S.map(s => s.edur).filter(Number.isFinite).sort((a, b) => a - b); return d.length ? +d[d.length >> 1].toFixed(2) : null; })(),
    durMaxErr: (() => { const d = S.map(s => s.dur).filter(Number.isFinite); return d.length ? +Math.max(...d.map(x => Math.abs(x - REF))).toFixed(2) : null; })(),
    seekEnd: (() => { const d = S.map(s => s.sk).filter(Number.isFinite).sort((a, b) => a - b); return d.length ? +d[d.length >> 1].toFixed(2) : null; })(),
    ctMax: S.length ? +Math.max(...S.map(s => s.ct)).toFixed(2) : null });
}
console.table(rows);
const evs = fin.events, cnt = {}; for (const e of evs) cnt[e.type] = (cnt[e.type] || 0) + 1;
console.log('events:', JSON.stringify(cnt));
const pick = t => evs.filter(e => e.type === t).map(e => JSON.stringify(e.data)).slice(0, 6);
for (const t of ['v2b_engage', 'v2b_prefetched', 'v2b_switch', 'v2b_active', 'v2b_respeed', 'v2b_release', 'v2b_restore', 'v2b_restored', 'v2b_fail', 'v2b_unavailable', 'base_ref', 'rate_ok', 'rate_cap', 'engine_fail', 'net_path', 'v2b_hls_warn', 'v2b_stall', 'v2b_external'])
  if (cnt[t]) console.log(t, pick(t).join(' | '));
console.log('quality-change: ct before', preQ.toFixed(2), '| restore 1x: before', pre1.toFixed(2), 'after', post1.ct.toFixed(2), 'src', post1.src, 'bridge resumeSeeks', preSeeks, '->', post1.resumeSeeks);
console.log('bridge', JSON.stringify({ retries: fin.bridge.retries, stallReloads: fin.bridge.stallReloads, srcWrites: fin.bridge.srcWrites, resumeSeeks: fin.bridge.resumeSeeks }), 'luna calls', fin.luna, 'MB', fin.lunaMB.toFixed(1), 'blocked direct', blocked.length, blocked.slice(0, 3).join(' | '));
console.log('v2b status', JSON.stringify(fin.status.v2b));
console.log('rateCap', JSON.stringify(fin.status.rateCap));
const errs = logs.filter(l => /PAGEERROR|Uncaught|TypeError|ReferenceError/.test(l));
console.log('page errors', errs.length, errs.slice(0, 5));
// ---- v1.3 audio-output checks (graph output level while anchored; hardware mute never used in v2b)
const v2bS = samples.filter(s => s.eng === 'v2b' && s.anch);
const outs = v2bS.filter(s => s.out !== null).map(s => s.out).sort((a, b) => a - b);
const audioChk = { anchoredSamples: v2bS.length, outDbP10: outs.length ? outs[Math.floor(outs.length * 0.1)] : null, outDbP50: outs.length ? outs[outs.length >> 1] : null,
  guardOnInV2b: v2bS.filter(s => s.guard).length, elementMutedInV2b: v2bS.filter(s => s.rm).length,
  rendering: evs.filter(e => e.type === 'audio_rendering').length, silent: evs.filter(e => e.type === 'audio_silent').map(e => e.data),
  ctx: evs.filter(e => e.type === 'audio_context').map(e => e.data) };
console.log('audio-out', JSON.stringify(audioChk));
// ---- v1.3.2 timeline checks: the bridge UI shows video.duration / video.currentTime (content time) in every phase
const durRows = rows.filter(r => r.dur !== null);
const durChk = { ref: REF, rows: durRows.map(r => [r.phase.split(' ')[0], r.dur, r.durNative, r.durMaxErr, r.seekEnd]), end: endState };
durChk.ok = durRows.length >= 8 && durRows.every(r => r.durMaxErr <= 1);
durChk.seekOk = rows.filter(r => r.v2b === 'active' && r.seekEnd !== null).every(r => Math.abs(r.seekEnd - REF) <= 1);
durChk.ctOk = rows.every(r => r.ctMax === null || r.ctMax <= REF + 0.5);
durChk.endOk = !!(endState && endState.ended && Math.abs(endState.ct - REF) <= 1.5 && Math.abs(endState.dur - REF) <= 1.5);
durChk.selfCheck = { mismatchEvents: cnt.v2b_timeline_mismatch || 0, timeline: fin.status.v2b.timeline };
durChk.selfOk = durChk.selfCheck.mismatchEvents === 0 && !!(fin.status.v2b.timeline && fin.status.v2b.timeline.checks > 20);
console.log('timeline', JSON.stringify(durChk));
console.log(durChk.ok ? 'PASS' : 'FAIL', 'video.duration = playlist total', REF, 's in every phase (native and v2b, max |err| <= 1 s)');
console.log(durChk.seekOk ? 'PASS' : 'FAIL', 'seekable end = playlist total in v2b phases');
console.log(durChk.ctOk ? 'PASS' : 'FAIL', 'currentTime never beyond the end');
console.log(durChk.endOk ? 'PASS' : 'FAIL', "VOD end at 1.5x: 'ended' with currentTime = duration = total", JSON.stringify(endState));
console.log(durChk.selfOk ? 'PASS' : 'FAIL', 'engine self-check: no v2b_timeline_mismatch, checks ran', JSON.stringify(durChk.selfCheck));
// ---- v1.3.3 generic speed checks on the steady v2b phases (0.25x / 0.75x included)
const STEADY = ['P1', 'P2', 'P3', 'P4', 'P4c', 'P4e', 'P4g', 'P4i', 'P5', 'P6', 'P8', 'P8c'];
const spRows = rows.filter(r => STEADY.includes(r.phase.split(' ')[0]));
const spChk = spRows.map(r => ({ phase: r.phase.split(' ')[0], speed: r.speed, content: r.content, element: r.element, p95: r.syncP95Ms, anch: r.anchPct,
  ok: r.v2b === 'active' && r.speed > 0 && r.content !== null && Math.abs(r.content / r.speed - 1) <= 0.03 && r.element !== null && Math.abs(r.element - 1) <= 0.03 &&
    r.syncP95Ms !== null && r.syncP95Ms <= 40 && r.anchPct >= 90 }));
for (const c of spChk) console.log(c.ok ? 'PASS' : 'FAIL', 'phase', c.phase, 'speed', c.speed, ': content slope', c.content, '(=speed +-3%), element', c.element, '(=1), sync p95', c.p95, 'ms (<=40), anchored', c.anch + '%');
const got = s => spChk.some(c => c.speed === s && c.ok);
console.log(got(0.25) && got(0.75) ? 'PASS' : 'FAIL', 'v1.3.3: 0.25x and 0.75x run through v2b (no unsupported_speed)', JSON.stringify((cnt.v2b_restore ? evs.filter(e => e.type === 'v2b_restore').map(e => e.data) : [])));
// ---- v1.3.4 rapid switching / fuse checks
const evAfter = (t0, type) => evs.filter(e => e.t >= t0 && e.type === type);
let overlap = 0, open = false;
for (const e of evs) { if (e.type === 'v2b_switch') { if (open) overlap++; open = true; } else if (e.type === 'v2b_active' || e.type === 'v2b_restore' || e.type === 'v2b_release' || e.type === 'v2b_fail') open = false; }
const rs = { b1: burst.b1.respeeds - burst.b0.respeeds, c1: burst.b1.coalesced - burst.b0.coalesced, b2: burst.b3.respeeds - burst.b2.respeeds,
  fails: burst.b4.failures - burst.b0.failures, ct0: +burst.b0.ct.toFixed(2), ct2: +burst.b2.ct.toFixed(2),
  raw1: +burst.min1.raw.toFixed(2), app1: +burst.min1.app.toFixed(2), st1: +burst.min1.st.toFixed(2),
  raw2: +burst.min2.raw.toFixed(2), app2: +burst.min2.app.toFixed(2), st2: +burst.min2.st.toFixed(2),
  graceStalls: burst.b4.switchStalls - burst.b3.switchStalls, overlap };
console.log('rapid', JSON.stringify(rs));
console.log(burst.ok1 && rs.b1 >= 1 && rs.b1 <= 2 && rs.c1 >= 5 ? 'PASS' : 'FAIL', 'v1.3.4 burst of 8 requests in 2.4 s -> <= 2 pipeline switches, ends at the last speed (0.75x)', JSON.stringify({ switches: rs.b1, coalesced: rs.c1 }));
console.log(burst.ok2 && rs.b2 <= 4 && overlap === 0 ? 'PASS' : 'FAIL', 'v1.3.4 requests 700 ms apart: never a new switch while one attaches, ends at 1.25x', JSON.stringify({ switches: rs.b2, overlap }));
console.log(Math.min(rs.app1, rs.st1) >= rs.ct0 - 1.5 && Math.min(rs.app2, rs.st2) >= rs.ct2 - 1.5 ? 'PASS' : 'FAIL', 'v1.3.4 app position (gettime/getsavedtime/progress bar) never jumps back during bursts (no 00:00)',
  JSON.stringify({ before1: rs.ct0, app1: rs.app1, bar1: rs.st1, before2: rs.ct2, app2: rs.app2, bar2: rs.st2 }));
console.log('INFO raw element currentTime minimum during bursts (re-attach reads 0, hidden from the app by the hold)', JSON.stringify({ raw1: rs.raw1, raw2: rs.raw2 }));
console.log(Math.min(restMin.app, restMin.st) >= pre1 - 1.5 && holds1.holds > holds0 && !holds1.hold ? 'PASS' : 'FAIL', 'v1.3.4 app position holds during the native restore to 1x and the hold is released after it',
  JSON.stringify({ before: +pre1.toFixed(2), app: +restMin.app.toFixed(2), bar: +restMin.st.toFixed(2), raw: +restMin.raw.toFixed(2), holds: holds1.holds - holds0, holdMaxMs: holds1.max, left: holds1.hold }));
console.log(rs.fails === 0 && rs.graceStalls >= 5 ? 'PASS' : 'FAIL', 'v1.3.4 stalls right after a switch are not counted (no fuse during the bursts)', JSON.stringify({ failures: rs.fails, switchStalls: rs.graceStalls }));
const gateAfter = evs.filter(e => e.t >= fuse.tAfter && e.type === 'toast' && /does not apply|не применяет/.test(e.data));
console.log(fuse.restored && fuse.f1.failures === fuse.f0.failures + 1 && fuse.fail === 'stalls' ? 'PASS' : 'FAIL', 'v1.3.4 fuse still trips on 5 stalls outside the grace window -> restore 1x', JSON.stringify({ fail: fuse.fail, failures: [fuse.f0.failures, fuse.f1.failures] }));
console.log(fuse.retryOk && fuse.back && evAfter(fuse.tAfter, 'v2b_retry').length === 1 && gateAfter.length === 0 ? 'PASS' : 'FAIL', 'v1.3.4 the next user request retries v2b once (no "TV does not apply" toast)', JSON.stringify({ retry: evAfter(fuse.tAfter, 'v2b_retry').map(e => e.data), gate: gateAfter.map(e => e.data) }));
fs.writeFileSync(DIR + 'result_v2b_' + NET + '.json', JSON.stringify({ marks, rows, spChk, audioChk, durChk, diag, rapid: { rs, burst, fuse }, events: evs, bridge: fin.bridge, status: fin.status, logs: logs.slice(-600) }));
await page.close(); await browser.close();
process.exit(0);
