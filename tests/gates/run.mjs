// Sandbox run of probe/sttv-gates.js: fake bridge page + sttv-speed.js + Luna mock backed by the real service module.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { KIT, TD } from '../_paths.mjs';
const E2E = KIT + 'tests/e2e/', PROBE = KIT + 'probe/';
fs.copyFileSync(KIT + 'sttv-speed/sttv-speed.js', E2E + 'sttv-speed.js');
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.route('https://sttv.test/**', route => {
  const f = E2E + new URL(route.request().url()).pathname.slice(1);
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript' });
});
const svc = createRequire(import.meta.url)(KIT + 'deploy/service/sttv_media_fetch.js');
await ctx.exposeFunction('__lunaFetch', (uri, params) => new Promise(res => {
  if (!/^luna:\/\/com\.tbsniller\.smarttwitchwebostv\.hls\/fetchPlaylist$/.test(uri)) return res(JSON.stringify({ returnValue: false, errorCode: 'bad_uri' }));
  svc.fetchMedia(JSON.parse(params), r => res(JSON.stringify(r)));
}));
await ctx.addInitScript(() => {
  window.__native = true;
  window.PalmSystem = { identifier: 'com.tbsniller.smarttwitchwebostv 1001', deviceInfo: JSON.stringify({ modelName: 'SANDBOX', platformVersion: '0.0.0' }) };
  window.PalmServiceBridge = function () {
    var self = this;
    this.call = function (uri, params) { window.__lunaFetch(uri, params).then(function (r) { if (self.onservicecallback) self.onservicecallback(r); }); };
    this.cancel = function () { self.onservicecallback = null; };
  };
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('https://sttv.test/page.html');
await page.waitForFunction(() => window.Android && window.Android.StartAuto && window.STTVSpeed && STTVSpeed._ctl.hookedObj === window.Android, null, { timeout: 15000 });
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
await page.evaluate(([u, pl]) => window.Android.StartAuto(u, pl, 2, 1000000, 0), ['https://usher.ttvnw.net/vod/2915888911.m3u8', master]);
await page.waitForFunction(() => document.getElementById('sttv_main').currentTime > 1001, null, { timeout: 45000 });
await page.evaluate(() => window.Android.stopVideo());          // "Back": player closed, like the instructions say
await page.evaluate(fs.readFileSync(PROBE + 'gate-media.js', 'utf8') + '\n;0');
await page.evaluate(fs.readFileSync(PROBE + 'sttv-gates.js', 'utf8') + '\n;0');
const t0 = Date.now();
const R = await page.evaluate(only => STTVGates.run({ only }), process.argv[2] || undefined);
console.log('took', ((Date.now() - t0) / 1000).toFixed(1), 's');
fs.writeFileSync(KIT + 'tests/gates/result_sandbox.json', JSON.stringify(R, null, 1));
console.log(JSON.stringify({ verdict: R.verdict, caps: R.caps && { mse: R.caps.mse, decoders: R.caps.decoders, audio: R.caps.audio, rvfc: R.caps.rvfc }, g1: R.g1, g2: R.g2, g3: R.g3, g4: R.g4 && { ...R.g4, chunks: (R.g4.chunks || []).slice(0, 4) }, g5: R.g5, error: R.error }, null, 1));
await page.close(); await browser.close();
process.exit(0);
