// probe/sttv-cdp.mjs CLI against a local Chromium with the Twitch NG IPK (stand-in for the TV's DevTools port 9998):
// list, check (pass + mismatch -> exit 4), key (keyCodes reach the page), shot (PNG), watch (samples + reconnect after reload),
// redaction of tokens / signed URLs in everything printed or saved (--raw 1 opts out), report JSON, heap + privacy warning.
//   node tests/probe/cdp-cli.mjs <twitchng.ipk> [workDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), CLI = path.join(KIT, 'probe/sttv-cdp.mjs');
// what `check` must find by default = this kit's versions (engine VERSION, twitchng.js PRE_N)
const KSRC = (f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const ngSrc = KSRC('brand/twitchng/web/twitchng.js');
const isPre = /\bPRE\s*=\s*true\b/.test(ngSrc);
const KV = { engine: /\bVERSION = '([\d.]+)'/.exec(KSRC('sttv-speed/sttv-speed.js'))[1], isPre, pre: isPre ? (/\bPRE_N = '(\d*)'/.exec(ngSrc) || [])[1] || '' : 'none' };
const IPK = path.resolve(process.argv[2] || ''), W = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'sttv-cdp-cli'));
if (!fs.existsSync(IPK)) { console.error('usage: node tests/probe/cdp-cli.mjs <twitchng.ipk> [workDir]'); process.exit(2); }
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(path.join(W, 'ar'), { recursive: true }); fs.mkdirSync(path.join(W, 'root'));
execFileSync('ar', ['x', IPK], { cwd: path.join(W, 'ar') });
execFileSync('tar', ['-xzf', path.join(W, 'ar', 'data.tar.gz'), '-C', path.join(W, 'root')]);
const ID = 'com.twitchng.tv', APP = path.join(W, 'root/usr/palm/applications', ID), PORT = 9333;
let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : '')); if (!c) fails++; };
const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager' });
await ctx.addInitScript(({ id }) => {
  window.PalmSystem = { identifier: id + ' 1001', launchParams: '{}', activate() {}, platformBack() {}, stageReady() {},
    deviceInfo: JSON.stringify({ modelName: 'OLED65M59LA', platformVersion: '10.3.0', platformVersionMajor: 10, screenWidth: 1920, screenHeight: 1080 }) };
  window.__keys = []; window.addEventListener('keydown', (e) => { if (e.isTrusted) window.__keys.push(e.keyCode); }, true);   // the app itself dispatches untrusted F2 (113) events
}, { id: ID });
const page = await ctx.newPage();
await page.goto('file://' + path.join(APP, 'release/index.html'));
await page.waitForFunction(() => window.STTVSpeed && window.TwitchNG, null, { timeout: 30000 });
const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a, '--host', '127.0.0.1', '--port', String(PORT), '--match', 'twitchng'], { cwd: W, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: r.stdout + r.stderr, so: r.stdout }; };
const runAsync = (...a) => new Promise((res) => { import('node:child_process').then(({ spawn }) => {
  const p = spawn(process.execPath, [CLI, ...a, '--host', '127.0.0.1', '--port', String(PORT), '--match', 'twitchng'], { cwd: W }); let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', (code) => res({ code, out })); }); });

let r = run('list');
ok(r.code === 0 && (/com\.twitchng\.tv|Twitch NG/.test(r.out)), 'list: the app target is visible');
r = run('check');
const preOk = KV.isPre ? r.out.includes('PASS TwitchNG pre-release ' + KV.pre) : !r.out.includes('PASS TwitchNG pre-release');
ok(r.code === 0 && r.out.includes('PASS engine ' + KV.engine) && /PASS app id com\.twitchng\.tv/.test(r.out) && /PASS BASE inside/.test(r.out) && /PASS TwitchNG 1\.0\.0 variant L3/.test(r.out) && preOk && /CHECK OK/.test(r.out), 'check: engine ' + KV.engine + ', app id, BASE, pre-release ' + KV.pre + ', TwitchNG 1.0.0 L3 -> exit 0', r.out.split('\n').filter((l) => /PASS|FAIL|CHECK/.test(l)));
r = run('check', '--pre', '01');
ok(r.code === 4 && /FAIL TwitchNG pre-release 01/.test(r.out), 'check: pre-release 01 expected on a ' + (KV.isPre ? KV.pre : 'release') + ' build -> FAIL + exit 4', { code: r.code });
r = run('check', '--variant', 'A', '--engine', '1.3.3');
ok(r.code === 4 && /FAIL engine 1\.3\.3/.test(r.out) && /CHECK FAILED/.test(r.out), 'check: wrong expectations -> FAIL lines + exit 4', { code: r.code });
await page.evaluate(() => (window.__keys = []));
r = run('key', 'down', 'right', 'enter', 'back', '5', '--gap', '50');
const keys = await page.evaluate(() => window.__keys);
ok(r.code === 0 && JSON.stringify(keys) === '[40,39,13,461,53]', 'key: down right enter back 5 -> trusted keyCodes 40 39 13 461 53 reach the page', keys);
r = run('shot', '--out', 'shot.png');
const png = fs.existsSync(path.join(W, 'shot.png')) ? fs.readFileSync(path.join(W, 'shot.png')) : null;
ok(r.code === 0 && png && png.toString('latin1', 1, 4) === 'PNG' && png.readUInt32BE(16) === 1920, 'shot: 1920-wide PNG of the page', png && [png.readUInt32BE(16), png.readUInt32BE(20)]);
const wp = runAsync('watch', '--every', '500', '--for', '9', '--out', 'w.jsonl');
await new Promise((res) => setTimeout(res, 3500));
await page.reload(); await page.waitForFunction(() => window.STTVSpeed, null, { timeout: 30000 });
r = await wp;
const lines = fs.existsSync(path.join(W, 'w.jsonl')) ? fs.readFileSync(path.join(W, 'w.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const samples = lines.filter((l) => l.engine), firstEv = samples.length ? samples[0].ev.length : 0;
ok(r.code === 0 && samples.length >= 8 && samples.every((s) => s.app === ID && s.engine === KV.engine && 'uiMs' in s && 'heapMB' in s && 'hold' in s && 'net' in s), 'watch: samples with app, engine, uiMs, heap, hold, net', { samples: samples.length, keys: samples[0] && Object.keys(samples[0]) });
ok(firstEv > 0 && samples.slice(1).some((s) => s.ev.length === 0), 'watch: events are streamed once (first sample has the backlog, later ones only new events)', { firstEv });
ok(samples.some((s) => s.pageReloaded) || lines.some((l) => l.connect && lines.indexOf(l) > 0), 'watch: survives a page reload (pageReloaded flag / reconnect)', lines.filter((l) => l.connect || l.error || l.pageReloaded).map((l) => l.connect ? 'connect' : l.error ? 'error' : 'reloaded'));
// redaction (default): reports get shared, Twitch playlist URLs carry a signed token; --raw 1 opts out
const SECRET = { u: 'https://usher.ttvnw.net/vod/2600000000.m3u8?sig=5ec7e7deadbeef&token=%7B%22user_id%22%3A4242%7D', j: { access_token: 'abc123secretvalue', refresh_token: 'r3fr3shsecret' },
  h: 'Authorization: Bearer ' + 'abcdefghijklmnop0123', o: 'oauth:0123456789abcdef', n: 'x?nauthsig=99secret99&ok=1', w: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlc2VjcmV0' };
const SECRETS = ['5ec7e7deadbeef', 'user_id', 'abc123secretvalue', 'r3fr3shsecret', 'abcdefghijklmnop0123', '0123456789abcdef', '99secret99', 'c2lnbmF0dXJlc2VjcmV0'];
r = run('eval', '(' + JSON.stringify(SECRET) + ')');
let parsed = null; try { parsed = JSON.parse(r.so); } catch (e) {}
ok(r.code === 0 && parsed && SECRETS.every((x) => !r.out.includes(x)) && parsed.u === 'https://usher.ttvnw.net/vod/2600000000.m3u8?<query removed>' && parsed.j.access_token === '<redacted>',
  'redaction: tokenized playlist URL, access_token fields, Bearer, oauth:, nauthsig=, JWT removed; output is still valid JSON', parsed);
r = run('eval', JSON.stringify(JSON.stringify(SECRET)));
ok(r.code === 0 && SECRETS.every((x) => !r.out.includes(x)), 'redaction: also inside a JSON string (escaped quotes) returned by eval', r.so.slice(0, 200));
r = run('eval', '(' + JSON.stringify(SECRET) + ')', '--raw', '1');
ok(r.code === 0 && SECRETS.every((x) => r.out.includes(x)), '--raw 1: nothing redacted (local debugging only)');
r = run('report', '--out', 'rep.json');
let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(W, 'rep.json'), 'utf8')); } catch (e) {}
ok(r.code === 0 && rep && rep.status && rep.status.version === KV.engine, 'report: saved file is valid JSON after redaction', rep && Object.keys(rep));
r = run('mem');
let mem = null; try { mem = JSON.parse(r.so.trim().split('\n').pop()); } catch (e) {}
ok(r.code === 0 && mem && mem.heapUsedMB > 0 && mem.dom && mem.dom.nodes > 0 && mem.segCache && mem.segCache.n === 0 && 'abufMB' in mem,
  'mem: heap after GC, DOM counters, ArrayBuffer MB and the v2b segment cache (empty while idle)', mem);
r = run('heap', '--out', 'h.heapsnapshot');
ok(r.code === 0 && /PRIVATE: a heap snapshot/.test(r.out) && fs.statSync(path.join(W, 'h.heapsnapshot')).size > 1e6, 'heap: snapshot saved + privacy warning printed', r.out.split('\n').filter((l) => /saved|PRIVATE/.test(l)));
fs.rmSync(path.join(W, 'h.heapsnapshot'), { force: true });
await page.close(); await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL CDP CLI TESTS PASSED');
process.exit(fails ? 1 : 0);
