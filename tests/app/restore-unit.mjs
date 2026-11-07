// tests/app/restore-unit.mjs - unit test suite for Roadmap Item 13 (Smooth VOD Restore without stalls)
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

function makeEnv(initialCt = 1500) {
  const writes = { rates: [], seeks: [], plays: 0 };
  let _ct = initialCt;
  const vid = {
    id: 'sttv_main',
    src: 'https://usher.ttvnw.net/vod/1.m3u8',
    get currentSrc() { return this.src; },
    get currentTime() { return _ct; },
    set currentTime(x) { writes.seeks.push(x); _ct = x; },
    _advance(x) { _ct = x; },
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    _r: 1,
    get playbackRate() { return this._r; },
    set playbackRate(x) { writes.rates.push(x); this._r = x; },
    play() { writes.plays++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  const document = { getElementById: (id) => (id === 'sttv_main' ? vid : null), body: null };
  const a = loadAddon({
    localStorage: mkLS(),
    document,
    HTMLMediaElement: class {},
    Element: class {},
    addEventListener() {},
    removeEventListener() {}
  });
  const I = a._internals;
  const b = I.v2b;
  b.state = 'idle';
  b.mode = 'takeover';
  b.v = vid;
  b.gen = 1;
  b.restoreNudges = 0;
  return { a, I, b, vid, writes };
}

console.log('Testing Roadmap Item 13: Smooth VOD Restore (Engine 1.3.9)');

// Test 1: Keyframe start before p0 (e.g. p0=1500, starts at 1499.5, advances to 1499.7)
// Must trigger v2b_restore_ok by movement without waiting for ct > p0 + 0.3 and without in-segment seeks
{
  const { a, I, b, vid, writes } = makeEnv(1499.5);
  const r = { pos: 1500, at: performance.now(), play: true, src: vid.src, attempt: 1 };
  I.v2bRestoreWatch(vid, r);

  // simulate playback advancing within keyframe segment (1499.5 -> 1499.75)
  setTimeout(() => { vid._advance(1499.75); }, 500);

  await new Promise((res) => setTimeout(res, 1200));
  const okEv = a.events(20).find((e) => e.type === 'v2b_restore_ok');
  ok(okEv && b.restoreNudges === 0 && writes.seeks.length === 0,
    'Restore with keyframe start (ct < p0) advancing forward -> v2b_restore_ok, 0 nudges, 0 in-segment seeks',
    { ev: okEv && okEv.data, seeks: writes.seeks });
}

// Test 2: Decoder frozen at readyState=4 with no forward progress
// Should nudge at ~1.6s (earlier than 3.5s) without seeking within the segment
{
  const { a, I, b, vid, writes } = makeEnv(1500.0);
  const r = { pos: 1500, at: performance.now(), play: true, src: vid.src, attempt: 1 };
  I.v2bRestoreWatch(vid, r);

  // Do not advance currentTime, element remains stuck at 1500.0 with readyState=4
  await new Promise((res) => setTimeout(res, 2200));
  const stuckEv = a.events(20).find((e) => e.type === 'v2b_restore_stuck');
  ok(stuckEv && stuckEv.data.step === 1 && b.restoreNudges === 1,
    'Frozen decoder with readyState=4 gets early nudge at ~1.6s',
    stuckEv && stuckEv.data);
  ok(!writes.seeks.some((s) => Math.abs(s - 1500.05) < 0.001),
    'Early nudge does NOT seek to p0 + 0.05 inside segment (prevents pipeline re-freeze)',
    { seeks: writes.seeks });
}

// Test 3: Severe position drift (> 4s off from p0)
// If decoder started at 1480s (20s off), the nudge should correct to p0
{
  const { a, I, b, vid, writes } = makeEnv(1480.0);
  const r = { pos: 1500, at: performance.now(), play: true, src: vid.src, attempt: 1 };
  I.v2bRestoreWatch(vid, r);

  await new Promise((res) => setTimeout(res, 2200));
  ok(writes.seeks.some((s) => Math.abs(s - 1500) < 0.1),
    'Severe drift (> 4s off from p0) applies seek to target position on nudge',
    { seeks: writes.seeks });
}

// Test 4: User paused during restore -> aborts watchdog gracefully without nudges
{
  const { a, I, b, vid } = makeEnv(1500.0);
  const r = { pos: 1500, at: performance.now(), play: true, src: vid.src, attempt: 1 };
  a._ctl.userPauseAt = performance.now() + 10;
  I.v2bRestoreWatch(vid, r);

  await new Promise((res) => setTimeout(res, 2200));
  const stuckEv = a.events(20).find((e) => e.type === 'v2b_restore_stuck');
  ok(!stuckEv && b.restoreNudges === 0,
    'User pause during restore -> watchdog cancels gracefully without nudges');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL RESTORE UNIT CHECKS PASSED');
process.exit(fails ? 1 : 0);
