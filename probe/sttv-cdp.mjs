#!/usr/bin/env node
// sttv-cdp.mjs - talk to the SmartTwitchTV page on the TV over DevTools (CDP). Node >= 18 (Node 22+: built-in WebSocket,
// older: `npm i ws` next to this file). Nothing is written on the TV.
//   node sttv-cdp.mjs list                       targets on http://TV:9998/json/list
//   node sttv-cdp.mjs probe [--dwell 5000]       inject sttv-probe.js, run it, save sttv-probe-<time>.json
//   node sttv-cdp.mjs ear [1.5]                  listening A/B test (watch the banner on the TV)
//   node sttv-cdp.mjs beep                       short WebAudio tone over the video
//   node sttv-cdp.mjs inject ../sttv-speed/sttv-speed.js   live trial without touching files (gone after app restart)
//   node sttv-cdp.mjs gates [--only caps,g1,g2,g3,g4,g5]   MSE-path go/no-go gates (sttv-gates.js), saves sttv-gates-<time>.json
//   node sttv-cdp.mjs status                     STTVSpeed.status()
//   node sttv-cdp.mjs audiodiag [--media 0]      v1.3 listening test (6 numbered beep tests, ~25 s): a PERSON in front of
//                                                the TV notes which test numbers were audible; saves sttv-audiodiag-<time>.json
//   node sttv-cdp.mjs report                     status + audio + events(400) + prevLog (last 120 events of the
//                                                previous app run, 1.3.4+) in one JSON (sttv-report-<time>.json)
//   node sttv-cdp.mjs eval "<js expression>"     evaluate (promises awaited)
//   node sttv-cdp.mjs check [--engine 1.3.7] [--app com.twitchng.tv] [--ng 1.0.0] [--pre 04] [--variant L3]
//                                                build gate: engine / app id / BASE / TwitchNG.state() (version +
//                                                pre-release number; --pre none skips it); exit 4 on mismatch
//   node sttv-cdp.mjs key right right enter [--gap 400]   remote keys via CDP (left right up down enter back play pause
//                                                stop ff rw red green yellow blue 0-9, or a number = keyCode)
//   node sttv-cdp.mjs mem [--out mem.jsonl] [--gc 0]   forced GC + JS heap + DOM counters (leak watch), one JSON line
//   node sttv-cdp.mjs heap [--out f.heapsnapshot]   full heap snapshot (the page stalls for seconds: take it while paused)
//   node sttv-cdp.mjs shot [--out f.png]         screenshot of the web page (the video plane is NOT in it: black / empty)
//   node sttv-cdp.mjs watch [--every 2000] [--for 600] [--out f.jsonl]   sample every N ms for S seconds: speed, v2b
//                                                state, UI position (Android.gettime) vs raw currentTime, hold, buffer,
//                                                dropped frames, JS heap + every new engine event; reconnects after
//                                                app restarts; warns when the UI position jumps back to ~0
// Options: --host <TV_IP> (default: $TV_HOST, see tv.env.example) --port 9998 --match smarttwitch|tbsniller --timeout 180000
//          --raw 1   do not redact. By default everything printed or saved is redacted, because reports get shared:
//                    URL query strings (Twitch playlist URLs carry a signed token with the account id and IP), sig= /
//                    token= / access_token= values, "access_token": "..." style JSON fields, Bearer / OAuth headers, JWTs.
//                    A heap snapshot (heap) cannot be redacted: it holds the app's memory incl. the Twitch sign-in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = { host: process.env.TV_HOST || '', port: 9998, match: 'smarttwitch|tbsniller|twitch', timeout: 180000, dwell: 5000 };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]);
}
const cmd = pos[0] || 'probe';
// redaction of everything that leaves this script (stdout + saved files); works on JSON text without breaking it:
// no pattern consumes a quote or a backslash
const KEYS_SECRET = 'access_token|refresh_token|oauth_token|auth_token|id_token|token|sig|nauth|nauthsig|client_secret|password|authorization|cookie';
function redact(s) {
  if (opt.raw === '1' || typeof s !== 'string') return s;
  return s
    .replace(/(\b(?:https?|wss?):\/\/[^\s"'?#\\]*)\?[^\s"'#\\]+/gi, '$1?<query removed>')
    .replace(new RegExp('\\b(' + KEYS_SECRET + ')=[^&\\s"\'\\\\]+', 'gi'), '$1=<redacted>')
    .replace(new RegExp('(\\\\?")(' + KEYS_SECRET + ')\\1(\\s*:\\s*)\\1[^"\\\\]*\\1', 'gi'), '$1$2$1$3$1<redacted>$1')
    .replace(/\b(Bearer|OAuth)\s+[A-Za-z0-9._~+\/=-]{8,}/g, '$1 <redacted>')
    .replace(/\boauth:[A-Za-z0-9]{8,}/g, 'oauth:<redacted>')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt redacted>');
}
const J = (o, rep, sp) => redact(JSON.stringify(o, rep, sp));
// `check` expects the versions of THIS kit (the build under test), read from its sources: nothing to bump here per release
function kitVersions() {
  const rd = (f) => { try { return fs.readFileSync(path.join(here, '..', f), 'utf8'); } catch (e) { return ''; } };
  const ng = rd('brand/twitchng/web/twitchng.js'), m = (re, t, d) => (re.exec(t) || [])[1] || d;
  return { engine: m(/\bVERSION = '([\d.]+)'/, rd('sttv-speed/sttv-speed.js'), '?'), ng: m(/\bVERSION = '([\d.]+)'/, ng, '1.0.0'),
    pre: /\bPRE = true\b/.test(ng) ? m(/\bPRE_N = '(\d*)'/, ng, '') : 'none' };
}

async function getWS() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  try { return (await import('ws')).default; } catch (e) {
    console.error('No WebSocket: use Node 22+ or run `npm i ws` in ' + here); process.exit(2);
  }
}
async function targets() {
  if (!opt.host) { console.error('No TV address: --host <TV_IP> or export TV_HOST=<TV_IP> (see tv.env.example)'); process.exit(2); }
  const base = `http://${opt.host}:${opt.port}`;
  let r;
  try { r = await fetch(base + '/json/list'); } catch (e) { r = await fetch(base + '/json'); }
  const list = await r.json();
  return list.map(t => {
    let ws = t.webSocketDebuggerUrl;
    if (!ws && t.id) ws = `ws://${opt.host}:${opt.port}/devtools/page/${t.id}`;
    if (ws) ws = ws.replace(/^ws:\/\/[^/]+/, `ws://${opt.host}:${opt.port}`);
    return { ...t, ws };
  });
}
async function pick() {
  const list = await targets(), re = new RegExp(opt.match, 'i');
  const t = list.find(x => x.ws && re.test((x.url || '') + ' ' + (x.title || ''))) || list.find(x => x.ws && x.type === 'page') || list.find(x => x.ws);
  if (!t) { console.error('No debuggable target. Is the app running and DevTools enabled?', list); process.exit(3); }
  return t;
}
async function connect(t) {
  const WS = await getWS(), ws = new WS(t.ws), pending = new Map(), listeners = {};
  let id = 0;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error ' + (e.message || ''))); });
  ws.onmessage = m => {
    const d = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method && listeners[d.method]) listeners[d.method](d.params);
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id, to = setTimeout(() => { pending.delete(i); rej(new Error(method + ' timeout')); }, +opt.timeout);
    pending.set(i, d => { clearTimeout(to); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, on: (m, f) => { listeners[m] = f; }, close: () => ws.close() };
}
const KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, ok: 13, back: 461, play: 415, pause: 19, stop: 413, ff: 417, rw: 412,
  red: 403, green: 404, yellow: 405, blue: 406, ...Object.fromEntries([...'0123456789'].map((d) => [d, 48 + +d])) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const SAMPLE = `(() => { const S = window.STTVSpeed; if (!S) return { noEngine: true, url: location.href };
  const s = S.status(), v = s.v2b || {}, m = performance.memory; let ui = null, dur = null;
  try { ui = window.Android && Android.gettime ? Android.gettime() : null; } catch (e) { ui = 'err'; }
  try { dur = window.Android && Android.getMainDurationMs ? Android.getMainDurationMs() : null; } catch (e) {}
  return { tvNow: Date.now(), up: Math.round(performance.now()), app: s.app && s.app.id, engine: s.version, speed: s.speed, v2b: v.state,
    ct: s.video && s.video.ct, paused: s.video && s.video.paused, rate: s.video && s.video.rate, uiMs: ui, durMs: dur,
    hold: v.hold, holds: v.holds, holdMaxMs: v.holdMaxMs, aheadS: v.bufferAheadS, q: v.quality, lvl: v.level && v.level.h,
    stalls60s: v.stalls60s, fails: v.failures, verdict: s.verdict && s.verdict.why, variant: v.variant && v.variant.video, net: v.net || null,
    restoreNudges: v.restoreNudges, engineRetries: v.engineRetries, heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
    ev: S.events(400).filter((e) => e.t > (window.__sttvWatchT || -1)).map((e) => (window.__sttvWatchT = Math.max(window.__sttvWatchT || -1, e.t), e)) }; })()`;
async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
const probeSrc = () => fs.readFileSync(path.join(here, 'sttv-probe.js'), 'utf8');
const ensureProbe = `(function(){ if (!window.STTVProbe) { ${'__PROBE__'} } })()`;

(async () => {
  if (cmd === 'list') { console.table((await targets()).map(t => ({ type: t.type, title: (t.title || '').slice(0, 40), url: redact((t.url || '').slice(0, 90)) }))); return process.exit(0); }
  if (cmd === 'watch') {   // own loop: survives app restarts (target_closed) by reconnecting
    const every = +(opt.every || 2000), until = Date.now() + 1000 * +(opt.for || 600), file = opt.out || `sttv-watch-${stamp()}.jsonl`;
    let c = null, lastUi = null, lastUp = null, n = 0;
    console.error('watch ->', file, 'every', every, 'ms for', opt.for || 600, 's (Ctrl+C stops; the file is written line by line)');
    while (Date.now() < until) {
      try {
        if (!c) { const t = await pick(); c = await connect(t); fs.appendFileSync(file, J({ at: new Date().toISOString(), connect: (t.url || '').slice(0, 120) }) + '\n'); }
        const r = await evaluate(c, SAMPLE), at = new Date().toISOString();
        if (r && lastUp !== null && r.up < lastUp) r.pageReloaded = true;
        if (r && typeof r.uiMs === 'number' && typeof lastUi === 'number' && lastUi > 5000 && r.uiMs < 1500 && !r.pageReloaded) r.warn = 'UI position jumped to ~0 (' + lastUi + ' -> ' + r.uiMs + ' ms)';
        fs.appendFileSync(file, J({ at, ...r }) + '\n');
        if (r) { lastUi = r.uiMs; lastUp = r.up; }
        if (r && (n++ % Math.max(1, Math.round(5000 / every)) === 0 || r.warn))
          console.log(at.slice(11, 19), r.noEngine ? 'no engine' : `${r.app} x${r.speed} v2b=${r.v2b} ui=${r.uiMs} ct=${r.ct} hold=${r.hold ? r.hold.why : '-'} ahead=${r.aheadS} heap=${r.heapMB}MB${r.net ? ' net=' + r.net.bwEstMbps + '/' + r.net.needMbps + 'Mbps ' + (r.variant || '') : ''} ev+${(r.ev || []).length}${r.warn ? '  WARN ' + r.warn : ''}`);
      } catch (e) {
        fs.appendFileSync(file, J({ at: new Date().toISOString(), error: e.message }) + '\n');
        console.error(new Date().toISOString().slice(11, 19), 'lost target (' + e.message + '), reconnecting...');
        try { c && c.close(); } catch (x) {}
        c = null; await sleep(3000); continue;
      }
      await sleep(every);
    }
    console.error('saved', file);
    return process.exit(0);
  }
  const t = await pick();
  console.error('target:', t.title || '', redact((t.url || '').slice(0, 100)));
  const c = await connect(t);
  let out;
  const loadProbe = async () => evaluate(c, ensureProbe.replace('__PROBE__', () => probeSrc()));
  if (cmd === 'probe') {
    await loadProbe();
    console.error('running probe (~40 s), do not touch the remote...');
    out = await evaluate(c, `STTVProbe.run({ dwell: ${+opt.dwell} })`);
    const file = opt.out || `sttv-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, J(out, null, 1));
    console.log(J({ verdict: out.verdict, pipeline: out.pipeline, rates: (out.rates || []).map(r => [r.req, r.label, r.eff, r.events]) }, null, 1));
    console.error('saved', file);
  } else if (cmd === 'ear') {
    await loadProbe();
    out = await evaluate(c, `STTVProbe.ear(${parseFloat(pos[1]) || 1.5}, ${parseFloat(opt.secs) || 7})`);
    console.log(J(out, null, 1));
  } else if (cmd === 'beep') {
    await loadProbe();
    out = await evaluate(c, 'STTVProbe.beep()');
    console.log(J(out, null, 1));
  } else if (cmd === 'inject') {
    const f = pos[1] || path.join(here, '..', 'sttv-speed', 'sttv-speed.js');
    await evaluate(c, fs.readFileSync(f, 'utf8') + '\n;0');
    out = await evaluate(c, 'window.STTVSpeed ? STTVSpeed.status() : null');
    console.log(J(out, null, 1));
  } else if (cmd === 'gates') {
    await evaluate(c, fs.readFileSync(path.join(here, 'gate-media.js'), 'utf8') + '\n;0');
    await evaluate(c, fs.readFileSync(path.join(here, 'sttv-gates.js'), 'utf8') + '\n;0');
    console.error('running gates (~90 s, a small test video appears bottom-right), do not touch the remote...');
    out = await evaluate(c, `STTVGates.run(${JSON.stringify({ only: opt.only, chunkMB: opt.chunkMB ? +opt.chunkMB : undefined })})`);
    const file = opt.out || `sttv-gates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, J(out, null, 1));
    console.log(J({ verdict: out.verdict, g1: out.g1 && [out.g1.elementRate, out.g1.fps], g2: (out.g2 || []).map(g => [g.S, g.contentRate, g.waiting, g.fps, g.error]),
      g3: out.g3 && out.g3.bytesMB, g4: out.g4 && { MBps: out.g4.MBps, margin: out.g4.margin, error: out.g4.error }, g5: (out.g5 || []).map(g => [g.mediaOption, g.elementRate, g.error]) }, null, 1));
    console.error('saved', file);
  } else if (cmd === 'audiodiag') {
    console.error('audio test: ~25 s. Someone must LISTEN at the TV and note the test numbers that were audible (test N = N beeps).');
    out = await evaluate(c, `window.STTVSpeed && STTVSpeed.audioDiag ? STTVSpeed.audioDiag(${JSON.stringify({ media: opt.media === '0' ? false : undefined })}) : "STTVSpeed 1.3 not loaded"`);
    const file = opt.out || `sttv-audiodiag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, J(out, null, 1));
    if (out && out.tests) console.table(out.tests.map(x => ({ test: x.id, path: x.name, renderedDb: x.renderedDb, clock: x.clock, ctx: x.ctx ? x.ctx.state + ' ' + x.ctx.sr + ' out=' + x.ctx.out : '', videoMuted: x.elementMuted0 === undefined ? (x.elementMuted === undefined ? '' : String(x.elementMuted)) : x.elementMuted0 + '>' + x.elementMuted, note: x.err || x.skipped || (x.audioCt !== undefined ? 'audio ct ' + x.audioCt : '') })));
    console.log(J({ caps: out && out.caps, engine: out && out.engine, after: out && out.after }, null, 1));
    console.error('saved', file, '- now add: which test numbers were AUDIBLE?');
  } else if (cmd === 'report') {
    out = await evaluate(c, 'window.STTVSpeed ? { status: STTVSpeed.status(), audio: STTVSpeed.audio ? STTVSpeed.audio() : null, events: STTVSpeed.events(400), prevLog: STTVSpeed.prevLog ? STTVSpeed.prevLog() : null, app: window.TwitchNG ? { name: TwitchNG.name, version: TwitchNG.version, preRelease: TwitchNG.preRelease, preReleaseN: TwitchNG.preReleaseN || null, platform: TwitchNG.state ? TwitchNG.state().platform : null } : null } : "STTVSpeed not loaded"');
    const file = opt.out || `sttv-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, J(out, null, 1));
    console.log(J(out && out.status ? { verdict: out.status.verdict, v2b: out.status.v2b && out.status.v2b.state, audioOut: out.status.engine && out.status.engine.audioOut } : out, null, 1));
    console.error('saved', file);
  } else if (cmd === 'status') {
    out = await evaluate(c, 'window.STTVSpeed ? STTVSpeed.status() : "STTVSpeed not loaded"');
    console.log(J(out, null, 1));
  } else if (cmd === 'check') {
    out = await evaluate(c, `(() => { const s = window.STTVSpeed ? STTVSpeed.status() : null, ng = window.TwitchNG && TwitchNG.state ? TwitchNG.state() : null;
      return { url: location.href, engine: s && s.version, app: s && s.app, base: s && s.v2b && s.v2b.base, mode: s && s.mode, v2bCfg: s && s.v2b && s.v2b.cfg,
        v2bDefault: s && s.v2b && s.v2b.cfgDefault, libs: s && s.v2b && s.v2b.libs, ng, ua: navigator.userAgent, tvNow: new Date().toISOString() }; })()`);
    const kv = kitVersions(), want = { engine: opt.engine || kv.engine, app: opt.app || 'com.twitchng.tv', ng: opt.ng || kv.ng, pre: opt.pre || kv.pre, variant: opt.variant || 'L3' };
    const res = [['engine ' + want.engine, out.engine === want.engine], ['app id ' + want.app, !!(out.app && out.app.id === want.app)],
      ['BASE inside ' + want.app, String(out.base || '').indexOf('/' + want.app + '/') >= 0]];
    if (want.ng !== 'none') res.push(['TwitchNG ' + want.ng + ' variant ' + want.variant, !!(out.ng && out.ng.version === want.ng && out.ng.variant === want.variant)]);
    if (want.ng !== 'none' && want.pre !== 'none') res.push(['TwitchNG pre-release ' + want.pre, !!(out.ng && out.ng.preRelease === true && String(out.ng.preReleaseN || '') === String(want.pre))]);
    console.log(J(out, null, 1));
    res.forEach(([k, okk]) => console.log((okk ? 'PASS ' : 'FAIL ') + k));
    const bad = res.filter((r) => !r[1]).length;
    console.log(bad ? 'CHECK FAILED: this is not the build under test - stop and fix the install first' : 'CHECK OK');
    c.close(); process.exit(bad ? 4 : 0);
  } else if (cmd === 'key') {
    const gap = +(opt.gap || 400);
    for (const k of pos.slice(1)) {
      const code = /^\d+$/.test(k) && !(k in KEYS && k.length === 1) ? +k : KEYS[String(k).toLowerCase()];
      if (!code) { console.error('unknown key', k, Object.keys(KEYS).join(' ')); process.exit(1); }
      const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: k === 'enter' || k === 'ok' ? 'Enter' : String(k) };
      await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      console.log(new Date().toISOString(), 'key', k, code);
      await sleep(gap);
    }
  } else if (cmd === 'shot') {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    const file = opt.out || `sttv-shot-${stamp()}.png`;
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.error('saved', file, '(web layer only: the video plane is not captured)');
  } else if (cmd === 'mem') {   // leak watch: forced GC, then JS heap + DOM counters (documents, nodes, listeners); --gc 0 skips the GC
    if (opt.gc !== '0') { try { await c.send('HeapProfiler.enable'); await c.send('HeapProfiler.collectGarbage'); } catch (e) {} }
    const h = await c.send('Runtime.getHeapUsage').catch(() => null), d = await c.send('Memory.getDOMCounters').catch(() => null);
    // + ArrayBuffer memory outside the JS heap (newer Chromium only) and the engine's v2b segment cache (1.3.8: 0 after stopVideo)
    const sc = await evaluate(c, '(function(){ var C = window.STTVSpeed && STTVSpeed._internals && STTVSpeed._internals.segCache; return C ? { n: C.order.length, mb: +(C.bytes / 1048576).toFixed(1) } : null; })()').catch(() => null);
    out = { at: new Date().toISOString(), heapUsedMB: h ? +(h.usedSize / 1048576).toFixed(1) : null, heapTotalMB: h ? +(h.totalSize / 1048576).toFixed(1) : null, dom: d,
      abufMB: h && h.backingStorageSize !== undefined ? +(h.backingStorageSize / 1048576).toFixed(1) : null, segCache: sc };
    console.log(J(out));
    if (opt.out) fs.appendFileSync(opt.out, J(out) + '\n');
  } else if (cmd === 'heap') {  // full heap snapshot (pauses the page for seconds; take it while paused)
    const file = opt.out || `sttv-heap-${stamp()}.heapsnapshot`, fd = fs.openSync(file, 'w');
    let n = 0;
    c.on('HeapProfiler.addHeapSnapshotChunk', (p) => { fs.writeSync(fd, p.chunk); n += p.chunk.length; });
    await c.send('HeapProfiler.enable');
    await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    fs.closeSync(fd);
    console.error('saved', file, (n / 1048576).toFixed(1) + ' MB');
    console.error('PRIVATE: a heap snapshot is the app\'s memory, incl. the Twitch sign-in token. Analyse it locally, never attach it to a report, chat or git.');
  } else if (cmd === 'eval') {
    out = await evaluate(c, pos.slice(1).join(' '));
    console.log(typeof out === 'string' ? redact(out) : J(out, null, 1));
  } else { console.error('unknown command ' + cmd); process.exit(1); }
  c.close();
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
