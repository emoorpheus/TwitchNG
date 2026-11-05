// mse-hook fixes, Node unit tests with a mocked MediaSource: original PR code (2c4af3c) vs fixed.
// node tests/msehook/unit.mjs
import { split, timescales, shiftFrag } from './mp4util.mjs';
const ORIG = new URL('./speed-orig/', import.meta.url).pathname, FIXED = new URL('./speed-fixed/', import.meta.url).pathname;
const D = new URL('./media/', import.meta.url).pathname;
const tick = () => new Promise((r) => setTimeout(r, 0));
const results = {};

function makeWin() {
  const native = { appends: 0, quotaNext: false };
  class SourceBuffer extends EventTarget {
    constructor(mime) { super(); this.mime = mime; this.data = []; this._to = 0; }
    appendBuffer(d) {
      native.appends++;
      if (native.quotaNext) { native.quotaNext = false; const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      this.data.push(new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));
    }
    remove() {}
    get timestampOffset() { return this._to; } set timestampOffset(v) { this._to = v; }
    get appendWindowStart() { return 0; } set appendWindowStart(v) {}
    get appendWindowEnd() { return Infinity; } set appendWindowEnd(v) {}
    get buffered() { return { length: 0, start() { return 0; }, end() { return 0; } }; }
  }
  class MediaSource extends EventTarget {
    constructor() { super(); this._sbs = []; this._d = NaN; }
    addSourceBuffer(m) { const sb = new SourceBuffer(m); this._sbs.push(sb); return sb; }
    removeSourceBuffer(sb) {   // like Chrome: a non-SourceBuffer is a TypeError
      if (!(sb instanceof SourceBuffer)) throw new TypeError("Failed to execute 'removeSourceBuffer' on 'MediaSource': parameter 1 is not of type 'SourceBuffer'.");
      this._sbs.splice(this._sbs.indexOf(sb), 1);
    }
    get sourceBuffers() { const a = this._sbs.slice(), l = { length: a.length, item: (i) => a[i] }; a.forEach((x, i) => (l[i] = x)); return l; }
    get duration() { return this._d; } set duration(v) { this._d = v; }
  }
  return { native, win: { MediaSource, URL: { createObjectURL: () => 'blob:x' }, HTMLMediaElement: { prototype: {} }, EventTarget, Event } };
}
function makeSink() {
  const s = { stored: [], calls: [], configure(c) { s.calls.push('configure'); s.cfg = c; },
    push(ch) { s.calls.push('push'); for (const c of ch) s.stored.push([c.pts, c.pts + c.duration, s.cfg && s.cfg.sampleRate]); },
    discard(a, b) { s.calls.push('discard'); s.stored = s.stored.filter(([x, y]) => !(y > a && x < b)); },
    reset() { s.calls.push('reset'); s.stored = []; },
    destroy() { s.calls.push('destroy'); s.destroyed = true; s.stored = []; } };
  return s;
}
const ranges = (b) => Array.from({ length: b.length }, (_, i) => [+b.start(i).toFixed(3), +b.end(i).toFixed(3)]);
// seconds listed in `buffered` that the sink can no longer play
function phantom(sb, sink) {
  let miss = 0;
  for (const [a, b] of ranges(sb.buffered)) for (let t = a + 0.01; t < b; t += 0.02) if (!sink.stored.some(([x, y]) => t >= x && t < y)) miss += 0.02;
  return +miss.toFixed(2);
}

async function suite(tag, dir) {
  const hookMod = await import(dir + 'mse-hook.js'), cont = await import(dir + 'containers.js');
  const r = (results[tag] = {});
  // 1. timescale rewrite of a muxed A/V init (ffmpeg: video 15360, audio 48000, movie 1000)
  const mux = split(D + 'muxed.mp4');
  r.muxed_init_x1_5 = timescales(cont.rewriteInitTimescale(mux.init, 1.5).data);
  const tw = split(D + 'a48.mp4');   // single-track init (what hls.js generates per track)
  r.single_init_x1_5 = timescales(cont.rewriteInitTimescale(tw.init, 1.5).data);

  // 2. FakeAudioSourceBuffer: changeType keeps buffered coherent with the sink
  const { win, native } = makeWin();
  const sinks = [], errors = [];
  const hook = hookMod.installMseHook(win, { getSpeed: () => 1.5, createAudioSink: () => { const s = makeSink(); sinks.push(s); return s; },
    onRateRequest() {}, onError: (e) => errors.push(e.message), onNativeAudio() {} });
  const ms = new win.MediaSource();
  const vsb = ms.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');
  const asb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const sink = sinks[0];
  const A = (u8) => { asb.appendBuffer(u8); return tick(); };
  const at = (k) => (r[k] = { buffered: ranges(asb.buffered), sinkStoredS: +sink.stored.reduce((s, [a, b]) => s + b - a, 0).toFixed(2), phantomS: phantom(asb, sink) });
  await A(tw.init); for (let i = 0; i < 3; i++) await A(shiftFrag(tw.init, tw.frags[i], 1000));
  at('after_3_frags');
  asb.changeType('audio/mp4; codecs="mp4a.40.2"');
  at('after_changeType');
  await A(tw.init); await A(shiftFrag(tw.init, tw.frags[3], 1000));
  at('after_same_init_again');
  // media appended after changeType() before any init (allowed to happen with players that only re-send the init when it changes)
  asb.changeType('audio/mp4; codecs="mp4a.40.2"');
  await A(shiftFrag(tw.init, tw.frags[4], 1000));
  at('media_without_new_init');
  const e0 = errors.length; let n = 0;
  while (n < 400 && errors.length === e0) { await A(shiftFrag(tw.init, tw.frags[5], 1000)); n++; }
  r.media_without_init_x400 = { appends: n, errors: errors.slice(e0) };
  // real codec change (48 kHz stereo -> 44.1 kHz mono) after changeType
  const m44 = split(D + 'a44m.mp4');
  asb.changeType('audio/mp4; codecs="mp4a.40.2"');
  await A(m44.init); await A(shiftFrag(m44.init, m44.frags[0], 1006));
  r.after_codec_change = { buffered: ranges(asb.buffered), sinkRates: [...new Set(sink.stored.map((x) => x[2]))], resets: sink.calls.filter((c) => c === 'reset').length, phantomS: phantom(asb, sink) };

  // 3. native append errors of the video buffer
  await (vsb.appendBuffer(mux.init), tick());   // any init: rewritten
  const before = native.appends, eBefore = errors.length; let thrown = null;
  native.quotaNext = true;
  try { vsb.appendBuffer(mux.frags[0]); } catch (e) { thrown = e.name; }
  r.video_quota = { nativeAppendCalls: native.appends - before, thrownToPlayer: thrown, reportedAsSpeedFailure: errors.slice(eBefore) };

  // 4. removeSourceBuffer(fake) as hls.js does on detach / recoverMediaError
  let rm = null; try { ms.removeSourceBuffer(asb); rm = 'ok'; } catch (e) { rm = e.name + ': ' + e.message.slice(0, 60); }
  r.removeSourceBuffer_fake = { result: rm, sinkDestroyed: !!sink.destroyed, sourceBuffersLength: ms.sourceBuffers.length };

  // 5. muxed A/V SourceBuffer (hls.js 'audiovideo')
  const ms2 = new win.MediaSource(), e2 = errors.length;
  const avsb = ms2.addSourceBuffer('video/mp4; codecs="avc1.42c01e,mp4a.40.2"');
  avsb.appendBuffer(mux.init); await tick();
  r.muxed_sourcebuffer = { appendedInit: timescales(avsb.data[avsb.data.length - 1]), errors: errors.slice(e2) };
  hook.uninstall();
}
await suite('orig', ORIG);
await suite('fixed', FIXED);
console.log(JSON.stringify(results, null, 1));
