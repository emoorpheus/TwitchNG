import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadAddon } from './load.mjs';
import { TD } from './_paths.mjs';
const api = loadAddon();
const I = api._internals;
let fails = 0;
function ok(cond, msg, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails++; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- playlists
const master = fs.readFileSync(TD + 'master.m3u8', 'utf8');
const vars = I.parseMaster(master, 'https://usher.ttvnw.net/vod/2915888911.m3u8');
const ao = vars.filter(v => v.audioOnly);
ok(vars.length >= 6 && ao.length === 1, 'master variants + single audio_only', { n: vars.length, ao: ao.map(v => v.uri.split('/').slice(-2).join('/')) });
const v360 = vars.find(v => /\/360p30\//.test(v.uri));
const picked = I.pickSources(vars, v360.uri);
ok(picked.audio === ao[0].uri && picked.audioKind === 'audio_only' && picked.video === v360.uri, 'pickSources prefers audio_only, keeps playing video');
ok(I.deriveAudioOnly(v360.uri) === ao[0].uri, 'deriveAudioOnly(360p) == master audio_only', I.deriveAudioOnly(v360.uri));
ok(I.deriveAudioOnly('https://example.com/movie/stream.m3u8') === null, 'deriveAudioOnly ignores non-Twitch layout');
ok(I.streamKey('https://usher.ttvnw.net/vod/2915888911.m3u8?x=1', master, 2) === 'vod:2915888911', 'streamKey from usher url');
const apl = I.parseMedia(fs.readFileSync(TD + 'audio.m3u8', 'utf8'), ao[0].uri);
ok(apl.segs.length === 5360 && near(apl.total, 53591.179, 1e-6) && apl.ended && !apl.fmp4, 'audio playlist parse', { segs: apl.segs.length, total: apl.total });
ok(apl.segs[100].uri === ao[0].uri.replace('index-dvr.m3u8', '100.ts'), 'segment uri resolution');
ok(I.segAt(apl, 0) === 0 && I.segAt(apl, 1000.0) === 100 && I.segAt(apl, 1009.99) === 100 && I.segAt(apl, 1e9) === 5359, 'segAt');

// ---- TS demux vs ffprobe
function probePackets(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', file]).toString().trim().split('\n').map(s => parseInt(s, 10));
  return out;
}
for (const f of ['a100.ts', 'a101.ts', 'v100.ts']) {
  const u8 = new Uint8Array(fs.readFileSync(TD + f));
  const t0 = performance.now();
  const r = I.demuxTS(u8);
  const ms = performance.now() - t0;
  const ref = probePackets(TD + f);
  let maxd = 0; for (let i = 0; i < Math.min(ref.length, r.frames.length); i++) maxd = Math.max(maxd, Math.abs(r.frames[i].pts - ref[i]));
  ok(r.frames.length === ref.length && maxd <= 1 && r.sr === 48000 && r.ch === 2 && r.aot === 2, `demuxTS ${f}: frames/PTS match ffprobe`, { frames: r.frames.length, ffprobe: ref.length, maxPtsDiff: maxd, ms: +ms.toFixed(1), vpts: r.firstVideoPts });
}
for (const f of ['a0_head.ts', 'v0_head.ts']) {
  const r = I.demuxTS(new Uint8Array(fs.readFileSync(TD + f)));
  console.log('INFO head', f, { firstAudio: r.firstAudioPts / 90000, firstVideo: r.firstVideoPts / 90000, frames: r.frames.length });
}
const vh = I.demuxTS(new Uint8Array(fs.readFileSync(TD + 'v0_head.ts')));
const base = Math.min(...[vh.firstVideoPts, vh.firstAudioPts].filter(x => x >= 0)) / 90000;
const a100 = I.demuxTS(new Uint8Array(fs.readFileSync(TD + 'a100.ts')));
const ct100 = a100.frames[0].pts / 90000 - base;
ok(near(ct100, apl.segs[100].start, 0.05), 'content time of audio seg100 ~ EXTINF start', { ct: +ct100.toFixed(4), extinf: apl.segs[100].start, base });

// ---- PTS unwrap
const W = 8589934592;
ok(I.unwrapPts(100, W + 50) === W + 100 && I.unwrapPts(W - 10, 5) === -10, 'unwrapPts');

// ---- ADTS re-wrap round trip + ffmpeg decode length
{
  const r = a100;
  const asc = I.makeAsc(r.aot, r.sr, r.ch);
  ok(asc[0] === 0x11 && asc[1] === 0x90, 'ASC for AAC-LC 48k stereo = 11 90', Array.from(asc));
  const parts = r.frames.map(f => I.adtsWrap(f.data, { sr: r.sr, ch: r.ch, aot: r.aot }));
  const same = parts.every((p, i) => Buffer.compare(Buffer.from(p), Buffer.from(r.frames[i].adts)) === 0 || (p.length === r.frames[i].adts.length));
  ok(same, 'adtsWrap reproduces ADTS frames (length-wise)');
  const total = parts.reduce((a, p) => a + p.length, 0);
  fs.writeFileSync('/tmp/a100.aac', Buffer.concat(parts.map(p => Buffer.from(p)), total));
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', '/tmp/a100.aac', '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'], { maxBuffer: 1 << 28 });
  const n = pcm.length / 8;
  ok(Math.abs(n - r.frames.length * 1024) <= 2048, 'ffmpeg decodes re-wrapped ADTS to expected length', { samples: n, expect: r.frames.length * 1024 });
}

// ---- PcmStore edge cases
{
  const S = new I.PcmStore(48000, 2);
  const mk = (n, v) => [new Float32Array(n).fill(v), new Float32Array(n).fill(-v)];
  S.write(1000, mk(1024, 0.1), 1024);
  S.write(2024 + 1, mk(1024, 0.2), 1024);            // 1-sample gap -> snapped
  S.write(1500, mk(300, 0.9), 300);                 // fully overlapping -> ignored
  S.write(70000, mk(1000, 0.3), 1000);              // separate island
  ok(S.covered(1000, 3048, 0) && !S.covered(1000, 3100, 0), 'store snaps 1-sample gaps; covered() exact', S.ranges());
  const out = [new Float32Array(3000), new Float32Array(3000)];
  S.read(900, 3000, out, 0);
  ok(out[0][50] === 0 && near(out[0][150], 0.1, 1e-7) && near(out[0][600], 0.1, 1e-7) && near(out[0][1200], 0.2, 1e-7) && out[0][2500] === 0 && near(out[1][150], -0.1, 1e-7), 'store read with zero-filled holes; overlap kept first data');
  // big write spanning several blocks
  const big = 200000; const S2 = new I.PcmStore(48000, 2);
  const L = new Float32Array(big), R = new Float32Array(big); for (let i = 0; i < big; i++) { L[i] = Math.sin(i / 50); R[i] = i / big; }
  S2.write(5, [L, R], big);
  const o2 = [new Float32Array(big), new Float32Array(big)]; S2.read(5, big, o2, 0);
  let md = 0; for (let i = 0; i < big; i++) md = Math.max(md, Math.abs(o2[0][i] - L[i]), Math.abs(o2[1][i] - R[i]));
  ok(md === 0 && S2.blocks.length === Math.ceil(big / 65536), 'store multi-block write/read exact', { blocks: S2.blocks.length });
  S2.prune(100000, 1e9);
  ok(!S2.covered(5, 1000, 0) && S2.covered(131077, 150000, 0), 'store prune drops whole old blocks only');
  const mono = new I.PcmStore(48000, 2); mono.write(0, [new Float32Array(10).fill(0.5)], 10);
  const o3 = [new Float32Array(10), new Float32Array(10)]; mono.read(0, 10, o3, 0);
  ok(o3[1][5] === 0.5, 'mono input duplicated to both channels');
}

// ---- VClock
{
  const vc = new I.VClock();
  let tw = 0, ct = 100;
  for (let k = 0; k < 100; k++) { tw += 0.04; if (k % 6 === 0) ct = 100 + tw * 1.5; vc.sample(ct, tw, 1.5); } // 240 ms granularity
  const est = vc.estimate(tw, 1.5), truth = 100 + tw * 1.5;
  ok(Math.abs(est - truth) < 0.15 && vc.moving(tw), 'VClock estimate with coarse 240ms updates', { err: +(est - truth).toFixed(3), gran: vc.granularity() });
}

// ---- v1.1: VClock observation bias with async coarse currentTime (pipeline steps 200 ms at random phase, jittery 40 ms tick)
{
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const errs = [];
  for (let trial = 0; trial < 30; trial++) {
    const vc = new I.VClock(), phase = rnd() * 0.2; let tw = 10 + rnd();
    for (let k = 0; k < 300; k++) {
      tw += 0.04 * (0.8 + 0.4 * rnd());
      const tu = Math.floor((tw - phase) / 0.2) * 0.2 + phase;
      vc.sample(100 + tu * 1.5, tw, 1.5);
      if (k > 60 && vc.ready()) errs.push(vc.estimate(tw, 1.5) - (100 + tw * 1.5));
    }
  }
  const m = errs.reduce((a, b) => a + b, 0) / errs.length;
  ok(Math.abs(m) < 0.005, 'VClock: no systematic lag with async 200 ms currentTime steps (v1.0: -31 ms)', { meanMs: +(m * 1000).toFixed(1) });
}
// ---- v1.1: RateMeter slope on a stepped clock
{
  const rm = new I.RateMeter(); let tw = 5;
  for (let k = 0; k < 64; k++) { tw += 0.04; rm.add(tw, 50 + Math.floor(tw / 0.2) * 0.2 * 1.0); }   // video really at 1.0x, 200 ms steps
  const r = rm.slope();
  ok(rm.span() > 2.5 && Math.abs(r - 1) < 0.05, 'RateMeter: 2.5 s window resolves 1.00x on a 200 ms stepped clock', { ratio: +r.toFixed(3) });
  rm.add(tw + 0.04, 10);
  ok(rm.p.length === 1, 'RateMeter: backwards jump (seek) resets the window');
}
// ---- v1.1: LatTracker - jitter suppression, slew + feed-forward, jump
{
  const lt = new I.LatTracker(); let tw = 1, seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const ctx = { baseLatency: 0.0427, outputLatency: 0.112, currentTime: 1 };
  let out = 0.112, hold = 0; const app = [];
  for (let k = 0; k < 750; k++) {                          // 30 s, outputLatency jumps around 96..136 ms every ~250 ms
    tw += 0.04; ctx.currentTime += 0.04;
    if (--hold <= 0) { out = 0.096 + 0.04 * rnd(); hold = 6; }
    ctx.outputLatency = out; lt.update(ctx, tw);
    if (k > 100) app.push(lt.applied);
  }
  const mn = Math.min(...app), mx = Math.max(...app);
  ok(mx - mn < 0.012 && Math.abs(lt.applied - 0.1547) < 0.012, 'LatTracker: 40 ms report jitter -> applied latency spread < 12 ms', { spreadMs: +((mx - mn) * 1000).toFixed(1), appliedMs: +(lt.applied * 1000).toFixed(1) });
  let jumped = false, maxFf = 0;
  for (let k = 0; k < 200; k++) { tw += 0.04; ctx.currentTime += 0.04; ctx.outputLatency = 0.136; if (lt.update(ctx, tw)) jumped = true; maxFf = Math.max(maxFf, Math.abs(lt.ff)); }
  ok(!jumped && maxFf <= 0.0051 && maxFf > 0, 'LatTracker: small step -> slewed <= 5 ms/s with feed-forward, no re-anchor', { ffMax: +maxFf.toFixed(4), appliedMs: +(lt.applied * 1000).toFixed(1) });
  for (let k = 0; k < 100; k++) { tw += 0.04; ctx.currentTime += 0.04; ctx.outputLatency = 0.300; if (lt.update(ctx, tw)) jumped = true; }
  ok(jumped && Math.abs(lt.applied - 0.3427) < 0.002, 'LatTracker: +160 ms sustained (BT) -> immediate jump + re-anchor', { appliedMs: +(lt.applied * 1000).toFixed(1), jumps: lt.jumps });
}
// ---- v1.1: rate capability cache keyed by firmware
{
  const store = {}; const LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const mk = (ua) => loadAddon({ localStorage: LS, navigator: { language: 'en', userAgent: ua }, PalmSystem: { deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '10.3.0' }) } });
  const a = mk('Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/120.0.0.0 Safari/537.36 WebAppManager');
  store.STTV_SPEED_RATECAP = JSON.stringify({ k: a._internals.fwKey(), s: 2, native: { v: 'ignored', sp: [1.5], ratio: 1, at: Date.now() } });
  ok(a._internals.capGet('native') && a._internals.capGet('native').v === 'ignored' && !a._internals.capGet('mse'), 'cap: native=ignored read back, mse unknown');
  const b = mk('Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/126.0.0.0 Safari/537.36 WebAppManager');
  ok(b._internals.capGet('native') === null, 'cap: firmware/UA change invalidates the cache');
  store.STTV_SPEED_RATECAP = JSON.stringify({ k: a._internals.fwKey(), s: 2, native: { v: 'ignored', sp: [1.5], at: Date.now() - 31 * 864e5 } });
  ok(a._internals.capGet('native') === null, 'cap: 30-day expiry');
  // v1.2: v1.1 entries (no schema) are dropped - v1.1 filed blob: m3u8 text (native HLS) under 'mse'
  store.STTV_SPEED_RATECAP = JSON.stringify({ k: a._internals.fwKey(), mse: { v: 'ignored', sp: [1.5], ratio: 1, at: Date.now() } });
  ok(a._internals.capGet('mse') === null && a._internals.capGet('native') === null, 'cap v1.2: v1.1 entry (no s:2) dropped');
}
// ---- v1.2: what is behind a blob: src (object-URL registry + one-shot XHR probe)
{
  let n = 0; const texts = {};
  class FakeMS {}
  class FakeXHR {
    open(m, u) { this.u = u; } setRequestHeader() {}
    send() { setTimeout(() => { if (this.u in texts) { this.status = 200; this.response = texts[this.u]; this.onload(); } else { this.status = 0; this.onerror(); } }, 5); }
  }
  const U = { createObjectURL: () => 'blob:https://sttv.test/' + (++n), revokeObjectURL() {} };
  const a = loadAddon({ URL: U, MediaSource: FakeMS, XMLHttpRequest: FakeXHR });
  const P = v => a._internals.pipeKind(v);
  const uH = U.createObjectURL(new Blob(['#EXTM3U\n'], { type: 'application/vnd.apple.mpegurl' }));
  const uM = U.createObjectURL(new FakeMS());
  const uT = U.createObjectURL(new Blob(['#EXTM3U\n#EXT-X-TARGETDURATION:10\n'], { type: 'text/plain' }));
  texts[uT] = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n';
  ok(P({ src: 'https://x/index-dvr.m3u8' }) === 'native', 'pipeKind: https m3u8 -> native');
  ok(P({ currentSrc: uH }) === 'native', 'pipeKind: blob of m3u8 text (xenking createMediaPlaylistObjectUrl) -> native, not mse');
  ok(P({ currentSrc: uM }) === 'mse', 'pipeKind: blob of a MediaSource -> mse');
  const first = [P({ currentSrc: uT }), P({ currentSrc: 'blob:https://sttv.test/foreign' })];
  await new Promise(r => setTimeout(r, 30));
  ok(first[0] === 'unknown' && first[1] === 'unknown' && P({ currentSrc: uT }) === 'native' && P({ currentSrc: 'blob:https://sttv.test/foreign' }) === 'mse',
    'pipeKind: unknown blobs probed once (m3u8 text -> native, unreadable -> mse)', { first });
}
// ---- v1.3: audio output policy (context options, mute policy, meter classes, WAV generator)
{
  const store = {};
  const LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  class FakeAC {
    constructor(o) { if (o && o.sampleRate && FakeAC.rejectSr) throw new Error('NotSupportedError'); this.o = o || null; this.sampleRate = (o && o.sampleRate) || 44100; this.state = 'running'; }
    close() { this.state = 'closed'; }
  }
  const a = loadAddon({ localStorage: LS, AudioContext: FakeAC, Blob });
  const I3 = a._internals;
  ok(I3.cfg.actx === 'default' && I3.cfg.mute === 'auto' && I3.cfg.actxFresh === true, 'v1.3 defaults: actx default, mute auto, fresh v2b context');
  const o0 = I3.ctxOptions('default'), o48 = I3.ctxOptions('48k');
  ok(o0[0] === null && o48[0].sampleRate === 48000 && o48[0].latencyHint === 'playback', 'ctxOptions: platform defaults first (1.3), 48k/playback = 1.2');
  let r = I3.newContext('default');
  ok(r.ctx && r.ctx.o === null && r.opts === 'default', 'newContext(default) = new AudioContext() without options', r.opts);
  FakeAC.rejectSr = true; r = I3.newContext('48k'); FakeAC.rejectSr = false;
  ok(r.ctx && r.ctx.o && !r.ctx.o.sampleRate && r.opts === 'playback', 'newContext(48k) falls back when sampleRate is rejected', r.opts);
  store.STTV_SPEED_ACTX = '48k'; store.STTV_SPEED_MUTE = 'hw'; store.STTV_SPEED_ACTX_FRESH = '0'; I3.audioConf();
  ok(I3.cfg.actx === '48k' && I3.cfg.mute === 'hw' && I3.cfg.actxFresh === false, 'audioConf reads STTV_SPEED_ACTX / _MUTE / _ACTX_FRESH');
  const conf = a.audio({ actx: 'default', mute: 'auto', fresh: true });
  ok(conf.actx === 'default' && conf.mute === 'auto' && conf.fresh === true && !('STTV_SPEED_ACTX' in store) && !('STTV_SPEED_MUTE' in store) && !('STTV_SPEED_ACTX_FRESH' in store),
    'STTVSpeed.audio() back to defaults removes the keys');
  const G = I3.Engine.prototype._guardWanted, gw = (pipe, mute) => { I3.cfg.mute = mute; return G.call({ pipe }); };
  ok(gw('v2b', 'auto') === false && gw('native', 'auto') === true && gw('unknown', 'auto') === true && gw('v2b', 'hw') === true && gw('native', 'off') === false,
    'mute policy: auto = hardware mute only outside v2b, hw = 1.2, off = never');
  I3.cfg.mute = 'auto';
  ok(I3.audioClass(-20, -22) === 'rendering' && I3.audioClass(-25, -120) === 'graph_silent' && I3.audioClass(-120, -120) === 'pcm_silent' &&
    I3.audioClass(-70, -100) === 'quiet' && I3.audioClass(null, null) === 'quiet', 'meter classes: rendering / graph_silent / pcm_silent / quiet');
  ok(I3.db(1) === 0 && I3.db(0.1) === -20 && I3.db(0) === -120, 'db()');
  const ab = new Uint8Array(await I3.wavBlob(3, 880).arrayBuffer()), dv = new DataView(ab.buffer), n = (ab.length - 44) / 2;
  let mx = 0, nz = 0; for (let i = 0; i < n; i++) { const x = Math.abs(dv.getInt16(44 + 2 * i, true)); if (x > mx) mx = x; if (x > 300) nz++; }
  ok(String.fromCharCode(...ab.slice(0, 4)) === 'RIFF' && dv.getUint32(24, true) === 48000 && n === Math.round(48000 * (0.15 + 3 * 0.4 + 0.1)) &&
    mx > 9000 && mx < 10000 && Math.abs(nz / 48000 - 3 * 0.22) < 0.05, 'wavBlob: 48 kHz mono 16-bit, 3 beeps x 0.22 s at -10.5 dBFS', { n, mx, toneS: +(nz / 48000).toFixed(3) });
}
{
  // 1.3.1: build-time v2b default from our own script tag (data-v2b), localStorage wins, the setter stores deviations only
  const store = {}; const LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const SRC = 'file:///media/developer/apps/usr/palm/applications/x/release/githubio/js/sttv-speed.js?v=1.3.1';
  const docWith = (v) => ({ getElementById: () => null, currentScript: { src: SRC, getAttribute: n => (n === 'data-v2b' ? v : null) } });
  const a0 = loadAddon({ localStorage: LS, document: docWith(null) });
  ok(a0._internals.BUILD_V2B === 'off' && a0._internals.cfg.v2b === 'off' && a0.v2b().cfgDefault === 'off', 'no data-v2b: default off (= 1.3)');
  const a1 = loadAddon({ localStorage: LS, document: docWith('auto') }), I1 = a1._internals;
  ok(I1.BUILD_V2B === 'auto' && I1.cfg.v2b === 'auto' && a1.v2b().cfg === 'auto' && a1.v2b().cfgDefault === 'auto' &&
    I1.BASE === 'file:///media/developer/apps/usr/palm/applications/x/release/githubio/js/', 'data-v2b="auto": cfg auto, BASE from the tag src', I1.BASE);
  a1.v2b('off');
  ok(store.STTV_SPEED_V2B === 'off' && I1.cfg.v2b === 'off', "v2b('off') with build default auto is stored (sticks)", store.STTV_SPEED_V2B);
  a1.v2b('FORCE');
  ok(store.STTV_SPEED_V2B === 'force' && I1.cfg.v2b === 'force', "v2b('force') stored normalized");
  a1.v2b('auto');
  ok(!('STTV_SPEED_V2B' in store) && I1.cfg.v2b === 'auto', "v2b(build default) removes the key");
  store.STTV_SPEED_V2B = 'off';
  ok(loadAddon({ localStorage: LS, document: docWith('auto') })._internals.cfg.v2b === 'off', 'localStorage wins over data-v2b');
  delete store.STTV_SPEED_V2B;
  ok(loadAddon({ localStorage: LS, document: docWith('bogus') })._internals.cfg.v2b === 'off', 'invalid data-v2b -> off');
  ok(loadAddon({ localStorage: LS, document: docWith(null), STTV_SPEED_BUILD: { v2b: 'auto' } })._internals.cfg.v2b === 'auto', 'window.STTV_SPEED_BUILD.v2b fallback');
  const a2 = loadAddon({ localStorage: LS, document: docWith(null) });
  a2.v2b('auto');
  ok(store.STTV_SPEED_V2B === 'auto' && a2._internals.cfg.v2b === 'auto', "build default off: v2b('auto') stored as before (1.3 behaviour)");
  a2.v2b('off');
  ok(!('STTV_SPEED_V2B' in store), "build default off: v2b('off') removes the key");
}
// ---- v1.3.2: v2b timeline self-check (TV report on 1.3.1: VOD duration in the player UI = S x the real length)
{
  const a = loadAddon(), I4 = a._internals;
  I4.v2bLevelInfo({ fragments: [{ start: 0 }, { start: 10 }], totalduration: 53591.201, live: false });
  ok(I4.v2b.levelInfo.end === 53591.201 && I4.v2b.levelInfo.frags === 2 && I4.v2b.levelInfo.live === false, 'v2bLevelInfo: end = fragments[0].start + totalduration', I4.v2b.levelInfo);
  I4.v2b.gen = 7; I4.v2b.speed = 2;
  const good = { duration: 53591.2 }, bad = { duration: 107182.402 }, nan = { duration: NaN };
  for (let i = 0; i < 5; i++) I4.v2bTimelineCheck(good);
  I4.v2bTimelineCheck(nan);
  ok(I4.v2b.tl.checks === 5 && I4.v2b.tl.mismatches === 0 && I4.v2b.tl.bad === 0, 'timeline check: correct duration -> no mismatch, NaN (re-attach) skipped', I4.v2b.tl);
  I4.v2bTimelineCheck(bad); I4.v2bTimelineCheck(bad);
  ok(I4.v2b.tl.mismatches === 0, 'timeline check: 2 bad samples are not enough (transient)');
  I4.v2bTimelineCheck(bad); I4.v2bTimelineCheck(bad); I4.v2bTimelineCheck(bad);
  const mm = a.events(50).filter(e => e.type === 'v2b_timeline_mismatch');
  ok(I4.v2b.tl.mismatches === 1 && mm.length === 1 && mm[0].data.ratio === 2 && mm[0].data.end === 53591.201, 'timeline check: S x duration -> one v2b_timeline_mismatch per engagement (ratio 2)', mm[0] && mm[0].data);
  I4.v2b.levelInfo.live = true; const n0 = I4.v2b.tl.checks; I4.v2bTimelineCheck(bad);
  ok(I4.v2b.tl.checks === n0, 'timeline check: live playlists skipped');
}
// ---- v1.3.2: audio output accounting - every meter interval lands in exactly one bucket; silentS = current streak
{
  const I5 = loadAddon()._internals, E = I5.Engine.prototype;
  const f = { ctx: { currentTime: 0 }, meter: null, anch: true, anchorTw: -10, renderNote: true, v: {}, guard: { active: false },
    fade: { gain: { value: 1 } }, vol: { gain: { value: 1 } },
    am: { pcmSq: 0, pcmN: 0, pcmDb: null, outDb: null, peakDb: null, at: 0, ctxT: 0, clock: null, cls: '', silentS: 0, okS: 0, flagged: '', quietS: 0, silentTotalS: 0, startS: 0, unanchS: 0 } };
  let tw = 1;
  const step = (pcmDb, outDb, anch, anchorTw) => {
    f.anch = anch; f.anchorTw = anchorTw === undefined ? -10 : anchorTw;
    const amp = Math.pow(10, pcmDb / 20); f.am.pcmSq = amp * amp * 100; f.am.pcmN = 100; f.am.outDb = outDb;
    tw += 0.5; f.ctx.currentTime += 0.5; E._meter.call(f, tw);
  };
  E._meter.call(f, tw);                                        // first interval: dt = 0
  step(-20, -22, true); step(-20, -22, true);                  // rendering 1.0 s
  step(-70, -120, true);                                       // quiet 0.5 s (content quiet, not silent)
  step(-120, -120, true); step(-120, -120, true);              // pcm_silent 1.0 s (streak 1.0)
  step(-20, -22, true);                                        // rendering resets the streak
  step(-20, -120, true);                                       // graph_silent 0.5 s (streak 0.5)
  step(-20, -22, false);                                       // unanchored 0.5 s
  step(-20, -22, true, tw + 0.5 - 1);                          // starting (anchored < 1.5 s ago) 0.5 s
  const m = f.am, sum = m.okS + m.quietS + m.silentTotalS + m.startS + m.unanchS;
  ok(near(m.okS, 1.5, 1e-9) && near(m.quietS, 0.5, 1e-9) && near(m.silentTotalS, 1.5, 1e-9) && near(m.startS, 0.5, 1e-9) && near(m.unanchS, 0.5, 1e-9) && near(sum, 4.5, 1e-9),
    'meter buckets: rendering 1.5 + quiet 0.5 + silent 1.5 + starting 0.5 + unanchored 0.5 = 4.5 s metered', { okS: m.okS, quietS: m.quietS, silentTotalS: m.silentTotalS, startS: m.startS, unanchS: m.unanchS });
  ok(near(m.silentS, 0.5, 1e-9) && !m.flagged, 'silentS is the current streak (0.5 s after the reset), total silence kept in silentTotalS', { silentS: m.silentS });
}
// ---- v1.3.3: speed set (TV report on 1.3.0: 0.25x refused, 1.05-1.2x poked a pipeline that ignores playbackRate)
{
  const store = {}, LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const a = loadAddon({ localStorage: LS }), I6 = a._internals;
  ok(JSON.stringify(I6.V2B_SPEEDS) === '[0.25,0.5,0.75,1.25,1.5,1.75,2]' && I6.ENGINE_MIN === 0.25, 'v2b speeds 0.25-2 (0.25 new), engine minimum 0.25', { speeds: I6.V2B_SPEEDS, min: I6.ENGINE_MIN });
  ok(JSON.stringify(a.v2b().speeds) === JSON.stringify(I6.V2B_SPEEDS), 'status().v2b.speeds lists them');
  const el = { src: 'https://d1m7jfoe9zdc1j.cloudfront.net/x/360p30/index-dvr.m3u8', currentSrc: '' };
  I6.cfg.v2b = 'auto'; I6.cfg.mode = 'auto';
  ok(I6.nativeRate(el, 1.15) === 1.15 && I6.nativeRate(el, 1.5) === 1.5, 'rate cap unknown: native element gets the requested speed (measured as before)');
  I6.capPut('native', { v: 'ignored', sp: [1.5], ratio: 0.996 });
  ok(I6.nativeRate(el, 1.15) === 1 && I6.nativeRate(el, 1.2) === 1 && I6.nativeRate(el, 3) === 1, 'native known to ignore playbackRate: speeds v2b cannot take keep the element at 1.0');
  // 1.3.5 (TV report: native at 0.25-2x froze after restores / quality changes, crawled in clips): v2b speeds are held too
  ok(I6.nativeRate(el, 0.25) === 1 && I6.nativeRate(el, 2) === 1 && I6.nativeRate(el, 1.5) === 1 && I6.nativeRate(el, 1) === 1, '1.3.5: v2b speeds are held at 1.0 on the native element too (v2b sets its own rate)');
  I6.cfg.v2b = 'off';
  ok(I6.nativeRate(el, 1.5) === 1, 'v2b off + native ignored: 1.5x also held at 1.0');
  I6.cfg.v2b = 'auto'; I6.cfg.rateGate = false;
  ok(I6.nativeRate(el, 1.15) === 1.15, 'STTV_SPEED_RATEGATE=off: no hold');
  I6.cfg.rateGate = true;
  // onSetSpeed on a known-ignored native element: no poke, event rate_hold, element stays at 1.0
  const writes = [];
  const vid = { src: el.src, currentSrc: el.src, paused: false, readyState: 4, currentTime: 100, addEventListener() {}, removeEventListener() {},
    get playbackRate() { return 1; }, set playbackRate(x) { writes.push(x); }, get defaultPlaybackRate() { return 1; }, set defaultPlaybackRate(x) { writes.push('d' + x); } };
  I6.applyNative(vid, I6.nativeRate(vid, 1.15));
  ok(writes.length === 0, 'applyNative(nativeRate(1.15)) on an ignoring pipeline writes nothing (rate already 1.0)', writes);
}
// ---- v1.3.3: the bridge's own setPlaybackSpeed writes video.playbackRate before our hook -> a held speed reaches it as 1
{
  const store = {}, LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const writes = [], got = [];
  const vid = { id: 'sttv_main', src: 'https://d1m7jfoe9zdc1j.cloudfront.net/x/360p30/index-dvr.m3u8', paused: false, readyState: 4, currentTime: 100, _r: 1,
    addEventListener() {}, removeEventListener() {}, get currentSrc() { return this.src; },
    get playbackRate() { return this._r; }, set playbackRate(x) { writes.push(x); this._r = x; }, get defaultPlaybackRate() { return 1; }, set defaultPlaybackRate(x) { writes.push('d' + x); } };
  const Android = { setPlaybackSpeed(sp) { got.push(sp); vid.playbackRate = parseFloat(sp); }, StartAuto() {}, stopVideo() {} };
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: LS, document, Android }), I7 = a._internals;
  I7.cfg.v2b = 'auto'; I7.cfg.mode = 'auto'; I7.cfg.rateGate = true;
  I7.hook();
  ok(Android.setPlaybackSpeed.__sttvSpeedWrap === true, 'hook wraps Android.setPlaybackSpeed');
  Android.setPlaybackSpeed(1.15);
  ok(got[got.length - 1] === 1.15 && vid._r === 1.15, 'rate cap unknown: the bridge gets 1.15 (first measurement as before)', got);
  Android.setPlaybackSpeed(1); writes.length = 0;
  I7.capPut('native', { v: 'ignored', sp: [1.5], ratio: 0.996 });
  Android.setPlaybackSpeed(1.2);
  const evs = a.events(50).filter(e => e.type === 'rate_hold');
  ok(got[got.length - 1] === 1 && vid._r === 1 && writes.every(x => x === 1 || x === 'd1'), 'native known to ignore the rate: the bridge is called with 1, the element never sees 1.2', { got, writes });
  ok(evs.length >= 1 && evs[evs.length - 1].data.speed === 1.2 && a._ctl.speed === 1.2, 'rate_hold event, engine keeps the user speed 1.2 (status/toast)', evs.map(e => e.data));
  ok(I7.bridgeRate(2) === 1 && I7.bridgeRate(0.25) === 1, '1.3.5: v2b speeds reach the bridge as 1 too (the native element never runs at them)');
  I7.v2b.state = 'active'; I7.v2b.v = vid;
  ok(I7.bridgeRate(2) === 2, 'v2b owns the element: the bridge write passes (the hook shims playbackRate)');
  I7.v2b.state = 'idle'; I7.v2b.v = null;
  const errs = a.events(80).filter(e => e.type === 'hook_error');
  ok(errs.length === 0, 'no hook errors', errs.map(e => e.data));
}
// ---- v1.3.4: app-visible position hold (a v2b switch / restore re-attaches the element: currentTime reads 0)
{
  const store = {}, LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const vid = { id: 'sttv_main', src: 'https://d1m7jfoe9zdc1j.cloudfront.net/x/360p30/index-dvr.m3u8', paused: false, readyState: 4, currentTime: 0, playbackRate: 1,
    defaultPlaybackRate: 1, addEventListener() {}, removeEventListener() {}, get currentSrc() { return this.src; } };
  const T = { last: null, Play_ShowVideoStatus(sl, wc, s) { T.last = JSON.parse(s); } };
  const Android = { setPlaybackSpeed() {}, StartAuto() {}, stopVideo() {}, gettime() { return Math.floor(vid.currentTime * 1000); }, mseekTo(x) { vid.currentTime = x / 1000; } };
  Android.getsavedtime = Android.gettime;
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: LS, document, Android, smartTwitchTV: T }), I8 = a._internals;
  I8.cfg.mode = 'auto';
  I8.hook(); I8.hookApp();
  ok(Android.gettime.__sttvSpeedWrap && Android.getsavedtime.__sttvSpeedWrap && Android.mseekTo.__sttvSpeedWrap && T.Play_ShowVideoStatus.__sttvSpeedWrap,
    'hook wraps gettime / getsavedtime / mseekTo and the app export Play_ShowVideoStatus');
  Android.StartAuto('https://usher.ttvnw.net/vod/2915888911.m3u8', master, 2, 0, 0);
  const status = pos => { T.Play_ShowVideoStatus(false, 1, JSON.stringify(['', '', 0, 0, '', '', '', 0, 3600000, pos])); return T.last[9]; };
  vid.currentTime = 0; I8.v2bHold(812.4, 'switch');
  ok(Android.gettime() === 812400 && Android.getsavedtime() === 812400 && status(0) === 812400, 'element reads 0 while attaching -> app sees the switch position (gettime, getsavedtime, progress bar)');
  vid.currentTime = 812.45;
  ok(Android.gettime() === 812450 && I8.v2b.hold === null, 'element back at the position -> raw time, hold released');
  vid.currentTime = 0;
  ok(Android.gettime() === 0 && status(0) === 0, 'no hold -> the bridge value passes through unchanged');
  I8.v2bHold(500, 'restore'); Android.mseekTo(10000);
  ok(I8.v2b.hold === null && Android.gettime() === 10000, 'a user seek (mseekTo) drops the hold');
  I8.v2bHold(500, 'restore'); vid.currentTime = 0; Android.stopVideo();
  ok(I8.v2b.hold === null && Android.gettime() === 0, 'stopVideo drops the hold');
  Android.StartAuto('https://usher.ttvnw.net/api/channel/hls/x.m3u8', master, 1, 0, 0);
  I8.v2bHold(100, 'switch');
  ok(I8.v2b.hold === null, 'live streams are never held (bridge reports a seekable-window position there)');
  const errs = a.events(80).filter(e => e.type === 'hook_error');
  ok(errs.length === 0 && a.events(80).some(e => e.type === 'v2b_hold'), 'v2b_hold event logged, no hook errors', errs.map(e => e.data));
}

// ---- v1.3.5 (TV report on Twitch NG 1.0.0 / engine 1.3.4, webOS 25)
const mkLS = () => { const store = {}; return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }; };
function FakeHls(cfg) { this.cfg = cfg; this.ev = {}; this.stops = 0; this.starts = []; this.destroyed = false; FakeHls.inst.push(this); }
FakeHls.inst = [];
FakeHls.Events = { BUFFER_CREATED: 'bc', INIT_PTS_FOUND: 'ip', FRAG_BUFFERED: 'fb', LEVEL_LOADED: 'll', ERROR: 'er', MEDIA_ATTACHED: 'ma' };
FakeHls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
FakeHls.prototype.on = function (n, f) { (this.ev[n] = this.ev[n] || []).push(f); };
FakeHls.prototype.off = function () {};
FakeHls.prototype.loadSource = function (u) { this.src = u; };
FakeHls.prototype.attachMedia = function (m) { this.media = m; };
FakeHls.prototype.detachMedia = function () { this.media = null; };
FakeHls.prototype.destroy = function () { this.destroyed = true; };
FakeHls.prototype.stopLoad = function () { this.stops++; };
FakeHls.prototype.startLoad = function (p) { this.starts.push(p); };
function v2bEnv(extra = {}) {
  const vid = { id: 'sttv_main', src: 'blob:https://localhost/abc', currentTime: 1500, paused: false, seeking: false, ended: false, readyState: 4, _r: 1,
    buffered: { length: 1, start: () => 1490, end: () => 1530 }, duration: 53591,
    addEventListener() {}, removeEventListener() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    get currentSrc() { return this.src; }, get playbackRate() { return this._r; }, set playbackRate(x) { this._r = x; }, defaultPlaybackRate: 1 };
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: mkLS(), document, HTMLMediaElement: class {}, Element: class {}, addEventListener() {}, removeEventListener() {}, ...extra });
  const I = a._internals, b = I.v2b;
  a._ctl.stream = { u: 'https://usher.ttvnw.net/vod/1.m3u8', pl: master, t: 2, key: 'vod:1' };
  b.Hls = FakeHls; b.state = 'active'; b.mode = 'takeover'; b.v = vid; b.key = 'vod:1'; b.speed = 2; b.gen = 5;
  b.hls = new FakeHls({}); b.activeAt = performance.now() - 120000; b.seekAt = performance.now() - 200000; b.switchAt = performance.now() - 125000; b.lastKick = 0;
  b.orig = { src: vid.src, ct: 1000 };
  b.master = I.parseMaster(master, 'https://usher.ttvnw.net/vod/1.m3u8');
  const ch = b.master.find(x => x.video === 'chunked');
  b.variant = { h: 1080, bw: ch.bw, video: 'chunked', from: 'element' };
  return { a, I, b, vid };
}
{
  // toast with several arguments
  const a = loadAddon({ localStorage: mkLS() }), I = a._internals;
  I.toast('v2b_down', ['2×', '720p60']);
  const t = a.events(5).filter(e => e.type === 'toast').pop();
  ok(t && t.data === 'Speed 2× · network too slow, quality 720p60', 'toast fills every %s from an argument array', t && t.data);
}
{
  // clips: rate held + honest toast; a clip at a rate the TV does not apply goes back to 1.0 and files the cap
  const writes = [];
  const vid = { id: 'sttv_main', src: 'https://production.assets.clips.twitchcdn.net/x.mp4', paused: false, readyState: 4, currentTime: 10, _r: 1,
    addEventListener() {}, removeEventListener() {}, get currentSrc() { return this.src; },
    get playbackRate() { return this._r; }, set playbackRate(x) { writes.push(x); this._r = x; }, get defaultPlaybackRate() { return 1; }, set defaultPlaybackRate(x) {} };
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: mkLS(), document }), I = a._internals;
  I.cfg.mode = 'auto'; I.cfg.v2b = 'auto';
  a._ctl.stream = { u: vid.src, pl: '', t: 3, key: 'u:clip|3' };
  I.capPut('native', { v: 'ignored', sp: [1.5], ratio: 0.996 });
  I.onSetSpeed(2);
  const tc = a.events(20).filter(e => e.type === 'toast');
  ok(vid._r === 1 && writes.every(x => x === 1) && tc.some(e => /clips/.test(e.data)), '1.3.5: clip at 2x on a pipeline known to ignore the rate: element stays 1.0, toast "cannot change the speed of clips"', { writes, toasts: tc.map(e => e.data) });
  // fresh TV (no cap yet): the clip gets 2x, the passive meter sees ~1.0x -> back to 1.0, cap filed, toast
  const a2 = loadAddon({ localStorage: mkLS(), document }), I2 = a2._internals;
  I2.cfg.mode = 'auto';
  a2._ctl.stream = { u: vid.src, pl: '', t: 3, key: 'u:clip|3' }; a2._ctl.speed = 2; vid._r = 2;
  a2._ctl.passive = { ratio: 1.04, elementRate: 2, at: performance.now() };
  I2.clipRateCheck(vid);
  const cap = I2.capGet('native');
  ok(vid._r === 1 && cap && cap.v === 'ignored' && a2.events(20).some(e => e.type === 'clip_rate_bad') && a2.events(20).some(e => e.type === 'toast' && /clips/.test(e.data)),
    '1.3.5: clip measured at 1.04x while 2x requested -> element back to 1.0, rate cap native=ignored, toast', { rate: vid._r, cap });
  a2._ctl.stream.t = 2; vid._r = 2; a2._ctl.passive = { ratio: 1.0, elementRate: 2, at: performance.now() };
  I2.clipRateCheck(vid);
  ok(vid._r === 2, 'clipRateCheck leaves VODs alone (the engine pre-flight measures those)');
}
{
  // audio_silent: PCM silence (content) -> event only; graph silence -> toast
  const run = (pcmDb, outDb) => {
    const a = loadAddon({ localStorage: mkLS() }), E = a._internals.Engine.prototype;
    const f = { ctx: { currentTime: 0 }, meter: null, anch: true, anchorTw: -10, renderNote: true, v: {}, guard: { active: false }, lastCt: 12.5,
      fade: { gain: { value: 1 } }, vol: { gain: { value: 1 } },
      am: { pcmSq: 0, pcmN: 0, pcmDb: null, outDb: null, peakDb: null, at: 0, ctxT: 0, clock: null, cls: '', silentS: 0, okS: 0, flagged: '', quietS: 0, silentTotalS: 0, startS: 0, unanchS: 0 } };
    let tw = 1; E._meter.call(f, tw);
    for (let i = 0; i < 8; i++) { const amp = Math.pow(10, pcmDb / 20); f.am.pcmSq = amp * amp * 100; f.am.pcmN = 100; f.am.outDb = outDb; tw += 0.5; f.ctx.currentTime += 0.5; E._meter.call(f, tw); }
    return a.events(30);
  };
  const p = run(-120, -120), g = run(-20, -120);
  const ps = p.find(e => e.type === 'audio_silent'), gs = g.find(e => e.type === 'audio_silent');
  ok(ps && ps.data.cause === 'pcm_silent' && ps.data.ct === 12.5 && !p.some(e => e.type === 'toast'), '1.3.5: pcm_silent (content silence) -> audio_silent event with ct, no toast', ps && ps.data);
  ok(gs && gs.data.cause === 'graph_silent' && g.some(e => e.type === 'toast'), 'graph_silent (PCM present, output silent) still toasts', gs && gs.data);
}
{
  // 1.3.6 (TV 2026-11-05, 0.75x): a silent intro (pcm_silent 2.5 s) then speech whose first window is still silent at the
  // output (PCM metered at scheduling, ~0.6 s ahead) -> must not be called graph_silent / toast "gain" / mark the context
  const seq = list => {
    const a = loadAddon({ localStorage: mkLS() }), I = a._internals, E = I.Engine.prototype;
    const f = { ctx: { currentTime: 0 }, meter: null, anch: true, anchorTw: -10, renderNote: true, v: {}, guard: { active: false }, lastCt: 40,
      fade: { gain: { value: 1 } }, vol: { gain: { value: 1 } },
      am: { pcmSq: 0, pcmN: 0, pcmDb: null, outDb: null, peakDb: null, at: 0, ctxT: 0, clock: null, cls: '', silentS: 0, okS: 0, flagged: '', quietS: 0, silentTotalS: 0, startS: 0, unanchS: 0 } };
    let tw = 1; E._meter.call(f, tw);
    for (const [pcmDb, outDb] of list) { const amp = Math.pow(10, pcmDb / 20); f.am.pcmSq = amp * amp * 100; f.am.pcmN = 100; f.am.outDb = outDb; tw += 0.5; f.ctx.currentTime += 0.5; E._meter.call(f, tw); }
    return { ev: a.events(40), am: f.am };
  };
  const S = [-120, -120], G = [-27.3, -120], R = [-25, -24];
  const t1 = seq([S, S, S, S, S, G, R, R, R]);
  const s1 = t1.ev.filter(e => e.type === 'audio_silent');
  ok(s1.length === 1 && s1[0].data.cause === 'pcm_silent' && !t1.ev.some(e => e.type === 'toast') && t1.am.flagged === 'pcm_silent',
    '1.3.6: silent intro (2.5 s) + one graph-silent window at the speech onset -> pcm_silent, no "gain" toast', s1.map(e => e.data));
  const t2 = seq([S, S, S, S, S, G, G, G, G, G, G, G]);
  const s2 = t2.ev.filter(e => e.type === 'audio_silent');
  ok(s2.length === 2 && s2[0].data.cause === 'pcm_silent' && s2[1].data.cause === 'graph_silent' && t2.ev.some(e => e.type === 'toast') && t2.am.flagged === 'graph_silent',
    '1.3.6: silent intro, then the output stays silent with PCM present for 3 s -> graph_silent + toast', s2.map(e => e.data.cause));
  const t3 = seq([G, G, G, R, G, G, G, R, G, G, R]);
  ok(!t3.ev.some(e => e.type === 'audio_silent' || e.type === 'toast'), '1.3.6: short graph-silent runs (1.5 s) between rendering windows -> nothing (0.25x TV pattern)', t3.ev.filter(e => e.type === 'audio_silent').map(e => e.data));
}
{
  // variant step-down at 2x (TV report T8: chunked 6.5 Mbit/s x 2 on a ~12 Mbit/s link)
  const { a, I, b, vid } = v2bEnv();
  b.bwEst = 12e6; b.bwN = 6;
  const old = b.hls; FakeHls.inst.length = 0;
  I.v2bHlsError({ details: 'bufferStalledError' });
  const sd = a.events(30).find(e => e.type === 'v2b_step_down'), nh = FakeHls.inst[0];
  ok(sd && sd.data.from === '1080p' && sd.data.to === '720p60' && old.destroyed && nh && /\/720p60\//.test(nh.src) && b.state === 'engaging' && b.stalls.length === 0,
    '1.3.5: counted stall at 2x, link 12 Mbit/s < 13 needed -> step down chunked -> 720p60 (3.0 x 2 x 1.25 <= 12), new pipeline at the same speed', sd && sd.data);
  ok(nh && nh.cfg.startPosition === 1500 && b.speed === 2 && b.downCap && b.downCap.bps === Math.round(b.variant.bw * 2) && b.stepDowns === 1,
    'step-down keeps position and speed, remembers the bandwidth cap for this VOD', { start: nh && nh.cfg.startPosition, cap: b.downCap });
  ok(a.events(30).some(e => e.type === 'toast' && /network too slow, quality 720p60/.test(e.data)), 'toast: "Speed 2× · network too slow, quality 720p60"');
  ok(b.failures === 0 && !a.events(30).some(e => e.type === 'v2b_fail'), 'no fallback to 1x');
  // a stall with lots of headroom is a hiccup: counted, no step-down
  b.state = 'active'; b.hls = new FakeHls({}); b.activeAt = performance.now() - 60000; b.bwEst = 60e6;
  const n0 = b.stepDowns; I.v2bHlsError({ details: 'bufferStalledError' });
  ok(b.stepDowns === n0 && b.stalls.length === 1, 'stall with 60 Mbit/s measured (need 6 at 720p60 x 2): counted as before, no step-down', { stalls: b.stalls.length });
  // unknown bandwidth -> one step down; then 3 per VOD at most, then the fuse as before
  b.bwN = 0; b.variant = { h: 720, bw: b.master.find(x => x.video === '720p60').bw, video: '720p60' };
  ok(I.v2bStepDown('stall') && /\/720p30\//.test(b.plUrl), 'bandwidth unknown -> next lower variant (720p60 -> 720p30)', b.plUrl.split('/').slice(-2)[0]);
  b.state = 'active'; b.hls = new FakeHls({});
  ok(I.v2bStepDown('stall') && /\/480p30\//.test(b.plUrl), 'second step 720p30 -> 480p30');
  b.state = 'active'; b.hls = new FakeHls({});
  ok(!I.v2bStepDown('stall') && b.downs.n === 3, 'at most 3 step-downs per VOD (then the stalls fuse decides)', b.downs);
  // 1x-or-slower speeds never step down (stall path)
  b.downs = { key: '', n: 0 }; b.speed = 0.5; b.state = 'active'; b.hls = new FakeHls({}); b.bwEst = 1e6; b.bwN = 5; b.stalls = []; const sd0 = b.stepDowns;
  I.v2bHlsError({ details: 'bufferStalledError' });
  ok(b.stepDowns === sd0, 'stall at 0.5x: no step-down');
  // v2bPlaylist bandwidth cap: the chunked variant is not picked again at 2x after a step-down
  const vars = b.master, chv = vars.find(x => x.video === 'chunked');
  const pk = I.v2bPickVariant(vars, 0, chv, Math.floor(3034381 * 2 / 2));
  ok(pk && pk.video === '720p60', 'v2bPickVariant with a bandwidth cap (step-down memory): chunked -> 720p60', pk && pk.video);
  ok(I.v2bPickVariant(vars, 0, chv, 0) === chv, 'no cap -> the element variant as before');
  ok(I.variantName({ video: 'chunked', res: '1920x1080' }) === '1080p' && I.variantName({ video: '720p60' }) === '720p60', 'variantName: chunked -> 1080p');
}
{
  // proactive step-down before the stall: buffer < 4 s of wall-clock playback, measured link below the need
  const { a, I, b, vid } = v2bEnv();
  b.bwEst = 11e6; b.bwN = 8; vid.buffered = { length: 1, start: () => 1490, end: () => 1505 };       // 5 content-s ahead at 2x
  I.v2bNetWatch(vid); ok(b.lowSince > 0 && b.stepDowns === 0, 'low buffer noticed, not acted on at once');
  b.lowSince = performance.now() - 6000; I.v2bNetWatch(vid);
  const sd = a.events(20).find(e => e.type === 'v2b_step_down');
  ok(sd && sd.data.why === 'low_buffer' && sd.data.to === '720p60', '1.3.5: 5 s of draining buffer with 11 Mbit/s < 13 needed -> step-down before any stall', sd && sd.data);
  // a stalled element with nothing arriving for 10 s gets a kick
  b.state = 'active'; b.hls = new FakeHls({}); b.activeAt = performance.now() - 60000; b.netAt = performance.now() - 11000; b.lastKick = 0; vid.readyState = 2; vid.buffered = { length: 0 };
  I.v2bNetWatch(vid);
  ok(b.hls.stops === 1 && b.hls.starts.length === 1 && a.events(20).some(e => e.type === 'v2b_kick' && e.data.why === 'stall_idle'), 'stalled + 10 s without bytes -> kick (stopLoad + startLoad)');
}
{
  // the bridge's stall reload while v2b plays is absorbed (TV report T10) - 3 per minute, then the old release path
  const { a, I, b } = v2bEnv();
  const h = b.hls;
  ok(I.v2bAbsorbLoad() && I.v2bAbsorbLoad() && I.v2bAbsorbLoad(), 'three bridge mv.load() in a minute are absorbed');
  ok(h.stops === 3 && h.starts.length === 3 && h.starts[0] === 1500 && b.state === 'active', 'each = hls.stopLoad + startLoad(content position), v2b stays active', { stops: h.stops, starts: h.starts });
  ok(!I.v2bAbsorbLoad() && a.events(20).some(e => e.type === 'v2b_absorb_budget'), 'the 4th falls back to the release path');
}
{
  // engaging timeout follows the download progress
  const { a, I, b } = v2bEnv();
  const t = performance.now();
  b.state = 'engaging'; b.switchAt = t - 9000; b.netAt = 0; b.kicked = false; b.frags = 0;
  I.v2bEngageWatch();
  ok(b.kicked && b.hls.stops === 1 && b.state === 'engaging', '8 s into a switch with no bytes for 6 s -> one kick');
  b.switchAt = t - 20000; b.netAt = t - 2000; I.v2bEngageWatch();
  ok(b.state === 'engaging' && b.failures === 0, '20 s but bytes 2 s ago (slow link) -> still engaging (1.3.4 failed at 15 s)');
  b.switchAt = t - 16000; b.netAt = t - 11000; I.v2bEngageWatch();
  ok(b.failures === 1 && a.events(30).some(e => e.type === 'v2b_engage_timeout'), '16 s with 11 s of silence -> timeout', a.events(30).filter(e => e.type === 'v2b_engage_timeout').map(e => e.data));
  const e2 = v2bEnv(), b2 = e2.b;
  b2.state = 'engaging'; b2.switchAt = performance.now() - 41000; b2.netAt = performance.now() - 500; b2.kicked = true;
  e2.I.v2bEngageWatch();
  ok(b2.failures === 1, 'hard limit 40 s even with bytes arriving');
}
{
  // fatal hls.js network errors -> startLoad again while the outage lasts (<= 90 s per episode), manifest errors still fail
  const { a, I, b } = v2bEnv();
  const fatal = d => I.v2bHlsError({ fatal: true, type: 'networkError', details: d });
  fatal('fragLoadError'); fatal('levelLoadTimeOut'); fatal('fragLoadError'); fatal('fragLoadError');
  ok(b.netRecovers === 4 && b.failures === 0 && b.state === 'active', '4 fatal network errors in one outage -> 4 recoveries, no fallback (1.3.4 restored native offline)');
  const delays = a.events(20).filter(e => e.type === 'v2b_net_recover').map(e => e.data.delayMs).join();
  ok(delays === '2000,4000,6000,8000', 'startLoad again after 2-8 s', delays);
  b.netEp.t0 -= 91000; fatal('fragLoadError');
  ok(b.failures === 1 && a.events(10).some(e => e.type === 'v2b_net_giveup'), 'more than 90 s into the outage -> v2b_fail');
  const e3 = v2bEnv(), f3 = d => e3.I.v2bHlsError({ fatal: true, type: 'networkError', details: d });
  f3('fragLoadError'); e3.b.netEp.t0 -= 95000; e3.b.netAt = performance.now() + 1; f3('fragLoadError');
  ok(e3.b.failures === 0 && e3.b.netEp.n === 1, 'bytes arrived since the last error -> a new episode, no fallback');
  const e2 = v2bEnv(); e2.I.v2bHlsError({ fatal: true, type: 'networkError', details: 'manifestLoadError' });
  ok(e2.b.failures === 1, 'manifest load error -> fail at once');
}
{
  // engine failure on the network in v2b -> 2 new engines before the fallback
  const { a, I, b, vid } = v2bEnv();
  const e = { v: vid, key: 'vod:1', pipe: 'v2b' };
  I.onEngineFail(e, 'source:timeout'); I.onEngineFail(e, 'net');
  ok(b.engineRetries === 2 && b.failures === 0, '1.3.5: engine source:timeout / net in v2b -> retried twice', a.events(20).filter(e => e.type === 'v2b_engine_retry').map(e => e.data));
  I.onEngineFail(e, 'source:timeout');
  ok(b.failures === 1 && a.events(30).some(x => x.type === 'v2b_fail' && x.data === 'engine:source:timeout'), 'third -> v2b_fail engine:source:timeout');
  const e2 = v2bEnv(); e2.I.onEngineFail({ v: e2.vid, key: 'vod:1', pipe: 'v2b' }, 'decode');
  ok(e2.b.failures === 1, 'non-network engine failure -> fail at once');
}
{
  // restore watchdog: stuck after 3.5 s -> rate 1 + seek + play; after 8 s -> native source loaded once more
  const { a, I, b, vid } = v2bEnv();
  b.state = 'idle'; b.hls = null; vid.paused = false; vid._r = 2; vid.currentTime = 1500;
  const r = { pos: 1500, at: performance.now(), play: true, src: vid.src, attempt: 1 };
  I.v2bRestoreWatch(vid, r);
  await new Promise(res => setTimeout(res, 4300));
  const st1 = a.events(30).find(e => e.type === 'v2b_restore_stuck');
  ok(st1 && st1.data.step === 1 && vid._r === 1 && Math.abs(vid.currentTime - 1500.05) < 1e-6, '1.3.5: restored element frozen 3.5 s -> rate 1, seek to the position, play', st1 && st1.data);
  let srcSet = 0; const s0 = vid.src; Object.defineProperty(vid, 'src', { configurable: true, get() { return s0; }, set(x) { srcSet++; } });
  await new Promise(res => setTimeout(res, 4500));
  const st2 = a.events(40).filter(e => e.type === 'v2b_restore_stuck').pop();
  ok(st2 && st2.data.step === 2 && srcSet === 1 && b.restoring && b.restoring.attempt === 2 && b.restoreNudges === 2, 'still frozen at 8 s -> one more native load (attempt 2, shielded)', st2 && st2.data);
  // a restore that plays: ok event, no nudges
  const e2 = v2bEnv(); e2.b.state = 'idle'; e2.b.hls = null; e2.vid.currentTime = 800;
  e2.I.v2bRestoreWatch(e2.vid, { pos: 800, at: performance.now(), play: true, src: e2.vid.src, attempt: 1 });
  setTimeout(() => { e2.vid.currentTime = 801; }, 600);
  await new Promise(res => setTimeout(res, 1300));
  ok(e2.a.events(20).some(e => e.type === 'v2b_restore_ok') && e2.b.restoreNudges === 0, 'restore that plays -> v2b_restore_ok, no nudge');
  // the user paused -> not stuck
  const e3 = v2bEnv(); e3.b.state = 'idle'; e3.b.hls = null; e3.vid.paused = true;
  const r3 = { pos: 800, at: performance.now(), play: true, src: e3.vid.src, attempt: 1 };
  e3.a._ctl.userPauseAt = performance.now() + 1;
  e3.I.v2bRestoreWatch(e3.vid, r3);
  await new Promise(res => setTimeout(res, 4000));
  ok(e3.b.restoreNudges === 0, 'paused by the user (Android.PlayPause(false)) -> no nudge');
}
{
  // audio segments: v2b rides out 45 s of network trouble, native gives up after 4 tries as before
  const mkX = () => { function X() { this.status = 0; this.response = null; } X.prototype.open = function () {}; X.prototype.setRequestHeader = function () {};
    X.prototype.send = function () { const s = this; setTimeout(() => s.onerror && s.onerror(), 1); }; return X; };
  for (const pipe of ['v2b', 'native']) {
    const a = loadAddon({ localStorage: mkLS(), XMLHttpRequest: mkX() }), I = a._internals;
    let failed = null; const eng = { pipe, fail(r) { failed = r; }, kick() {}, info: {} };
    const src = new I.HlsSource(eng), sg = { i: 7, uri: 'https://localhost/a/7.ts', range: null, st: 0 };
    for (let k = 0; k < 5; k++) { src._fetch(sg); await new Promise(res => setTimeout(res, 15)); }
    const f1 = failed; sg.err0 = performance.now() - 46000; src._fetch(sg); await new Promise(res => setTimeout(res, 15));
    if (pipe === 'v2b') ok(f1 === null && failed === 'net', '1.3.5: v2b audio segment errors: no engine failure for 45 s (5 errors), then net', { tries: sg.tries, failed });
    else ok(f1 === 'net', 'native pipe: engine fails after 4 tries as before', { tries: sg.tries });
    ok(sg.retryAt - performance.now() <= 8000, 'segment retry backoff capped at 8 s (' + pipe + ')');
  }
}
{
  // audio playlist: one retry on timeout, then the 5 min cache (ENDLIST playlists)
  let n = 0;
  function X() { this.status = 0; this.response = null; }
  X.prototype.open = function () {}; X.prototype.setRequestHeader = function () {};
  X.prototype.send = function () { const s = this; n++; setTimeout(() => { if (n === 1) s.ontimeout(); else { s.status = 200; s.response = '#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n'; s.onload(); } }, 1); };
  const a = loadAddon({ localStorage: mkLS(), XMLHttpRequest: X }), I = a._internals;
  const u = 'https://localhost/audio_only/index-dvr.m3u8';
  const t1 = await I.plText(u, { dead: false });
  ok(/#EXTINF/.test(t1) && n === 2 && a.events(10).some(e => e.type === 'playlist_retry'), '1.3.5: playlist timeout -> one retry (TV report T7 engine:source:timeout)', { requests: n });
  const t2 = await I.plText(u, { dead: false });
  ok(t2 === t1 && n === 2, 'second open within 5 min comes from the cache (every v2b engagement = a new engine)');
}
// ---- v1.3.7 (TV run 2026-11-05, pre-release 03, T7 at 2x): OK on the quality button = Android.RestartPlayer (the bridge's
// setMain with the resume point), the app re-selects its quality from Play_getQualities ~10-70 ms later ->
// Android.SetQuality reads the resume point from video.currentTime = 0 (element reloading) -> the VOD restarted from 00:00
{
  const LS = {}, U = 'https://d1m7jfoe9zdc1j.cloudfront.net/x/', USH = 'https://usher.ttvnw.net/vod/2915888911.m3u8';
  const vid = { id: 'sttv_main', src: '', paused: false, readyState: 0, seeking: false, _ct: 0, sets: [], playbackRate: 1, defaultPlaybackRate: 1,
    get currentSrc() { return this.src; }, get currentTime() { return this._ct; }, set currentTime(x) { this._ct = +x; this.sets.push(+x); },
    addEventListener(t, f) { (LS[t] = LS[t] || []).push(f); }, removeEventListener(t, f) { LS[t] = (LS[t] || []).filter(g => g !== f); },
    load() { this._ct = 0; this.readyState = 0; }, play() { return { catch() {} }; } };
  const fire = t => (LS[t] || []).slice().forEach(f => f.call(vid, { type: t }));
  // the real bridge (webosCompatBridge.js): setMain keeps rs as the resume point (applied on loadedmetadata),
  // SetQuality overwrites it with video.currentTime unless the target already is the current source
  const ms = { type: 1, resume: 0, rawUri: '', q: [U + '720p60/index-dvr.m3u8', U + '480p30/index-dvr.m3u8'] };
  const setMain = (u, t, rs) => { ms.type = t || 1; ms.rawUri = u; ms.resume = rs > 0 ? rs : 0; vid.src = u; vid.load(); };
  const meta = () => { vid.readyState = 4; if (ms.resume > 0 && ms.type === 2) vid.currentTime = ms.resume / 1000; fire('loadedmetadata'); };
  const Android = { setPlaybackSpeed() {}, stopVideo() {}, gettime() { return Math.floor(vid.currentTime * 1000); }, mseekTo(x) { vid.currentTime = x / 1000; },
    StartAuto(u, pl, t, rs) { setMain(u, t, rs); },
    RestartPlayer(t, rs, player) { if (!(player > 0)) setMain(ms.rawUri, t || ms.type, rs); },
    SetQuality(pos) { const tg = ms.q[pos]; if (tg === vid.src) return; ms.resume = ms.type === 2 ? Math.floor(vid.currentTime * 1000) : 0; vid.src = tg; vid.load(); } };
  Android.getsavedtime = Android.gettime;
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: mkLS(), document, Android }), I9 = a._internals;
  I9.cfg.mode = 'auto';
  I9.hook();
  ok(Android.RestartPlayer.__sttvSpeedWrap && Android.SetQuality.__sttvSpeedWrap, '1.3.7: hook wraps Android.RestartPlayer / SetQuality');
  Android.StartAuto(USH, master, 2, 0, 0); meta();
  vid._ct = 1427.2; I9.posSample(vid);
  // TV sequence (pre03, 07:13:32): RestartPlayer(2, 1427216, 0) -> SetQuality(2) 68 ms later (element at 0) -> loadedmetadata
  Android.RestartPlayer(2, Android.gettime(), 0); Android.SetQuality(1); meta();
  const qr = a.events(40).filter(e => e.type === 'quality_resume');
  ok(near(vid.currentTime, 1427.2, 0.1) && near(Android.gettime(), 1427200, 100), '1.3.7: RestartPlayer + SetQuality while reloading -> the VOD keeps its position (not 00:00)', { ct: vid.currentTime, sets: vid.sets });
  ok(qr.length === 1 && near(qr[0].data.pos, 1427.2, 0.1) && qr[0].data.from === 'restart', '1.3.7: quality_resume event with the RestartPlayer position', qr.map(e => e.data));
  // the user picks another quality 2 s later while the element plays at the position: the bridge reads it itself
  vid._ct = 1431.5; vid.sets.length = 0; Android.SetQuality(0); meta();
  ok(near(vid.currentTime, 1431.5, 0.1) && a.events(40).filter(e => e.type === 'quality_resume').length === 1, '1.3.7: SetQuality at a real position -> bridge resume, no guard', { ct: vid.currentTime, sets: vid.sets });
  // v2b handed the element back (src reset, reads 0) without a RestartPlayer: the last sampled position is used
  vid._ct = 1500.4; I9.posSample(vid); a._ctl.mainRestart = null;
  vid.src = 'blob:x'; vid.load(); Android.SetQuality(1); meta();
  ok(near(vid.currentTime, 1500.4, 0.1), '1.3.7: SetQuality right after the element was reset (no RestartPlayer) -> last sampled position', { ct: vid.currentTime });
  // a user seek to the start is not undone: mseekTo drops the remembered positions
  Android.mseekTo(0); vid.readyState = 4; Android.SetQuality(0); meta();
  ok(vid.currentTime === 0, '1.3.7: mseekTo(0) then SetQuality -> stays at 0 (user seek respected)', { ct: vid.currentTime });
  // live streams: never touched
  Android.StartAuto('https://usher.ttvnw.net/api/channel/hls/x.m3u8', master, 1, 0, 0); meta(); vid._ct = 50; I9.posSample(vid);
  Android.RestartPlayer(1, 50000, 0); Android.SetQuality(1); meta();
  ok(vid.currentTime === 0 && a.events(60).filter(e => e.type === 'quality_resume').length === 2, '1.3.7: live (type 1) -> no guard', { ct: vid.currentTime });
  // kill switch: mode off = upstream behaviour
  Android.StartAuto(USH, master, 2, 0, 0); meta(); vid._ct = 900; I9.posSample(vid); I9.cfg.mode = 'off';
  Android.RestartPlayer(2, 900000, 0); Android.SetQuality(0); meta();
  ok(vid.currentTime === 0, '1.3.7: STTV_SPEED_MODE=off -> upstream behaviour (no guard)', { ct: vid.currentTime });
  I9.cfg.mode = 'auto';
  const errs = a.events(120).filter(e => e.type === 'hook_error');
  ok(errs.length === 0, '1.3.7: no hook errors', errs.map(e => e.data));
}
// ---- v1.3.8 (tests/app/leak.mjs, 20 speed cycles): the v2b segment cache (up to 24 MB) outlived the player
{
  const pend = [];
  function X() { this.status = 0; this.response = null; }
  X.prototype.open = function (m, u) { this.u = u; }; X.prototype.setRequestHeader = function () {};
  X.prototype.send = function () { pend.push(this); };
  const done = (x, n) => { x.status = 200; x.response = new ArrayBuffer(n); x.onload(); };
  const LS = {}, vid = { id: 'sttv_main', src: '', paused: false, readyState: 4, seeking: false, currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1,
    get currentSrc() { return this.src; }, addEventListener(t, f) { (LS[t] = LS[t] || []).push(f); }, removeEventListener() {}, load() {}, play() { return { catch() {} }; } };
  const Android = { setPlaybackSpeed() {}, stopVideo() {}, StartAuto(u) { vid.src = u; }, gettime() { return 0; } };
  const document = { getElementById: id => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({ localStorage: mkLS(), XMLHttpRequest: X, document, Android }), I = a._internals, C = I.segCache;
  I.cfg.mode = 'auto'; I.hook();
  const V1 = 'https://usher.ttvnw.net/vod/2915888911.m3u8', V2 = 'https://usher.ttvnw.net/vod/2915888912.m3u8', seg = n => 'https://localhost/v/' + n + '.ts';
  Android.StartAuto(V1, master, 2, 0, 0);
  const p1 = I.segFetch(seg(1), null, 5000), p2 = I.segFetch(seg(2), null, 5000);
  done(pend.shift(), 1000); await p1;
  ok(C.order.length === 1 && C.bytes === 1000, 'v2b segment cache: a downloaded segment is kept while the VOD plays', { n: C.order.length, bytes: C.bytes });
  Android.stopVideo();
  ok(C.order.length === 0 && C.bytes === 0 && Object.keys(C.map).length === 0, '1.3.8: stopVideo empties the segment cache (it kept up to 24 MB after the player closed)', { n: C.order.length, bytes: C.bytes });
  done(pend.shift(), 2000); await p2;
  ok(C.order.length === 0, '1.3.8: a download that finishes after stopVideo is not cached', { n: C.order.length });
  Android.StartAuto(V1, master, 2, 0, 0);
  const p3 = I.segFetch(seg(3), null, 5000); done(pend.shift(), 500); await p3;
  Android.StartAuto(V1, master, 2, 60000, 0);
  ok(C.order.length === 1, 'same VOD started again (resume point) keeps the cache', { n: C.order.length });
  Android.StartAuto(V2, master, 2, 0, 0);
  ok(C.order.length === 0 && C.bytes === 0, '1.3.8: another VOD empties the cache', { n: C.order.length });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL UNIT TESTS PASSED');
process.exit(fails ? 1 : 0);
