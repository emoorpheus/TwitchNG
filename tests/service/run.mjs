// deploy/service/sttv_media_fetch.js without a TV and without network: the URL allowlist (scheme, host, port, userinfo,
// path, parser tricks), redirects re-checked, size cap, timeout clamp, Range header, a throwing request(), and the Luna
// routing (hookService / install: only payload.sttvMedia === true is ours, everything else reaches the app's handler).
//   node tests/service/run.mjs
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const https = require('https'), http = require('http');
const svc = require('../../deploy/service/sttv_media_fetch.js');
const urlLib = require('url');
let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : '')); if (!c) fails++; };

// ---- 1. allowlist
const yes = ['https://d2vi6trrdongqn.cloudfront.net/abc_123/chunked/index-dvr.m3u8', 'https://usher.ttvnw.net/vod/2600000000.m3u8?sig=x&token=y',
  'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/a.m3u8', 'https://vod-secure.twitch.tv/x/720p60/12.ts', 'https://a.akamaized.net/v/1.mp4',
  'https://a.live-video.net/v/1.m4s', 'https://a.jtvnw.net/v/1.aac', 'https://a.ttvnw.net/v/1.m4a', 'https://A.TTVNW.NET/V/1.TS', 'https://a.ttvnw.net:443/v/1.ts'];
const no = [['http://usher.ttvnw.net/vod/1.m3u8', 'http'], ['https://127.0.0.1/a.ts', 'loopback IP'], ['https://192.168.1.1/a.m3u8', 'LAN IP'],
  ['https://10.0.0.8/a.ts', 'LAN IP'], ['https://[::1]/a.ts', 'IPv6 loopback'], ['https://169.254.169.254/latest/a.ts', 'metadata IP'],
  ['https://ttvnw.net.evil.example/a.ts', 'suffix trick'], ['https://evilttvnw.net/a.ts', 'no dot boundary'], ['https://ttvnw.net@127.0.0.1/a.ts', 'userinfo trick'],
  ['https://u:p@' + 'a.ttvnw.net/a.ts', 'userinfo on an allowed host'], ['https://a.ttvnw.net:22/a.ts', 'other port'], ['https://a.ttvnw.net:8443/a.ts', 'other port'],
  ['https://a.ttvnw.net/a.html', 'not media'], ['https://a.ttvnw.net/a.ts.html', 'not media (double ext)'], ['https://a.ttvnw.net/', 'no file'],
  ['https://a.ttvnw.net./a.ts', 'trailing dot'], ['file:///etc/passwd', 'file:'], ['ftp://a.ttvnw.net/a.ts', 'ftp:'], ['//a.ttvnw.net/a.ts', 'protocol-relative'],
  ['https://127.0.0.1\\.ttvnw.net/a.ts', 'backslash trick'], ['https://127.0.0.1#.ttvnw.net/a.ts', 'hash trick'], ['https://127.0.0.1?.ttvnw.net/a.ts', 'query trick'],
  ['https://127.0.0.1%2f.ttvnw.net/a.ts', 'encoded slash'], ['javascript:alert(1)//a.ttvnw.net/a.ts', 'javascript:'], ['', 'empty']];
ok(yes.every((u) => svc.allowed(urlLib.parse(u))), 'allowlist: ' + yes.length + ' real Twitch media URL shapes pass', yes.filter((u) => !svc.allowed(urlLib.parse(u))));
const leaked = no.filter(([u]) => { let p = null; try { p = urlLib.parse(u); } catch (e) { return false; } return svc.allowed(p); });
ok(leaked.length === 0, 'allowlist: ' + no.length + ' bad URLs rejected (http, IPs, suffix/userinfo/backslash/hash tricks, ports, non-media)', leaked);
ok(svc.version === '1.2.1', 'version 1.2.1', svc.version);

// ---- 2. fetchMedia against a scripted https.request (no network): what is requested, redirects, caps
let routes = {}, seen = [], throwNext = false;
const realHttps = https.request, realHttp = http.request;
http.request = () => { seen.push({ http: true }); throw new Error('http.request must not be used'); };
https.request = (o, cb) => {
  if (throwNext) { throwNext = false; throw new TypeError('ERR_UNESCAPED_CHARACTERS (simulated)'); }
  const req = new EventEmitter(), url = 'https://' + o.hostname + (o.port && o.port !== 443 ? ':' + o.port : '') + o.path;
  seen.push({ url, port: o.port, protocol: o.protocol, headers: o.headers });
  req.timeoutMs = null; req.aborted = false;
  req.setTimeout = (ms, f) => { req.timeoutMs = ms; req.onTimeout = f; }; req.abort = () => { req.aborted = true; };
  req.end = () => setImmediate(() => {
    const r = routes[url] || { status: 404 }, res = new EventEmitter();
    res.statusCode = r.status; res.headers = r.headers || {}; res.resume = () => {};
    if (r.timeout) return req.onTimeout && req.onTimeout();
    cb(res);
    setImmediate(() => { for (const c of r.chunks || []) { if (req.aborted) break; res.emit('data', c); } if (!req.aborted) res.emit('end'); });
  });
  seen[seen.length - 1].req = req;
  return req;
};
const fetchP = (payload) => new Promise((res) => svc.fetchMedia(payload, res));
const A = 'https://a.ttvnw.net/v/1.ts', B = 'https://b.cloudfront.net/v/1.ts';
routes[A] = { status: 200, chunks: [Buffer.from('hello')] };
let r = await fetchP({ sttvMedia: true, url: A, encoding: 'utf8' });
ok(r.returnValue && r.status === 200 && r.text === 'hello' && seen.length === 1 && seen[0].port === 443 && seen[0].protocol === 'https:', 'fetch: allowed URL -> https:443 request, body returned', { r, seen: seen.map((s) => s.url) });
seen = []; r = await fetchP({ sttvMedia: true, url: 'https://127.0.0.1/a.ts' });
ok(!r.returnValue && r.status === 403 && r.errorCode === 'URL_NOT_ALLOWED' && seen.length === 0, 'fetch: disallowed URL -> 403 URL_NOT_ALLOWED and nothing is requested', r);
seen = []; r = await fetchP({ sttvMedia: true, url: 'http://a.ttvnw.net/v/1.ts' });
ok(!r.returnValue && r.status === 403 && seen.length === 0, 'fetch: http:// -> 403, no request (https only)', r);
// redirects: allowed hop is followed, a hop to an IP / http / non-media is refused, max 3 hops
routes = { [A]: { status: 302, headers: { location: B } }, [B]: { status: 200, chunks: [Buffer.from('ok')] } };
seen = []; r = await fetchP({ sttvMedia: true, url: A, encoding: 'utf8' });
ok(r.returnValue && r.text === 'ok' && seen.map((s) => s.url).join() === [A, B].join(), 'redirect: to another Twitch media host is followed', seen.map((s) => s.url));
for (const [loc, why] of [['https://127.0.0.1/a.ts', 'loopback'], ['http://b.cloudfront.net/v/1.ts', 'http downgrade'], ['https://b.cloudfront.net/v/1.html', 'non-media'], ['https://evil.example/a.ts', 'other host']]) {
  routes = { [A]: { status: 301, headers: { location: loc } } };
  seen = []; r = await fetchP({ sttvMedia: true, url: A });
  ok(!r.returnValue && r.errorCode === 'REDIRECT_NOT_ALLOWED' && seen.length === 1, 'redirect: to ' + why + ' -> REDIRECT_NOT_ALLOWED, not requested', { r, seen: seen.map((s) => s.url) });
}
routes = {}; for (let i = 0; i < 5; i++) routes['https://a.ttvnw.net/v/' + i + '.ts'] = { status: 302, headers: { location: '/v/' + (i + 1) + '.ts' } };
seen = []; r = await fetchP({ sttvMedia: true, url: 'https://a.ttvnw.net/v/0.ts' });
ok(!r.returnValue && r.errorCode === 'UPSTREAM_STATUS_302' && seen.length === 4, 'redirect: at most 3 hops (4 requests), then the 302 is an error', { r, n: seen.length });
// size cap 8 MB: aborts the request
routes = { [A]: { status: 200, chunks: Array.from({ length: 9 }, () => Buffer.alloc(1024 * 1024)) } };
seen = []; r = await fetchP({ sttvMedia: true, url: A });
ok(!r.returnValue && r.status === 413 && r.errorCode === 'RESPONSE_TOO_LARGE' && seen[0].req.aborted, 'size cap: > 8 MB -> 413 RESPONSE_TOO_LARGE, upstream aborted', r);
// timeout clamp + Range header
routes = { [A]: { status: 206, headers: { 'content-range': 'bytes 0-1/10' }, chunks: [Buffer.from('ab')] } };
const tms = [];
for (const t of [10, undefined, 999999, 'x']) { seen = []; await fetchP({ sttvMedia: true, url: A, timeoutMs: t }); tms.push(seen[0].req.timeoutMs); }
ok(tms.join() === '2000,15000,30000,15000', 'timeout: clamped to 2..30 s, default 15 s', tms);
seen = []; r = await fetchP({ sttvMedia: true, url: A, range: '0-1' });
const rg = seen[0].headers.Range; seen = []; await fetchP({ sttvMedia: true, url: A, range: '0-1\r\nX-Evil: 1' });
ok(rg === 'bytes=0-1' && r.status === 206 && r.contentRange === 'bytes 0-1/10' && seen[0].headers.Range === undefined, 'range: digits-digits -> Range header; anything else (CRLF) is dropped', { rg, cr: r.contentRange, bad: seen[0].headers.Range });
routes = { [A]: { timeout: true } };
seen = []; r = await fetchP({ sttvMedia: true, url: A });
ok(!r.returnValue && r.status === 504 && r.errorCode === 'TIMEOUT' && seen[0].req.aborted, 'timeout: -> 504 TIMEOUT, request aborted', r);
throwNext = true; let threw = null;
try { r = await fetchP({ sttvMedia: true, url: A }); } catch (e) { threw = e.message; }
ok(threw === null && r && !r.returnValue && /ERR_UNESCAPED/.test(r.errorCode), 'a throwing https.request is answered as an error (does not escape into the service)', { threw, r });
ok(!seen.some((s) => s.http), 'http.request is never used');

// ---- 3. Luna routing: hookService wraps Service.prototype.register('fetchPlaylist') only for sttvMedia:true payloads
function Service() { this.h = {}; }
Service.prototype.register = function (name, cb) { this.h[name] = cb; return name; };
ok(svc.hookService(Service) === true && svc.hookService(Service) === false, 'hookService: hooks once (second call is a no-op)');
const s = new Service(); let origCalls = 0;
s.register('fetchPlaylist', () => { origCalls++; }); s.register('other', () => { origCalls += 100; });
const call = (name, payload) => new Promise((res) => { s.h[name]({ payload, respond: res }); setTimeout(() => res('__no_response__'), 50); });
r = await call('fetchPlaylist', { sttvMedia: true, ping: true });
ok(r && r.pong === true && r.version === '1.2.1' && origCalls === 0, 'luna: {sttvMedia:true, ping:true} -> pong 1.2.1, app handler not called', r);
r = await call('fetchPlaylist', { url: 'https://usher.ttvnw.net/api/channel/hls/x.m3u8' });
ok(origCalls === 1 && r === '__no_response__', 'luna: payload without sttvMedia goes to the app\'s own handler untouched', { origCalls });
r = await call('fetchPlaylist', { sttvMedia: 'true', ping: true });
ok(origCalls === 2, 'luna: sttvMedia must be boolean true (string "true" -> app handler)', { origCalls });
await call('other', { sttvMedia: true, ping: true });
ok(origCalls === 102, 'luna: other methods are not wrapped', { origCalls });
const client = { fetchPlaylist: (p, cb) => cb('orig') };
svc.install(client); svc.install(client);
const viaInstall = await new Promise((res) => client.fetchPlaylist({ sttvMedia: true, ping: true }, res));
const viaOrig = await new Promise((res) => client.fetchPlaylist({ url: 'x' }, res));
ok(viaInstall && viaInstall.pong === true && viaOrig === 'orig' && client.__sttvMedia === true, 'install (v1.1 module layout): same routing, idempotent', { viaInstall, viaOrig });

https.request = realHttps; http.request = realHttp;
console.log(fails ? `${fails} FAILED` : 'ALL SERVICE TESTS PASSED');
process.exit(fails ? 1 : 0);
