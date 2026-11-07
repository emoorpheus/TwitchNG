// ui-lab.mjs - design lab for the Twitch NG UI (dev tool, not a test): runs a BUILT IPK in Chromium like tests/app/twitchng.mjs
// (webOS stubs, 1920x1080, real Twitch API), optionally injects extra CSS / JS on top (iterate without rebuilding), walks the
// main screens and saves screenshots (+ DOM dumps with --dump).
// Usage: node tools/ui-lab.mjs <twitchng.ipk> <outDir> [--css a.css[,b.css]] [--js file.js] [--dump 1]
//   [--screens intro,home,home2,down,side,side2,side3,games,switch,videos,clips,featured,search,search2,user,news,exit,about,settings,player]
// [--fontsets DIR] (screen fonts) [--probe f.js] (a JS expression evaluated at every shot -> probe-<screen>.json, e.g. element boxes)
// [--pre f.js] (a JS expression evaluated before every shot);
// NG_LANG=ru_RU NG_LOCALE=ru-RU for the Russian UI
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
// --fontsets DIR: DIR/<name>/fonts.css (+ font files) re-declare 'NG Sans' / 'Roboto' / 'Roboto-Bold'; screen "fonts" shoots the
// home screen once per set (font-<name>.png), same page and data, so only the typeface changes
const FONTSETS = opt('fontsets') ? path.resolve(opt('fontsets')) : null;
const PROBE = opt('probe') ? fs.readFileSync(path.resolve(opt('probe')), 'utf8') : null;
// --pre f.js: a JS expression evaluated right before every shot (e.g. to simulate DOM states the lab cannot reach), then 0.4 s settle
const PRE = opt('pre') ? fs.readFileSync(path.resolve(opt('pre')), 'utf8') : null;
const W = path.join(OUT, '.app');
fs.rmSync(W, { recursive: true, force: true });
for (const d of ['ar', 'root', 'stub/webos-service']) fs.mkdirSync(path.join(W, d), { recursive: true });
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const PK = path.join(W, 'root/usr/palm/packages');
const pinfo = JSON.parse(fs.readFileSync(path.join(PK, fs.readdirSync(PK)[0], 'packageinfo.json'), 'utf8'));
const ID = pinfo.app, SID = pinfo.services[0];
const APP = path.join(W, 'root/usr/palm/applications', ID), SVC = path.join(W, 'root/usr/palm/services', SID);
if (FONTSETS) fs.cpSync(FONTSETS, path.join(APP, 'release/githubio/css/fontsets'), { recursive: true });
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
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--disable-web-security', '--no-sandbox'] });
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
  try { localStorage.setItem('show_feed_player', '1'); } catch (e) {}
  if (css || js) document.addEventListener('DOMContentLoaded', () => {
    if (!/\/release\/index\.html/.test(location.pathname)) return;
    if (css) { const l = document.createElement('link'); l.id = 'ui-lab-css'; l.rel = 'stylesheet'; l.href = 'githubio/css/ui-lab.css?' + Date.now(); document.head.appendChild(l); }
    if (js) { const s = document.createElement('script'); s.textContent = js; document.head.appendChild(s); }
  });
}, { id: ID, css: CSS, js: JS, lang: process.env.NG_LANG || null });
const page = await ctx.newPage();
page.on('console', msg => console.log('PAGE:', msg.text().slice(0, 150)));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.TwitchNG, null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => { const d = document.getElementById('welcome_dialog'); return d && !d.classList.contains('hide'); }, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const shot = async (n) => { if (PRE) { await page.evaluate(PRE).catch((e) => console.log('pre ' + n + ': ' + e)); await page.waitForTimeout(400); }
  await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot ' + n);
  if (PROBE) fs.writeFileSync(path.join(OUT, 'probe-' + n + '.json'), JSON.stringify(await page.evaluate(PROBE).catch((e) => ({ error: String(e) })), null, 1));
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
if (SCREENS.includes('fonts') && FONTSETS) {
  await shot('font-0-base');
  for (const n of fs.readdirSync(FONTSETS).filter((d) => fs.existsSync(path.join(FONTSETS, d, 'fonts.css'))).sort()) {
    await page.evaluate((href) => new Promise((res) => { let l = document.getElementById('ng-fontset');
      if (!l) { l = document.createElement('link'); l.id = 'ng-fontset'; l.rel = 'stylesheet'; document.head.appendChild(l); }
      l.onload = () => document.fonts.ready.then(() => setTimeout(res, 1200)); l.href = href; }), 'githubio/css/fontsets/' + n + '/fonts.css');
    await shot('font-' + n);
  }
  await page.evaluate(() => { const l = document.getElementById('ng-fontset'); if (l) l.remove(); });
}
if (SCREENS.includes('home2')) { await key('ArrowRight'); await shot('home2'); await key('ArrowLeft'); }
// down: third row focused = the grid scrolled (rows above pass under the header)
if (SCREENS.includes('down')) { await key('ArrowDown', 2); await page.waitForTimeout(1200); await shot('down'); await key('ArrowUp', 2); }
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
// switch: the switch row of a game's live screen (Videos / Clips / Follow) focused
if (SCREENS.includes('switch')) { if (!SCREENS.includes('games')) { await sideGo(/^(games|категории)$/); await page.waitForTimeout(3500); await key('Enter'); await page.waitForTimeout(3500); }
  await key('ArrowUp'); await page.waitForTimeout(800); await shot('switch'); }
if (SCREENS.includes('videos')) { await sideGo(/^(videos|видео)$/); await page.waitForTimeout(3500); await shot('videos'); }
if (SCREENS.includes('clips')) {
  await page.evaluate(() => {
    const el = document.getElementById('side_panel_movel_new_7');
    if (el) el.click();
    const ud = document.getElementById('user_dialog');
    if (ud) ud.classList.add('hide');
  });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('img')];
    return imgs.length >= 6 && imgs.filter(img => img.naturalWidth > 0).length >= 6;
  }, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await shot('clips');
}
if (SCREENS.includes('featured')) { await sideGo(/^(featured|рекомендуемые|на главной странице)$/); await page.waitForTimeout(3500); await shot('featured'); }
if (SCREENS.includes('search')) { await sideGo(/^(search|поиск)$/); await page.waitForTimeout(1500); await shot('search'); await key('Escape'); }
// search2: a query typed, the Channels results (channel cards)
if (SCREENS.includes('search2')) { await sideGo(/^(search|поиск)$/); await page.waitForTimeout(1200); await page.fill('#search_input', 'minecraft').catch(() => {});
  await key('ArrowDown'); await key('Enter'); await page.waitForTimeout(3500); await shot('search-channels'); await key('Escape'); await key('Escape'); }
if (SCREENS.includes('user')) { await sideGo(/(add user|аккаунт|account)/, 0, 1); await page.waitForTimeout(2000); await shot('user'); await key('Escape'); }
if (SCREENS.includes('news')) { await sideGo(/(what.s new|что нового)/, 10); await page.waitForTimeout(1000); await shot('news'); await key('Escape'); }
if (SCREENS.includes('exit')) { await sideGo(/(exit|выход)/, 10); await shot('exit'); await key('Escape'); }
if (SCREENS.includes('about')) { await sideGo(/(about|описание|о приложении)/, 10); await page.waitForTimeout(1000); await shot('about'); await key('Escape'); }
if (SCREENS.includes('settings')) { await sideGo(/(settings|настройки)/, 10); await key('ArrowDown', 2); await shot('settings'); await key('Escape'); }
if (SCREENS.includes('player')) {
  console.log('revealing player OSD elements directly for inspection...');
  await page.evaluate(({ isRu }) => {
    const s1 = document.getElementById('scene1');
    if (s1) s1.style.display = 'none';
    const s2 = document.getElementById('scene2');
    if (s2) {
      s2.classList.remove('hide');
      s2.style.display = 'block';
      s2.style.opacity = '1';
      s2.style.background = '#050408';
    }
    let bg = document.getElementById('mock_player_bg');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'mock_player_bg';
      bg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:radial-gradient(circle at 60% 40%, #1a102e 0%, #0c0817 60%, #000 100%);z-index:1;';
      bg.innerHTML = `
        <div style="position:absolute;top:3%;left:3%;display:flex;align-items:center;gap:1.5vh;background:rgba(0,0,0,0.6);padding:.8vh 2vh;border-radius:1vh;border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(8px);">
          <div style="width:4.2vh;height:4.2vh;border-radius:50%;background:linear-gradient(135deg, #9146ff, #bf94ff);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:2vh;color:#fff;">${isRu ? 'NS' : 'TK'}</div>
          <div>
            <div style="font-family:var(--ng-font);font-size:2.2vh;font-weight:700;color:#fff;">${isRu ? 'just_ns' : 'tarik'}</div>
            <div style="font-family:var(--ng-font);font-size:1.6vh;color:#c9c3d6;">${isRu ? 'Старпёрхаб — Гранд-финал!' : 'VCT Champions - Grand Finals'} · <span style="color:#bf94ff;">${isRu ? 'Dota 2' : 'VALORANT'}</span></div>
          </div>
          <div style="margin-left:2vh;background:#ff3b4e;color:#fff;font-family:var(--ng-font);font-size:1.4vh;font-weight:700;padding:.3vh 1vh;border-radius:.4vh;letter-spacing:.05em;">LIVE</div>
          <div style="color:#8e87a2;font-family:var(--ng-font);font-size:1.5vh;font-weight:600;">${isRu ? '54,2 тыс. зрителей' : '48.5K viewers'}</div>
        </div>
      `;
      s2.insertBefore(bg, s2.firstChild);
    }
    const op = document.getElementById('scene_channel_panel');
    if (op) { op.style.opacity = '1'; op.style.pointerEvents = 'auto'; op.style.zIndex = '10'; }
    const pph = document.getElementById('progress_pause_holder');
    if (pph) {
      pph.classList.remove('hide');
      pph.style.display = 'block';
      pph.style.opacity = '1';
      pph.style.zIndex = '100';
      pph.innerHTML = `
        <div class="progress_bar_div" style="width:100%;display:flex;align-items:center;gap:2vw;margin-bottom:1.5vh;">
          <span class="progress_bar_timer" style="font-family:var(--ng-font);font-weight:700;font-size:2vh;color:#f5f3fa;text-shadow:0 0 1vh #000;">28:45</span>
          <div id="progress_bar_inner_container" style="flex:1;height:.65vh;background:rgba(255,255,255,0.15);border-radius:.35vh;position:relative;overflow:visible;">
            <div id="inner_progress_bar_buffer" style="width:55%;height:100%;background:rgba(255,255,255,0.25);border-radius:.35vh;position:absolute;left:0;top:0;"></div>
            <div id="inner_progress_bar" style="width:34%;height:100%;background:linear-gradient(90deg, #9146ff, #bf94ff);border-radius:.35vh;position:absolute;left:0;top:0;box-shadow:0 0 1.2vh rgba(145,70,255,0.7);">
              <div class="inner_progress_circle" style="width:1.8vh;height:1.8vh;border-radius:50%;background:#bf94ff;border:2px solid #fff;box-shadow:0 0 1vh rgba(191,148,255,0.9);position:absolute;right:0;top:50%;transform:translate(50%,-50%);"></div>
            </div>
          </div>
          <span class="progress_bar_timer" style="font-family:var(--ng-font);font-weight:700;font-size:2vh;color:#8e87a2;text-shadow:0 0 1vh #000;">1:42:10</span>
        </div>
        <div class="pause_next_div" style="display:flex;align-items:center;justify-content:center;gap:3vw;">
          <div class="back_button" style="padding:.8vh 2vh;border-radius:1vh;background:rgba(255,255,255,0.08);color:#c9c3d6;font-family:var(--ng-font);font-size:1.8vh;font-weight:600;display:flex;align-items:center;gap:1vh;">
            <i class="icon-fast_rewind"></i> -10s
          </div>
          <div class="pause_button progress_bar_div_focus" style="width:6.2vh;height:6.2vh;border-radius:50%;background:linear-gradient(90deg, #9146ff, #7a2ff0);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 0 0 .37vh #bf94ff, 0 .8vh 3vh rgba(145, 70, 255, 0.6);transform:scale(1.1);">
            <i class="icon-play" style="font-size:3vh;margin-left:.3vh;"></i>
          </div>
          <div class="next_button" style="padding:.8vh 2vh;border-radius:1vh;background:rgba(255,255,255,0.08);color:#c9c3d6;font-family:var(--ng-font);font-size:1.8vh;font-weight:600;display:flex;align-items:center;gap:1vh;">
            +30s <i class="icon-fast_forward"></i>
          </div>
        </div>
      `;
    }
    const ch = document.getElementById('controls_holder');
    if (ch) {
      ch.classList.remove('hide');
      ch.style.display = 'flex';
      ch.style.justifyContent = 'center';
      ch.style.gap = '1.5vw';
      ch.style.opacity = '1';
      ch.style.zIndex = '100';
      ch.style.bottom = '3vh';
      const btns = isRu ? [
        { icon: 'icon-arrow_back', label: 'Назад' },
        { icon: 'icon-speed', label: 'Скорость 1×' },
        { icon: 'icon-settings', label: '1080p60' },
        { icon: 'icon-volume_up', label: 'Звук' },
        { icon: 'icon-chat', label: 'Чат' },
        { icon: 'icon-crop_free', label: 'Формат' },
        { icon: 'icon-tune', label: 'Опции' }
      ] : [
        { icon: 'icon-arrow_back', label: 'Back' },
        { icon: 'icon-speed', label: 'Speed 1×' },
        { icon: 'icon-settings', label: '1080p60' },
        { icon: 'icon-volume_up', label: 'Audio' },
        { icon: 'icon-chat', label: 'Chat' },
        { icon: 'icon-crop_free', label: 'Aspect' },
        { icon: 'icon-tune', label: 'Options' }
      ];
      ch.innerHTML = btns.map((b, i) => `
        <div class="controls_button_holder" style="display:flex;flex-direction:column;align-items:center;gap:.6vh;">
          <div class="controls_button ${i === 2 ? 'progress_bar_div_focus' : ''}" style="width:5.2vh;height:5.2vh;border-radius:1.2vh;background:${i === 2 ? 'linear-gradient(90deg, #9146ff, #7a2ff0)' : 'rgba(255,255,255,0.08)'};display:flex;align-items:center;justify-content:center;color:#fff;border:1px solid ${i === 2 ? '#bf94ff' : 'rgba(255,255,255,0.1)'};box-shadow:${i === 2 ? '0 0 1.5vh rgba(145,70,255,0.6)' : 'none'};">
            <i class="${b.icon}" style="font-size:2.4vh;"></i>
          </div>
          <span style="font-family:var(--ng-font);font-size:1.5vh;font-weight:600;color:${i === 2 ? '#bf94ff' : '#8e87a2'};">${b.label}</span>
        </div>
      `).join('');
    }
  }, { isRu: /^ru/i.test(process.env.NG_LANG || '') });
  await page.waitForTimeout(1000);
  await shot('player');
}
console.log('errors ' + JSON.stringify(errors.slice(0, 5)));
await page.close(); await browser.close();
process.exit(0);
