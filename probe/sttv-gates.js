/*!
 * sttv-gates.js - go/no-go measurements for the MSE speed path (v2) on the TV. Read-only: creates its own hidden-ish
 * test <video> elements and removes them, changes nothing on disk, does not touch the app's player.
 *   node sttv-cdp.mjs gates [--only caps,g1,g2,g3,g4,g5]   (injects gate-media.js + this file, saves sttv-gates-<time>.json)
 * Before running: close the player (no video playing), stay on a screen without preview playback.
 * G4/G5 need a Twitch VOD opened once in this app session (uses STTVSpeed._ctl.stream) - open a VOD, press Back, run.
 *   caps  MediaSource/codec/decoder capabilities, AudioContext latencies
 *   G1    MSE + element playbackRate 1.5 (does the webOS MSE pipeline honour playbackRate at all?)
 *   G2    MSE timeline compression (mvhd/mdhd timescale x S, element rate 1.0) at S = 1.5 and 2 on 1080p60:
 *         content must advance S x wall clock, no stalls, decoder must sustain 60*S fps
 *   G3    SourceBuffer quota (bytes until QuotaExceededError) -> hls.js maxBufferSize / maxBufferLength
 *   G4    Luna service throughput for real video segments (base64 over the bus) vs. bitrate * S
 *   G5    native HLS + LG mediaOption transport variants @1.5 (experimental, undocumented effect on rate)
 */
(function (w) {
    'use strict';
    if (w.STTVGates) return;
    var doc = w.document;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var nowS = function () { return performance.now() / 1000; };
    function once(t, name, ms) {
        return new Promise(function (res, rej) {
            var to = setTimeout(function () { t.removeEventListener(name, f); rej(new Error('timeout:' + name)); }, ms || 10000);
            function f(e) { clearTimeout(to); t.removeEventListener(name, f); res(e); }
            t.addEventListener(name, f);
        });
    }
    function err(e) { return e ? String((e.name ? e.name + ': ' : '') + (e.message || e)) : 'error'; }
    function b64(s) { var bin = atob(s), u = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function boxes(b, s, e) {
        var out = [], o = s, sz, t;
        while (o + 8 <= e) {
            sz = u32(b, o); t = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
            if (sz === 1) sz = u32(b, o + 8) * 4294967296 + u32(b, o + 12); else if (sz === 0) sz = e - o;
            if (sz < 8 || o + sz > e) break;
            out.push({ t: t, o: o, sz: sz }); o += sz;
        }
        return out;
    }
    function cat(parts) {
        var n = 0, o = 0, i, u;
        for (i = 0; i < parts.length; i++) n += parts[i].length;
        u = new Uint8Array(n);
        for (i = 0; i < parts.length; i++) { u.set(parts[i], o); o += parts[i].length; }
        return u;
    }
    var clip = null;
    function getClip() {
        if (clip) return clip;
        var C = w.__STTV_GATE_CLIP;
        if (!C) throw new Error('gate-media.js not loaded');
        var u8 = b64(C.b64), init = [], media = [];
        boxes(u8, 0, u8.length).forEach(function (bx) {
            var p = u8.subarray(bx.o, bx.o + bx.sz);
            if (bx.t === 'ftyp' || bx.t === 'moov') init.push(p); else if (bx.t === 'moof' || bx.t === 'mdat') media.push(p);
        });
        clip = { codec: C.codec, dur: C.dur, fps: C.fps, init: cat(init), media: cat(media) };
        return clip;
    }
    // Timeline compression (YouTube-PR technique): timescale *= S in mvhd and every mdhd. All sample durations / tfdt /
    // edit lists are in those units, so the presentation timeline shrinks by S and the element plays it at rate 1.0.
    function scaleInit(init, S) {
        var b = init.slice(), touched = [];
        (function walk(s, e) {
            boxes(b, s, e).forEach(function (bx) {
                var h = bx.o + 8;
                if (bx.t === 'mvhd' || bx.t === 'mdhd') {
                    var off = h + 4 + (b[h] === 1 ? 16 : 8), ts = u32(b, off), ns = Math.round(ts * S);
                    b[off] = (ns >>> 24) & 255; b[off + 1] = (ns >>> 16) & 255; b[off + 2] = (ns >>> 8) & 255; b[off + 3] = ns & 255;
                    touched.push(bx.t + ':' + ts + '->' + ns + (Math.abs(ns - ts * S) > 1e-9 ? '(rounded)' : ''));
                } else if (/^(moov|trak|mdia)$/.test(bx.t)) walk(h, bx.o + bx.sz);
            });
        })(0, b.length);
        return { init: b, touched: touched };
    }
    function slope(pts) {
        var n = pts.length, mx = 0, my = 0, sxx = 0, sxy = 0, i, dx;
        if (n < 8) return null;
        for (i = 0; i < n; i++) { mx += pts[i][0]; my += pts[i][1]; }
        mx /= n; my /= n;
        for (i = 0; i < n; i++) { dx = pts[i][0] - mx; sxx += dx * dx; sxy += dx * (pts[i][1] - my); }
        return sxx > 0 ? sxy / sxx : null;
    }
    function quality(v) {
        try {
            if (v.getVideoPlaybackQuality) { var q = v.getVideoPlaybackQuality(); return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames }; }
            if ('webkitDecodedFrameCount' in v) return { total: v.webkitDecodedFrameCount, dropped: v.webkitDroppedFrameCount };
        } catch (e) {}
        return null;
    }
    function ranges(tr) { var o = [], i; try { for (i = 0; i < tr.length; i++) o.push([+tr.start(i).toFixed(3), +tr.end(i).toFixed(3)]); } catch (e) {} return o; }
    function testVideo() {
        var v = doc.createElement('video');
        v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '');
        v.style.cssText = 'position:fixed;right:2%;bottom:4%;width:28%;z-index:2147483646;background:#000;border:2px solid #9146ff';
        doc.body.appendChild(v);
        return v;
    }
    function dispose(v, url) {
        try { v.pause(); } catch (e) {}
        try { v.removeAttribute('src'); while (v.firstChild) v.removeChild(v.firstChild); v.load(); } catch (e2) {}
        try { v.parentNode && v.parentNode.removeChild(v); } catch (e3) {}
        if (url) { try { URL.revokeObjectURL(url); } catch (e4) {} }
    }
    function appender(sb) {
        return function (buf) {
            return new Promise(function (ok, ko) {
                function cl() { sb.removeEventListener('updateend', u); sb.removeEventListener('error', e1); }
                function u() { cl(); ok(); }
                function e1() { cl(); ko(new Error('sourcebuffer_error')); }
                sb.addEventListener('updateend', u); sb.addEventListener('error', e1);
                try { sb.appendBuffer(buf); } catch (e) { cl(); ko(e); }
            });
        };
    }
    // measure currentTime slope + decoded/dropped frame rate while playing
    function measure(v, secs) {
        var pts = [], waiting = 0, t0, q0, raf = 0, rafOn = false;
        function wf() { waiting++; }
        function tick() { if (!rafOn) return; raf++; w.requestAnimationFrame(tick); }
        return sleep(700).then(function () {
            v.addEventListener('waiting', wf);            // stalls inside the window only (startup 'waiting' is normal)
            q0 = quality(v); t0 = nowS();
            if (w.requestAnimationFrame) { rafOn = true; w.requestAnimationFrame(tick); }
            return (function loop() {
                if (nowS() - t0 >= secs || v.ended || v.error) return null;
                pts.push([nowS(), v.currentTime]);
                return sleep(40).then(loop);
            })();
        }).then(function () {
            v.removeEventListener('waiting', wf);
            rafOn = false;
            var q1 = quality(v), dt = nowS() - t0;
            return {
                rate: slope(pts), secs: +dt.toFixed(2), waiting: waiting, ended: v.ended, error: v.error ? v.error.code : null,
                displayHz: raf ? Math.round(raf / dt) : null,
                fps: (q0 && q1 && q1.total > 0) ? { decoded: +((q1.total - q0.total) / dt).toFixed(1), dropped: +((q1.dropped - q0.dropped) / dt).toFixed(1) } : null
            };
        });
    }
    function msePlay(o) {
        var c = getClip(), v = testVideo(), ms = new MediaSource(), url = URL.createObjectURL(ms), res = { S: o.S, rate: o.rate };
        var S = o.S, D = c.dur / S;
        v.src = url;
        return once(ms, 'sourceopen', 6000).then(function () {
            var sb = ms.addSourceBuffer(c.codec), app = appender(sb), si = S !== 1 ? scaleInit(c.init, S) : { init: c.init, touched: [] }, k = 0;
            res.touched = si.touched;
            return app(si.init).then(function next() {
                if (k >= o.copies) return null;
                sb.timestampOffset = k * D; k++;
                return app(c.media).then(next);
            });
        }).then(function () {
            try { ms.endOfStream(); } catch (e) {}
            res.duration = +(+v.duration).toFixed(3); res.expectDuration = +(o.copies * D).toFixed(3); res.buffered = ranges(v.buffered);
            v.defaultPlaybackRate = o.rate; v.playbackRate = o.rate;
            return v.play();
        }).then(function () { return measure(v, o.secs); }).then(function (m) {
            res.elementRate = m.rate === null ? null : +m.rate.toFixed(3);
            res.contentRate = m.rate === null ? null : +(m.rate * S).toFixed(3);
            res.readBack = v.playbackRate; res.waiting = m.waiting; res.ended = m.ended; res.error = m.error;
            res.fps = m.fps; res.fpsExpected = m.rate === null ? null : Math.round(c.fps * m.rate * S);
            // frames that cannot be shown: content fps x S above the display refresh are dropped by design (decimation)
            res.displayHz = m.displayHz; res.contentFps = c.fps;
            res.dropsExpected = (m.rate === null || !m.displayHz) ? null : +Math.max(0, c.fps * m.rate * S - Math.max(m.displayHz, 50)).toFixed(1);
            dispose(v, url); return res;
        }, function (e) { res.error = err(e); dispose(v, url); return res; });
    }
    // ------------------------------------------------------------------ caps
    function caps() {
        var MS = w.MediaSource, out = { ua: navigator.userAgent, deviceInfo: null, mse: {}, video: {}, decoders: {}, audio: null, rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype };
        try { var di = w.PalmSystem && w.PalmSystem.deviceInfo; out.deviceInfo = typeof di === 'string' ? JSON.parse(di) : (di || null); } catch (e) {}
        ['video/mp4; codecs="avc1.64002a"', 'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.4d401f"', 'audio/mp4; codecs="mp4a.40.2"',
            'audio/mp4; codecs="mp4a.40.5"', 'video/mp2t; codecs="avc1.64002a,mp4a.40.2"', 'video/mp4; codecs="hvc1.1.6.L120.90"']
            .forEach(function (t) { out.mse[t] = !!(MS && MS.isTypeSupported && MS.isTypeSupported(t)); });
        var tv = doc.createElement('video');
        ['application/vnd.apple.mpegurl', 'application/x-mpegURL', 'video/mp4'].forEach(function (t) { out.video[t] = tv.canPlayType(t); });
        var ps = [];
        if (w.VideoDecoder && w.VideoDecoder.isConfigSupported) {
            ['prefer-hardware', 'prefer-software'].forEach(function (hw) {
                ps.push(w.VideoDecoder.isConfigSupported({ codec: 'avc1.64002a', codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: hw })
                    .then(function (r) { out.decoders['avc1.64002a/' + hw] = !!(r && r.supported); }, function (e) { out.decoders['avc1.64002a/' + hw] = err(e); }));
            });
        } else out.decoders.VideoDecoder = false;
        try {
            var AC = w.AudioContext || w.webkitAudioContext, ac = new AC({ latencyHint: 'playback' });
            ps.push(sleep(600).then(function () {
                var ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
                out.audio = { sr: ac.sampleRate, base: ac.baseLatency, out: ac.outputLatency, state: ac.state,
                    ots: ts ? +(ac.currentTime - (ts.contextTime + (performance.now() - ts.performanceTime) / 1000)).toFixed(4) : null };
                try { ac.close(); } catch (e) {}
            }));
        } catch (e) { out.audio = err(e); }
        return Promise.all(ps).then(function () { return out; });
    }
    // ------------------------------------------------------------------ G3 quota
    function quota() {
        var c = getClip(), v = testVideo(), ms = new MediaSource(), url = URL.createObjectURL(ms), bytes = c.init.length, k = 0, res = {};
        v.src = url;
        return once(ms, 'sourceopen', 6000).then(function () {
            var sb = ms.addSourceBuffer(c.codec), app = appender(sb);
            return app(c.init).then(function next() {
                if (bytes > 400 * 1048576) { res.limit = 'not reached (>400 MB)'; return null; }
                sb.timestampOffset = k * c.dur;
                return app(c.media).then(function () { bytes += c.media.length; k++; return next(); },
                    function (e) { res.limit = err(e); return null; });
            });
        }).then(function () {
            var secs = k * c.dur;
            res.bytesMB = +(bytes / 1048576).toFixed(1); res.seconds1080p60 = secs; res.buffered = ranges(v.buffered);
            res.atTwitchSourceSec = { '6Mbps': Math.round(bytes * 8 / 6e6), '8Mbps': Math.round(bytes * 8 / 8e6) };
            dispose(v, url); return res;
        }, function (e) { res.error = err(e); dispose(v, url); return res; });
    }
    // ------------------------------------------------------------------ G4 luna throughput
    function lunaCall(params, timeoutMs) {
        return new Promise(function (res, rej) {
            var id = w.PalmSystem && w.PalmSystem.identifier ? String(w.PalmSystem.identifier).split(' ')[0] : '';
            if (typeof w.PalmServiceBridge !== 'function' || !id) { rej(new Error('luna_unavailable')); return; }
            var br = new w.PalmServiceBridge(), t0 = performance.now(), done = false;
            var to = setTimeout(function () { if (done) return; done = true; try { br.cancel(); } catch (e) {} rej(new Error('timeout')); }, timeoutMs || 30000);
            br.onservicecallback = function (msg) {
                if (done) return; done = true; clearTimeout(to);
                var t1 = performance.now(), r = null;
                try { r = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch (e) {}
                var t2 = performance.now();
                try { br.cancel(); } catch (e2) {}
                if (!r || !r.returnValue) { rej(new Error('luna_' + (r ? (r.errorCode || r.status) : 'bad'))); return; }
                var u8 = null, t3 = t2;
                if (r.body64) { u8 = b64(r.body64); t3 = performance.now(); }
                res({ r: r, bytes: u8 ? u8.length : (r.text || '').length, rttMs: t1 - t0, jsonMs: t2 - t1, b64Ms: t3 - t2, svcMs: r.ms || 0 });
            };
            br.call('luna://' + id + '.hls/fetchPlaylist', JSON.stringify(params));
        });
    }
    function luna(o) {
        var S = w.STTVSpeed, st = S && S._ctl && (S._ctl.stream || S._ctl.lastStream), I = S && S._internals, res = { chunks: [] };
        if (!st || !st.pl || !I) return Promise.resolve({ error: 'open a Twitch VOD once in this app session first (STTVSpeed._ctl.stream is empty)' });
        var vars = I.parseMaster(st.pl, st.u).filter(function (x) { return !x.audioOnly; }).sort(function (a, b) { return b.bw - a.bw; });
        if (!vars.length) return Promise.resolve({ error: 'no variants in master playlist' });
        var vr = vars[0];
        res.variant = { uri: vr.uri.replace(/^https?:\/\/([^\/]+)\/.*\/([^\/]+\/[^\/]+)$/, '$1/…/$2'), bw: vr.bw, res: vr.res };
        return lunaCall({ sttvMedia: true, url: vr.uri, encoding: 'utf8', timeoutMs: 15000 }).then(function (pr) {
            var pl = I.parseMedia(pr.r.text, vr.uri), n = pl.segs.length;
            if (!n) throw new Error('empty media playlist');
            var segs = [pl.segs[Math.floor(n * 0.4)], pl.segs[Math.floor(n * 0.4) + 1]], chunk = (o.chunkMB || 2) * 1048576, t0 = performance.now(), total = 0, svc = 0;
            res.playlistMs = Math.round(pr.rttMs);
            function fetchSeg(sg) {
                var off = 0, size = Infinity;
                return (function next() {
                    if (off >= size) return null;
                    var end = Math.min(off + chunk, size) - 1;
                    return lunaCall({ sttvMedia: true, url: sg.uri, range: off + '-' + end, encoding: 'base64', timeoutMs: 20000 }).then(function (c) {
                        var m = /\/(\d+)\s*$/.exec(c.r.contentRange || '');
                        if (m) size = +m[1]; else if (c.bytes < chunk) size = off + c.bytes;
                        res.chunks.push({ kb: Math.round(c.bytes / 1024), rtt: Math.round(c.rttMs), svc: c.svcMs, json: Math.round(c.jsonMs), b64: Math.round(c.b64Ms) });
                        total += c.bytes; svc += c.svcMs; off += c.bytes;
                        if (!c.bytes) size = off;
                        return next();
                    });
                })();
            }
            return fetchSeg(segs[0]).then(function () { return fetchSeg(segs[1]); }).then(function () {
                var secs = (performance.now() - t0) / 1000, mbps = total / 1048576 / secs, content = segs[0].dur + segs[1].dur;
                res.MBps = +mbps.toFixed(2); res.MB = +(total / 1048576).toFixed(2); res.secs = +secs.toFixed(2);
                res.netOnlyMBps = svc ? +(total / 1048576 / (svc / 1000)).toFixed(2) : null;
                res.contentSecPerWallSec = +(content / secs).toFixed(2);          // must be > S with margin
                res.needMBps = { '1.5x': +(vr.bw * 1.5 / 8 / 1048576).toFixed(2), '2x': +(vr.bw * 2 / 8 / 1048576).toFixed(2) };
                res.margin = { '1.5x': +(res.contentSecPerWallSec / 1.5).toFixed(2), '2x': +(res.contentSecPerWallSec / 2).toFixed(2) };
                return res;
            });
        }).then(null, function (e) { res.error = err(e); return res; });
    }
    // ------------------------------------------------------------------ G5 native HLS + mediaOption (experimental)
    function nativeRate(o) {
        var S = w.STTVSpeed, st = S && S._ctl && (S._ctl.stream || S._ctl.lastStream), I = S && S._internals;
        if (!st || !st.pl || !I) return Promise.resolve({ error: 'open a Twitch VOD once in this app session first' });
        var vars = I.parseMaster(st.pl, st.u).filter(function (x) { return !x.audioOnly; }).sort(function (a, b) { return a.bw - b.bw; });
        var uri = (vars[Math.floor(vars.length / 2)] || vars[0]).uri, out = [];
        var opts = [null, { mediaTransportType: 'HLS' }, { mediaTransportType: 'URI' }];
        return opts.reduce(function (p, mo) {
            return p.then(function () {
                var v = testVideo(), src = doc.createElement('source'), r = { mediaOption: mo };
                src.src = uri;
                src.type = 'application/vnd.apple.mpegurl' + (mo ? ';mediaOption=' + encodeURIComponent(JSON.stringify(mo)) : '');
                v.appendChild(src); v.defaultPlaybackRate = o.rate;
                v.preload = 'auto'; v.load();
                // the TV's URI transport never fired canplay before play() in the v1.1 run: start playback and wait for 'playing'
                return once(v, 'canplay', 20000).catch(function () {
                    r.note = 'no canplay in 20 s -> play() first';
                    var pp = v.play(); if (pp && pp.catch) pp.catch(function () {});
                    return once(v, 'playing', 15000);
                }).then(function () {
                    var d = v.duration, to = (isFinite(d) && d > 0) ? d * 0.4 : 0;
                    r.duration = isFinite(d) ? +d.toFixed(1) : String(d);
                    if (!(to > 1)) return null;                       // live-like/unknown duration: measure where it starts
                    v.currentTime = to;
                    return once(v, 'seeked', 20000);
                }).then(function () { v.playbackRate = o.rate; return v.play(); }).then(function () { return sleep(800); })
                    .then(function () { v.playbackRate = o.rate; return measure(v, o.secs); }).then(function (m) {
                        r.elementRate = m.rate === null ? null : +m.rate.toFixed(3); r.readBack = v.playbackRate; r.waiting = m.waiting; r.fps = m.fps;
                    }, function (e) { r.error = err(e); }).then(function () { dispose(v); out.push(r); return sleep(1500); });
            });
        }, Promise.resolve()).then(function () { return out; });
    }
    // ------------------------------------------------------------------ verdict
    function verdict(R) {
        var codes = [], next = [], near = function (a, b, tol) { return a !== null && a !== undefined && Math.abs(a - b) <= tol; };
        if (R.g1) codes.push(near(R.g1.elementRate, 1.5, 0.06) ? 'MSE_RATE_OK' : (near(R.g1.elementRate, 1, 0.05) ? 'MSE_RATE_IGNORED' : 'MSE_RATE_UNCLEAR'));
        (R.g2 || []).forEach(function (g) {
            var ok = near(g.contentRate, g.S, 0.06 * g.S) && !g.waiting && !g.error;
            // v1.1 judged dropped/decoded > 5 %: wrong at S x fps > display Hz, where ~ (fps x S - Hz) frames/s must be dropped
            var dr = g.fps ? g.fps.dropped : null, exp = g.dropsExpected, tol = 3 + 0.05 * (g.contentFps || 60) * g.S, tag = 'OK';
            if (dr !== null && exp !== null && exp !== undefined) tag = dr > exp + tol ? 'OK_DROPS_EXCESS' : (exp > 0 && dr > tol ? 'OK_DECIMATION' : 'OK');
            else if (dr !== null && g.fps.decoded > 0 && dr / g.fps.decoded > 0.05) tag = 'OK_DROPS_UNCHECKED';
            codes.push('COMPRESS_' + g.S + 'x_' + (ok ? tag : 'FAIL'));
        });
        if (R.g3 && R.g3.bytesMB) codes.push('QUOTA_' + R.g3.bytesMB + 'MB');
        if (R.g4 && R.g4.margin) codes.push(R.g4.margin['1.5x'] >= 2 ? 'LUNA_OK' : (R.g4.margin['1.5x'] >= 1.2 ? 'LUNA_TIGHT' : 'LUNA_TOO_SLOW'));
        if (R.g5 && R.g5.length) R.g5.forEach(function (g) { if (near(g.elementRate, 1.5, 0.06)) codes.push('NATIVE_RATE_OK_' + (g.mediaOption ? g.mediaOption.mediaTransportType : 'plain')); });
        if (codes.indexOf('MSE_RATE_OK') >= 0) next.push('v2a: hls.js + current engine (playbackRate on MSE works) - no timeline compression needed');
        else if (codes.some(function (c) { return /^COMPRESS_1.5x_OK/.test(c); })) next.push('v2b: hls.js + patched YT hook (timeline compression, audio via WebCodecs/WSOLA)');
        else next.push('no MSE speed path on this firmware: speed only via re-timing on a LAN server (ffmpeg) or not at all');
        if (codes.indexOf('COMPRESS_2x_OK_DROPS_EXCESS') >= 0 || codes.indexOf('COMPRESS_2x_FAIL') >= 0) next.push('decoder short of 2x 1080p60: cap v2b at 1.5x or STTV_SPEED_V2B_MAXH=720');
        if (codes.indexOf('COMPRESS_2x_OK_DECIMATION') >= 0) next.push('2x 1080p60 decodes fully; drops = display decimation (60 Hz shows every 2nd frame) - not a decoder limit');
        if (codes.indexOf('LUNA_TIGHT') >= 0) next.push('Luna path tight at 2x 1080p60: STTV_SPEED_V2B_MAXH=720 (or LAN proxy) for 2x');
        if (codes.indexOf('LUNA_TOO_SLOW') >= 0) next.push('segments over Luna too slow: use the TV-local HTTP relay in the JS service or the LAN proxy');
        if (codes.some(function (c) { return /^NATIVE_RATE_OK/.test(c); })) next.push('native HLS honours rate with that mediaOption: try it in the bridge first (cheapest fix)');
        return { codes: codes, next: next };
    }
    function run(opts) {
        opts = opts || {};
        var only = opts.only ? String(opts.only).split(',') : ['caps', 'g1', 'g2', 'g3', 'g4', 'g5'], R = { version: '1.2', at: new Date().toISOString() };
        var has = function (k) { return only.indexOf(k) >= 0; }, p = Promise.resolve();
        if (has('caps')) p = p.then(caps).then(function (r) { R.caps = r; });
        if (has('g1')) p = p.then(function () { return msePlay({ S: 1, rate: 1.5, copies: 4, secs: 6 }); }).then(function (r) { R.g1 = r; });
        if (has('g2')) p = p.then(function () { return msePlay({ S: 1.5, rate: 1, copies: 6, secs: 8 }); }).then(function (r) { R.g2 = [r]; })
            .then(function () { return msePlay({ S: 2, rate: 1, copies: 8, secs: 8 }); }).then(function (r) { R.g2.push(r); });
        if (has('g3')) p = p.then(quota).then(function (r) { R.g3 = r; });
        if (has('g4')) p = p.then(function () { return luna({ chunkMB: opts.chunkMB || 2 }); }).then(function (r) { R.g4 = r; });
        if (has('g5')) p = p.then(function () { return nativeRate({ rate: 1.5, secs: 5 }); }).then(function (r) { R.g5 = r; });
        return p.then(function () { R.verdict = verdict(R); return R; }, function (e) { R.error = err(e); R.verdict = verdict(R); return R; });
    }
    w.STTVGates = { run: run, caps: caps, msePlay: msePlay, quota: quota, luna: luna, nativeRate: nativeRate, scaleInit: scaleInit, _verdict: verdict };
})(window);
