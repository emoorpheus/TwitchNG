// VOD timeline through the REAL app bridge of a built IPK (what the SmartTwitchTV UI shows), on a TV-like
// RATE_IGNORED emulation (playbackRate reads back, media stays 1.00x -> v2b takeover), Chromium's built-in HLS as the
// stand-in for the TV's native player. v1.3.2 regression for the TV report on 1.3.1: "VOD duration S x too long".
//   node tests/app/vod.mjs <app.ipk> [workDir]
// UI reads: Android.getDuration(cb) / getVideoStatus() payload[8] = duration ms, Android.gettime() / payload[9] = position.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TD } from '../_paths.mjs';
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IPK = path.resolve(process.argv[2] || '');
const W = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'sttv-app-vod'));
if (!fs.existsSync(IPK)) { console.error('usage: node tests/app/vod.mjs <app.ipk> [workDir]'); process.exit(2); }
fs.rmSync(W, { recursive: true, force: true });
for (const d of ['ar', 'root', 'stub/webos-service']) fs.mkdirSync(path.join(W, d), { recursive: true });
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const PK = path.join(W, 'root/usr/palm/packages');
const pinfo = JSON.parse(fs.readFileSync(path.join(PK, fs.readdirSync(PK)[0], 'packageinfo.json'), 'utf8'));
const ID = pinfo.app, SID = pinfo.services[0];
const APP = path.join(W, 'root/usr/palm/applications', ID), SVC = path.join(W, 'root/usr/palm/services', SID);
fs.writeFileSync(path.join(W, 'stub/webos-service/index.js'),
  'function Service(name) { this.name = name; global.__svc = { name: name, methods: {} }; }\n' +
  'Service.prototype.register = function (m, cb) { global.__svc.methods[m] = cb; return { on: function () {} }; };\nmodule.exports = Service;\n');
process.env.NODE_PATH = path.join(W, 'stub');
createRequire(import.meta.url)('module').Module._initPaths();
createRequire(import.meta.url)(path.join(SVC, JSON.parse(fs.readFileSync(path.join(SVC, 'package.json'), 'utf8')).main));
const svc = global.__svc;

// test VOD (14.9 h GDQ VOD, 360p30 only for the native player; the engine gets audio_only from the StartAuto playlist)
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const REF = +fs.readFileSync(TD + 'v360.m3u8', 'utf8').split(/\r?\n/).filter(l => l.startsWith('#EXTINF:')).reduce((a, l) => a + parseFloat(l.slice(8)), 0).toFixed(3);
function filterMaster(txt, keep) {
  const L = txt.split(/\r?\n/), out = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('#EXT-X-MEDIA:')) { const url = L[i + 2] || ''; if (keep.some(k => url.includes('/' + k + '/'))) out.push(L[i], L[i + 1], L[i + 2]); i += 2; }
    else if (!L[i].startsWith('#EXT-X-STREAM-INF') && !/^https?:/.test(L[i])) out.push(L[i]);
  }
  return out.join('\n');
}
const USHER = 'https://usher.ttvnw.net/vod/2915888911.m3u8';
const plStart = filterMaster(master, ['360p30', 'audio_only']), plNative = filterMaster(master, ['360p30']);

let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails++; };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
console.log('ipk', path.basename(IPK), 'app', ID, 'ref duration', REF, 's');

const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
// web security off: Chromium's built-in HLS (stand-in for the TV player) refuses cross-origin segments otherwise
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--disable-web-security', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 },
  userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager' });
await ctx.route(USHER + '*', (r) => r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: plNative }));
await ctx.exposeFunction('__luna', (uri, params) => new Promise((res) => {
  const m = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri || ''), p = (() => { try { return JSON.parse(params); } catch (e) { return {}; } })();
  if (!m || m[1] !== SID || !svc.methods[m[2]]) return res(JSON.stringify({ returnValue: false, errorText: 'unknown ' + uri }));
  svc.methods[m[2]]({ payload: p, respond: (r) => res(JSON.stringify(r)) });
}));
await ctx.addInitScript(({ id }) => {
  window.PalmSystem = { identifier: id + ' 1001', launchParams: '{}', activate() {}, platformBack() {}, stageReady() {},
    deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '10.3.0', platformVersionMajor: 10, screenWidth: 1920, screenHeight: 1080 }) };
  window.PalmServiceBridge = function () {
    const self = this;
    this.call = (uri, params) => { window.__luna(uri, params).then((r) => { if (self.onservicecallback) self.onservicecallback(r); }); };
    this.cancel = () => { self.onservicecallback = null; };
  };
  // RATE_IGNORED (LG M59LA, webOS 25): playbackRate reads back, the media keeps 1.00x
  const P = HTMLMediaElement.prototype;
  for (const name of ['playbackRate', 'defaultPlaybackRate']) {
    const d = Object.getOwnPropertyDescriptor(P, name), req = new WeakMap();
    Object.defineProperty(P, name, { configurable: true, enumerable: true, get() { return req.has(this) ? req.get(this) : d.get.call(this); },
      set(v) { req.set(this, +v); d.set.call(this, 1); this.dispatchEvent(new Event('ratechange')); } });
  }
  window.__ui = { durCalls: [], statusCalls: 0, last: null };
  window.__sttvDur = (d) => { window.__ui.dur = d; };
}, { id: ID });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.STTVSpeed && window.Android && window.Android.__isWebOSPolyfill && STTVSpeed.status().hooked, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
// capture what the app UI is handed: Play_UpdateDuration (bridge, loadedmetadata) + Play_ShowVideoStatus payload
await page.evaluate(() => {
  const ns = window.smartTwitchTV || window;
  for (const n of ['Play_UpdateDuration', 'Play_ShowVideoStatus']) {
    const orig = ns[n];
    ns[n] = function () {
      if (n === 'Play_UpdateDuration') window.__ui.durCalls.push({ d: arguments[0], ct: (document.getElementById('sttv_main') || {}).currentTime });
      else { window.__ui.statusCalls++; try { const p = JSON.parse(arguments[2]); window.__ui.last = { durationMs: p[8], positionMs: p[9] }; } catch (e) {} }
      try { return orig && orig.apply(this, arguments); } catch (e) { return null; }
    };
  }
});
const ui = () => page.evaluate(() => {
  const A = window.Android, v = document.getElementById('sttv_main'), S = window.STTVSpeed, I = S._internals;
  A.getDuration('__sttvDur'); A.getVideoStatus(false, 0);
  return { getDuration: window.__ui.dur, gettime: A.gettime(), status: window.__ui.last, ct: v ? v.currentTime : null, dur: v ? v.duration : null,
    v2b: I.v2b.state, speed: I.v2b.speed, ended: v ? v.ended : null, anch: !!(S._ctl.engine && S._ctl.engine.anch), timeline: S.v2b().timeline };
});
const waitFor = async (fn, ms, label) => { try { await page.waitForFunction(fn, null, { timeout: ms, polling: 250 }); return true; } catch (e) { console.log('TIMEOUT', label, JSON.stringify(await ui())); return false; } };
const active = (s) => `(() => { const I = STTVSpeed._internals; return I.v2b.state === 'active' && I.v2b.speed === ${s} && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch; })()`;
const T0 = Date.now(), log = (m) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's ' + m);
const rows = [];
function check(phase, u, S) {
  const durOk = near(u.getDuration, REF * 1000, 1000) && near(u.status && u.status.durationMs, REF * 1000, 1000);
  const posOk = near(u.gettime, u.ct * 1000, 1500) && u.gettime <= REF * 1000 + 500;
  rows.push({ phase, S, getDurationS: u.getDuration / 1000, statusDurS: u.status && u.status.durationMs / 1000, gettimeS: u.gettime / 1000, ct: +(+u.ct).toFixed(2), v2b: u.v2b, durOk, posOk });
  ok(durOk, `${phase}: UI duration (getDuration + getVideoStatus) = ${REF} s`, { getDuration: u.getDuration, status: u.status && u.status.durationMs, ratio: +(u.getDuration / 1000 / REF).toFixed(3) });
  ok(posOk, `${phase}: UI position (gettime) = video.currentTime`, { gettime: u.gettime, ct: u.ct });
}

await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), [USHER, plStart]);
log('StartAuto VOD @1000 s');
await waitFor(() => { const v = document.getElementById('sttv_main'); return v && v.currentTime > 1001 && !v.paused; }, 45000, 'native play');
await page.waitForTimeout(2000);
check('native 1x', await ui(), 1);

await page.evaluate(() => Android.setPlaybackSpeed(2)); log('speed 2');
await waitFor(active(2), 60000, 'v2b 2x');
await page.waitForTimeout(4000);
const a = await ui(); await page.waitForTimeout(4000); const b = await ui();
check('v2b 2x', b, 2);
const slope = (b.gettime - a.gettime) / 4000;
ok(near(slope, 2, 0.15), 'v2b 2x: UI position advances 2 s per second (content time)', { slope: +slope.toFixed(3) });

const pos0 = (await ui()).gettime;
await page.evaluate((p) => Android.mseekTo(p + 60000), pos0); log('seek +60 s');
await waitFor(active(2), 30000, 'after seek');
await page.waitForTimeout(3000);
const s1 = await ui();
check('v2b 2x after seek +60', s1, 2);
ok(s1.gettime - pos0 >= 60000 && s1.gettime - pos0 <= 60000 + 12000, 'seek +60 s lands +60 s in content time', { delta: s1.gettime - pos0 });

// 1.3.7 (TV run 2026-11-05, pre-release 03, T7 at 2x): OK on the quality button = Android.RestartPlayer (the bridge's setMain
// with the resume point) + the app's SetQuality re-select ~10-70 ms later -> the bridge took the resume point from the
// reloading element (0) and the VOD restarted from 00:00
const pq = (await ui()).gettime;
await page.evaluate(() => { Android.RestartPlayer(2, Android.gettime(), 0); setTimeout(() => Android.SetQuality(0), 40); });
log('RestartPlayer + SetQuality 40 ms later (TV T7)');
await waitFor(active(2), 60000, 'v2b 2x after the quality reload');
await page.waitForTimeout(3000);
const sq = await ui();
const qres = await page.evaluate(() => STTVSpeed.events(300).filter(e => e.type === 'quality_resume' || e.type === 'quality_resume_meta').map(e => e.type + ' ' + JSON.stringify(e.data)));
check('v2b 2x after RestartPlayer + SetQuality', sq, 2);
ok(sq.gettime >= pq - 3000 && sq.gettime <= pq + 40000, '1.3.7: RestartPlayer + SetQuality at 2x keeps the VOD position (TV T7 pre03: 00:00)', { before: pq, after: sq.gettime, ct: sq.ct, events: qres });

await page.evaluate(() => Android.setPlaybackSpeed(1.5)); log('speed 1.5');
await waitFor(active(1.5), 30000, 'v2b 1.5x');
await page.waitForTimeout(4000);
check('v2b 1.5x', await ui(), 1.5);

// v1.3.3: 0.25x (the TV report on 1.3.0: refused as "unsupported_speed") now runs through v2b as well
await page.evaluate(() => Android.setPlaybackSpeed(0.25)); log('speed 0.25');
await waitFor(active(0.25), 30000, 'v2b 0.25x');
await page.waitForTimeout(3000);
const q1 = await ui(); await page.waitForTimeout(8000); const q2 = await ui();
check('v2b 0.25x', q2, 0.25);
const sl25 = (q2.gettime - q1.gettime) / 8000;
ok(near(sl25, 0.25, 0.04), 'v2b 0.25x: UI position advances 0.25 s per second (content time)', { slope: +sl25.toFixed(3) });

await page.evaluate(() => Android.setPlaybackSpeed(1)); log('speed 1');
await waitFor(() => { const v = document.getElementById('sttv_main'); return STTVSpeed._internals.v2b.state === 'idle' && !STTVSpeed._internals.v2b.restoring && v && !v.paused && v.readyState >= 3; }, 30000, 'restored 1x');
await page.waitForTimeout(3000);
check('native 1x restored', await ui(), 1);

// v1.3.3: 1.15x is not a v2b speed and this pipeline is known to ignore playbackRate (cap cached by the 2x pre-flight):
// the element is held at 1.0 (rate_hold) + the gate toast, instead of poking the native player (TV: jump to the start)
const h0 = await ui();
await page.evaluate(() => Android.setPlaybackSpeed(1.15)); log('speed 1.15 (native pipeline ignores the rate)');
await page.waitForTimeout(3000);
const h = await page.evaluate(() => { const v = document.getElementById('sttv_main'), evs = STTVSpeed.events(80), t = document.getElementById('sttv_speed_toast');
  return { rate: v.playbackRate, def: v.defaultPlaybackRate, v2b: STTVSpeed._internals.v2b.state, paused: v.paused, ct: v.currentTime,
    hold: evs.filter(e => e.type === 'rate_hold').map(e => e.data), gate: evs.filter(e => e.type === 'rate_gate').map(e => e.data), toast: t ? t.textContent : null }; });
ok(h.rate === 1 && h.def === 1 && h.hold.length >= 1 && h.v2b === 'idle' && !h.paused, '1.15x: element held at 1.0 (rate_hold), no v2b, playback continues', h);
ok(h.gate.length >= 1 && /1\.15/.test(h.toast || ''), '1.15x: gate toast tells the user the TV does not apply it', { toast: h.toast });
ok(h.ct * 1000 >= h0.gettime + 1500 && h.ct * 1000 <= h0.gettime + 6000, '1.15x: position keeps going at 1x (no jump)', { before: h0.gettime, after: Math.round(h.ct * 1000) });
await page.evaluate(() => Android.setPlaybackSpeed(1)); log('speed 1');
await page.waitForTimeout(1000);

await page.evaluate(() => Android.setPlaybackSpeed(2)); log('speed 2 (cached caps)');
await waitFor(active(2), 40000, 'v2b 2x again');
await page.waitForTimeout(3000);
check('v2b 2x again', await ui(), 2);
// the bridge clamps a seek to (duration - 1 s): with the 1.3.1 duration (S x) a seek past the end went beyond the media
await page.evaluate((r) => Android.mseekTo(Math.round((r + 100) * 1000)), REF); log('seek past the end');
await page.waitForTimeout(1500);
const sEnd = await ui();
ok(sEnd.gettime <= REF * 1000 + 500 && sEnd.gettime >= (REF - 3) * 1000, 'seek past the end: the bridge clamps to the last second', { gettime: sEnd.gettime, refMs: REF * 1000 });
const endedOk = await waitFor(() => { const v = document.getElementById('sttv_main'); return v && v.ended; }, 20000, 'ended');
const fin = await ui();
ok(endedOk && near(fin.gettime, REF * 1000, 1500) && near(fin.getDuration, REF * 1000, 1500), "VOD end: 'ended', UI position = UI duration = total", { gettime: fin.gettime, getDuration: fin.getDuration, ended: fin.ended });
const tl = (await page.evaluate(() => STTVSpeed.v2b().timeline)) || {};   // 1.3.1 has no self-check
const evs = await page.evaluate(() => STTVSpeed.events(400));
const cnt = {}; for (const e of evs) cnt[e.type] = (cnt[e.type] || 0) + 1;
const durCalls = await page.evaluate(() => window.__ui.durCalls);
ok(!cnt.v2b_timeline_mismatch && tl.checks > 10, 'engine self-check: no v2b_timeline_mismatch', { checks: tl.checks, mismatches: tl.mismatches, hook: tl.hook });
ok(durCalls.every(c => near(c.d, REF * 1000, 1000)), 'every Play_UpdateDuration call carried the real duration', durCalls.map(c => c.d));
ok(!cnt.v2b_fail && errors.length === 0, 'no v2b failures, no page errors', { v2b_fail: cnt.v2b_fail || 0, errors: errors.slice(0, 3) });
console.table(rows);
console.log('events', JSON.stringify(cnt));
fs.writeFileSync(path.join(W, 'vod-result.json'), JSON.stringify({ ipk: path.basename(IPK), ref: REF, rows, durCalls, timeline: tl, events: evs }, null, 1));
await page.close(); await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL APP VOD TIMELINE CHECKS PASS');
process.exit(fails ? 1 : 0);
