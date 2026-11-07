#!/usr/bin/env node
/**
 * tools/tv-capture-suite.mjs
 * Direct TV screenshot capture suite via Chrome DevTools Protocol (CDP).
 * Captures all 10 documented screens in 1920x1080 directly from the running app on LG OLED TV ($TV_HOST).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOST = process.env.TV_HOST;
const PORT = '9998';
const LANG = process.argv[2] || 'ru'; // 'ru' or 'en'
const OUT_DIR = path.resolve(process.argv[3] || `docs/screenshots/${LANG}`);

if (!HOST) {
  console.error('No TV address: export TV_HOST=<TV_IP> (see tv.env.example)');
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
  const tgt = list.find((t) => t.type === 'page' && /com\.twitchng\.tv/.test(t.url || ''));
  if (!tgt) throw new Error('Twitch NG page not found in DevTools targets');
  return `ws://${HOST}:${PORT}/devtools/page/${tgt.id}`;
}

async function connect() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) {
      pend.get(d.id)(d);
      pend.delete(d.id);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('WS connection error: ' + e));
  });

  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pend.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) return { error: r.error.message };
    if (r.result && r.result.exceptionDetails) {
      return { error: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    }
    return r.result && r.result.result ? r.result.result.value : r;
  };

  const KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461, esc: 27 };
  const press = async (k) => {
    const code = KEYS[k] || +k;
    const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: k === 'enter' ? 'Enter' : String(k) };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const key = async (k, n = 1, ms = 450) => {
    for (let i = 0; i < n; i++) {
      await press(k);
      await sleep(ms);
    }
  };

  const capture = async (name) => {
    console.log(`[${new Date().toISOString()}] Capturing: ${name}...`);
    // Full HD 1920x1080 screenshot
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const rawPng = Buffer.from(r.result.data, 'base64');
    const tmpPng = path.join('/tmp', `tv-${LANG}-${name}.png`);
    const outJpg = path.join(OUT_DIR, `${name}.jpg`);
    fs.writeFileSync(tmpPng, rawPng);
    // Convert to JPEG with quality 92 via macOS sips
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', tmpPng, '--out', outJpg], { stdio: 'pipe' });
    const sz = fs.statSync(outJpg).size;
    console.log(`[${new Date().toISOString()}] Saved ${outJpg} (${Math.round(sz / 1024)} KB)`);
  };

  return { ws, send, ev, press, key, capture };
}

async function run() {
  console.log(`=== Starting TV Capture Suite for LANG: ${LANG} ===`);
  const c = await connect();

  // Helper to ensure clean home grid state
  const resetToHome = async () => {
    for (let i = 0; i < 4; i++) {
      await c.key('back');
      await sleep(300);
    }
    await c.ev("document.getElementById('side_panel_new_3') && document.getElementById('side_panel_new_3').click()");
    await sleep(2500);
  };

  try {
    await resetToHome();

    // 1. HOME SCREEN
    console.log('--- Screen 1: home ---');
    await c.ev("document.getElementById('side_panel_new_3').click()");
    await sleep(3000);
    await c.capture('home');

    // 2. SIDE DRAWER
    console.log('--- Screen 2: side ---');
    // Press back from grid to open side drawer
    await c.key('back');
    await sleep(800);
    // Ensure drawer is open or press left
    const isOpen = await c.ev("document.getElementById('side_panel_movel').style.transform.includes('translateX(5%)')");
    if (!isOpen) {
      await c.key('left');
      await sleep(800);
    }
    await c.capture('side');

    // 3. CATEGORIES / GAMES
    console.log('--- Screen 3: games ---');
    await resetToHome();
    await c.ev("document.getElementById('side_panel_new_4').click()");
    await sleep(3500);
    await c.capture('games');

    // 4. GAME STREAMS
    console.log('--- Screen 4: game-streams ---');
    // Select first game in grid
    await c.key('down');
    await sleep(500);
    await c.key('enter');
    await sleep(4000);
    await c.capture('game-streams');

    // 5. CLIPS
    console.log('--- Screen 5: clips ---');
    // In game screen, press up to reach switch bar (Videos / Clips / Follow)
    await c.key('up');
    await sleep(800);
    // Find clip button in switch bar and click it
    const clipFound = await c.ev(`(() => {
      const items = Array.from(document.querySelectorAll('.stream_thumbnail_channel_vod'));
      const clip = items.find(e => /клип|clip/i.test(e.innerText));
      if (clip) { clip.click(); return clip.innerText.trim(); }
      return null;
    })()`);
    console.log('Switching to clips:', clipFound);
    await sleep(4000);
    await c.capture('clips');

    // 6. VIDEOS (VODs)
    console.log('--- Screen 6: videos ---');
    await resetToHome();
    await c.ev("document.getElementById('side_panel_new_5').click()");
    await sleep(3500);
    await c.capture('videos');

    // 7. SEARCH CHANNELS
    console.log('--- Screen 7: search-channels ---');
    await resetToHome();
    await c.ev("document.getElementById('side_panel_new_1').click()");
    await sleep(2000);
    await c.ev(`(() => {
      const i = document.getElementById('search_input');
      if (i) {
        i.value = 'minecraft';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await sleep(800);
    await c.key('down');
    await sleep(500);
    await c.key('enter');
    await sleep(3500);
    await c.capture('search-channels');
    await c.key('back');
    await sleep(500);
    await c.key('back');
    await sleep(500);

    // 8. SETTINGS
    console.log('--- Screen 8: settings ---');
    await resetToHome();
    await c.ev("document.getElementById('side_panel_movel_new_10') && document.getElementById('side_panel_movel_new_10').click()");
    await sleep(2000);
    await c.key('down', 2);
    await sleep(800);
    await c.capture('settings');
    await c.key('back');
    await sleep(1000);

    // 9. WHAT'S NEW (NEWS)
    console.log('--- Screen 9: news ---');
    await resetToHome();
    await c.ev("document.getElementById('side_panel_movel_new_14') && document.getElementById('side_panel_movel_new_14').click()");
    await sleep(2000);
    await c.capture('news');
    await c.key('back');
    await sleep(1000);

    // 10. PLAYER (Live stream with full OSD)
    console.log('--- Screen 10: player ---');
    await resetToHome();
    // Select first stream card
    await c.key('right');
    await sleep(600);
    await c.key('enter');
    // Wait for video and stream to start
    await sleep(4500);
    // Bring up OSD
    await c.key('up');
    await sleep(700);
    await c.capture('player');
    // Stop playback
    await c.key('back');
    await sleep(1500);

    console.log(`=== Done capturing all 10 screens for LANG: ${LANG} ===`);
  } finally {
    c.ws.close();
  }
}

run().catch((e) => {
  console.error('Fatal error in tv-capture-suite:', e);
  process.exit(1);
});
