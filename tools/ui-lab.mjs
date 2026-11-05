// ui-lab.mjs - design lab for the Twitch NG UI (dev tool, not a test): runs a BUILT IPK in Chromium like tests/app/twitchng.mjs
// (webOS stubs, 1920x1080, real Twitch API), optionally injects extra CSS / JS on top (iterate without rebuilding), walks the
// main screens and saves screenshots (+ DOM dumps with --dump).
// Usage: node tools/ui-lab.mjs <twitchng.ipk> <outDir> [--css a.css[,b.css]] [--js file.js] [--screens intro,home,home2,side,side2,side3,games,videos,exit,about,settings,player] [--dump 1]
// (NG_LANG=ru_RU NG_LOCALE=ru-RU for the Russian UI)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const IPK = path.resolve(argv[0] || ''), OUT = path.resolve(argv[1] || '/tmp/ui-lab');
if (!fs.existsSync(IPK)) { console.error('usage: node tools/ui-lab.mjs <twitchng.ipk> <outDir> [--css f] [--js f] [--screens a,b] [--dump 1]'); process.exit(2); }
// --css a.css,b.css: concatenated into release/githubio/css/ui-lab.css (next to the app's twitchng.css, so url(fonts/...) resolves the
// same way as in a build); each file's sibling fonts/ dir is copied into githubio/css/fonts. --js: inlined after the app scripts.
const CSS_FILES = opt('css') ? opt('css').split(',').map((f) => path.resolve(f)) : [];
const CSS = CSS_FILES.length ? CSS_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n') : null, JS = opt('js') ? fs.readFileSync(path.resolve(opt('js')), 'utf8') : null;
const SCREENS = (opt('screens', 'home,side,games,settings,about,exit')).split(','), DUMP = opt('dump', '0') === '1';
const W = path.join(OUT, '.app');
fs.rmSync(W, { recursive: true, force: true });
for (const d of ['ar', 'root', 'stub/webos-service']) fs.mkdirSync(path.join(W, d), { recursive: true });
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const PK = path.join(W, 'root/usr/palm/packages');
const pinfo = JSON.parse(fs.readFileSync(path.join(PK, fs.readdirSync(PK)[0], 'packageinfo.json'), 'utf8'));
const ID = pinfo.app, SID = pinfo.services[0];
const APP = path.join(W, 'root/usr/palm/applications', ID), SVC = path.join(W, 'root/usr/palm/services', SID);
if (CSS) {
  const cssDir = path.join(APP, 'release/githubio/css');
  fs.writeFileSync(path.join(cssDir, 'ui-lab.css'), CSS);
  for (const f of CSS_FILES) { const fd = path.join(path.dirname(f), 'fonts');
    if (fs.existsSync(fd)) for (const n of fs.readdirSync(fd)) fs.copyFileSync(path.join(fd, n), path.join(cssDir, 'fonts', n)); }
}
fs.writeFileSync(path.join(W, 'stub/webos-service/index.js'),
  'function Service(name) { this.name = name; global.__svc = { name: name, methods: {} }; }\n' +
  'Service.prototype.register = function (m, cb) { global.__svc.methods[m] = cb; return { on: function () {} }; };\nmodule.exports = Service;\n');
process.env.NODE_PATH = path.join(W, 'stub');
createRequire(import.meta.url)('module').Module._initPaths();
createRequire(import.meta.url)(path.join(SVC, JSON.parse(fs.readFileSync(path.join(SVC, 'package.json'), 'utf8')).main));
const svc = global.__svc;
const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: process.env.NG_LOCALE || 'en-US',
  userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager' });
await ctx.exposeFunction('__luna', (uri, params) => new Promise((res) => {
  const m = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri || ''), p = (() => { try { return JSON.parse(params); } catch (e) { return {}; } })();
  if (uri === 'luna://com.webos.service.tv.systemproperty/getSystemInfo') return res(JSON.stringify({ returnValue: true, modelName: 'OLED65M59LA', firmwareVersion: '33.30.97', sdkVersion: '10.3.0' }));
  if (!m || m[1] !== SID || !svc.methods[m[2]]) return res(JSON.stringify({ returnValue: false, errorText: 'unknown ' + uri }));
  svc.methods[m[2]]({ payload: p, respond: (r) => res(JSON.stringify(r)) });
}));
await ctx.addInitScript(({ id, css, js, lang }) => {
  window.PalmSystem = { identifier: id + ' 1001', launchParams: '{}', activate() {}, platformBack() {}, stageReady() {},
    deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '33.30.97', platformVersionMajor: 33, screenWidth: 1920, screenHeight: 1080 }) };
  window.PalmServiceBridge = function () {
    const self = this;
    this.call = (uri, params) => { window.__luna(uri, params).then((r) => { if (self.onservicecallback) self.onservicecallback(r); }); };
    this.cancel = () => { self.onservicecallback = null; };
  };
  if (lang) try { localStorage.setItem('app_lang_string', lang); } catch (e) {}
  if (css || js) document.addEventListener('DOMContentLoaded', () => {
    if (!/\/release\/index\.html/.test(location.pathname)) return;
    if (css) { const l = document.createElement('link'); l.id = 'ui-lab-css'; l.rel = 'stylesheet'; l.href = 'githubio/css/ui-lab.css?' + Date.now(); document.head.appendChild(l); }
    if (js) { const s = document.createElement('script'); s.textContent = js; document.head.appendChild(s); }
  });
}, { id: ID, css: CSS, js: JS, lang: process.env.NG_LANG || null });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.TwitchNG, null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => { const d = document.getElementById('welcome_dialog'); return d && !d.classList.contains('hide'); }, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot ' + n);
  if (DUMP) fs.writeFileSync(path.join(OUT, 'dom-' + n + '.html'), (await page.content()).replace(/(src|onerror)="(data:|this\.onerror)[^"]*"/g, '$1="…"')); };
const key = async (k, n = 1, ms = 650) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await page.waitForTimeout(ms); } await page.waitForTimeout(700); };
if (SCREENS.includes('intro')) await shot('intro');
await key('Enter');
await page.waitForFunction(() => document.querySelectorAll('img').length > 6, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
if (DUMP) {
  const d = await page.evaluate(() => {
    const f = document.querySelector('[class*="stream_thumbnail_focused"], .stream_thumbnail_focused') || document.querySelector('[id^="live_thumbdiv"]');
    const card = f ? (f.closest('[id*="cell"]') || f.parentElement) : null;
    const vis = [...document.querySelectorAll('body > *')].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map((e) => e.id || e.className).slice(0, 40);
    return { card: card ? card.outerHTML.slice(0, 6000) : null, focusedClass: f ? f.className : null, top: vis };
  });
  fs.writeFileSync(path.join(OUT, 'dom-home.json'), JSON.stringify(d, null, 1));
  fs.writeFileSync(path.join(OUT, 'dom-full.html'), await page.content());
}
if (SCREENS.includes('home')) await shot('home');
if (SCREENS.includes('home2')) { await key('ArrowRight'); await shot('home2'); await key('ArrowLeft'); }
const side = () => page.evaluate(() => { const m = document.getElementById('side_panel_movel'); let f = null;
  for (let i = 0; i < 15; i++) { const e = document.getElementById('side_panel_movel_new_' + i);
    if (e && (e.classList.contains('side_panel_new_icons_text') || e.classList.contains('side_panel_new_icons_text_botton'))) f = { i: i, text: e.innerText.trim() }; }
  return { open: !!m && m.style.transform.indexOf('translateX(5%)') >= 0, f: f }; });
async function sideGo(re, lo = 0, hi = 15, enter = true) {
  for (let n = 0; n < 3 && !(await side()).open; n++) await key('Escape');
  const t = await page.evaluate(([src, lo, hi]) => { const r = new RegExp(src, 'i');
    for (let i = lo; i < hi; i++) { const e = document.getElementById('side_panel_movel_new_' + i); if (e && r.test(e.innerText)) return i; } return -1; }, [re.source, lo, hi]);
  for (let n = 0; n < 16 && t >= 0; n++) { const s = await side(); if (!s.open || !s.f) break;
    if (s.f.i === t) { if (enter) await key('Enter'); return s.f; }
    await page.keyboard.press(s.f.i < t ? 'ArrowDown' : 'ArrowUp'); await page.waitForTimeout(450); }
  return null;
}
if (SCREENS.includes('side')) { await key('Escape'); await shot('side'); await key('Escape'); }
// side2: menu open, focus moved off the current section; side3: focus in the bottom group (no Enter)
if (SCREENS.includes('side2')) { await sideGo(/^(games|категории)$/, 0, 10, false); await shot('side2'); await key('Escape'); }
if (SCREENS.includes('side3')) { await sideGo(/(settings|настройки)/, 10, 15, false); await shot('side3'); await key('Escape'); }
if (SCREENS.includes('games')) { await sideGo(/^(games|категории)$/); await page.waitForTimeout(3500); await shot('games'); await key('ArrowDown'); await key('Enter'); await page.waitForTimeout(3500); await shot('game-streams'); }
if (SCREENS.includes('videos')) { await sideGo(/^(videos|видео)$/); await page.waitForTimeout(3500); await shot('videos'); }
if (SCREENS.includes('exit')) { await sideGo(/(exit|выход)/, 10); await shot('exit'); await key('Escape'); }
if (SCREENS.includes('about')) { await sideGo(/(about|описание|о приложении)/, 10); await page.waitForTimeout(1000); await shot('about'); await key('Escape'); }
if (SCREENS.includes('settings')) { await sideGo(/(settings|настройки)/, 10); await key('ArrowDown', 2); await shot('settings'); await key('Escape'); }
if (SCREENS.includes('player')) { await sideGo(/^(live|в эфире)$/); await page.waitForTimeout(2500); await key('Enter'); await page.waitForTimeout(6000); await key('ArrowUp'); await page.waitForTimeout(800); await shot('player'); }
console.log('errors ' + JSON.stringify(errors.slice(0, 5)));
await page.close(); await browser.close();
process.exit(0);
