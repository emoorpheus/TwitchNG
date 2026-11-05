// E2E for v1.1 verify-then-engage + rate capability cache. Emulates the LG M59LA (webOS 25) native HLS pipeline:
// playbackRate property reads back the requested value but the media keeps running at 1.00x (RATE_IGNORED).
// Usage: node run_gate.mjs   -> result_gate.json + console report
import { chromium } from 'playwright';
import fs from 'node:fs';
import { KIT, TD } from '../_paths.mjs';
const DIR = KIT + 'tests/e2e/';
fs.copyFileSync(KIT + 'sttv-speed/sttv-speed.js', DIR + 'sttv-speed.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.route('https://sttv.test/**', route => {
  const f = DIR + new URL(route.request().url()).pathname.slice(1);
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript' });
});
await ctx.addInitScript(() => {
  window.__native = true;
  try { localStorage.setItem('STTV_SPEED_DEBUG', '1'); } catch (e) {}
  const P = HTMLMediaElement.prototype, dr = Object.getOwnPropertyDescriptor(P, 'playbackRate'), dd = Object.getOwnPropertyDescriptor(P, 'defaultPlaybackRate');
  const req = new WeakMap(), reqD = new WeakMap();
  window.__ignoreRate = sessionStorage.getItem('ignoreRate') !== '0';
  const def = (name, d, map) => Object.defineProperty(P, name, { configurable: true, enumerable: true,
    get() { return window.__ignoreRate && map.has(this) ? map.get(this) : d.get.call(this); },
    set(v) { if (window.__ignoreRate) { map.set(this, +v); d.set.call(this, 1); this.dispatchEvent(new Event('ratechange')); } else d.set.call(this, v); } });
  def('playbackRate', dr, req); def('defaultPlaybackRate', dd, reqD);
  window.__setIgnoreRate = on => {
    window.__ignoreRate = on; sessionStorage.setItem('ignoreRate', on ? '1' : '0');
    if (!on) document.querySelectorAll('video').forEach(v => { if (req.has(v)) dr.set.call(v, req.get(v)); if (reqD.has(v)) dd.set.call(v, reqD.get(v)); });
  };
  const md = Object.getOwnPropertyDescriptor(P, 'muted');
  window.__s = [];
  setInterval(() => {
    const v = document.getElementById('sttv_main'), S = window.STTVSpeed, e = S && S._ctl.engine;
    if (v) window.__s.push({ p: performance.now(), ct: v.currentTime, realMuted: md.get.call(v), anch: !!(e && e.anch), eng: !!(e && !e.dead), speed: S ? S._ctl.speed : null });
  }, 100);
});
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (logs.length < 2000) logs.push(m.text().slice(0, 200)); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const marks = [];
async function mark(name) { const p = await page.evaluate(() => performance.now()); marks.push({ name, p }); console.log('mark', name, Math.round(p)); }
async function boot(tag) {
  await page.goto('https://sttv.test/page.html');
  await page.waitForFunction(() => window.Android && window.Android.StartAuto && window.STTVSpeed && STTVSpeed._ctl.hookedObj === window.Android, null, { timeout: 15000 });
  await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
  await page.waitForFunction(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1001 && !v.paused; }, null, { timeout: 45000 });
  await mark(tag + ':play_1x');
  await sleep(1500);
}
const phases = [];
async function phase(name, fn, waitMs) {
  const t0 = await page.evaluate(() => performance.now());
  await fn();
  await sleep(waitMs);
  const r = await page.evaluate(t0 => {
    const S = STTVSpeed, evs = S.events(400).filter(e => e.t >= t0 - 5), smp = window.__s.filter(s => s.p >= t0);
    const first = type => { const e = evs.find(x => x.type === type); return e ? Math.round(e.t - t0) : null; };
    const v = document.getElementById('sttv_main');
    const pts = smp.filter(s => s.ct > 0), rate = pts.length > 10 ? (pts[pts.length - 1].ct - pts[0].ct) / ((pts[pts.length - 1].p - pts[0].p) / 1000) : null;
    return { types: evs.map(e => e.type + (e.data && typeof e.data !== 'object' ? ':' + e.data : (e.data && e.data.v ? ':' + e.data.v : ''))),
      tEngineStart: first('engine_start'), tRateOk: first('rate_ok'), tFail: first('engine_fail'), tGate: first('rate_gate'), tAnchor: first('anchor'),
      everAnchored: smp.some(s => s.anch), mutedSamples: smp.filter(s => s.realMuted).length, samples: smp.length,
      videoRate: rate === null ? null : +rate.toFixed(3), propRate: v.playbackRate, verdict: S.status().verdict, cap: S.rateCap(), toast: (document.getElementById('sttv_speed_toast') || {}).textContent || null };
  }, t0);
  r.phase = name; phases.push(r);
  console.log(JSON.stringify(r));
}
// A: RATE_IGNORED, empty cache -> pre-flight must reject without ever touching the audio
await boot('A');
await phase('A: 1.5x, rate ignored, empty cache', () => page.evaluate(() => Android.setPlaybackSpeed(1.5)), 9000);
// B: another speed, same stream -> cached gate, no engine
await phase('B: 2x, cached ignored', () => page.evaluate(() => Android.setPlaybackSpeed(2)), 3000);
// C: app restart (reload), cache persists
await boot('C');
await phase('C: reload, 1.5x, cached ignored', () => page.evaluate(() => Android.setPlaybackSpeed(1.5)), 3000);
// D: firmware "fixed" (rate works now) + cache reset -> pre-flight verifies, engine engages
await page.evaluate(() => window.__setIgnoreRate(false));
await phase('D: rate works, resetRateCap @1.5x', () => page.evaluate(() => STTVSpeed.resetRateCap()), 9000);
await phase('E: 2x (unverified speed)', () => page.evaluate(() => Android.setPlaybackSpeed(2)), 8000);
await phase('F: back to 1.5x (verified -> no pre-flight)', () => page.evaluate(() => Android.setPlaybackSpeed(1.5)), 5000);
// G: reload with rate working: cached ok -> immediate engage
await boot('G');
await phase('G: reload, 1.5x, cached ok', () => page.evaluate(() => Android.setPlaybackSpeed(1.5)), 6000);
fs.writeFileSync(DIR + 'result_gate.json', JSON.stringify({ marks, phases, logs }));
await page.close(); await browser.close();
process.exit(0);
