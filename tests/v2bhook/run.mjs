// v1.3.2 regression: MediaSource.duration set BEFORE the first addSourceBuffer() (hls.js does it on 'sourceopen' and on
// LEVEL_UPDATED) must read back as content time through the element shim (TV report on 1.3.1: UI duration = S x VOD).
// Usage: node tests/v2bhook/run.mjs [path/to/sttv-v2b.js]   (default: sttv-speed/sttv-v2b.js of this kit)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = process.argv[2] || path.join(KIT, 'sttv-speed/sttv-v2b.js');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.route('https://hook.test/**', r => r.request().url().endsWith('/hook.js')
  ? r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(HOOK) })
  : r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><video id="v"></video><script src="/hook.js"></script>' }));
await page.goto('https://hook.test/');
const res = await page.evaluate(async () => {
  const P = HTMLMediaElement.prototype, nd = Object.getOwnPropertyDescriptor(P, 'duration'), MSd = Object.getOwnPropertyDescriptor(MediaSource.prototype, 'duration');
  let speed = 1;
  const hook = STTVMseHook.installMseHook(window, { getSpeed: () => speed, onError: e => out.errors.push(String(e && e.message || e)),
    createAudioSink: () => ({ configure() {}, push() {}, discard() {}, reset() {}, destroy() {} }), onRateRequest() {}, onNativeAudio() {} });
  const out = { version: STTVMseHook.version, errors: [], cases: [] };
  const VID = 'video/mp4; codecs="avc1.4d401f"', AUD = 'audio/mp4; codecs="mp4a.40.2"';
  async function run(S, preDur, postDur, order) {
    speed = S;
    const v = document.createElement('video'); document.body.appendChild(v);
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);
    await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
    if (preDur) ms.duration = preDur;                    // hls.js: _onMediaSourceOpen / onLevelUpdated without SourceBuffers
    const r = { S, preDur, postDur, order };
    for (const m of order) ms.addSourceBuffer(m === 'v' ? VID : AUD);
    r.afterSb = { el: v.duration, native: nd.get.call(v), ms: ms.duration, msNative: MSd.get.call(ms) };
    if (postDur) {                                       // hls.js later: only grows the duration (levelDuration > ms/media)
      const msD = Number.isFinite(ms.duration) ? ms.duration : 0, mD = v.duration;   // hls.js updateMediaElementDuration()
      const grow = (postDur > msD && postDur > mD) || !Number.isFinite(mD);
      if (grow) ms.duration = postDur;
      r.grow = grow;
      r.afterPost = { el: v.duration, native: nd.get.call(v), ms: ms.duration };
    }
    try { const sk = v.seekable; r.seekEnd = sk.length ? sk.end(sk.length - 1) : null; } catch (e) { r.seekEnd = 'err ' + e.message; }
    r.hookStats = hook.stats ? JSON.parse(JSON.stringify(hook.stats)) : null;
    v.removeAttribute('src'); v.load(); v.remove();
    out.cases.push(r);
  }
  await run(2, 3600, 0, ['a', 'v']);          // hls.js order (audio first), the TV case at 2x
  await run(1.5, 53591.201, 0, ['v', 'a']);   // e2e VOD length at 1.5x, video first
  await run(1.25, 0, 7200, ['v', 'a']);       // duration set only after the SourceBuffers (patched setter path)
  await run(2, 3600, 3700, ['a', 'v']);       // pre-set, then the playlist grows (EVENT playlist reload)
  await run(0.25, 53591.201, 0, ['a', 'v']); // 1.3.3: 0.25x (slow motion: native duration = 4 x content)
  await run(1, 3600, 0, ['a', 'v']);          // 1x: hook not engaged, value untouched
  hook.uninstall();
  return out;
});
// 1.3.8 leak (found by tests/app/leak.mjs: +2 closed MediaSource per v2b cycle): the hook's url -> MediaSource map pinned
// every MediaSource while the hook is installed (all page long). hls.js-like lifecycle x12 (createObjectURL -> src ->
// sourceopen -> 2 SourceBuffers -> revoke + detach), then GC and count the live MediaSource objects over CDP with the
// hook still installed; a player that never revokes must not grow the map past 8.
const cdp = await page.context().newCDPSession(page);
async function liveMediaSource() {
  await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage'); await new Promise((r) => setTimeout(r, 300)); await cdp.send('HeapProfiler.collectGarbage');
  const proto = await cdp.send('Runtime.evaluate', { expression: 'MediaSource.prototype', objectGroup: 'leak' });
  const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: 'leak' });
  const n = (await cdp.send('Runtime.callFunctionOn', { objectId: q.objects.objectId, returnByValue: true, functionDeclaration: 'function () { return this.length; }' })).result.value;
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'leak' });
  return n;
}
const leak = { before: await liveMediaSource() };
leak.afterRevoke = await page.evaluate(async () => {
  const VID = 'video/mp4; codecs="avc1.4d401f"', AUD = 'audio/mp4; codecs="mp4a.40.2"';
  const hook = window.__leakHook = STTVMseHook.installMseHook(window, { getSpeed: () => 2, onError() {}, onRateRequest() {}, onNativeAudio() {},
    createAudioSink: () => ({ configure() {}, push() {}, discard() {}, reset() {}, destroy() {} }) });
  for (let i = 0; i < 12; i++) {
    const v = document.createElement('video'); document.body.appendChild(v);
    const ms = new MediaSource(), u = URL.createObjectURL(ms);
    v.src = u;
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    ms.addSourceBuffer(AUD); ms.addSourceBuffer(VID);
    URL.revokeObjectURL(u); v.removeAttribute('src'); v.load(); v.remove();
  }
  return hook.stats.urlMap;
});
leak.liveAfterRevoke = await liveMediaSource();
Object.assign(leak, await page.evaluate(() => {
  const hook = window.__leakHook;
  for (let i = 0; i < 12; i++) URL.createObjectURL(new MediaSource());
  const r = { neverRevoked: hook.stats.urlMap };
  hook.uninstall();
  r.afterUninstall = hook.stats.urlMap;
  return r;
}));
await browser.close();
const near = (a, b, eps = 1e-3) => typeof a === 'number' && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
let pass = 0, fail = 0;
function ok(c, name, data) { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + name + (data !== undefined ? '  ' + JSON.stringify(data) : '')); }
console.log('hook', res.version, 'from', path.relative(KIT, HOOK) || HOOK);
for (const c of res.cases) {
  const want = c.postDur && (c.grow || !c.preDur) ? c.postDur : c.preDur;
  const last = c.afterPost || c.afterSb;
  ok(near(last.el, want), `S=${c.S} pre=${c.preDur} post=${c.postDur}: video.duration = ${want} (content time)`, last);
  ok(near(last.native, want / c.S), `S=${c.S}: native element duration = ${(want / c.S).toFixed(3)} (element time)`, { native: last.native });
  ok(near(c.seekEnd, want), `S=${c.S}: seekable end = ${want}`, { seekEnd: c.seekEnd });
  if (c.S !== 1 && c.postDur && c.preDur) ok(c.grow === true, `S=${c.S}: a longer playlist still grows the duration (hls.js rule)`, { grow: c.grow });
}
const st = res.cases[res.cases.length - 1].hookStats;
if (st) ok(st.sessions === 5 && st.durationRebased === 4 && st.rebaseErrors === 0, 'hook stats: 5 sessions, 4 rebased, 0 errors', st);
ok(res.errors.length === 0, 'no hook errors', res.errors);
ok(leak.afterRevoke === 0 && leak.neverRevoked <= 8 && leak.afterUninstall === 0, '1.3.8: url map empties on revokeObjectURL, capped at 8 without revoke, cleared on uninstall', leak);
ok(leak.liveAfterRevoke - leak.before <= 1, '1.3.8: 12 revoked + detached MediaSource objects are garbage-collected while the hook is installed', leak);
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} V2B HOOK TIMELINE CHECKS PASS`);
process.exit(fail ? 1 : 0);
