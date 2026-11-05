// Memory-leak watch for a BUILT IPK in Chromium (stand-in for the TV): N cycles of a real VOD session through the app
// bridge on the RATE_IGNORED emulation (webOS 25: v2b takes over), each cycle = StartAuto -> 1x -> 2x (v2b: hls.js +
// MediaSource + AudioContext) -> 1.5x -> seek -> 1x (restore) -> stopVideo. After every cycle: forced GC, JS heap, DOM
// counters (nodes, listeners), live instances (Runtime.queryObjects) of AudioContext / MediaSource / SourceBuffer /
// video + audio elements / audio nodes, open object URLs and intervals, ArrayBuffer memory (outside the JS heap) and the
// v2b segment cache. Heap snapshots after the warm-up cycle and the last one are compared by constructor (what grows with
// every cycle). A leak = something that keeps growing per cycle; memory held after stopVideo = the cache check.
//   node tests/app/leak.mjs <app.ipk> [workDir] [--cycles 6] [--keep]   (--keep: leave the two heap snapshots in workDir)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TD } from '../_paths.mjs';
const args = process.argv.slice(2), pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const CYCLES = Math.max(3, +(args[args.indexOf('--cycles') + 1] || 0) || 6);
const IPK = path.resolve(pos[0] || ''), W = path.resolve(pos[1] || path.join(os.tmpdir(), 'sttv-app-leak'));
if (!fs.existsSync(IPK)) { console.error('usage: node tests/app/leak.mjs <app.ipk> [workDir] [--cycles 6]'); process.exit(2); }
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
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
function filterMaster(txt, keep) {
  const L = txt.split(/\r?\n/), out = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('#EXT-X-MEDIA:')) { const url = L[i + 2] || ''; if (keep.some(k => url.includes('/' + k + '/'))) out.push(L[i], L[i + 1], L[i + 2]); i += 2; }
    else if (!L[i].startsWith('#EXT-X-STREAM-INF') && !/^https?:/.test(L[i])) out.push(L[i]);
  }
  return out.join('\n');
}
// a new VOD id per cycle: the engine allows 12 speed take-overs per 5 min per VOD (reengage_budget, by design) - one VOD
// for 20 fast cycles ends in the "Too many speed changes" toast at cycle 13
const USHER = (i) => 'https://usher.ttvnw.net/vod/' + (2915888911 + i) + '.m3u8';
const plStart = filterMaster(master, ['360p30', 'audio_only']), plNative = filterMaster(master, ['360p30']);
let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); if (!c) fails++; };

const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--disable-web-security', '--no-sandbox', '--js-flags=--expose-gc'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 },
  userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager' });
await ctx.route(/^https:\/\/usher\.ttvnw\.net\/vod\/\d+\.m3u8/, (r) => r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: plNative }));
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
  const P = HTMLMediaElement.prototype;   // RATE_IGNORED (LG M59LA, webOS 25)
  for (const name of ['playbackRate', 'defaultPlaybackRate']) {
    const d = Object.getOwnPropertyDescriptor(P, name), req = new WeakMap();
    Object.defineProperty(P, name, { configurable: true, enumerable: true, get() { return req.has(this) ? req.get(this) : d.get.call(this); },
      set(v) { req.set(this, +v); d.set.call(this, 1); this.dispatchEvent(new Event('ratechange')); } });
  }
  // bookkeeping that the heap cannot show: object URLs (blob registry) and live intervals
  const L = window.__leak = { urls: new Map(), intervals: new Map(), seq: 0 };
  const cu = URL.createObjectURL, ru = URL.revokeObjectURL, si = window.setInterval, ci = window.clearInterval;
  const where = () => (new Error().stack || '').split('\n').slice(3, 6).map((l) => l.trim().replace(/^at /, '').replace(/\(?file:\/\/[^)]*\/([^/)]+)\)?/, '$1')).join(' < ');
  URL.createObjectURL = function (o) { const u = cu.call(URL, o); L.urls.set(u, { seq: ++L.seq, kind: o && o.constructor && o.constructor.name, at: where() }); return u; };
  URL.revokeObjectURL = function (u) { L.urls.delete(u); return ru.call(URL, u); };
  window.setInterval = function (f, ms) { const h = si.apply(window, arguments); L.intervals.set(h, { seq: ++L.seq, ms, at: where() }); return h; };
  window.clearInterval = function (h) { L.intervals.delete(h); return ci.call(window, h); };
}, { id: ID });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.STTVSpeed && window.Android && window.Android.__isWebOSPolyfill && STTVSpeed.status().hooked, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
const cdp = await ctx.newCDPSession(page);
await cdp.send('HeapProfiler.enable');

const T0 = Date.now(), log = (m) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's ' + m);
// on a timeout: v2b / engine state and the last engine events (URLs without query strings)
const diag = () => page.evaluate(() => {
  const I = STTVSpeed._internals, b = I.v2b, e = STTVSpeed._ctl.engine, cut = (x) => JSON.stringify(x === undefined ? null : x).replace(/\?[^"\s]*/g, '').slice(0, 160);
  return { state: b.state, speed: b.speed, want: b.want, fail: b.fail, restoring: !!b.restoring, engine: e ? { pipe: e.pipe, anch: !!e.anch, dead: !!e.dead } : null,
    events: STTVSpeed.events(12).map((x) => x.type + ' ' + cut(x.data)) };
}).catch((e) => String(e).slice(0, 200));
const waitFor = async (fn, ms, label) => { try { await page.waitForFunction(fn, null, { timeout: ms, polling: 250 }); return true; } catch (e) { log('TIMEOUT ' + label + ' ' + JSON.stringify(await diag())); return false; } };
const active = (s) => `(() => { const I = STTVSpeed._internals; return I.v2b.state === 'active' && I.v2b.speed === ${s} && STTVSpeed._ctl.engine && STTVSpeed._ctl.engine.anch; })()`;
const LIVE = { AudioContext: 'AudioContext.prototype', MediaSource: 'MediaSource.prototype', SourceBuffer: 'SourceBuffer.prototype',
  video: 'HTMLVideoElement.prototype', audio: 'HTMLAudioElement.prototype', audioNode: 'AudioNode.prototype', XHR: 'XMLHttpRequest.prototype' };
async function live(protoExpr) {
  const p = await cdp.send('Runtime.evaluate', { expression: protoExpr, objectGroup: 'leak' });
  if (!p.result.objectId) return null;
  const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: p.result.objectId, objectGroup: 'leak' });
  const r = await cdp.send('Runtime.callFunctionOn', { objectId: q.objects.objectId, returnByValue: true, functionDeclaration:
    'function () { var by = {}, i, k; for (i = 0; i < this.length; i++) { k = this[i].state || (this[i].readyState !== undefined ? "rs" + this[i].readyState : "") || (this[i].isConnected === false ? "detached" : "attached"); by[k] = (by[k] || 0) + 1; } return { n: this.length, by: by }; }' });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'leak' });
  return r.result.value;
}
async function sample(label) {
  await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(300); await cdp.send('HeapProfiler.collectGarbage');
  const h = await cdp.send('Runtime.getHeapUsage'), d = await cdp.send('Memory.getDOMCounters');
  const s = { label, heapMB: +(h.usedSize / 1048576).toFixed(2), nodes: d.nodes, listeners: d.jsEventListeners, documents: d.documents,
    abufMB: h.backingStorageSize === undefined ? null : +(h.backingStorageSize / 1048576).toFixed(2) };   // ArrayBuffer memory (not in usedSize)
  for (const k of Object.keys(LIVE)) s[k] = await live(LIVE[k]);
  Object.assign(s, await page.evaluate(() => ({ objectURLs: window.__leak.urls.size, intervals: window.__leak.intervals.size, seq: window.__leak.seq,
    events: STTVSpeed.events(2000).length, v2b: STTVSpeed._internals.v2b.state,
    segCache: { n: STTVSpeed._internals.segCache.order.length, mb: +(STTVSpeed._internals.segCache.bytes / 1048576).toFixed(1) } })));
  return s;
}
async function snapshot(file) {
  const fd = fs.openSync(file, 'w'), on = (p) => fs.writeSync(fd, p.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', on); fs.closeSync(fd);
}
function census(file) {   // constructor / closure name -> count (+ detached DOM nodes)
  const j = JSON.parse(fs.readFileSync(file, 'utf8')), m = j.snapshot.meta, F = m.node_fields, n = F.length, types = m.node_types[0];
  const iT = F.indexOf('type'), iN = F.indexOf('name'), iS = F.indexOf('self_size'), iD = F.indexOf('detachedness'), out = {}, N = j.nodes;
  let detached = 0;
  for (let i = 0; i < N.length; i += n) {
    const t = types[N[i + iT]];
    let name = t === 'object' || t === 'closure' || t === 'native' ? j.strings[N[i + iN]] : '(' + t + ')';
    if (iD >= 0 && N[i + iD] === 2) detached++;
    if (/^Detached /.test(name)) detached++;
    if (t === 'closure') name = 'fn ' + (name || '(anonymous)');
    if (name.length > 60) name = name.slice(0, 60);
    const o = out[name] || (out[name] = { c: 0, b: 0 }); o.c++; o.b += N[i + iS];
  }
  return { by: out, detached };
}
async function cycle(i) {
  const start = 1000000 + i * 120000;
  await page.evaluate(([u, pl, rs]) => window.Android.StartAuto(u, pl, 2, rs, 0), [USHER(i), plStart, start]);
  const okPlay = await waitFor((rs) => { const v = document.getElementById('sttv_main'); return v && v.currentTime > rs / 1000 + 1 && !v.paused; }, 45000, 'native play');
  await page.evaluate(() => Android.setPlaybackSpeed(2));
  const ok2 = await waitFor(active(2), 60000, 'v2b 2x');
  await page.waitForTimeout(3000);
  await page.evaluate(() => Android.setPlaybackSpeed(1.5));
  const ok15 = await waitFor(active(1.5), 30000, 'v2b 1.5x');
  await page.evaluate(() => Android.mseekTo(Android.gettime() + 30000));
  await waitFor(active(1.5), 30000, 'v2b 1.5x after seek');
  await page.waitForTimeout(2000);
  await page.evaluate(() => Android.setPlaybackSpeed(1));
  const ok1 = await waitFor(() => { const v = document.getElementById('sttv_main'); return STTVSpeed._internals.v2b.state === 'idle' && !STTVSpeed._internals.v2b.restoring && v && !v.paused && v.readyState >= 3; }, 40000, 'restored 1x');
  await page.waitForTimeout(1500);
  await page.evaluate(() => Android.stopVideo());
  await page.waitForTimeout(2500);
  return okPlay && ok2 && ok15 && ok1;
}

const rows = [await sample('start')];
let flowOk = 0;
for (let i = 1; i <= CYCLES; i++) {
  const c = await cycle(i); if (c) flowOk++;
  const s = await sample('cycle ' + i); rows.push(s);
  log(`cycle ${i}: ${c ? 'ok' : 'FLOW TIMEOUT'} heap ${s.heapMB} MB nodes ${s.nodes} listeners ${s.listeners} AudioContext ${JSON.stringify(s.AudioContext)} MediaSource ${JSON.stringify(s.MediaSource)} video ${s.video && s.video.n} audioNode ${s.audioNode && s.audioNode.n} urls ${s.objectURLs} intervals ${s.intervals} abuf ${s.abufMB} MB segCache ${s.segCache.n}`);
  if (i === 2) await snapshot(path.join(W, 'warm.heapsnapshot'));
}
await snapshot(path.join(W, 'last.heapsnapshot'));
console.table(rows.map((r) => ({ label: r.label, heapMB: r.heapMB, nodes: r.nodes, listeners: r.listeners, ctx: r.AudioContext && r.AudioContext.n, ctxBy: JSON.stringify(r.AudioContext && r.AudioContext.by), ms: r.MediaSource && r.MediaSource.n, sb: r.SourceBuffer && r.SourceBuffer.n, video: r.video && r.video.n, audio: r.audio && r.audio.n, audioNode: r.audioNode && r.audioNode.n, xhr: r.XHR && r.XHR.n, urls: r.objectURLs, intervals: r.intervals, events: r.events, abufMB: r.abufMB, cache: r.segCache.n })));

// per-cycle growth after the warm-up (cycle 2 -> last): a leak grows ~linearly with the cycles
const a = rows[2], z = rows[rows.length - 1], k = rows.length - 3, per = (f) => +((f(z) - f(a)) / k).toFixed(3);
const g = { heapMB: per((r) => r.heapMB), nodes: per((r) => r.nodes), listeners: per((r) => r.listeners), AudioContext: per((r) => r.AudioContext.n),
  openAudioContext: per((r) => r.AudioContext.n - (r.AudioContext.by.closed || 0)), MediaSource: per((r) => r.MediaSource.n), SourceBuffer: per((r) => r.SourceBuffer.n),
  video: per((r) => r.video.n), audioNode: per((r) => r.audioNode.n), objectURLs: per((r) => r.objectURLs), intervals: per((r) => r.intervals),
  abufMB: z.abufMB === null ? null : per((r) => r.abufMB) };
const cacheLeft = rows.slice(1).filter((r) => r.segCache.n > 0).map((r) => r.label + ': ' + r.segCache.n + ' / ' + r.segCache.mb + ' MB');
const w = census(path.join(W, 'warm.heapsnapshot')), l = census(path.join(W, 'last.heapsnapshot'));
const diff = Object.keys(l.by).map((name) => ({ name, d: l.by[name].c - ((w.by[name] || {}).c || 0), kb: +((l.by[name].b - ((w.by[name] || {}).b || 0)) / 1024).toFixed(1) }));
const grow = diff.filter((x) => x.d >= k).sort((x, y) => y.d - x.d).slice(0, 15), growKb = diff.filter((x) => x.kb >= 16).sort((x, y) => y.kb - x.kb).slice(0, 10);
fs.writeFileSync(path.join(W, 'leak-result.json'), JSON.stringify({ ipk: path.basename(IPK), cycles: CYCLES, rows, perCycle: g, snapshotGrowth: grow, snapshotGrowthKb: growKb, detached: { warm: w.detached, last: l.detached }, errors }, null, 1));
console.log('per cycle after warm-up', JSON.stringify(g));
console.log('snapshot growth (cycle 2 -> ' + CYCLES + ', count >= cycles)', JSON.stringify(grow));
console.log('snapshot growth by size (>= 16 KB)', JSON.stringify(growKb));
console.log('detached DOM nodes', w.detached, '->', l.detached);
const newer = await page.evaluate((seq) => ({ intervals: [...window.__leak.intervals.values()].filter((x) => x.seq > seq), urls: [...window.__leak.urls.values()].filter((x) => x.seq > seq) }), a.seq);
console.log('live since the warm-up: intervals', JSON.stringify(newer.intervals), 'object URLs', JSON.stringify(newer.urls));
if (!args.includes('--keep')) for (const f of ['warm.heapsnapshot', 'last.heapsnapshot']) fs.rmSync(path.join(W, f), { force: true });   // app memory: not kept (--keep: local analysis only)

ok(flowOk === CYCLES, `flow: ${CYCLES} cycles StartAuto -> 2x -> 1.5x -> seek -> 1x -> stopVideo completed`, { flowOk });
ok(g.heapMB <= 0.5, 'JS heap after GC grows <= 0.5 MB per cycle', { perCycle: g.heapMB, warm: a.heapMB, last: z.heapMB });
ok(g.nodes <= 20 && g.listeners <= 5, 'DOM nodes / listeners do not grow per cycle', { nodes: g.nodes, listeners: g.listeners });
ok(z.AudioContext.n - (z.AudioContext.by.closed || 0) <= 1 && g.openAudioContext <= 0, 'AudioContext: at most one open, none piling up', z.AudioContext);
ok(g.MediaSource <= 0 && g.SourceBuffer <= 0 && z.MediaSource.n <= 2, 'MediaSource / SourceBuffer instances do not pile up', { ms: z.MediaSource, sb: z.SourceBuffer });
ok(g.video <= 0 && g.audioNode <= 0.5, 'video elements / audio nodes do not pile up', { video: z.video, audioNode: z.audioNode });
ok(newer.urls.length <= 1 && newer.intervals.length <= 1, 'object URLs revoked, intervals cleared (at most one long-lived of each started after the warm-up)', newer);
ok(l.detached - w.detached <= 5, 'detached DOM nodes do not grow', { warm: w.detached, last: l.detached });
// 1.3.8: the v2b segment cache (up to 24 MB) outlived the player: 20 cycles held 29 segments / 24 MB after stopVideo
ok(cacheLeft.length === 0, 'v2b segment cache is empty after every stopVideo', cacheLeft.slice(0, 3));
ok(z.abufMB === null || (z.abufMB - a.abufMB <= 2 && z.abufMB <= 4), 'ArrayBuffer memory after stopVideo stays small (<= 4 MB, not growing)', { warm: a.abufMB, last: z.abufMB, perCycle: g.abufMB });
ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
await page.close(); await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL LEAK CHECKS PASSED');
process.exit(fails ? 1 : 0);
