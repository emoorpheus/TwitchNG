// twitchng.mjs - Twitch NG app layer of a BUILT IPK (build/build-app.mjs --brand twitchng), webOS-like runtime as smoke.mjs.
// Static: appinfo (id/title/vendor/version 1.0.0/iconColor/icons/splash sizes), release/index.html tags + title, no analytics
// tags / preconnects of the original project, main.js patches (speed menu 0.25-2 in VOD + clips only, app name, purple default
// focus, About / What's new / update check / settings / sign-in help / empty-screen image), twitchng.js/css shipped.
// Runtime (first run, real Twitch API): TwitchNG API 1.0.0 pre-release, intro without the original project's names (closed by
// OK like before), exit dialog text, About (version, legal notice, no contact / donation / phone texts), side menu
// "What's new" -> update dialog with this app's notes and no update buttons, Settings without "Updates", Russian texts,
// no request to the original project's site / Firebase / Google Analytics, OLED preset vs classic (TWITCHNG_OLED=0) on
// 7 screens: mean luminance and lit pixels with pictures hidden.
// Usage: node tests/app/twitchng.mjs <twitchng.ipk> [workDir]      -> screenshots + twitchng-result.json in workDir
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { KIT } from '../_paths.mjs';

const IPK = path.resolve(process.argv[2] || '');
// expected pre-release number: the one place it is set (brand/twitchng/web/twitchng.js PRE_N), not a copy in this test
const PRE = (/\bPRE_N\s*=\s*'(\d*)'/.exec(fs.readFileSync(path.join(KIT, 'brand/twitchng/web/twitchng.js'), 'utf8')) || [])[1] || '?';
const W = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'sttv-app-twitchng'));
if (!fs.existsSync(IPK)) { console.error('usage: node tests/app/twitchng.mjs <twitchng.ipk> [workDir]'); process.exit(2); }
fs.rmSync(W, { recursive: true, force: true });
for (const d of ['ar', 'root', 'stub/webos-service', 'shots']) fs.mkdirSync(path.join(W, d), { recursive: true });
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const PK = path.join(W, 'root/usr/palm/packages');
const pinfo = JSON.parse(fs.readFileSync(path.join(PK, fs.readdirSync(PK)[0], 'packageinfo.json'), 'utf8'));
const ID = pinfo.app, SID = pinfo.services[0];
const APP = path.join(W, 'root/usr/palm/applications', ID), SVC = path.join(W, 'root/usr/palm/services', SID), REL = path.join(APP, 'release');
let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails++; };

// ---------------------------------------------------------------- static
const pngSize = (f) => { const b = fs.readFileSync(f); return b.toString('latin1', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
const ai = JSON.parse(fs.readFileSync(path.join(APP, 'appinfo.json'), 'utf8'));
const asz = (k) => (ai[k] && fs.existsSync(path.join(APP, ai[k])) ? pngSize(path.join(APP, ai[k])) : null);
ok(ai.title === 'Twitch NG' && ai.vendor === 'TwitchNG' && ai.iconColor === '#9146FF' && ai.version === '1.0.0', 'appinfo: title Twitch NG, vendor, iconColor #9146FF, version 1.0.0 (own version line)', { id: ai.id, title: ai.title, version: ai.version });
ok(!/fgl27|TBSniller|SmartTwitchTV/i.test(ai.appDescription || ''), 'appinfo description names only this app', ai.appDescription);
ok(new RegExp('^Twitch NG 1\\.0\\.0 \\(pre-release ' + PRE + '\\) - ').test(ai.appDescription || ''), 'appinfo description carries the pre-release number from twitchng.js (PRE_N)', ai.appDescription);
const icon = asz('icon'), large = asz('largeIcon'), splash = asz('splashBackground');
ok(icon && icon[0] === 80 && icon[1] === 80 && large && large[0] === 130 && large[1] === 130 && splash && splash[0] === 1920 && splash[1] === 1080, 'LG appinfo spec: icon 80x80, largeIcon 130x130, splash 1920x1080', { icon, large, splash });
const iconPx = (() => {   // pixel (4, 0) of the icon PNG (8-bit RGB/RGBA, row 0 unfiltered) -> the purple field
  try { const b = fs.readFileSync(path.join(APP, ai.icon)); let o = 8, idat = []; let ihdr = null;
    while (o < b.length) { const n = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8); if (t === 'IHDR') ihdr = b.subarray(o + 8, o + 8 + n); if (t === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + n)); o += 12 + n; }
    const raw = zlib.inflateSync(Buffer.concat(idat)), ch = ihdr[9] === 6 ? 4 : 3, w = ihdr.readUInt32BE(0), f = raw[0], row = raw.subarray(1, 1 + w * ch), px = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) { const a = i >= ch ? px[i - ch] : 0; px[i] = (row[i] + (f === 1 || f === 4 ? a : f === 3 ? a >> 1 : 0)) & 255; }   // row 0: up = 0
    return [px[ch * 4], px[ch * 4 + 1], px[ch * 4 + 2]]; } catch (e) { return null; } })();
const splashFile = path.join(APP, ai.splashBackground || 'assets/splash.png'), splashBytes = fs.existsSync(splashFile) ? fs.statSync(splashFile).size : 0;
ok(splashBytes > 0 && splashBytes < 300 * 1024, 'splash.png compact (palette PNG, < 300 KB)', splashBytes);
ok(iconPx && Math.abs(iconPx[0] - 0x91) < 6 && Math.abs(iconPx[1] - 0x46) < 6 && Math.abs(iconPx[2] - 0xff) < 6, 'icon background = Twitch purple', iconPx);
const html = fs.readFileSync(path.join(REL, 'index.html'), 'utf8'), main = fs.readFileSync(path.join(REL, 'githubio/js/main.js'), 'utf8');
const pos = (re) => html.search(re);
const iLink = pos(/<link[^>]+twitchng\.css/), iDiv = html.indexOf('<div'), iSp = pos(/<script[^>]+sttv-speed\.js/), iNg = pos(/<script[^>]+twitchng\.js/), iMain = pos(/<script[^>]+githubio\/js\/main\.js/);
ok(iLink > 0 && iLink < iDiv && iSp > 0 && iSp < iNg && iNg < iMain && /<title>Twitch NG<\/title>/.test(html), 'index.html: twitchng.css in head, sttv-speed < twitchng.js < main.js, title Twitch NG', { iLink, iDiv, iSp, iNg, iMain });
ok(fs.existsSync(path.join(REL, 'githubio/js/twitchng.js')) && fs.existsSync(path.join(REL, 'githubio/css/twitchng.css')), 'twitchng.js + twitchng.css shipped');
ok(!/firebasejs|googletagmanager|fgl27\.github\.io/.test(html) && /<script[^>]+twitchng\.js\?v=1\.0\.0" data-name="Twitch NG" data-variant="L3"/.test(html),
  'index.html: no Firebase / Google Analytics tags, no preconnect to the original site; twitchng.js 1.0.0 tag with name + variant');
const gates = ['TwitchNG.aboutHtml(ua)', 'TwitchNG.newsHtml()', 'TwitchNG.newsHtml(pa)', 'TwitchNG.newsLabel(Ju)', 'function xj(){if(window.TwitchNG)return;',
  '(window.TwitchNG?"":cQ("update_settings"', 'TwitchNG.authHelp(Ua,_h)', 'image:"githubio/images/twitchng-empty.png"', 'gh("https://ttv.lol")',
  '"githubio/css/icons.min.css"'];
ok(gates.every((g) => main.split(g).length === 2) && main.indexOf('mipmap-nodpi/ic_splash.png') < 0 && main.indexOf('gh("https://ttv.lol/donate")') < 0 && main.indexOf('fgl27.github.io/SmartTwitchTV/release/githubio/css/') < 0,
  'main.js: About / What\'s new / update check / settings / sign-in help / empty image / proxy link / icon-font fallback patched once each', gates.filter((g) => main.split(g).length !== 2));
ok(fs.existsSync(path.join(REL, 'githubio/images/twitchng-empty.png')) && !fs.existsSync(path.join(REL, 'githubio/images/bitcoin.png')) && !fs.existsSync(path.join(REL, 'githubio/images/paypal.png')),
  'local empty-screen image shipped, donation images dropped');
const sp = /ShowInLive:(!\d),ShowInVod:(!\d),ShowInClip:(!\d),ShowInPP:(!\d),ShowInMulti:(!\d)[^}]*?icons:"speedometer",offsetY:-5,string:\w+,values:(\[[^\]]*\]),defaultValue:(\d+)/.exec(main);
const vals = sp ? JSON.parse(sp[6].replace(/(^|[,[])\./g, '$10.')) : null;
ok(sp && JSON.stringify(vals) === '[0.25,0.5,0.75,1,1.25,1.5,2]' && vals[+sp[7]] === 1, 'main.js speed menu: 0.25 0.5 0.75 1 1.25 1.5 2, default index -> 1x', { vals, def: sp && sp[7] });
ok(sp && sp[1] === '!1' && sp[2] === '!0' && sp[3] === '!0' && sp[4] === '!1' && sp[5] === '!1', 'main.js speed menu only in VOD + clips (live / PP / multi: off)', sp && sp.slice(1, 6));
const brandLeft = ['SmartTV Client for Twitch', 'Cliente SmartTV para Twitch', 'SmartTV Client для Twitch', 'Twitch için SmartTV'].filter((k) => main.indexOf(k) >= 0);
ok(brandLeft.length === 0 && (main.match(/Twitch NG/g) || []).length >= 12, 'main.js brand strings -> Twitch NG (en/fr/es/pt/ru/uk/tr)', { left: brandLeft, ng: (main.match(/Twitch NG/g) || []).length });
ok(main.indexOf('["rgba(0,0,0,1)","rgba(255,255,255,1)","rgba(145,70,255,1)","rgba(145,70,255,1)"]') >= 0, 'main.js default focus style: purple border + watched bar');

// ---------------------------------------------------------------- runtime
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
  // webOS 25 (LG M59LA, TV report): what webOSTV.js webOS.deviceInfo reads -> About shows webOS 10.3.0 + firmware 33.30.97
  if (uri === 'luna://com.webos.service.tv.systemproperty/getSystemInfo') return res(JSON.stringify({ returnValue: true, modelName: 'OLED65M59LA', firmwareVersion: '33.30.97', sdkVersion: '10.3.0' }));
  if (!m || m[1] !== SID || !svc.methods[m[2]]) return res(JSON.stringify({ returnValue: false, errorText: 'unknown ' + uri }));
  svc.methods[m[2]]({ payload: p, respond: (r) => res(JSON.stringify(r)) });
}));
await ctx.addInitScript(({ id }) => {
  window.PalmSystem = { identifier: id + ' 1001', launchParams: '{}', activate() {}, platformBack() {}, stageReady() {},
    deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '33.30.97', platformVersionMajor: 33, screenWidth: 1920, screenHeight: 1080 }) };
  window.PalmServiceBridge = function () {
    const self = this;
    this.call = (uri, params) => { window.__luna(uri, params).then((r) => { if (self.onservicecallback) self.onservicecallback(r); }); };
    this.cancel = () => { self.onservicecallback = null; };
  };
}, { id: ID });
const reqs = [], missing = [];
ctx.on('request', (r) => reqs.push(r.url()));
// pre-release 05 drops 22 unused files of the original project: none of them may be requested at runtime
ctx.on('requestfailed', (r) => { if (/^file:/.test(r.url())) missing.push(r.url().replace(/^.*\/release\//, 'release/') + ' ' + ((r.failure() || {}).errorText || '')); });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.TwitchNG && window.STTVSpeed, null, { timeout: 15000 }).catch(() => {});
const introUp = await page.waitForFunction(() => { const d = document.getElementById('welcome_dialog'); return d && !d.classList.contains('hide') && d.querySelector('.ng-intro'); }, null, { timeout: 30000 }).then(() => true, () => false);
await page.waitForTimeout(1500);
const splashStat = await page.evaluate(async (b64) => {   // decoded in the browser: luminance of the launch splash
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, Y = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let sum = 0, max = 0, black = 0; for (let i = 0; i < d.length; i += 4) { const y = Y(i); sum += y; if (y > max) max = y; if (d[i] + d[i + 1] + d[i + 2] === 0) black++; }
  const at = (x, y) => Y(4 * (y * c.width + x));
  return { w: c.width, h: c.height, meanY: +(sum / (d.length / 4)).toFixed(2), maxY: Math.round(max), blackPct: +(100 * black / (d.length / 4)).toFixed(2),
    corner: Math.round(at(20, 20)), glow: Math.round(at(Math.round(c.width * 0.36), Math.round(c.height * 0.4))) };
}, fs.readFileSync(splashFile).toString('base64'));
ok(splashStat.w === 1920 && splashStat.h === 1080 && splashStat.blackPct < 1 && splashStat.corner > 0 && splashStat.glow > splashStat.corner + 15 && splashStat.maxY > 240 && splashStat.meanY > 8 && splashStat.meanY < 60,
  'splash: not a black screen (dark backdrop, no pure #000), soft glow behind the mark, bright mark / text, still dark overall', splashStat);
const st = await page.evaluate(() => ({ ng: window.TwitchNG && window.TwitchNG.state(), title: document.title, speed: window.STTVSpeed && STTVSpeed.version,
  app: window.STTVSpeed && STTVSpeed.status().app,
  intro: (() => { const t = document.getElementById('welcome_dialog_text'), i = t && t.querySelector('.ng-intro'), h = t && t.querySelector('svg.ng-hero'), r = h && h.getBoundingClientRect();
    return t ? { text: t.innerText.replace(/\s+/g, ' ').trim(), hero: h ? h.getAttribute('aria-label') : null, heroBox: r ? [Math.round(r.top), Math.round(r.height)] : null,
      backdrop: i ? getComputedStyle(i).backgroundImage.slice(0, 40) : null, glitch: /M11\.571 4\.714/.test(t.innerHTML), old: /SmartTV Client|Press return or enter/i.test(t.innerText) } : null; })(),
  bg: getComputedStyle(document.getElementById('welcome_dialog')).backgroundColor }));
ok(st.ng && st.ng.version === '1.0.0' && st.ng.preRelease === true && st.ng.preReleaseN === PRE && st.ng.name === 'Twitch NG' && st.ng.variant === 'L3' && st.ng.oled === true && st.ng.classic === false && st.ng.css && st.ng.logo && st.ng.hero,
  'TwitchNG API: 1.0.0 pre-release ' + PRE + ', variant L3 (default icon), OLED preset on by default, css + logo + intro hero', st.ng);
ok(st.app && st.app.id === ID && st.app.name === 'Twitch NG' && st.app.version === '1.0.0', 'STTVSpeed.status().app = this app 1.0.0', st.app);
ok(st.title === 'Twitch NG', 'document.title', st.title);
// the viewport is 1920 x 1080 (as the TV): the hero sits where the splash has it (ink top 344 px, 372 px high; SVG box + 4 px pad)
ok(introUp && st.intro && st.intro.hero === 'Twitch Next-Gen' && st.intro.heroBox && Math.abs(st.intro.heroBox[0] - 340) <= 3 && Math.abs(st.intro.heroBox[1] - 380) <= 3 &&
  /radial-gradient/.test(st.intro.backdrop || '') && !st.intro.glitch && !st.intro.old && new RegExp('Twitch NG 1\\.0\\.0 · pre-release ' + PRE + ' · ').test(st.intro.text) &&
  /not affiliated with Twitch/.test(st.intro.text) && !/fgl27|TBSniller|SmartTwitch|Felipe/i.test(st.intro.text) && st.bg === 'rgb(8, 7, 13)',
  'first run: Twitch NG intro continues the splash (hero "Twitch Next-Gen" at the splash position, same backdrop + glow, no Glitch, pre-release, no names of the original projects)', st.intro);
await page.screenshot({ path: path.join(W, 'shots', 'intro.png') });

// light metric: pictures hidden (thumbnails, avatars, emotes, video), the rest is the UI the preset is about
await page.addStyleTag({ content: 'html.ng-measure img, html.ng-measure video, html.ng-measure canvas { visibility: hidden !important; }' });
async function light() {
  await page.evaluate(() => document.documentElement.classList.add('ng-measure'));
  await page.waitForTimeout(150);
  const b64 = (await page.screenshot()).toString('base64');
  await page.evaluate(() => document.documentElement.classList.remove('ng-measure'));
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0, lit = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += y; if (y > 24) lit++; }
    return { meanY: +(sum / n).toFixed(2), litPct: +(100 * lit / n).toFixed(2) };
  }, b64);
}
const metrics = {};
async function measure(name) {
  const oled = await light();
  await page.screenshot({ path: path.join(W, 'shots', name + '.png') });
  await page.evaluate(() => TwitchNG.oled(false)); await page.waitForTimeout(450);
  const classic = await light();
  await page.screenshot({ path: path.join(W, 'shots', name + '-classic.png') });
  await page.evaluate(() => TwitchNG.oled(null)); await page.waitForTimeout(450);
  metrics[name] = { oled, classic, lessLight: +(100 * (1 - oled.meanY / Math.max(classic.meanY, 1e-6))).toFixed(1) };
  console.log('  ' + name.padEnd(9) + ' meanY ' + classic.meanY + ' -> ' + oled.meanY + '  lit ' + classic.litPct + '% -> ' + oled.litPct + '%  (' + metrics[name].lessLight + '% less light)');
}
const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await page.waitForTimeout(650); } await page.waitForTimeout(900); };
console.log('light (pictures hidden): classic -> OLED');
await measure('intro');
await key('Enter');
const closed = await page.evaluate(() => document.getElementById('welcome_dialog').classList.contains('hide'));
ok(closed, 'OK closes the intro (app handler unchanged)');
await measure('home');
// side menu: navigate by the focused item (LZ focus class), not by blind key counts - focus stays where it was left
const side = () => page.evaluate(() => {
  const m = document.getElementById('side_panel_movel'); let f = null;
  for (let i = 0; i < 15; i++) { const e = document.getElementById('side_panel_movel_new_' + i);
    if (e && (e.classList.contains('side_panel_new_icons_text') || e.classList.contains('side_panel_new_icons_text_botton'))) f = { i: i, text: e.innerText.replace(/\s+/g, ' ').trim() }; }
  return { open: !!m && m.style.transform.indexOf('translateX(5%)') >= 0, f: f };
});
async function sideGo(re) {   // open the side menu (back key on the home screen), walk to the bottom option matching re, Enter
  for (let n = 0; n < 3 && !(await side()).open; n++) await key('Escape');
  const t = await page.evaluate((src) => { const r = new RegExp(src, 'i');
    for (let i = 10; i < 15; i++) { const e = document.getElementById('side_panel_movel_new_' + i); if (e && r.test(e.innerText)) return i; } return -1; }, re.source);
  for (let n = 0; n < 16 && t >= 0; n++) {
    const s = await side(); if (!s.open || !s.f) break;
    if (s.f.i === t) { await key('Enter'); return s.f; }
    await page.keyboard.press(s.f.i < t ? 'ArrowDown' : 'ArrowUp'); await page.waitForTimeout(450);
  }
  return null;
}
await key('Escape'); await measure('side');
const goExit = await sideGo(/exit/);
const exitTxt = await page.evaluate(() => { const e = document.getElementById('main_dialog_exit'); return e && !e.classList.contains('hide') ? document.getElementById('main_dialog_exit_text').innerText.trim() : null; });
ok(exitTxt && /Twitch NG/.test(exitTxt), 'exit dialog names Twitch NG', { item: goExit, text: exitTxt });
const exitBg = await page.evaluate(() => [getComputedStyle(document.getElementById('main_dialog_exit')).backgroundColor, getComputedStyle(document.querySelector('#main_dialog_exit .dialog_exit')).backgroundColor]);
await measure('exit');
await key('Escape');
const goAbout = await sideGo(/about/);
const aboutUp = await page.evaluate(() => !document.getElementById('dialog_about').classList.contains('hide'));
await page.waitForTimeout(1200);
const about = await page.evaluate(() => { const t = document.getElementById('dialog_about_text'); return t ? { html: t.innerHTML.length, ng: !!t.querySelector('.ng-about'),
  text: t.innerText.replace(/\s+/g, ' ').trim(), run: (document.getElementById('about_runningtime') || {}).innerText || '' } : null; });
ok(aboutUp && about && about.ng && new RegExp('Version 1\\.0\\.0 · pre-release ' + PRE + ' · speed engine \\d+\\.\\d+\\.\\d+').test(about.text) && /GNU GPL v3\.0/.test(about.text) && /absolutely no warranty/i.test(about.text) &&
  /gnu\.org\/licenses\/gpl-3\.0/.test(about.text) && /OLED65M59LA · webOS 10\.3\.0 · firmware 33\.30\.97 · Chromium \d+/.test(about.text) && !/webOS 33/.test(about.text) && /\S/.test(about.run),
  'About: Twitch NG 1.0.0 pre-release ' + PRE + ', engine, device (webOS 10.3.0 + firmware 33.30.97 from getSystemInfo, report T3), run time, GPL + no-warranty notice', about && about.text.slice(0, 400));
const aboutBad = about ? ['fglfgl27', 'gmail', 'PayPal', 'Paypal', 'Bitcoin', 'donat', 'Phone and tablet', 'github.com/fgl27', 'tinyurl', 'Apk:', 'Contact'].filter((k) => about.text.indexOf(k) >= 0) : ['?'];
ok(aboutBad.length === 0, 'About: no contact e-mail, donation, phone/tablet, upstream links or APK info', aboutBad);
const aboutBg = await page.evaluate(() => [getComputedStyle(document.getElementById('dialog_about')).backgroundColor, getComputedStyle(document.querySelector('#dialog_about .about_dialogs')).backgroundColor]);
await measure('about');
await key('Escape');
const side14 = await page.evaluate(() => { const e = document.getElementById('side_panel_movel_new_14'); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; });
const goNews = await sideGo(/what.s new/);
await page.waitForTimeout(1500);
const news = await page.evaluate(() => { const d = document.getElementById('update_dialog'), t = document.getElementById('update_dialog_text'), vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
  return { up: !!d && !d.classList.contains('hide'), ng: !!(t && t.querySelector('.ng-news')), text: t ? t.innerText.replace(/\s+/g, ' ').trim() : '', up_btn: vis('update_dialog_upbutton'), change_btn: vis('update_dialog_changebutton') }; });
ok(side14 === "What's new" && goNews && news.up && news.ng && new RegExp("What's new — Twitch NG 1\\.0\\.0 \\(pre-release " + PRE + '\\)').test(news.text) && !news.up_btn && !news.change_btn && !/Changelog|APK|fgl27/i.test(news.text),
  'side menu "What\'s new" -> this app\'s notes, no update / changelog buttons', { side14, item: goNews, news: { ...news, text: news.text.slice(0, 160) } });
await measure('news');
await key('Escape');
const newsClosed = await page.evaluate(() => document.getElementById('update_dialog').classList.contains('hide'));
ok(newsClosed, 'Back closes What\'s new');
const goSet = await sideGo(/settings/); await key('ArrowDown', 2);
const setSt = await page.evaluate(() => { const h = document.getElementById('settings_holder'), f = h && h.querySelector('.settings_div_focus');
  return { up: !!h && !h.classList.contains('hide') && h.offsetParent !== null, focus: !!f && f.offsetParent !== null, id: f ? f.id : null,
    bg: f ? getComputedStyle(f).backgroundImage.slice(0, 70) : null, fill: f ? getComputedStyle(f).backgroundColor : null }; });
await measure('settings');
const setUpd = await page.evaluate(() => ({ upd: !!document.getElementById('update_settings_div'), warn: !!document.getElementById('warnings_opt_div'), ui: !!document.getElementById('ui_opt_div') }));
ok(!setUpd.upd && setUpd.warn && setUpd.ui, 'Settings: no "Updates" section (neighbours still there)', setUpd);
ok(goExit && goAbout && goSet, 'side menu: Exit / About / Settings reached by focus walk', { exit: goExit, about: goAbout, settings: goSet });
ok(exitBg[0] === 'rgb(0, 0, 0)' && exitBg[1] === 'rgb(0, 0, 0)' && aboutUp && aboutBg[0] === 'rgb(0, 0, 0)' && aboutBg[1] === 'rgb(0, 0, 0)', 'OLED: dialog backdrops + panels true black (exit, about)', { exitBg, aboutBg });
ok(setSt.up && setSt.focus && /rgba\(145, 70, 255/.test(setSt.bg || ''), 'OLED: settings screen focus = purple lines / faint glow, no grey fill', setSt);
const names = Object.keys(metrics);
ok(names.every((n) => metrics[n].oled.meanY <= metrics[n].classic.meanY + 0.05), 'OLED never brighter than classic on any screen', names.map((n) => n + ' ' + metrics[n].lessLight + '%'));
ok(metrics.exit.lessLight >= 30 && metrics.about.lessLight >= 15 && metrics.settings.lessLight >= 10, 'OLED: exit -30%, about -15%, settings -10% light at least', { exit: metrics.exit.lessLight, about: metrics.about.lessLight, settings: metrics.settings.lessLight });
const lsOff = await page.evaluate(() => { TwitchNG.oled(false); const r = [localStorage.getItem('TWITCHNG_OLED'), document.documentElement.classList.contains('ng-classic')]; TwitchNG.oled(null); return r.concat([localStorage.getItem('TWITCHNG_OLED'), document.documentElement.classList.contains('ng-classic')]); });
ok(lsOff[0] === '0' && lsOff[1] === true && lsOff[2] === null && lsOff[3] === false, 'TwitchNG.oled(false) persists TWITCHNG_OLED=0 (classic), oled(null) -> default', lsOff);
const misc = await page.evaluate(() => {
  const en = TwitchNG.authHelp('Adding a key is not demanding.<br><br>In doubt read the contents of this link:<br><br>%x<br><br>For some devices, a mouse is necessary.');
  const pt = TwitchNG.authHelp('mais tarde <br><br> Em caso de dúvida, leia este link: <br><br>%x<br><br> Para alguns dispositivos');
  localStorage.setItem('app_lang_string', 'ru_RU');
  const ru = { about: TwitchNG.aboutHtml(), news: TwitchNG.newsHtml(), label: TwitchNG.newsLabel('x'), lang: TwitchNG.lang() };
  localStorage.removeItem('app_lang_string');
  return { en, pt, ru: { lang: ru.lang, label: ru.label, about: /Версия 1\.0\.0 · предварительная версия/.test(ru.about) && /без каких-либо гарантий/.test(ru.about), news: /Что нового — Twitch NG 1\.0\.0/.test(ru.news) } };
});
ok(misc.en === 'Adding a key is not demanding.<br><br>For some devices, a mouse is necessary.' && misc.pt === 'mais tarde <br><br> Para alguns dispositivos',
  'sign-in help without a source URL: the "read this link" sentence is dropped (en, pt spacing)', { en: misc.en, pt: misc.pt });
ok(misc.ru.lang === 'ru' && misc.ru.label === 'Что нового' && misc.ru.about && misc.ru.news, 'app language ru_RU -> Russian About / What\'s new', misc.ru);
const badReq = reqs.filter((u) => /fgl27\.github\.io|gstatic\.com\/firebasejs|googletagmanager\.com|google-analytics\.com|firebase/i.test(u));
ok(reqs.length > 20 && badReq.length === 0, 'network: no request to the original project site, Firebase or Google Analytics', { requests: reqs.length, bad: badReq.slice(0, 5) });
ok(missing.length === 0, 'package: no request for a missing local file (dropped images are not used)', missing.slice(0, 5));
ok(errors.length === 0, 'no page errors', errors.slice(0, 5));
fs.writeFileSync(path.join(W, 'twitchng-result.json'), JSON.stringify({ ipk: path.basename(IPK), id: ID, appinfo: ai, metrics, exitTxt, state: st }, null, 1));
console.log('screenshots ' + path.join(W, 'shots'));
await page.close(); await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL TWITCHNG CHECKS PASSED');
process.exit(fails ? 1 : 0);
