// E2E: fake bridge + hls.js-driven (or native HLS) <video> + sttv-speed.js in Chrome. Usage: node run.mjs [wc|dad] [hlsjs|native]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { KIT, TD } from '../_paths.mjs';
const DIR = KIT + 'tests/e2e/';
const decoder = process.argv[2] || 'wc';
const pipe = process.argv[3] || 'hlsjs';
// CORS-realistic variant: STTV_E2E_NET=luna|proxy -> web security ON, engine must fall back from direct XHR.
const netMode = process.env.STTV_E2E_NET || '';
const tag = decoder + (pipe === 'native' ? '_native' : '') + (netMode ? '_' + netMode : '');
fs.copyFileSync(KIT + 'sttv-speed/sttv-speed.js', DIR + 'sttv-speed.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({
  executablePath: '/usr/local/bin/chromium', headless: true,
  // proxy mode: Chrome 14x 'Local Network Access' blocks public->loopback; the TV's Chromium (file:// app) has no such check.
  args: (netMode ? [] : ['--disable-web-security']).concat(netMode === 'proxy' ? ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] : [])
    .concat(['--autoplay-policy=no-user-gesture-required', '--no-sandbox']),
});
const ctx = await browser.newContext();
await ctx.route('https://sttv.test/**', route => {
  const f = DIR + new URL(route.request().url()).pathname.slice(1);
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript' });
});
await ctx.addInitScript(({ decoder, pipe }) => {
  window.__native = pipe === 'native';
  try {
    localStorage.setItem('STTV_SPEED_DEBUG', '1');
    if (decoder === 'dad') localStorage.setItem('STTV_SPEED_DECODER', 'dad'); else localStorage.removeItem('STTV_SPEED_DECODER');
  } catch (e) {}
  window.__taps = [];
  window.__sttvSpeedTap = function (c) {
    var keep = window.__taps.length < 400, n = Math.min(2048, c.len), m = null, i;
    if (keep) { m = new Array(n); for (i = 0; i < n; i++) m[i] = Math.round((c.planes[0][i] + c.planes[1][i]) * 1e5) / 1e5; }
    window.__taps.push({ when: c.when, c0: c.c0, c1: c.c1, len: c.len, sr: c.sr, speed: c.speed, eff: c.eff, head: m });
  };
  window.__samples = [];
  setInterval(function () {
    var v = document.getElementById('sttv_main'), S = window.STTVSpeed, e = S && S._ctl && S._ctl.engine, ac = e && e.ctx;
    if (!v) return;
    window.__samples.push({ p: performance.now(), ctxT: ac ? ac.currentTime : null, ct: v.currentTime, rate: v.playbackRate,
      lat: e ? e.latS : null, anch: e ? e.anch : false, eff: e ? e.eff : null, speed: S ? S._ctl.speed : null, paused: v.paused, seeking: v.seeking });
  }, 20);
}, { decoder, pipe });
if (netMode === 'luna') {
  const svc = createRequire(import.meta.url)(KIT + 'deploy/service/sttv_media_fetch.js');
  await ctx.exposeFunction('__lunaFetch', (uri, params) => new Promise(res => {
    if (!/^luna:\/\/com\.tbsniller\.smarttwitchwebostv\.hls\/fetchPlaylist$/.test(uri)) return res(JSON.stringify({ returnValue: false, errorCode: 'bad_uri' }));
    svc.fetchMedia(JSON.parse(params), r => res(JSON.stringify(r)));
  }));
  await ctx.addInitScript(() => {
    window.PalmSystem = { identifier: 'com.tbsniller.smarttwitchwebostv 1001' };
    window.__lunaCalls = 0;
    window.PalmServiceBridge = function () {
      var self = this;
      this.call = function (uri, params) { window.__lunaCalls++; window.__lunaFetch(uri, params).then(function (r) { if (self.onservicecallback) self.onservicecallback(r); }); };
      this.cancel = function () { self.onservicecallback = null; };
    };
  });
}
if (netMode === 'proxy') await ctx.addInitScript(() => { localStorage.setItem('STTV_SPEED_PROXY', 'http://127.0.0.1:8787/'); });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { const t = m.text(); if (logs.length < 3000) logs.push(t.slice(0, 300)); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
const marks = [];
const mark = async name => { const p = await page.evaluate(() => performance.now()); marks.push({ name, p }); console.log('mark', name, Math.round(p)); };
await page.goto('https://sttv.test/page.html');
await page.waitForFunction(() => window.Android && window.Android.StartAuto && window.STTVSpeed && window.STTVSpeed._ctl.hookedObj === window.Android, null, { timeout: 15000 });
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
await page.waitForFunction(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1001 && !v.paused; }, null, { timeout: 45000 });
await mark('play_1x');
await sleep(2000);
await page.evaluate(() => window.Android.setPlaybackSpeed(1.5));
await mark('speed_1.5');
await page.waitForFunction(() => { const e = window.STTVSpeed._ctl.engine; return e && e.anch; }, null, { timeout: 30000 });
await mark('anchored_1.5');
await sleep(20000);
await page.evaluate(() => { const v = document.getElementById('sttv_main'); v.currentTime = v.currentTime + 60; });
await mark('seek+60');
await sleep(10000);
await page.evaluate(() => window.Android.setPlaybackSpeed(2));
await mark('speed_2');
await sleep(12000);
await page.evaluate(() => window.Android.setPlaybackSpeed(0.75));
await mark('speed_0.75');
await sleep(10000);
const storeDump = await page.evaluate(() => {
  const e = STTVSpeed._ctl.engine, sr = e.store.sr, v = document.getElementById('sttv_main');
  const pos = Math.round((v.currentTime + 1) * sr), n = 2 * sr, L = new Float32Array(n), R = new Float32Array(n);
  e.store.read(pos, n, [L, R], 0);
  return { t: pos / sr, sr, L: Array.from(L), baseRef: e.src.ref[0], audioUrl: e.src.s.audio, kind: e.src.s.audioKind, decoder: e.dec.kind };
});
await page.evaluate(() => window.Android.setPlaybackSpeed(1.25));
await mark('speed_1.25');
await sleep(8000);
await page.evaluate(() => document.getElementById('sttv_main').pause());
await mark('pause');
await sleep(2000);
await page.evaluate(() => document.getElementById('sttv_main').play());
await mark('resume');
await sleep(6000);
const during = await page.evaluate(() => { const v = document.getElementById('sttv_main'); const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted'); return { realMuted: d.get.call(v), appMuted: v.muted, status: STTVSpeed.status() }; });
await page.evaluate(() => window.Android.setPlaybackSpeed(1));
await mark('speed_1');
await sleep(3000);
const final = await page.evaluate(() => {
  const v = document.getElementById('sttv_main'), d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  return { lunaCalls: window.__lunaCalls, status: STTVSpeed.status(), realMuted: d.get.call(v), appMuted: v.muted, ownMuted: Object.prototype.hasOwnProperty.call(v, 'muted'), rate: v.playbackRate, events: STTVSpeed.events(400) };
});
const data = await page.evaluate(() => ({ taps: window.__taps, samples: window.__samples }));
fs.writeFileSync(DIR + `result_${tag}.json`, JSON.stringify({ decoder, pipe, marks, during, final, storeDump, ...data, logs }));
console.log('saved', DIR + `result_${tag}.json`, 'taps', data.taps.length, 'samples', data.samples.length);
await page.close(); await browser.close();
process.exit(0);
