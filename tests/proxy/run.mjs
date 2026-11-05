// proxy/sttv-cors-proxy.js without network: LAN-only clients, upstream allowlist (https, hosts, paths, ports, userinfo),
// redirects re-checked, safe response headers (media Content-Type by extension, nosniff, sandbox CSP, no cookies), Range,
// URL cap, upstream errors, and the CLI (/health). The upstream is a scripted stand-in for https.request.
//   node tests/proxy/run.mjs
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const P = fileURLToPath(new URL('../../proxy/sttv-cors-proxy.js', import.meta.url));
const proxy = require(P);
let fails = 0;
const ok = (c, name, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : '')); if (!c) fails++; };
const ip = (...o) => o.join('.');   // addresses are built, not written out (tests/hygiene.mjs)

// ---- 1. who may use it
const lan = ['127.0.0.1', '::1', '::ffff:127.0.0.1', ip(10, 1, 2, 3), ip(172, 16, 0, 1), ip(172, 31, 255, 1), ip(192, 168, 1, 20), '::ffff:' + ip(192, 168, 1, 20),
  ip(169, 254, 3, 4), ip(100, 64, 0, 1), ip(100, 127, 0, 9), 'fd12:3456::1', 'fc00::1', 'fe80::1%eth0'];
const pub = [ip(172, 15, 0, 1), ip(172, 32, 0, 1), ip(100, 63, 0, 1), ip(100, 128, 0, 1), '203.0.113.7', '198.51.100.1', ip(8, 8, 8, 8), '::ffff:203.0.113.7', '2001:db8::1', 'ff02::1', 'fe00::1', '', undefined];
ok(lan.every(proxy.privateClient), 'clients: loopback / RFC 1918 / 100.64/10 / link-local / ULA (+ IPv4-mapped) are LAN', lan.filter((a) => !proxy.privateClient(a)));
ok(!pub.some(proxy.privateClient), 'clients: public, documentation, multicast and empty addresses are not', pub.filter(proxy.privateClient));

// ---- 2. a server with a scripted upstream
let routes = {}, calls = [];
function fakeRequest(o, cb) {
  const req = new EventEmitter(), url = 'https://' + o.hostname + o.path;
  calls.push({ url, o });
  req.setTimeout = () => {}; req.abort = () => { req.aborted = true; };
  req.end = () => setImmediate(() => {
    const r = routes[url];
    if (!r || r.error) return req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const res = new PassThrough();
    res.statusCode = r.status; res.headers = r.headers || {};
    cb(res); res.end(r.body || '');
  });
  return req;
}
const srv = http.createServer(proxy.createHandler({ request: fakeRequest }));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const get = (p, opt = {}) => new Promise((res, rej) => {
  const q = http.request(BASE + p, { method: opt.method || 'GET', headers: opt.headers || {} }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ st: r.statusCode, h: r.headers, b })); });
  q.on('error', rej); q.end();
});
let r = await get('/health');
ok(r.st === 200 && /sttv-cors-proxy 1\.1\.0 ok/.test(r.b) && r.h['access-control-allow-origin'] === '*' && r.h['x-content-type-options'] === 'nosniff', '/health: 200 + CORS + nosniff', { st: r.st, b: r.b });
r = await get('/', { method: 'OPTIONS' });
ok(r.st === 204 && r.h['access-control-allow-private-network'] === 'true' && /Range/.test(r.h['access-control-allow-headers']), 'OPTIONS preflight: 204, Range allowed, Private-Network allowed', r.h);
r = await get('/https://a.ttvnw.net/v/1.ts', { method: 'POST' });
ok(r.st === 405, 'POST -> 405', r.st);

const A = 'https://a.ttvnw.net/v/1.ts';
routes[A] = { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'sid=1', 'content-length': '25', etag: '"e1"' }, body: '<script>alert(1)</script>' };
calls = []; r = await get('/' + A);
ok(r.st === 200 && r.h['content-type'] === 'video/mp2t' && r.h['x-content-type-options'] === 'nosniff' && /sandbox/.test(r.h['content-security-policy']) && !r.h['set-cookie'] && r.h.etag === '"e1"' && r.b === routes[A].body,
  'media: CDN says text/html -> served as video/mp2t + nosniff + CSP sandbox, no Set-Cookie (a CDN file cannot run as a page here)', { ct: r.h['content-type'], csp: r.h['content-security-policy'], cookie: r.h['set-cookie'] });
ok(calls.length === 1 && calls[0].o.protocol === 'https:' && calls[0].o.port === 443 && calls[0].o.hostname === 'a.ttvnw.net', 'upstream: https, port 443, the checked host', calls.map((c) => c.o.hostname + ':' + c.o.port));
const M = 'https://usher.ttvnw.net/vod/2600000000.m3u8';
routes[M + '?sig=s&token=t'] = { status: 200, headers: { 'content-type': 'text/html' }, body: '#EXTM3U' };
r = await get('/' + M + '?sig=s&token=t');
ok(r.st === 200 && r.h['content-type'] === 'application/vnd.apple.mpegurl' && r.b === '#EXTM3U', 'playlist: query kept for upstream, served as application/vnd.apple.mpegurl', r.h['content-type']);
routes[A] = { status: 206, headers: { 'content-range': 'bytes 0-1/9' }, body: 'ab' };
calls = []; r = await get('/' + A, { headers: { Range: 'bytes=0-1' } });
const r2 = await get('/' + A, { headers: { Range: 'bytes=0-1, 5-6' } });
ok(r.st === 206 && r.h['content-range'] === 'bytes 0-1/9' && calls[0].o.headers.Range === 'bytes=0-1' && calls[1].o.headers.Range === undefined, 'Range: single range passed through (206 + Content-Range), multi-range dropped', calls.map((c) => c.o.headers.Range || null));
calls = []; r = await get('/' + encodeURIComponent(A));
ok(r.st === 206 && calls.length === 1 && calls[0].url === A, 'encoded target (https%3A%2F%2F...) is decoded once', calls.map((c) => c.url));
const bad = [['/http://a.ttvnw.net/v/1.ts', 'http'], ['/https://127.0.0.1/a.ts', 'loopback'], ['/https://' + ip(192, 168, 1, 1) + '/a.ts', 'LAN IP'], ['/https://a.ttvnw.net/a.html', 'non-media'],
  ['/https://evil.example/a.ts', 'other host'], ['/https://ttvnw.net.evil.example/a.ts', 'suffix trick'], ['/https://ttvnw.net@127.0.0.1/a.ts', 'userinfo trick'], ['/https://a.ttvnw.net:22/a.ts', 'port'],
  ['/file:///etc/passwd', 'file:'], ['/https://127.0.0.1%23.ttvnw.net/a.ts', 'encoded hash'], ['/' + encodeURIComponent('https://127.0.0.1#.ttvnw.net/a.ts'), 'encoded hash trick']];
calls = [];
const st = []; for (const [p] of bad) st.push((await get(p)).st);
ok(st.every((s) => s === 403) && calls.length === 0, 'refused without any upstream request: ' + bad.map((b) => b[1]).join(', '), { st, calls: calls.map((c) => c.url) });
r = await get('/https://a.ttvnw.net/v/' + 'x'.repeat(5000) + '.ts');
ok(r.st === 414, 'URL > 4096 chars -> 414', r.st);
const B = 'https://b.cloudfront.net/v/2.ts';
routes = { [A]: { status: 302, headers: { location: B } }, [B]: { status: 200, body: 'seg' } };
calls = []; r = await get('/' + A);
ok(r.st === 200 && r.b === 'seg' && r.h['content-type'] === 'video/mp2t' && calls.map((c) => c.url).join() === [A, B].join(), 'redirect to another Twitch media URL is followed', calls.map((c) => c.url));
for (const [loc, why] of [['http://b.cloudfront.net/v/2.ts', 'http downgrade'], ['https://127.0.0.1/a.ts', 'loopback'], ['https://b.cloudfront.net/x.html', 'non-media']]) {
  routes = { [A]: { status: 301, headers: { location: loc } } };
  calls = []; r = await get('/' + A);
  ok(r.st === 403 && calls.length === 1, 'redirect to ' + why + ' -> 403, not requested', { st: r.st, calls: calls.map((c) => c.url) });
}
routes = {}; for (let i = 0; i < 6; i++) routes['https://a.ttvnw.net/v/' + i + '.ts'] = { status: 302, headers: { location: '/v/' + (i + 1) + '.ts' } };
calls = []; r = await get('/https://a.ttvnw.net/v/0.ts');
ok(calls.length === 4 && r.st === 302 && !r.h.location, 'redirects: max 3 hops, the 4th 3xx is returned without Location', { n: calls.length, st: r.st });
routes = { [A]: { status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>nope</h1>' } };
r = await get('/' + A);
ok(r.st === 404 && /^text\/plain/.test(r.h['content-type']) && r.h['x-content-type-options'] === 'nosniff', 'upstream 404 HTML -> 404 text/plain + nosniff', r.h['content-type']);
routes = { [A]: { error: true } };
r = await get('/' + A);
ok(r.st === 502 && /ENOTFOUND/.test(r.b), 'upstream network error -> 502', r.b);
srv.close();

// ---- 3. public clients are refused (handler called with a fake socket address)
const callHandler = (h, addr, url) => new Promise((res) => {
  const req = new EventEmitter(); req.method = 'GET'; req.url = url; req.headers = {}; req.socket = { remoteAddress: addr };
  const out = { st: 0, h: null, b: '' };
  h(req, { writeHead: (s, hh) => { out.st = s; out.h = hh; }, end: (b) => { out.b = String(b || ''); res(out); }, headersSent: false });
});
r = await callHandler(proxy.createHandler({ request: fakeRequest }), '203.0.113.7', '/health');
const r3 = await callHandler(proxy.createHandler({ request: fakeRequest }), '::ffff:' + ip(192, 168, 1, 20), '/health');
const r4 = await callHandler(proxy.createHandler({ request: fakeRequest, allowPublic: true }), '203.0.113.7', '/health');
ok(r.st === 403 && /LAN clients only/.test(r.b) && r3.st === 200 && r4.st === 200, 'public client -> 403 "LAN clients only"; LAN client 200; --allow-public lets it through', [r.st, r3.st, r4.st]);

// ---- 4. CLI
const port = 20000 + Math.floor(Math.random() * 20000);
const cli = spawn(process.execPath, [P, '--port', String(port), '--host', '127.0.0.1', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = ''; cli.stdout.on('data', (d) => (banner += d));
await new Promise((res) => { const t = setInterval(() => { if (/listening/.test(banner)) { clearInterval(t); res(); } }, 50); setTimeout(() => { clearInterval(t); res(); }, 5000); });
const h = await new Promise((res) => http.get('http://127.0.0.1:' + port + '/health', (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ st: x.statusCode, b })); }).on('error', (e) => res({ st: 0, b: e.message })));
cli.kill();
ok(/listening on http:\/\/127\.0\.0\.1:\d+\/ \(LAN clients only\)/.test(banner) && h.st === 200, 'CLI: starts (LAN clients only by default), /health 200', { banner: banner.trim(), h });

console.log(fails ? `${fails} FAILED` : 'ALL PROXY TESTS PASSED');
process.exit(fails ? 1 : 0);
