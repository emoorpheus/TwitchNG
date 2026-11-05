#!/usr/bin/env node
// Twitch NG on the TV over DevTools (CDP, port 9998): NG UI screens and checks for CODEX_TV_TEST.md T18 / T19.
// Runs on your machine (Node 22+: fetch + WebSocket built in). Reads only: keys, JS in the page, screenshots. Never writes on the TV.
//   TV_HOST=<TV_IP> node tools/tv-lab.mjs screens <outDir> [--screens home,focus,side,games,game-streams,switch,videos,clips,search2,news,exit,about,settings]
//        [--fmt webp|png|jpeg] [--q 80] [--scale 0.5]    -> <outDir>/<screen>.<fmt> + <screen>.json (checks), summary.json
//   TV_HOST=<TV_IP> node tools/tv-lab.mjs probe [name]  -> the same checks for the current screen, printed
//   TV_HOST=<TV_IP> node tools/tv-lab.mjs go "<menu item regex>" [--lo 10]  -> open a side menu item (e.g. "^(videos|видео)$"), then wait 2.5 s
// Checks per screen: NgUi.state(), html.ng-ui, fonts (document.fonts, family of every visible text), text cut by its clipping box or by the
// screen bottom, old strings of the classic look, badges / durations / NG icons, the focused element and the room around it (focus ring).
// focus: 10 x right, then 10 x down on the live grid; every press: did the focus move, is it fully on screen; frame gaps (rAF) and long tasks.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2), pos = argv.filter((a, i) => !a.startsWith('--') && !(i && argv[i - 1].startsWith('--')));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const HOST = opt('host', process.env.TV_HOST), PORT = opt('port', '9998'), CMD = pos[0] || 'probe';
if (!HOST) { console.error('No TV address: --host <TV_IP> or export TV_HOST=<TV_IP> (see tv.env.example)'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
const tgt = list.find((t) => t.type === 'page' && /com\.twitchng\.tv/.test(t.url || ''));
if (!tgt) { console.error('Twitch NG page not found in DevTools targets (is the app running?)'); process.exit(3); }
const ws = new WebSocket(`ws://${HOST}:${PORT}/devtools/page/${tgt.id}`);
let seq = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.error) return { error: r.error.message };
  if (r.result.exceptionDetails) return { error: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
  return r.result.result.value;
};
const KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461 };
const press = async (k) => { const code = KEYS[k], base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: k === 'enter' ? 'Enter' : k };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }); };
const key = async (k, n = 1, ms = 650) => { for (let i = 0; i < n; i++) { await press(k); await sleep(ms); } await sleep(700); };

// ---- checks in the page (Chromium 120) ----
const PROBE = String.raw`(() => {
  const vh = innerHeight, vw = innerWidth, R = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  // shown = rendered, not transparent (own or ancestor opacity 0), on screen and not covered (elementFromPoint at a visible point)
  const shown = (e) => { if (!e || !e.getClientRects().length) return false; const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden') return false; const r = e.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw)) return false;
    for (let a = e; a && a !== document.documentElement; a = a.parentElement) if (+getComputedStyle(a).opacity === 0) return false;
    // #scene_keys: the app's transparent full-screen key layer (z-index 200) is above everything: skip it
    const x = Math.min(Math.max((r.left + r.right) / 2, 1), vw - 2), y = Math.min(Math.max((r.top + Math.min(r.bottom, vh)) / 2, 1), vh - 2);
    const c = document.elementsFromPoint(x, y).find((h) => h.id !== 'scene_keys');
    return !!c && (e.contains(c) || c.contains(e)); };
  const clipAnc = (e) => { for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a); if (/hidden|clip|auto|scroll/.test(cs.overflowY)) return a; } return null; };
  const fam = {}, notNg = [], cut = [], cutScreen = [], old = [], sample = [];
  const OLD = /\bPlaying\b|Стрим по |^Уже \d|Зрел|посл\. обновление|Просмотров|\d Зрители|Транслировал|Запустил/;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n, texts = 0;
  while ((n = tw.nextNode())) {
    const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (!t) continue; const el = n.parentElement; if (!shown(el)) continue;
    texts++; const k = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fam[k] = (fam[k] || 0) + 1;
    if (!/^NG Sans$/i.test(k) && notNg.length < 12) notNg.push(k + ' | ' + t.slice(0, 50));
    if (OLD.test(t) && old.length < 12) old.push(t.slice(0, 70));
    if (sample.length < 60) sample.push(t.slice(0, 60));
    const r = el.getBoundingClientRect(), a = clipAnc(el);
    if (a) { const ar = a.getBoundingClientRect();
      if (r.top < ar.bottom - 2 && r.bottom > ar.bottom + 2 && cut.length < 12) cut.push({ t: t.slice(0, 40), el: R(r), clip: R(ar), by: String(a.id || a.className || a.tagName).slice(0, 50) }); }
    if (r.top < vh - 2 && r.bottom > vh + 2 && cutScreen.length < 12) cutScreen.push({ t: t.slice(0, 40), el: R(r) });
  }
  const focusSel = '[class*="stream_thumbnail_focused"], .side_panel_new_icons_text, .side_panel_new_icons_text_botton, [class*="focus"]';
  const foc = [...document.querySelectorAll(focusSel)].filter(shown).slice(0, 4).map((e) => { const r = e.getBoundingClientRect(), a = clipAnc(e), ar = a ? a.getBoundingClientRect() : null;
    const cs = getComputedStyle(e);
    return { id: e.id, cls: String(e.className).slice(0, 80), rect: R(r), room: ar ? [Math.round(r.left - ar.left), Math.round(r.top - ar.top), Math.round(ar.right - r.right), Math.round(ar.bottom - r.bottom)] : null,
      screenRoom: [Math.round(r.left), Math.round(r.top), Math.round(vw - r.right), Math.round(vh - r.bottom)], shadow: cs.boxShadow.slice(0, 60), outline: cs.outlineStyle + ' ' + cs.outlineWidth }; });
  const cnt = (s) => [...document.querySelectorAll(s)].filter(shown).length;
  const fonts = [...document.fonts].filter((f) => /NG Sans|Roboto/i.test(f.family)).map((f) => f.family.replace(/"/g, '') + ' ' + f.weight + ' ' + f.status);
  const width = (font, txt) => { const e = document.createElement('span'); e.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + font;
    e.textContent = txt; document.body.appendChild(e); const w = e.getBoundingClientRect().width; e.remove(); return Math.round(w * 10) / 10; };
  const TXT = 'Перейдите на другом устройстве: Watch live 0123 ёЁйЙ';
  const ic = [...document.querySelectorAll('[class*="ng-i-"], .ng-ico, [class*="ng-icon"]')].filter(shown);
  const icMask = ic.filter((e) => { const b = getComputedStyle(e, '::before'), s = getComputedStyle(e);
    return [b.webkitMaskImage, b.maskImage, s.webkitMaskImage, s.maskImage, b.backgroundImage].some((v) => v && v !== 'none'); }).length;
  return { url: location.hash, vw, vh, dpr: devicePixelRatio, html: document.documentElement.className.slice(0, 80), ng: window.NgUi && NgUi.state ? NgUi.state() : null,
    tw: window.TwitchNG && TwitchNG.state ? TwitchNG.state().ui : null, bodyBg: getComputedStyle(document.body).backgroundColor,
    fontsCheck: { ng400: document.fonts.check('400 16px "NG Sans"', TXT), ng700: document.fonts.check('700 16px "NG Sans"', TXT) }, fonts,
    widths: { ng400: width('400 40px "NG Sans"', TXT), roboto: width('400 40px Roboto', TXT), robotoBold: width('400 40px Roboto-Bold', TXT), ng700: width('700 40px "NG Sans"', TXT), serif: width('400 40px serif', TXT) },
    texts, fam, notNg, old, cut, cutScreen, focus: foc,
    counts: { ngLive: cnt('.ng-live'), badge: cnt('.ng-badge'), dur: cnt('.ng-dur'), up: cnt('.ng-up'), when: cnt('.ng-when'), seen: cnt('.ng-seen'), icons: ic.length, iconsMasked: icMask, imgs: cnt('img') },
    sample };
})()`;
const FRAMES_ON = `(() => { const run = window.__ngRun = (window.__ngRun || 0) + 1; window.__ngF = []; window.__ngLT = []; window.__ngT0 = performance.now(); let last = __ngT0;
  const f = (t) => { if (run !== window.__ngRun) return; __ngF.push(t - last); last = t; if (__ngF.length < 6000) requestAnimationFrame(f); }; requestAnimationFrame(f);  // one loop per run: off() ends it
  try { window.__ngPO = new PerformanceObserver((l) => l.getEntries().forEach((e) => __ngLT.push(Math.round(e.duration)))); __ngPO.observe({ entryTypes: ['longtask'] }); } catch (e) {} return 1; })()`;
const FRAMES_OFF = `(() => { const a = (window.__ngF || []).slice(1), s = a.slice().sort((x, y) => x - y), q = (p) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
  try { __ngPO.disconnect(); } catch (e) {} window.__ngRun = (window.__ngRun || 0) + 1; const ms = performance.now() - (window.__ngT0 || 0);
  return { frames: a.length, ms: Math.round(ms), fps: Math.round(a.length / ms * 10000) / 10, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(Math.max(0, ...a)), over50: a.filter((x) => x > 50).length, over100: a.filter((x) => x > 100).length, longTasks: (window.__ngLT || []).length, longMax: Math.max(0, ...(window.__ngLT || [])) }; })()`;
const FOCUSED = `(() => { const e = [...document.querySelectorAll('[class*="stream_thumbnail_focused"]')].find((x) => x.getClientRects().length && x.getBoundingClientRect().width > 1);
  if (!e) return null; const r = e.getBoundingClientRect();
  return { id: e.id, r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], on: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`;

const FMT = opt('fmt', 'webp'), Q = +opt('q', '80'), SCALE = +opt('scale', '0.5');  // the TV page is 1920x1080 CSS px at devicePixelRatio 2: 0.5 -> 1920x1080 file
const OUT = CMD === 'screens' ? pos[1] : null; if (OUT) fs.mkdirSync(OUT, { recursive: true });
const summary = {};
async function shot(name) {
  const p = { format: FMT }; if (FMT !== 'png') p.quality = Q;
  { const vp = await ev('[innerWidth, innerHeight]'); p.clip = { x: 0, y: 0, width: vp[0], height: vp[1], scale: SCALE }; }
  const r = await send('Page.captureScreenshot', p);
  if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name + '.' + (FMT === 'jpeg' ? 'jpg' : FMT)), Buffer.from(r.result.data, 'base64'));
  const pr = await ev(PROBE); fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(pr, null, 1));
  summary[name] = pr && !pr.error ? { ngOn: pr.ng && pr.ng.on, html: /ng-ui/.test(pr.html), fontsOk: pr.fontsCheck.ng400 && pr.fontsCheck.ng700, fam: pr.fam, notNg: pr.notNg.length,
    old: pr.old, cut: pr.cut.length, cutScreen: pr.cutScreen.length, focus: pr.focus.map((f) => f.id + ' room ' + JSON.stringify(f.room) + ' scr ' + JSON.stringify(f.screenRoom)), counts: pr.counts } : pr;
  console.log(new Date().toISOString(), 'shot', name, JSON.stringify(summary[name]).slice(0, 600));
}
const side = () => ev(`(() => { const m = document.getElementById('side_panel_movel'); let f = null;
  for (let i = 0; i < 15; i++) { const e = document.getElementById('side_panel_movel_new_' + i);
    if (e && (e.classList.contains('side_panel_new_icons_text') || e.classList.contains('side_panel_new_icons_text_botton'))) f = { i: i, text: e.innerText.trim() }; }
  return { open: !!m && m.style.transform.indexOf('translateX(5%)') >= 0, f: f }; })()`);
async function sideGo(re, lo = 0, hi = 15, enter = true) {
  for (let n = 0; n < 3 && !(await side()).open; n++) await key('back');
  const t = await ev(`(() => { const r = new RegExp(${JSON.stringify(re.source)}, 'i'); for (let i = ${lo}; i < ${hi}; i++) { const e = document.getElementById('side_panel_movel_new_' + i); if (e && r.test(e.innerText.trim())) return i; } return -1; })()`);
  for (let n = 0; n < 16 && t >= 0; n++) { const s = await side(); if (!s.open || !s.f) break;
    if (s.f.i === t) { if (enter) await key('enter'); return s.f; }
    await press(s.f.i < t ? 'down' : 'up'); await sleep(450); }
  console.log('sideGo failed', re.source, t, JSON.stringify(await side())); return null;
}

if (CMD === 'probe') { const pr = await ev(PROBE); console.log(JSON.stringify(pr, null, 1)); process.exit(0); }
if (CMD === 'eval') { console.log(JSON.stringify(await ev(pos[1]), null, 1)); process.exit(0); }
if (CMD === 'go') { const f = await sideGo(new RegExp(pos[1] || '^(live|в эфире)$', 'i'), +opt('lo', '0'), +opt('hi', '15')); await sleep(+opt('wait', '2500'));  // side menu item by its text
  console.log(JSON.stringify({ item: f, ng: await ev('window.NgUi && NgUi.state().on') })); process.exit(f ? 0 : 1); }
if (CMD !== 'screens') { console.error('commands: screens <outDir> | probe | eval "<js>" | go "<menu item regex>" [--lo 10]'); process.exit(2); }
const SCREENS = opt('screens', 'home,focus,side,games,game-streams,switch,videos,clips,search2,news,exit,about,settings').split(',');
const has = (s) => SCREENS.includes(s);
console.log(new Date().toISOString(), 'start', JSON.stringify(await ev('({ hidden: document.hidden, ng: window.NgUi && NgUi.state(), side: !!document.getElementById("side_panel_movel") })')));
// start from the live grid: close the menu if it is open, then go to "live"
if (has('home')) { await sideGo(/^(live|в эфире)$/); await sleep(2500); await shot('home'); }
if (has('focus')) {
  const steps = []; await ev(FRAMES_ON);
  for (const [k, n] of [['right', 10], ['down', 10]]) for (let i = 0; i < n; i++) { const b = await ev(FOCUSED); await press(k); await sleep(400); const a = await ev(FOCUSED);
    steps.push({ k, moved: !!(a && b && a.id !== b.id), on: a && a.on, id: a && a.id, r: a && a.r }); }
  await sleep(600); const fr = await ev(FRAMES_OFF); await shot('focus-after-20');
  summary.focusRun = { moved: steps.filter((s) => s.moved).length, offScreen: steps.filter((s) => !s.on).length, frames: fr, steps };
  fs.writeFileSync(path.join(OUT, 'focus-run.json'), JSON.stringify(summary.focusRun, null, 1));
  console.log(new Date().toISOString(), 'focus', JSON.stringify({ moved: summary.focusRun.moved, offScreen: summary.focusRun.offScreen, frames: fr }));
  await key('up', 10, 300); await key('left', 10, 300);
}
if (has('side')) { for (let n = 0; n < 3 && !(await side()).open; n++) await key('back');  // left x10 on the first column may already have opened it
  summary.sideOpen = (await side()).open; await sleep(800); await shot('side'); }
if (has('games')) { await sideGo(/^(games|категории)$/); await sleep(3500); await shot('games');
  if (has('game-streams')) { await key('down'); await key('enter'); await sleep(3500); await shot('game-streams'); } }
if (has('switch')) { await key('up'); await sleep(800); await shot('switch'); }
if (has('videos')) { await sideGo(/^(videos|видео)$/); await sleep(3500); await shot('videos'); }
if (has('clips')) { await sideGo(/^(clips|клипы)$/); await sleep(3500); await shot('clips'); }
if (has('search2')) { await sideGo(/^(search|поиск)$/); await sleep(1500);
  await ev(`(() => { const i = document.getElementById('search_input'); if (!i) return 0; i.value = 'minecraft'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await key('down'); await key('enter'); await sleep(3500); await shot('search-channels'); await key('back'); await key('back'); }
if (has('news')) { await sideGo(/(what.s new|что нового)/, 10); await sleep(1000); await shot('news'); await key('back'); }
if (has('exit')) { await sideGo(/(exit|выход)/, 10); await sleep(600); await shot('exit'); await key('back'); }
if (has('about')) { await sideGo(/(about|описание|о приложении)/, 10); await sleep(1000); await shot('about');
  summary.aboutText = await ev(`(document.getElementById('dialog_about_text') || {}).innerText || ''`); await key('back'); }
if (has('settings')) { await sideGo(/(settings|настройки)/, 10); await sleep(1000); await key('down', 2); await shot('settings'); await key('back'); }
if (has('home')) await sideGo(/^(live|в эфире)$/);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(new Date().toISOString(), 'done');
ws.close(); process.exit(0);
