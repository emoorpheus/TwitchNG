#!/usr/bin/env node
/*
 * sttv-cors-proxy.js 1.1.0 - tiny LAN CORS proxy for sttv-speed.js (only needed if the TV blocks cross-origin XHR and the
 * patched app service isn't available). Twitch media hosts + media file types only. No dependencies, Node >= 8.
 *   node sttv-cors-proxy.js [--port 8787] [--host 0.0.0.0] [--quiet] [--allow-public]
 *   TV: STTVSpeed.setProxy('http://<lan-host>:8787/')   (= localStorage.STTV_SPEED_PROXY)
 * Request format: GET http://proxy:8787/https://<cdn-host>/<path>.ts   (Range is passed through)
 * Safety (1.1.0, tests: tests/proxy/run.mjs):
 *  - clients: only loopback / private (RFC 1918, 100.64/10 e.g. Tailscale) / link-local / IPv6 ULA addresses, so a box
 *    with a public address is not an open proxy; --allow-public (or STTV_PROXY_ALLOW_PUBLIC=1) turns this off
 *  - upstream: https only (redirects re-checked, max 3), default port, no user:pass@, Twitch media hosts + media paths
 *  - responses: Content-Type from the file extension (never the CDN's), X-Content-Type-Options: nosniff and
 *    CSP "default-src 'none'; sandbox": a file on a shared CDN (anyone can host on cloudfront.net) cannot run as a web
 *    page on this LAN origin; no cookies or other upstream headers are passed on
 */
'use strict';
var http = require('http'), https = require('https'), urlLib = require('url');

var VERSION = '1.1.0';
var HOST_RE = /(^|\.)(cloudfront\.net|ttvnw\.net|jtvnw\.net|live-video\.net|akamaized\.net|twitch\.tv)$/i;
var PATH_RE = /\.(m3u8|ts|mp4|m4s|m4a|aac)$/i;
var TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', mp4: 'video/mp4', m4s: 'video/iso.segment', m4a: 'audio/mp4', aac: 'audio/aac' };
var MAX_URL = 4096, MAX_REDIRECTS = 3;
var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Private-Network': 'true'
};
var SAFE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' };

function allowed(u) {
    return !!u && u.protocol === 'https:' && !u.auth && (!u.port || u.port === '443') &&
        HOST_RE.test(String(u.hostname || '')) && PATH_RE.test(String(u.pathname || ''));
}
// loopback, RFC 1918, 100.64/10 (CGNAT / Tailscale), 169.254/16, ::1, fc00::/7, fe80::/10 (IPv4-mapped IPv6 too)
function privateClient(addr) {
    var a = String(addr || '').toLowerCase().replace(/%.*$/, ''), m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a), p;
    if (m) a = m[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) {
        p = a.split('.').map(Number);
        return p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
            (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
    }
    return a === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}
function headers(extra) {
    var h = {}, k;
    for (k in CORS) h[k] = CORS[k];
    for (k in SAFE) h[k] = SAFE[k];
    for (k in extra || {}) h[k] = extra[k];
    return h;
}
function send(res, st, msg) {
    res.writeHead(st, headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(msg || '');
}
function createHandler(o) {
    o = o || {};
    var request = o.request || https.request, log = o.log || function () {}, allowPublic = !!o.allowPublic;
    function upstream(u, req, res, redirects, t0) {
        var hd = { 'User-Agent': 'sttv-cors-proxy/' + VERSION, Accept: '*/*' }, up, ext = /\.([a-z0-9]+)$/i.exec(u.pathname)[1].toLowerCase();
        if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) hd.Range = req.headers.range;
        try {
            up = request({ protocol: 'https:', hostname: u.hostname, port: 443, path: u.path, method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: hd }, function (ur) {
                var st = ur.statusCode || 502, h = {}, k, keep = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
                if (st >= 300 && st < 400 && ur.headers.location && redirects < MAX_REDIRECTS) {
                    ur.resume();
                    var nu = urlLib.parse(urlLib.resolve(urlLib.format(u), String(ur.headers.location)));
                    if (!allowed(nu)) return send(res, 403, 'redirect not allowed');
                    return upstream(nu, req, res, redirects + 1, t0);
                }
                for (k = 0; k < keep.length; k++) if (ur.headers[keep[k]]) h[keep[k]] = ur.headers[keep[k]];
                h['Content-Type'] = st >= 200 && st < 300 ? TYPES[ext] : 'text/plain; charset=utf-8';
                h['Cache-Control'] = 'no-store';
                res.writeHead(st, headers(h));
                ur.pipe(res);
                ur.on('end', function () { log(new Date().toISOString() + ' ' + st + ' ' + (Date.now() - t0) + 'ms ' + u.hostname + u.pathname.slice(-48) + ' ' + (hd.Range || '')); });
            });
        } catch (e) { return send(res, 502, 'upstream error'); }
        up.setTimeout(20000, function () { up.abort(); });
        up.on('error', function (e) { if (!res.headersSent) send(res, 502, 'upstream error: ' + String(e && e.code || e && e.message || e).slice(0, 80)); else res.destroy(); });
        req.on('close', function () { if (!res.writableEnded && !res.finished) up.abort(); });
        up.end();
    }
    return function (req, res) {
        if (!allowPublic && !privateClient(req.socket && req.socket.remoteAddress)) return send(res, 403, 'LAN clients only (start with --allow-public to change)');
        if (req.method === 'OPTIONS') return send(res, 204);
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
        if (req.url === '/' || req.url === '/health') return send(res, 200, 'sttv-cors-proxy ' + VERSION + ' ok');
        if (req.url.length > MAX_URL) return send(res, 414, 'url too long');
        var target = req.url.slice(1), u = null;
        if (/^https?%3A/i.test(target)) { try { target = decodeURIComponent(target); } catch (e) {} }
        try { u = urlLib.parse(target); } catch (e) {}
        if (!allowed(u)) return send(res, 403, 'not allowed');
        upstream(u, req, res, 0, Date.now());
    };
}

module.exports = { createHandler: createHandler, allowed: allowed, privateClient: privateClient, version: VERSION };

if (require.main === module) {
    var args = process.argv.slice(2), i,
        opt = { port: +(process.env.PORT || 8787), host: process.env.HOST || '0.0.0.0', quiet: false, allowPublic: process.env.STTV_PROXY_ALLOW_PUBLIC === '1' };
    for (i = 0; i < args.length; i++) {
        if (args[i] === '--port') opt.port = +args[++i];
        else if (args[i] === '--host') opt.host = args[++i];
        else if (args[i] === '--quiet') opt.quiet = true;
        else if (args[i] === '--allow-public') opt.allowPublic = true;
    }
    http.createServer(createHandler({ allowPublic: opt.allowPublic, log: opt.quiet ? null : function (l) { console.log(l); } })).listen(opt.port, opt.host, function () {
        console.log('sttv-cors-proxy ' + VERSION + ' listening on http://' + opt.host + ':' + opt.port + '/' + (opt.allowPublic ? ' (ANY client: --allow-public)' : ' (LAN clients only)'));
    });
}
