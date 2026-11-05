/*
 * sttv_media_fetch.js 1.2.1 - CORS-free GET of Twitch VOD playlists/segments for sttv-speed.js (SmartTwitchTV webOS).
 * Lives in the app's JS service dir (services/<appId>.hls/) and is activated by ONE line at the top of the service's
 * main file (package.json "main", e.g. hls_service.js), inserted by deploy/install.sh:
 *   try { require('./sttv_media_fetch').hookService(require('webos-service')); } catch (e) {} // sttv-speed
 * hookService wraps Service.prototype.register, so it works whatever file registers "fetchPlaylist" and however
 * (inline service.register(...) in hls_service.js, or a hls_playlist_client.js module). v1.1's install(module.exports)
 * only worked for the module layout. Only payload.sttvMedia === true is handled here (same Luna method, no new ACG
 * permissions); everything else goes to the original handler untouched. {sttvMedia:true, ping:true} -> {pong:true}.
 * Allowed: GET, https only (redirects too), default port, no user:pass@, Twitch media hosts, .m3u8/.ts/.mp4/.m4s/.m4a/.aac
 * paths, <= 8 MB, optional single byte range. The URL that is checked is the URL that is requested (one url.parse result).
 * 1.2.1: https only (was http(s)), port 443 only, no userinfo, a throwing request() is reported instead of escaping into
 * the service (tests: tests/service/run.mjs).
 */
'use strict';

var https = require('https');
var urlLib = require('url');

var VERSION = '1.2.1';
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_REDIRECTS = 3;
var HOST_RE = /(^|\.)(cloudfront\.net|ttvnw\.net|jtvnw\.net|live-video\.net|akamaized\.net|twitch\.tv)$/i;
var PATH_RE = /\.(m3u8|ts|mp4|m4s|m4a|aac)$/i;

function allowed(u) {
    return !!u && u.protocol === 'https:' && !u.auth && (!u.port || u.port === '443') &&
        HOST_RE.test(String(u.hostname || '')) && PATH_RE.test(String(u.pathname || ''));
}
function clampInt(v, lo, hi, def) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = def;
    return n < lo ? lo : (n > hi ? hi : n);
}
function get(u, headers, timeoutMs, redirects, cb) {
    var done = false, req;
    function fin(err, status, buf, info) {
        if (done) return;
        done = true;
        cb(err, status, buf, info || {});
    }
    try {
        req = https.request({
            protocol: 'https:', hostname: u.hostname, port: 443, path: u.path, method: 'GET', headers: headers
        }, onResponse);
    } catch (e) { fin(e, 0); return; }
    function onResponse(res) {
        var st = res.statusCode || 0, chunks = [], total = 0;
        if (st >= 300 && st < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
            res.resume();
            var nu = urlLib.parse(urlLib.resolve(urlLib.format(u), res.headers.location));
            if (!allowed(nu)) { fin(new Error('REDIRECT_NOT_ALLOWED'), st); return; }
            done = true;
            get(nu, headers, timeoutMs, redirects + 1, cb);
            return;
        }
        if (st !== 200 && st !== 206) { res.resume(); fin(new Error('UPSTREAM_STATUS_' + st), st); return; }
        res.on('data', function (c) {
            if (done) return;
            total += c.length;
            if (total > MAX_BYTES) { try { req.abort(); } catch (e) {} fin(new Error('RESPONSE_TOO_LARGE'), 413); return; }
            chunks.push(c);
        });
        res.on('end', function () { fin(null, st, Buffer.concat(chunks), { contentRange: res.headers['content-range'] || '' }); });
        res.on('error', function (e) { fin(e, st); });
    }
    req.setTimeout(timeoutMs, function () { try { req.abort(); } catch (e) {} fin(new Error('TIMEOUT'), 504); });
    req.on('error', function (e) { fin(e, 0); });
    req.end();
}
function fetchMedia(payload, callback) {
    var url = String(payload && payload.url || ''), u = null, headers, t0 = Date.now();
    try { u = urlLib.parse(url); } catch (e) {}
    if (!allowed(u)) {
        callback({ returnValue: false, sttvMedia: true, status: 403, errorCode: 'URL_NOT_ALLOWED' });
        return;
    }
    headers = { 'User-Agent': 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) sttv-speed', Accept: '*/*' };
    if (payload.range && /^\d+-\d+$/.test(String(payload.range))) headers.Range = 'bytes=' + payload.range;
    get(u, headers, clampInt(payload.timeoutMs, 2000, 30000, 15000), 0, function (err, status, buf, info) {
        if (err) {
            callback({ returnValue: false, sttvMedia: true, status: status || 0, errorCode: String(err.message || 'NETWORK_ERROR') });
            return;
        }
        var r = { returnValue: true, sttvMedia: true, status: status, bytes: buf.length, contentRange: info.contentRange, ms: Date.now() - t0 };
        if (payload.encoding === 'utf8') r.text = buf.toString('utf8'); else r.body64 = buf.toString('base64');
        callback(r);
    });
}
function handle(payload, callback) {
    if (payload.ping) { callback({ returnValue: true, sttvMedia: true, pong: true, version: VERSION, pid: process.pid }); return; }
    fetchMedia(payload, callback);
}
// v1.1 style: wrap a module that exports fetchPlaylist(payload, callback)
function install(client) {
    if (!client || client.__sttvMedia || typeof client.fetchPlaylist !== 'function') return;
    var orig = client.fetchPlaylist;
    client.fetchPlaylist = function (payload, callback) {
        if (payload && typeof payload === 'object' && payload.sttvMedia === true) return handle(payload, callback);
        return orig.apply(this, arguments);
    };
    client.__sttvMedia = true;
}
// v1.2: wrap webos-service's Service.prototype.register before the service file registers its methods
function hookService(mod) {
    // webos-service exports the Service constructor itself; accept { Service } too
    var Service = typeof mod === 'function' ? mod : (mod && typeof mod.Service === 'function' ? mod.Service : null);
    var P = Service && Service.prototype;
    if (!P || P.__sttvMedia || typeof P.register !== 'function') return false;
    var reg = P.register;
    P.register = function (name, cb) {
        var args = Array.prototype.slice.call(arguments);
        if (name === 'fetchPlaylist' && typeof cb === 'function') {
            args[1] = function (message) {
                var p = message && message.payload;
                if (p && typeof p === 'object' && p.sttvMedia === true) {
                    handle(p, function (r) { try { message.respond(r); } catch (e) {} });
                    return;
                }
                return cb.apply(this, arguments);
            };
        }
        return reg.apply(this, args);
    };
    P.__sttvMedia = true;
    return true;
}

module.exports = { install: install, hookService: hookService, fetchMedia: fetchMedia, allowed: allowed, version: VERSION };
