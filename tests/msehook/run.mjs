// Chrome integration: PR mse-hook (orig|fixed) + hls.js 1.5 + real Twitch VOD TS, bridge error handler (old|fixed).
// node run.mjs hls <orig|fixed> <old|fixed> [speed]   |   node run.mjs muxed <orig|fixed> [speed]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { TD } from '../_paths.mjs';
const [mode = 'hls', hookV = 'orig', a3, a4, a5] = process.argv.slice(2);
const quota = +(a5 || 0);
const handler = mode === 'hls' ? a3 || 'old' : 'old', speed = +(mode === 'hls' ? a4 || 1.5 : a3 || 1.5);
const DIR = new URL('./', import.meta.url).pathname;
const map = (p) => p.startsWith('/speed-orig/') ? DIR + 'speed-orig/' + p.slice(12)
  : p.startsWith('/speed-fixed/') ? DIR + 'speed-fixed/' + p.slice(13)
  : p === '/hls.min.js' ? DIR + '../e2e/hls.min.js' : p === '/hls-recover-fix.js' ? DIR + '../../mse-fix/hls-recover-fix.js'
  : p === '/page.html' ? DIR + 'page.html' : p === '/mp4box.mjs' ? DIR + 'mp4box.mjs' : p.startsWith('/media/') ? DIR + p.slice(1) : null;
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const variant = master.split(/\r?\n/).find((l) => l.includes('/360p30/'));
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.route('https://sttv.test/**', (route) => {
  const f = map(new URL(route.request().url()).pathname);
  if (!f || !fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.mp4') ? 'video/mp4' : 'application/javascript' });
});
await ctx.addInitScript((u) => { window.__variantUrl = u; }, variant);
const page = await ctx.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && logs.length < 50) logs.push(m.text().slice(0, 160)); });
await page.goto(`https://sttv.test/page.html?mode=${mode}&hook=${hookV}&handler=${handler}&speed=${speed}&quota=${quota}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === 'muxed') {
  await page.waitForFunction(() => window.__st && window.__st.done, null, { timeout: 20000 });
  console.log(JSON.stringify({ mode, hook: hookV, speed, ...(await page.evaluate(() => window.__st.muxed)), logs }));
  await browser.close(); process.exit(0);
}
await sleep(14000);
await page.evaluate(() => window.__seek(60));
await sleep(14000);
const st = await page.evaluate(() => window.__st);
await browser.close();
// summary
const s = st.samples, p0 = s[0].p;
const at = (sec) => s.reduce((b, x) => (Math.abs(x.p - p0 - sec * 1000) < Math.abs(b.p - p0 - sec * 1000) ? x : b));
const rate = (a, b) => { const x = at(a), y = at(b); return +((y.ct - x.ct) / ((y.p - x.p) / 1000)).toFixed(3); };
const dr = s.filter((x) => x.drift !== null && x.p - p0 > 2000).map((x) => x.drift * 1000);
const mean = dr.reduce((a, b) => a + b, 0) / (dr.length || 1), sd = Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dr.length || 1));
const abs = dr.map(Math.abs).sort((a, b) => a - b);
const errs = {}; for (const e of st.errors) { const k = e.giveUp ? 'GIVE_UP' : `${e.type}/${e.details}${e.fatal ? '/FATAL' : ''}`; errs[k] = (errs[k] || 0) + 1; }
const out = {
  hook: hookV, handler, speed, quota, quotaThrows: st.quotaThrows,
  contentRate_4_12s: rate(4, 12), contentRate_19_27s: rate(19, 27),
  posAfter: +s[s.length - 1].ct.toFixed(1), paused: s[s.length - 1].paused, readyState: s[s.length - 1].rs,
  loadstart: st.loadstart, hlsErrors: errs, playRejects: st.playRejects.length, playReject0: st.playRejects[0] || null,
  speedErrors: st.speedErrors, reloadsTo1x: st.reloads, engines: st.engines, finalSpeed: s[s.length - 1].speed,
  audio: st.audio, drift_ms: dr.length ? { n: dr.length, mean: +mean.toFixed(1), sd: +sd.toFixed(1), p95abs: +abs[Math.floor(abs.length * 0.95)].toFixed(1) } : null,
  logs: logs.slice(0, 6)
};
console.log(JSON.stringify(out));
fs.writeFileSync(DIR + `result_${hookV}_${handler}_${speed}${quota ? '_q' + quota : ''}.json`, JSON.stringify(out, null, 1));
