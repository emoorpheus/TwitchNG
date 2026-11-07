// tests/app/stepup-unit.mjs - unit test suite for Roadmap Item 11 (Quality Step-Up after DownCap)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAddon } from '../load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
function ok(cond, msg, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (!cond) fails++;
}

function mkLS() {
  const s = {};
  return {
    getItem: (k) => (k in s ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: (k) => { delete s[k]; },
    clear: () => { Object.keys(s).forEach((k) => delete s[k]); }
  };
}

function FakeHls(cfg) {
  this.cfg = cfg || {};
  this.starts = [];
  this.stops = 0;
  this.destroyed = false;
  this.ev = {};
  FakeHls.inst.push(this);
}
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

const sampleMaster = [
  { uri: 'https://test/chunked/index.m3u8', bw: 6500000, video: 'chunked', res: '1920x1080' },
  { uri: 'https://test/720p60/index.m3u8', bw: 3200000, video: '720p60', res: '1280x720' },
  { uri: 'https://test/480p30/index.m3u8', bw: 1500000, video: '480p30', res: '852x480' },
  { uri: 'https://test/audio/index.m3u8', bw: 160000, audioOnly: true }
];

function makeEnv(speed = 2, currentBw = 3200000) {
  FakeHls.inst = [];
  let _ct = 1500;
  let bufferedEnd = 1530; // 30s ahead by default
  let clock = 1000000;
  const vid = {
    id: 'sttv_main',
    src: 'blob:https://localhost/test',
    get currentSrc() { return this.src; },
    get currentTime() { return _ct; },
    set currentTime(x) { _ct = x; },
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    _r: 1,
    get playbackRate() { return this._r; },
    set playbackRate(x) { this._r = x; },
    buffered: { length: 1, start: () => _ct, end: () => bufferedEnd },
    duration: 50000,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener() {},
    removeEventListener() {}
  };
  const document = { getElementById: (id) => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({
    localStorage: mkLS(),
    document,
    performance: { now: () => clock },
    HTMLMediaElement: class {},
    Element: class {},
    addEventListener() {},
    removeEventListener() {}
  });
  const I = a._internals;
  const b = I.v2b;
  b.Hls = FakeHls;
  b.state = 'active';
  b.mode = 'takeover';
  b.v = vid;
  b.key = 'vod:test';
  b.speed = speed;
  b.gen = 1;
  b.hls = new FakeHls({});
  b.activeAt = clock - 300000;
  b.seekAt = clock - 300000;
  b.master = sampleMaster;
  b.variant = { h: 720, bw: currentBw, video: '720p60' };
  b.downCap = { key: 'vod:test', bps: currentBw * speed };
  b.downs = { key: 'vod:test', n: 1 };
  b.stepDowns = 1;
  b.bwEst = 25000000; // 25 Mbps
  b.bwN = 10;
  b.highSince = 0;
  b.lastStepAt = 0;
  return { a, I, b, vid, clock, setBufferedEnd: (x) => { bufferedEnd = x; } };
}

console.log('Testing Roadmap Item 11: Quality Step-Up (Auto-Recovery after DownCap)');

// Test 1: Low buffer suppresses step-up even with high bandwidth
{
  const { a, I, b, vid, clock, setBufferedEnd } = makeEnv(2, 3200000);
  setBufferedEnd(1505); // only 5s ahead (needs >= 10*speed = 20s)
  b.highSince = clock - 150000; // 2.5 min high
  I.v2bNetWatch(vid);
  ok(!a.events(10).some((e) => e.type === 'v2b_step_up') && b.stepDowns === 1,
    'Low buffer (< 10*S ahead) suppresses quality step-up',
    { ahead: I.v2bAhead(vid) });
}

// Test 2: Bandwidth below 1.5x required margin suppresses step-up
// Target variant is 1080p60 (6.5 Mbps). At 2x speed, needed = 6.5*2 = 13 Mbps.
// 1.5x margin = 19.5 Mbps. With 15 Mbps measured, step-up must not trigger.
{
  const { a, I, b, vid, clock } = makeEnv(2, 3200000);
  b.bwEst = 15000000; // 15 Mbps < 19.5 Mbps
  b.highSince = clock - 150000;
  I.v2bNetWatch(vid);
  ok(!a.events(10).some((e) => e.type === 'v2b_step_up'),
    'Bandwidth below 1.5x margin (< 19.5 Mbps for 1080p60 @ 2x) suppresses step-up',
    { bwEstMbps: b.bwEst / 1e6 });
}

// Test 3: High bandwidth sustained for < 120s does not step up yet
{
  const { a, I, b, vid, clock } = makeEnv(2, 3200000);
  b.bwEst = 25000000; // 25 Mbps >= 19.5 Mbps
  b.highSince = clock - 60000; // only 60s
  I.v2bNetWatch(vid);
  ok(!a.events(10).some((e) => e.type === 'v2b_step_up') && b.highSince > 0,
    'High bandwidth sustained for only 60s (< 120s) records highSince but does not step up yet');
}

// Test 4: High bandwidth sustained >= 120s with full buffer triggers step-up
{
  const { a, I, b, vid, clock } = makeEnv(2, 3200000);
  b.bwEst = 25000000; // 25 Mbps
  b.highSince = clock - 125000; // 125s
  b.lastStepAt = clock - 310000; // 5+ min ago
  const oldHls = b.hls;
  I.v2bNetWatch(vid);
  const upEv = a.events(20).find((e) => e.type === 'v2b_step_up');
  ok(upEv && upEv.data.from === '720p60' && upEv.data.to === '1080p' && oldHls.destroyed,
    'High bandwidth for 120s+ triggers v2b_step_up (720p60 -> 1080p)',
    upEv && upEv.data);
  ok(b.downCap === null,
    'Reaching highest available variant clears downCap',
    { downCap: b.downCap });
  ok(a.events(20).some((e) => e.type === 'toast' && /quality restored/i.test(e.data)),
    'Toast shown notifying user that quality was restored');
}

// Test 5: 5-minute cooldown between step operations is enforced
{
  const { a, I, b, vid, clock } = makeEnv(2, 3200000);
  b.bwEst = 25000000;
  b.highSince = clock - 150000;
  b.lastStepAt = clock - 100000; // only 100s ago (< 300s)
  I.v2bNetWatch(vid);
  ok(!a.events(10).some((e) => e.type === 'v2b_step_up'),
    '5-minute cooldown (< 300s since last step) suppresses step-up');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL STEP-UP UNIT CHECKS PASSED');
process.exit(fails ? 1 : 0);
