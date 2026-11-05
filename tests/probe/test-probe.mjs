// Runs sttv-probe.js in sandbox Chrome on the e2e fake-bridge page.
// Usage: node test-probe.mjs [hlsjs|native|cors-luna|cors-unpatched|cors-none]   (cors-*: web security ON, native HLS)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { KIT, TD } from '../_paths.mjs';
const E2E = KIT + 'tests/e2e/';
const mode = process.argv[2] || 'hlsjs';
const cors = mode.startsWith('cors');
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: (cors ? [] : ['--disable-web-security']).concat(['--autoplay-policy=no-user-gesture-required', '--no-sandbox']) });
const ctx = await browser.newContext();
if (mode === 'cors-luna' || mode === 'cors-unpatched') {
  const svc = createRequire(import.meta.url)(KIT + 'deploy/service/sttv_media_fetch.js');
  await ctx.exposeFunction('__lunaFetch', (uri, params) => new Promise(res => {
    if (mode === 'cors-unpatched') return res(JSON.stringify({ returnValue: false, status: 403, errorCode: 'URL_NOT_ALLOWED', errorText: 'Only live Twitch GQL token and usher playlist URLs are allowed' }));
    svc.fetchMedia(JSON.parse(params), r => res(JSON.stringify(r)));
  }));
  await ctx.addInitScript(() => {
    window.PalmSystem = { identifier: 'com.tbsniller.smarttwitchwebostv 1001' };
    window.PalmServiceBridge = function () { var self = this; this.call = function (uri, p) { window.__lunaFetch(uri, p).then(function (r) { if (self.onservicecallback) self.onservicecallback(r); }); }; this.cancel = function () {}; };
  });
}
await ctx.route('https://sttv.test/**', route => {
  const f = E2E + new URL(route.request().url()).pathname.slice(1);
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript' });
});
await ctx.addInitScript(m => { window.__native = m === 'native' || m.indexOf('cors') === 0; window.__sttvSpeedNoAutoInstall = true; localStorage.setItem('STTV_SPEED_MODE', 'off'); }, mode);
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (/sttv-probe/.test(m.text())) console.log(m.text()); });
await page.goto('https://sttv.test/page.html');
console.log('canPlayType HLS:', await page.evaluate(() => document.createElement('video').canPlayType('application/vnd.apple.mpegurl')));
await page.waitForFunction(() => window.Android && window.Android.StartAuto && !window.Android.early, null, { timeout: 15000 });
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
await page.waitForFunction(() => { const v = document.getElementById('sttv_main'); return v.currentTime > 1001 && !v.paused; }, null, { timeout: 45000 });
await page.addScriptTag({ content: fs.readFileSync(KIT + 'probe/sttv-probe.js', 'utf8') });
const r = await page.evaluate(() => STTVProbe.run({ dwell: 3000, settle: 800 }));
fs.writeFileSync(`/tmp/probe_${mode}.json`, JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pipeline: r.pipeline, verdict: r.verdict, decoders: r.decoders, audioContext: r.audioContext, audioFetch: r.audioFetch }, null, 1));
console.table(r.rates.map(x => ({ req: x.req, label: x.label, eff: x.eff, ratio: x.ratio, r2: x.r2, residMs: x.residMs, minStepMs: x.minStepMs, fps: x.framesPerS, aB: x.aBytesPerS, ev: JSON.stringify(x.events) })));
console.log('video1', JSON.stringify(r.video1));
// derived-URL path (what the TV will use when <video>.src is the CDN variant URL)
const af = await page.evaluate(u => STTVProbe._internals.deriveAudioOnly(u), 'https://d1m7jfoe9zdc1j.cloudfront.net/abc_chan_123_456/360p30/index-dvr.m3u8');
console.log('derive', af);
const ear = await page.evaluate(() => STTVProbe.ear(1.5, 0.5));
console.log('ear', JSON.stringify(ear.steps));
const beep = await page.evaluate(() => STTVProbe.beep());
console.log('beep', JSON.stringify(beep));
console.log('after', JSON.stringify(await page.evaluate(() => STTVProbe.video())));
await page.close(); await browser.close(); process.exit(0);
