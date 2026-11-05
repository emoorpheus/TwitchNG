// smoke.mjs - boots the BUILT IPK (build/build-app.mjs) in Chromium with a webOS-like runtime and checks the integration.
// Runtime emulation: webOS TV user agent, window.PalmSystem (identifier = app id, M59LA deviceInfo), PalmServiceBridge ->
// the IPK's own JS service run under node with a stub webos-service (real fetchPlaylist + sttv_media_fetch hook).
// Checks: wrapper index.html -> release/index.html, bridge polyfill active, STTVSpeed loaded from the IPK with the build
// default (data-v2b), Android.setPlaybackSpeed hooked, v2b files load (STTVMseHook + private hls.js), Luna ping/pong through
// the built service, upstream UI renders, no page errors. Not tested here: playback (see tests/e2e), the TV itself.
// Usage: node tests/app/smoke.mjs <app.ipk> [workDir]      (needs playwright + ar + tar)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const IPK = path.resolve(process.argv[2] || '');
// expected versions come from this kit (no hard-coded release numbers)
const KITV = (/var VERSION = '([^']+)'/.exec(fs.readFileSync(new URL('../../sttv-speed/sttv-speed.js', import.meta.url), 'utf8')) || [])[1];
const HOOKV = (/version: "([^"]+)"/.exec(fs.readFileSync(new URL('../../sttv-speed/sttv-v2b.js', import.meta.url), 'utf8')) || [])[1];
const W = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'sttv-app-smoke'));
if (!fs.existsSync(IPK)) { console.error('usage: node tests/app/smoke.mjs <app.ipk> [workDir]'); process.exit(2); }
fs.rmSync(W, { recursive: true, force: true });
for (const d of ['ar', 'root', 'stub/webos-service']) fs.mkdirSync(path.join(W, d), { recursive: true });
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const PK = path.join(W, 'root/usr/palm/packages');
const pinfo = JSON.parse(fs.readFileSync(path.join(PK, fs.readdirSync(PK)[0], 'packageinfo.json'), 'utf8'));
const ID = pinfo.app, SID = pinfo.services[0];
const APP = path.join(W, 'root/usr/palm/applications', ID), SVC = path.join(W, 'root/usr/palm/services', SID);

// the built service under node (stub webos-service records register() calls)
fs.writeFileSync(path.join(W, 'stub/webos-service/index.js'),
  'function Service(name) { this.name = name; global.__svc = { name: name, methods: {} }; }\n' +
  'Service.prototype.register = function (m, cb) { global.__svc.methods[m] = cb; return { on: function () {} }; };\nmodule.exports = Service;\n');
process.env.NODE_PATH = path.join(W, 'stub');
createRequire(import.meta.url)('module').Module._initPaths();
createRequire(import.meta.url)(path.join(SVC, JSON.parse(fs.readFileSync(path.join(SVC, 'package.json'), 'utf8')).main));
const svc = global.__svc;

let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails++; };
ok(svc && svc.name === SID && typeof svc.methods.fetchPlaylist === 'function', 'service registers fetchPlaylist as ' + SID);

const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager' });
const luna = [];
await ctx.exposeFunction('__luna', (uri, params) => new Promise((res) => {
  const m = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri || ''), p = (() => { try { return JSON.parse(params); } catch (e) { return {}; } })();
  luna.push({ uri, sttvMedia: !!p.sttvMedia, ping: !!p.ping, url: p.url ? String(p.url).slice(0, 80) : null });
  if (!m || m[1] !== SID || !svc.methods[m[2]]) return res(JSON.stringify({ returnValue: false, errorText: 'unknown ' + uri }));
  svc.methods[m[2]]({ payload: p, respond: (r) => res(JSON.stringify(r)) });
}));
await ctx.addInitScript(({ id }) => {
  window.PalmSystem = { identifier: id + ' 1001', launchParams: '{}', activate() {}, platformBack() {}, stageReady() {},
    deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '10.3.0', platformVersionMajor: 10, screenWidth: 1920, screenHeight: 1080 }) };
  window.PalmServiceBridge = function () {
    const self = this;
    this.call = (uri, params) => { window.__luna(uri, params).then((r) => { if (self.onservicecallback) self.onservicecallback(r); }); };
    this.cancel = () => { self.onservicecallback = null; };
  };
}, { id: ID });
const page = await ctx.newPage();
const errors = [], consoleErr = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 200)); });
await page.goto('file://' + path.join(APP, 'index.html'));
await page.waitForURL(/\/release\/index\.html\?sttv_webos_launch=/, { timeout: 15000 }).catch(() => {});
ok(/\/release\/index\.html\?sttv_webos_launch=\d+/.test(page.url()) && page.url().startsWith('file://' + APP), 'wrapper navigates to the bundled release/index.html', page.url().replace(APP, '<app>'));
await page.waitForFunction(() => window.STTVSpeed && window.Android && window.Android.__isWebOSPolyfill, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(8000);   // upstream main.js init (Twitch API), bridge init, engine hook timer
const st = await page.evaluate(async () => {
  const S = window.STTVSpeed, A = window.Android, tag = document.querySelector('script[src*="sttv-speed.js"]');
  const r = { version: S && S.version, v2b: S && S.v2b(), hooked: S && S.status().hooked, wrap: !!(A && A.setPlaybackSpeed && A.setPlaybackSpeed.__sttvSpeedWrap),
    polyfill: !!(A && A.__isWebOSPolyfill), attr: tag && tag.getAttribute('data-v2b'), src: tag && tag.getAttribute('src'),
    order: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src').replace(/\?.*$/, '')).filter((s) => /webosCompatBridge|sttv-speed|main\.js/.test(s)),
    video: !!document.getElementById('sttv_main'), luna: S && S.status().net.luna, title: document.title,
    ui: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 160) : '' };
  const load = (src) => new Promise((res) => { const s = document.createElement('script'); s.src = src; s.onload = () => res(true); s.onerror = () => res(false); document.head.appendChild(s); });
  const base = r.v2b && r.v2b.base, saveHls = window.Hls;
  r.v2bLoad = base ? await load(base + 'sttv-v2b.js') : false;
  r.hook = window.STTVMseHook ? window.STTVMseHook.version : null;
  r.hlsLoad = base ? await load(base + 'sttv-hls.min.js') : false;
  r.hls = window.Hls && window.Hls.version; window.Hls = saveHls;
  r.ping = await new Promise((res) => { const b = new window.PalmServiceBridge(); b.onservicecallback = (x) => res(JSON.parse(x));
    b.call('luna://' + r.luna + '/fetchPlaylist', JSON.stringify({ sttvMedia: true, ping: true })); setTimeout(() => res(null), 5000); });
  S.apply(2); r.speed2 = S.status().speed; S.apply(1); r.speed1 = S.status().speed;
  r.events = S.events(30).map((e) => e.ev || e.e || e.type || e.name).filter(Boolean);
  return r;
});
ok(st.version === KITV && st.src === 'githubio/js/sttv-speed.js?v=' + KITV, 'STTVSpeed ' + KITV + ' loaded from the IPK', st.src);
ok(st.attr === 'auto' && st.v2b && st.v2b.cfg === 'auto' && st.v2b.cfgDefault === 'auto', 'v2b build default from data-v2b = auto', st.v2b && { cfg: st.v2b.cfg, cfgDefault: st.v2b.cfgDefault });
ok(st.v2b && st.v2b.base === 'file://' + APP + '/release/githubio/js/', 'v2b BASE = bundled githubio/js/', st.v2b && st.v2b.base.replace(APP, '<app>'));
ok(JSON.stringify(st.order) === JSON.stringify(['githubio/js/webosCompatBridge.js', 'githubio/js/sttv-speed.js', 'githubio/js/main.js']), 'script order bridge -> sttv-speed -> main.js', st.order);
ok(st.polyfill, 'bridge polyfill active (webOS UA + PalmSystem); #sttv_main is created on first playback', { video: st.video });
ok(st.hooked && st.wrap, 'Android.setPlaybackSpeed hooked by sttv-speed');
ok(st.v2bLoad && st.hook === HOOKV && st.hlsLoad && st.hls === '1.5.20', 'v2b files load from BASE (STTVMseHook ' + HOOKV + ', hls.js 1.5.20)', { hook: st.hook, hls: st.hls });
ok(st.luna === SID && st.ping && st.ping.pong === true && st.ping.sttvMedia === true, 'Luna ping/pong through the built service', st.ping);
ok(st.speed2 === 2 && st.speed1 === 1, 'Android.setPlaybackSpeed(2) / (1) reach the engine (no video: no engine start)');
const sttvErr = errors.concat(consoleErr).filter((e) => /sttv|STTVSpeed|STTVMseHook/i.test(e));
ok(errors.length === 0, 'no page errors', errors.slice(0, 5));
ok(sttvErr.length === 0, 'no console errors from sttv-speed', sttvErr.slice(0, 5));
console.log('info', JSON.stringify({ title: st.title, ui: st.ui, consoleErrors: consoleErr.length, consoleErrSample: consoleErr.slice(0, 4), luna: luna.length, lunaSample: luna.slice(0, 4), events: st.events.slice(-12) }));
await page.screenshot({ path: path.join(W, 'app.png') });
console.log('screenshot ' + path.join(W, 'app.png'));
await page.close(); await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL APP SMOKE CHECKS PASSED');
process.exit(fails ? 1 : 0);
