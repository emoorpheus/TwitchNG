// Reproduces the prototype's reload loop (old handler) and checks hls-recover-fix.js. node run.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import { KIT } from '../_paths.mjs';
const HLSJS = fs.readFileSync(KIT + 'tests/e2e/hls.min.js', 'utf8');
const FIX = fs.readFileSync(KIT + 'mse-fix/hls-recover-fix.js', 'utf8');
const SRC = 'https://d2vi6trrdongqn.cloudfront.net/fa44536e95f6efe9f2b2_gamesdonequick_321096577376_1793465395/360p30/index-dvr.m3u8';
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
async function scenario(handler) {
  const page = await browser.newPage();
  await page.setContent('<video id="v" muted playsinline></video>');
  await page.addScriptTag({ content: HLSJS });
  await page.addScriptTag({ content: FIX });
  await page.evaluate(([src, handler]) => {
    const v = document.getElementById('v'), c = window.__c = { loadstart: 0, emptied: 0, playRejected: 0, attached: 0, recover: 0, giveUp: null };
    const play0 = v.play.bind(v);
    v.play = () => { const p = play0(); p.catch(e => { if (/interrupted/.test(e.message)) c.playRejected++; }); return p; };
    v.addEventListener('loadstart', () => c.loadstart++); v.addEventListener('emptied', () => c.emptied++);
    const hls = window.__hls = new Hls({ startPosition: 1000 });
    hls.on(Hls.Events.MEDIA_ATTACHED, () => { c.attached++; v.play(); });
    if (handler === 'old') {
      // the prototype's handler (from the handoff)
      hls.on(Hls.Events.ERROR, (e, data) => { if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { c.recover++; hls.recoverMediaError(); } });
    } else {
      window.__rec = STTVHlsRecovery.attach(hls, v, { onGiveUp: why => { c.giveUp = why; } });
    }
    hls.loadSource(src); hls.attachMedia(v);
  }, [SRC, handler]);
  await page.waitForFunction(() => document.getElementById('v').currentTime > 1001, null, { timeout: 30000 });
  // non-fatal MEDIA_ERROR storm, like the stalls the SourceBuffer patch produced (every 200 ms for 5 s)
  const r = await page.evaluate(async () => {
    const v = document.getElementById('v'), hls = window.__hls, c = window.__c, ct0 = v.currentTime, t0 = performance.now();
    const base = { ...c };
    for (let i = 0; i < 25; i++) {
      hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR, fatal: false, buffer: 0 });
      await new Promise(r => setTimeout(r, 200));
    }
    const el = (performance.now() - t0) / 1000;
    return { progress: +((v.currentTime - ct0) / el).toFixed(2), loadstart: c.loadstart - base.loadstart, playRejected: c.playRejected - base.playRejected, recover: c.recover, reattach: c.attached - base.attached };
  });
  let fatal = null;
  if (handler === 'fixed') {
    fatal = await page.evaluate(async () => {
      const v = document.getElementById('v'), hls = window.__hls, c = window.__c, out = [];
      for (let i = 0; i < 3; i++) {
        hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_APPEND_ERROR, fatal: true });
        await new Promise(r => setTimeout(r, 4000));
        out.push({ step: i + 1, playing: !v.paused && v.readyState >= 3, ct: +v.currentTime.toFixed(1), log: window.__rec.state.log.map(x => x.type).join(','), giveUp: c.giveUp });
      }
      return out;
    });
  }
  await page.close();
  return { handler, nonFatalStorm: r, fatal };
}
const a = await scenario('old');
const b = await scenario('fixed');
console.log(JSON.stringify(a)); console.log(JSON.stringify(b, null, 1));
await browser.close(); process.exit(0);
