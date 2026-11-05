// v1.3: STTVSpeed.audioDiag() / beep() in headless Chromium (no app, no engine): every output path must RENDER
// (analyser level of the beeps), the context clocks must run, the WAV <audio> must advance, and the element mute
// state must be restored. Audibility itself can only be judged by a listener on the TV (README 11.5).
import { chromium } from 'playwright';
import fs from 'node:fs';
import { KIT } from '../_paths.mjs';
const SP = KIT + 'sttv-speed/sttv-speed.js', OUT = KIT + 'tests/audiodiag/result.json';
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text().slice(0, 300)));
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.route('https://sttv.test/**', r => {
  const u = new URL(r.request().url());
  if (u.pathname === '/sttv-speed.js') return r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SP) });
  return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><video id="sttv_main" muted></video><script src="/sttv-speed.js"></script></body></html>' });
});
await page.goto('https://sttv.test/');
await page.waitForFunction(() => window.STTVSpeed && STTVSpeed.version);
const t0 = Date.now();
const res = await page.evaluate(() => STTVSpeed.audioDiag());
const secs = (Date.now() - t0) / 1000;
const beep = await page.evaluate(() => STTVSpeed.beep(2));
const conf = await page.evaluate(() => STTVSpeed.audio());
const toasts = await page.evaluate(() => STTVSpeed.events(200).filter(e => e.type === 'toast').map(e => e.data));
let fails = 0;
const ok = (c, m, x) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails++; };
const T = id => res.tests.find(t => t.id === id) || {};
ok(res.tests.length === 6 && res.tests.map(t => t.id).join() === '1,2,3,4,5,6', '6 tests in order', res.tests.map(t => t.name));
ok(T(1).skipped === 'no_engine', 'test 1 skipped without an engine');
for (const id of [2, 3, 4, 5]) ok(T(id).renderedDb > -16 && T(id).renderedDb < -10 && T(id).clock > 0.8 && T(id).clock < 1.2 && !T(id).err,
  `test ${id} (${T(id).name}) rendered the beeps, clock runs`, { db: T(id).renderedDb, clock: T(id).clock, ctx: T(id).ctx });
ok(T(2).opts === 'default' && T(4).opts === '48000/playback' && T(4).ctx.sr === 48000, 'test 2 = default context, test 4 = 1.2 options (48 kHz)', { t2: T(2).opts, t4: T(4).opts });
ok(T(2).elementMuted === false && T(3).elementMuted === true && res.video.realMuted === true && res.after.realMuted === true, 'element mute: unmuted in 2, muted in 3, restored after', { before: res.video.realMuted, t2: T(2).elementMuted, t3: T(3).elementMuted, after: res.after.realMuted });
ok(T(5).audioPaused === false && !T(5).playErr, 'test 5: MediaStream <audio> playing', { paused: T(5).audioPaused, err: T(5).playErr });
ok(T(6).audioCt > 2.0 && !T(6).audioErr && !T(6).playErr, 'test 6: WAV <audio> advanced', { ct: T(6).audioCt, err: T(6).audioErr });
ok(res.caps && typeof res.caps.mse['audio/mp4; codecs="mp4a.40.2"'] === 'boolean' && 'opus' in res.caps.encoder, 'codec caps collected', res.caps);
ok(toasts.filter(t => /^(Audio test|Тест звука) \d\/6/.test(t)).length === 6, 'one numbered toast per test', toasts.slice(0, 6));
ok(beep.renderedDb > -16 && beep.opts === 'default', 'beep(2) through a fresh default context', beep);
ok(conf.lastDiag && conf.lastDiag.tests.length === 6, 'STTVSpeed.audio().lastDiag persisted');
ok(secs < 40, 'diag duration', secs);
const errs = logs.filter(l => /PAGEERROR|Uncaught/.test(l));
ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
fs.writeFileSync(OUT, JSON.stringify({ res, beep, secs, toasts }, null, 1));
console.log(fails ? `${fails} FAILED` : 'AUDIODIAG SANDBOX OK');
await browser.close();
process.exit(fails ? 1 : 0);
