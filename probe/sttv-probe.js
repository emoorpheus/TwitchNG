/*!
 * sttv-probe.js v1.0.0 - step 1 diagnostics for SmartTwitchTV on LG webOS: does the TV's native player honor
 * video.playbackRate and preservesPitch, and are the building blocks of sttv-speed.js available?
 * Use while a VOD is PLAYING in the app (DevTools console of the app, http://<tv-ip>:9998, or via sttv-cdp.mjs):
 *   r = await STTVProbe.run(); copy(JSON.stringify(r))   -> full JSON report (r.verdict = summary)
 *   await STTVProbe.ear(1.5)                              -> listening A/B test (1x / 1.5x pitch ON / 1.5x pitch OFF)
 *   await STTVProbe.beep()                                -> is WebAudio audible while the video plays?
 * Changes only playbackRate / preservesPitch / muted of the main <video> temporarily and restores them.
 */
(function (w) {
    'use strict';
    var VERSION = '1.0.0', doc = w.document;
    // 0.64 s ADTS AAC-LC 48 kHz stereo with a single impulse at input sample 12000 (ffmpeg decode: peak at 13024).
    var CLICK_B64 = '//FMgAOf/NwATGF2YzYxLjMuMTAwAEIgCMEYOP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8ISAEYIwc//FMgCRf/CFMNoAH///4AEYHt+3pN0PQAPi/t58dd/dWYKnFbgrEHaYrHHWgbMHUYbvHPgbsHJ4MDJKAMeE+t4/J9aIEB0qTGDj4gMPTpMYe/iAxdIkxi5iIDF3CTEPuogIfYJMQ/FiAR9ckwj5eIBH1CTATnIgAn/rJq8esAAAkCGSiFAADPO3QAAtImBGAADLPNoAAScDAiSiDASAAAAAHp3/C+b/4IBJiyUZ9bqIxYAAAAABbiSUWDg6CMWDlQxKLCAAAAAAAAyuIjAfnQJJ78fgIvgAAAAAAAAfeCR0/uyJ00QAkZIAAAAAAAHL5EI+UCQCdXkQE9wzsQAAAAAAAAAAIwPR9H0PQAPi/t58dd/dWYAAAAAAAAAAAAAAAAOD/8UyAAb/8IXAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHA==';
    var REF_PEAK = 13024;
    var SR_TAB = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    var EVTS = ['ratechange', 'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'playing', 'emptied', 'loadstart',
        'loadedmetadata', 'durationchange', 'error', 'ended', 'volumechange'];

    function now() { return (w.performance && w.performance.now) ? w.performance.now() : Date.now(); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function errStr(e) { return e ? String(e.message || e.name || e) : 'error'; }
    function rnd(x, d) { if (typeof x !== 'number' || !isFinite(x)) return x; var m = Math.pow(10, d || 0); return Math.round(x * m) / m; }
    function mask(u) { return u ? String(u).replace(/[?#].*$/, '') : u; }
    function parseJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch (e) { return null; } }
    function log(m) { try { w.console.log('[sttv-probe] ' + m); } catch (e) {} }
    function mainVideo() {
        var v = doc.getElementById('sttv_main'), all, i, best = null;
        if (v) return v;
        all = doc.getElementsByTagName('video');
        for (i = 0; i < all.length; i++) if (!all[i].paused && (!best || all[i].clientWidth > best.clientWidth)) best = all[i];
        return best || all[0] || null;
    }
    function xhr(url, type, range, ms) {
        return new Promise(function (res, rej) {
            var x = new XMLHttpRequest(), t0 = now();
            x.open('GET', url, true);
            x.responseType = type || 'text';
            x.timeout = ms || 10000;
            if (range) x.setRequestHeader('Range', 'bytes=' + range[0] + '-' + range[1]);
            x.onload = function () {
                if ((x.status >= 200 && x.status < 300) || (x.status === 0 && x.response)) res({ body: x.response, status: x.status, ms: Math.round(now() - t0) });
                else rej(new Error('http_' + x.status));
            };
            x.onerror = function () { rej(new Error('network_or_cors')); };
            x.ontimeout = function () { rej(new Error('timeout')); };
            x.send();
        });
    }
    function setPitch(v, on) {
        try { v.preservesPitch = on; } catch (e) {}
        try { if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = on; } catch (e) {}
    }
    function snapshot(v) {
        return { rate: v.playbackRate, def: v.defaultPlaybackRate, pp: v.preservesPitch, wpp: v.webkitPreservesPitch, muted: v.muted, vol: v.volume };
    }
    function restore(v, s) {
        if (!v || !s) return;
        try { if (s.pp !== undefined) v.preservesPitch = s.pp; } catch (e) {}
        try { if (s.wpp !== undefined) v.webkitPreservesPitch = s.wpp; } catch (e) {}
        try { v.defaultPlaybackRate = s.def; v.playbackRate = s.rate; v.muted = s.muted; v.volume = s.vol; } catch (e) {}
    }
    function ranges(tr) { var o = [], i; if (tr) for (i = 0; i < tr.length && i < 4; i++) o.push([rnd(tr.start(i), 2), rnd(tr.end(i), 2)]); return o; }
    function quality(v) {
        try { var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null; } catch (e) { return null; }
    }

    // ------------------------------------------------------------------ environment
    function env() {
        var nav = w.navigator || {}, ua = String(nav.userAgent || ''), m = /Chrome\/(\d+)/.exec(ua);
        var P = w.HTMLMediaElement ? w.HTMLMediaElement.prototype : {}, VP = w.HTMLVideoElement ? w.HTMLVideoElement.prototype : {}, tv = doc.createElement('video');
        var MS = w.MediaSource, AC = w.AudioContext || w.webkitAudioContext, sys = w.webOSSystem || w.PalmSystem || null;
        var di = sys ? parseJson(sys.deviceInfo) : null, A = w.Android, methods = [], k;
        function mse(t) { try { return MS && MS.isTypeSupported ? MS.isTypeSupported(t) : null; } catch (e) { return null; } }
        if (A) { try { for (k in A) if (typeof A[k] === 'function') methods.push(k); } catch (e) {} }
        return {
            probe: VERSION, ua: ua, chrome: m ? +m[1] : null, href: mask(w.location && w.location.href),
            device: di ? { model: di.modelName || null, platform: di.platformVersion || null, sdk: di.sdkVersion || null } : null,
            cores: nav.hardwareConcurrency || null, memGB: nav.deviceMemory || null,
            api: {
                preservesPitch: 'preservesPitch' in P, webkitPreservesPitch: 'webkitPreservesPitch' in P,
                hlsNative: tv.canPlayType('application/vnd.apple.mpegurl') || tv.canPlayType('application/x-mpegURL') || '',
                mse: !!MS, mseTs: mse('video/mp2t; codecs="avc1.4d401f,mp4a.40.2"'), mseMp4: mse('video/mp4; codecs="avc1.4d401f"'),
                mseAudioMp4: mse('audio/mp4; codecs="mp4a.40.2"'),
                webcodecsAudio: !!w.AudioDecoder, audioContext: !!AC, audioWorklet: !!w.AudioWorkletNode,
                getOutputTimestamp: !!(AC && AC.prototype.getOutputTimestamp), outputLatency: !!(AC && 'outputLatency' in AC.prototype),
                rvfc: 'requestVideoFrameCallback' in VP, playbackQuality: 'getVideoPlaybackQuality' in VP
            },
            app: {
                hlsjs: w.Hls ? (w.Hls.version || true) : false, androidMethods: methods.length, androidHas: {
                    setPlaybackSpeed: !!(A && A.setPlaybackSpeed), StartAuto: !!(A && A.StartAuto), stopVideo: !!(A && A.stopVideo)
                }, sttvSpeed: w.STTVSpeed ? (w.STTVSpeed.version || true) : null, videos: doc.getElementsByTagName('video').length
            }
        };
    }
    function vstate(v) {
        if (!v) return null;
        return {
            id: v.id || null, src: mask(v.currentSrc || v.src || ''), srcKind: /^blob:/.test(v.currentSrc || v.src) ? 'blob' : (/^https?:/.test(v.currentSrc || v.src) ? 'http' : 'other'),
            ct: rnd(v.currentTime, 3), dur: isFinite(v.duration) ? rnd(v.duration, 1) : String(v.duration), paused: v.paused, readyState: v.readyState,
            networkState: v.networkState, rate: v.playbackRate, defRate: v.defaultPlaybackRate, pp: v.preservesPitch, wpp: v.webkitPreservesPitch,
            muted: v.muted, vol: v.volume, size: v.videoWidth + 'x' + v.videoHeight, buffered: ranges(v.buffered),
            audioTracks: v.audioTracks ? v.audioTracks.length : null, aBytes: v.webkitAudioDecodedByteCount, vBytes: v.webkitVideoDecodedByteCount,
            frames: quality(v)
        };
    }

    // ------------------------------------------------------------------ pipeline + audio source discovery
    var QUALITY_DIR = /^(chunked|audio_only|\d{3,4}p\d{0,3})$/i;
    function deriveAudioOnly(url) {
        var m = /^(https?:\/\/[^?#]*\/)([^\/?#]+)\/([^\/?#]+\.m3u8)(\?[^#]*)?$/i.exec(String(url || ''));
        if (!m || !QUALITY_DIR.test(m[2])) return null;
        return m[1] + 'audio_only/' + m[3] + (m[4] || '');
    }
    function abs(rel, base) { try { return new URL(rel, base).href; } catch (e) { return rel; } }
    function masterAudio(txt, base) {
        var lines = txt.split(/\r?\n/), i, l, inf = null, best = null, low = null, m;
        for (i = 0; i < lines.length; i++) {
            l = lines[i].trim();
            if (l.indexOf('#EXT-X-STREAM-INF:') === 0) inf = l;
            else if (l && l.charAt(0) !== '#' && inf) {
                var u = abs(l, base), codecs = (/CODECS="([^"]*)"/.exec(inf) || [])[1] || '', bw = +((/BANDWIDTH=(\d+)/.exec(inf) || [])[1] || 0);
                if (/VIDEO="audio_only"/.test(inf) || /\/audio_only\//.test(u) || (/mp4a/.test(codecs) && !/avc|hvc|hev|av01|vp0/.test(codecs))) { if (!best) best = u; }
                else if ((!codecs || /mp4a/.test(codecs)) && (!low || bw < low.bw)) low = { u: u, bw: bw };
                inf = null;
            }
        }
        return best ? { url: best, kind: 'audio_only' } : (low ? { url: low.u, kind: 'variant' } : null);
    }
    function pipeline(v) {
        var src = v ? String(v.currentSrc || v.src || '') : '', o = { kind: 'none' };
        if (!src) return Promise.resolve(o);
        if (/^https?:/i.test(src)) {
            o.kind = /\.m3u8(\?|$)/i.test(src) ? 'native_hls_url' : 'native_url';
            o._url = src;
            return Promise.resolve(o);
        }
        if (!/^blob:/i.test(src)) { o.kind = 'other'; return Promise.resolve(o); }
        return xhr(src, 'text', null, 5000).then(function (r) {
            var t = String(r.body || '');
            if (t.indexOf('#EXTM3U') < 0) { o.kind = 'blob_not_m3u8'; return o; }
            o.kind = t.indexOf('#EXT-X-STREAM-INF') >= 0 ? 'native_hls_blob_master' : 'native_hls_blob_media';
            var segs = t.match(/^[^#\s].*$/mg) || [];
            o.entries = segs.length; o.endlist = t.indexOf('#EXT-X-ENDLIST') >= 0; o.fmp4 = t.indexOf('#EXT-X-MAP') >= 0;
            o._text = t; o._first = segs.length ? segs[0].trim() : null;
            return o;
        }, function (e) {
            o.kind = 'blob_unreadable'; o.hint = 'MediaSource (MSE/hls.js) object URL or revoked blob'; o.err = errStr(e);
            return o;
        });
    }
    function audioSource(pipe) {
        var d;
        if (pipe._url) {
            d = deriveAudioOnly(pipe._url);
            if (d) return Promise.resolve({ url: d, kind: 'derived', from: 'src' });
            return xhr(pipe._url, 'text', null, 8000).then(function (r) {
                var t = String(r.body || '');
                if (t.indexOf('#EXT-X-STREAM-INF') >= 0) {
                    var a = masterAudio(t, pipe._url);
                    if (a) { a.from = 'master'; return a; }
                }
                var first = (t.match(/^[^#\s].*$/m) || [])[0];
                d = first ? deriveAudioOnly(abs(first.trim(), pipe._url).replace(/\/[^\/?#]*(\?[^#]*)?$/, '/index-dvr.m3u8')) : null;
                return d ? { url: d, kind: 'derived', from: 'segment' } : { url: pipe._url, kind: 'same', from: 'src' };
            });
        }
        if (pipe._text) {
            if (pipe.kind === 'native_hls_blob_master') {
                var a2 = masterAudio(pipe._text, w.location.href);
                if (a2) { a2.from = 'blob_master'; return Promise.resolve(a2); }
            }
            d = pipe._first && /^https?:/i.test(pipe._first) ? deriveAudioOnly(pipe._first.replace(/\/[^\/?#]*(\?[^#]*)?$/, '/index-dvr.m3u8')) : null;
            if (d) return Promise.resolve({ url: d, kind: 'derived', from: 'blob_segment' });
        }
        return Promise.reject(new Error('cannot_find_audio_source'));
    }
    function lunaName() {
        try { var id = w.PalmSystem && w.PalmSystem.identifier ? String(w.PalmSystem.identifier).split(' ')[0] : ''; return id ? id + '.hls' : ''; } catch (e) { return ''; }
    }
    // The app's JS service (<appId>.hls/fetchPlaylist). Patched by deploy/install.sh to serve sttvMedia requests.
    function lunaTest(url) {
        var name = lunaName(), t0 = now();
        if (!name || typeof w.PalmServiceBridge !== 'function') return Promise.resolve({ state: 'unavailable' });
        return new Promise(function (res) {
            var b = null, done = false, timer;
            function fin(o) { if (done) return; done = true; clearTimeout(timer); try { b.onservicecallback = null; b.cancel(); } catch (e) {} o.ms = Math.round(now() - t0); o.service = name; res(o); }
            try { b = new w.PalmServiceBridge(); } catch (e) { fin({ state: 'bridge_error', err: errStr(e) }); return; }
            b.onservicecallback = function (msg) {
                var r = null; try { r = JSON.parse(msg); } catch (e) {}
                if (r && r.returnValue && r.sttvMedia) fin({ state: 'patched_ok', bytes: r.text ? r.text.length : r.bytes });
                else if (r && r.sttvMedia) fin({ state: 'patched_error', err: r.errorCode, status: r.status });
                else fin({ state: r ? 'reachable_unpatched' : 'bad_reply', err: r && (r.errorCode || r.errorText) });
            };
            timer = setTimeout(function () { fin({ state: 'timeout' }); }, 12000);
            try { b.call('luna://' + name + '/fetchPlaylist', JSON.stringify({ sttvMedia: true, url: url, encoding: 'utf8', timeoutMs: 10000 })); } catch (e) { fin({ state: 'call_error', err: errStr(e) }); }
        });
    }
    function proxyTest(url) {
        var px = ''; try { px = String(w.localStorage.getItem('STTV_SPEED_PROXY') || ''); } catch (e) {}
        if (!/^https?:\/\//.test(px)) return Promise.resolve(null);
        if (px.charAt(px.length - 1) !== '/') px += '/';
        return xhr(px + url, 'text', null, 8000).then(function (r) { return { state: 'ok', proxy: px, ms: r.ms }; }, function (e) { return { state: 'failed', proxy: px, err: errStr(e) }; });
    }
    function audioFetchTest(pipe) {
        var o = {};
        return audioSource(pipe).then(function (s) {
            o.kind = s.kind; o.from = s.from; o.url = mask(s.url);
            var side = Promise.all([lunaTest(s.url), proxyTest(s.url)]).then(function (x) { o.luna = x[0]; if (x[1]) o.proxy = x[1]; });
            return side.then(function () { return xhr(s.url, 'text', null, 10000); }).then(function (r) {
                var t = String(r.body || ''), segs = t.match(/^[^#\s].*$/mg) || [], durs = t.match(/#EXTINF:([\d.]+)/g) || [], total = 0, i;
                for (i = 0; i < durs.length; i++) total += parseFloat(durs[i].slice(8));
                o.playlistMs = r.ms; o.segments = segs.length; o.totalSec = rnd(total, 1); o.fmp4 = t.indexOf('#EXT-X-MAP') >= 0;
                o.endlist = t.indexOf('#EXT-X-ENDLIST') >= 0;
                if (!segs.length) throw new Error('empty_playlist');
                var mid = segs[Math.min(segs.length - 1, Math.floor(segs.length / 2))].trim(), segUrl = abs(mid, s.url);
                return xhr(segUrl, 'arraybuffer', [0, 65535], 10000);
            }).then(function (r) {
                var u = new Uint8Array(r.body), i, adts = 0;
                o.segMs = r.ms; o.segStatus = r.status; o.segBytes = u.length;
                o.rangeHonored = r.status === 206 || u.length <= 65536;
                o.container = (u[0] === 0x47 && u[188] === 0x47) ? 'ts' :
                    (String.fromCharCode(u[4], u[5], u[6], u[7]).match(/ftyp|styp|moof|sidx/) ? 'fmp4' : 'unknown');
                for (i = 0; i + 1 < u.length; i++) if (u[i] === 0xff && (u[i + 1] & 0xf6) === 0xf0) adts++;
                o.adtsSyncs = adts;
                o.ok = o.container !== 'unknown';
                return o;
            });
        }).catch(function (e) { o.ok = false; o.err = errStr(e); return o; });
    }

    // ------------------------------------------------------------------ playbackRate measurement
    function fit(pts) {
        var n = pts.length, mt = 0, mc = 0, sxy = 0, sxx = 0, syy = 0, i, dx, dy, b, res = 0;
        if (n < 5) return null;
        for (i = 0; i < n; i++) { mt += pts[i][0]; mc += pts[i][1]; }
        mt /= n; mc /= n;
        for (i = 0; i < n; i++) { dx = pts[i][0] - mt; dy = pts[i][1] - mc; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
        if (!sxx) return null;
        b = sxy / sxx;
        for (i = 0; i < n; i++) { dy = pts[i][1] - (mc + b * (pts[i][0] - mt)); res += dy * dy; }
        return { slope: b * 1000, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0, residMs: Math.sqrt(res / n) * 1000 };
    }
    function measure(v, c) {
        var evs = {}, pts = [], steps = [], q0, a0, t0, readBack, first = null;
        function on(e) { evs[e.type] = (evs[e.type] || 0) + 1; }
        EVTS.forEach(function (n) { v.addEventListener(n, on); });
        if (c.pitch !== undefined) setPitch(v, c.pitch);
        if (c.muted !== undefined) v.muted = c.muted;
        v.playbackRate = c.rate;
        readBack = v.playbackRate;
        return sleep(c.settle).then(function () {
            q0 = quality(v); a0 = v.webkitAudioDecodedByteCount; t0 = now();
            return new Promise(function (res) {
                var last = null;
                (function tick() {
                    var t = now(), ct = v.currentTime;
                    if (!v.paused && !v.seeking) { pts.push([t, ct]); if (first === null) first = ct; }
                    if (last !== null && ct !== last) steps.push(Math.abs(ct - last));
                    last = ct;
                    if (t - t0 >= c.dwell) return res();
                    setTimeout(tick, 50);
                })();
            });
        }).then(function () {
            var q1 = quality(v), a1 = v.webkitAudioDecodedByteCount, el = (now() - t0) / 1000, f = fit(pts);
            EVTS.forEach(function (n) { v.removeEventListener(n, on); });
            steps.sort(function (a, b) { return a - b; });
            return {
                req: c.rate, label: c.label || null, readBack: readBack, readAfter: v.playbackRate, pitch: c.pitch, muted: v.muted,
                eff: f ? rnd(f.slope, 4) : null, ratio: f ? rnd(f.slope / c.rate, 4) : null, r2: f ? rnd(f.r2, 5) : null,
                residMs: f ? rnd(f.residMs, 1) : null, n: pts.length, minStepMs: steps.length ? rnd(steps[0] * 1000, 1) : null,
                medStepMs: steps.length ? rnd(steps[steps.length >> 1] * 1000, 1) : null, events: evs,
                framesPerS: (q0 && q1) ? rnd((q1.total - q0.total) / el, 1) : null, droppedPerS: (q0 && q1) ? rnd((q1.dropped - q0.dropped) / el, 2) : null,
                aBytesPerS: (typeof a0 === 'number' && typeof a1 === 'number') ? Math.round((a1 - a0) / el) : null,
                paused: v.paused, ct: rnd(v.currentTime, 2)
            };
        });
    }

    // ------------------------------------------------------------------ decoders (click clip -> peak position)
    function b64(s) { var bin = w.atob(s), u = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    function adtsFrames(u) {
        var out = [], p = 0, prot, hl, len;
        while (p + 7 <= u.length) {
            if (u[p] !== 0xff || (u[p + 1] & 0xf6) !== 0xf0) { p++; continue; }
            prot = u[p + 1] & 1; hl = prot ? 7 : 9;
            len = ((u[p + 3] & 3) << 11) | (u[p + 4] << 3) | (u[p + 5] >> 5);
            if (len < hl || p + len > u.length) break;
            out.push({ hdr: u.subarray(p, p + 7), raw: u.subarray(p + hl, p + len) });
            p += len;
        }
        return out;
    }
    function ascOf(h) {
        var aot = ((h[2] >> 6) & 3) + 1, sfi = (h[2] >> 2) & 15, ch = ((h[2] & 1) << 2) | (h[3] >> 6);
        return { aot: aot, sr: SR_TAB[sfi], ch: ch, asc: new Uint8Array([(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (ch << 3)]) };
    }
    function planesOf(ad) {
        var n = ad.numberOfFrames, ch = ad.numberOfChannels, out = [], c, i, t, fmt = ad.format;
        for (c = 0; c < ch; c++) out.push(new Float32Array(n));
        try { for (c = 0; c < ch; c++) ad.copyTo(out[c], { planeIndex: c, format: 'f32-planar' }); return out; } catch (e) {}
        if (fmt === 'f32-planar') { for (c = 0; c < ch; c++) ad.copyTo(out[c], { planeIndex: c }); return out; }
        if (fmt === 'f32') { t = new Float32Array(n * ch); ad.copyTo(t, { planeIndex: 0 }); for (i = 0; i < n; i++) for (c = 0; c < ch; c++) out[c][i] = t[i * ch + c]; return out; }
        if (fmt === 's16') { t = new Int16Array(n * ch); ad.copyTo(t, { planeIndex: 0 }); for (i = 0; i < n; i++) for (c = 0; c < ch; c++) out[c][i] = t[i * ch + c] / 32768; return out; }
        if (fmt === 's16-planar') { t = new Int16Array(n); for (c = 0; c < ch; c++) { ad.copyTo(t, { planeIndex: c }); for (i = 0; i < n; i++) out[c][i] = t[i] / 32768; } return out; }
        throw new Error('audio_format_' + fmt);
    }
    function peakOf(chans) {
        var best = -1, bi = -1, i, s, L = chans[0], R = chans[1] || chans[0];
        for (i = 0; i < L.length; i++) { s = Math.abs(L[i] + R[i]); if (s > best) { best = s; bi = i; } }
        return bi;
    }
    // he=true: the config hls.js builds from ADTS on Chrome (explicit HE-AAC/SBR signalling, 'mp4a.40.5',
    // extension rate = core rate) - what an MSE hook's audio decoder receives from hls.js.
    function wcTest(he) {
        if (!w.AudioDecoder) return Promise.resolve({ ok: false, err: 'no_AudioDecoder' });
        var fr = adtsFrames(b64(CLICK_B64)), a = ascOf(fr[0].hdr), t0 = now(), fmt = null, outSr = 0, fpc = 0;
        var sfi = (fr[0].hdr[2] >> 2) & 15, asc = a.asc, codec = 'mp4a.40.' + a.aot;
        if (he) {
            asc = new Uint8Array([(5 << 3) | ((sfi & 0x0e) >> 1), ((sfi & 1) << 7) | (a.ch << 3) | ((sfi & 0x0e) >> 1), ((sfi & 1) << 7) | (2 << 2), 0]);
            codec = 'mp4a.40.5';
        }
        var conf = { codec: codec, sampleRate: a.sr, numberOfChannels: a.ch, description: asc };
        return w.AudioDecoder.isConfigSupported(conf).then(function (s) {
            if (!s || !s.supported) return { ok: false, err: 'config_unsupported' };
            return new Promise(function (res, rej) {
                var parts = [], dec = new w.AudioDecoder({
                    output: function (ad) { try { fmt = fmt || ad.format; outSr = outSr || ad.sampleRate; fpc = fpc || ad.numberOfFrames; parts.push(planesOf(ad)); } catch (e) { rej(e); } ad.close(); },
                    error: function (e) { rej(e); }
                }), i;
                dec.configure(conf);
                for (i = 0; i < fr.length; i++) dec.decode(new w.EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * 1024 * 1e6 / a.sr), data: fr[i].raw }));
                dec.flush().then(function () { try { dec.close(); } catch (e) {} res(parts); }, rej);
            }).then(function (parts) {
                var n = 0, i, c, L, R, o = 0;
                for (i = 0; i < parts.length; i++) n += parts[i][0].length;
                L = new Float32Array(n); R = new Float32Array(n);
                for (i = 0; i < parts.length; i++) { L.set(parts[i][0], o); R.set(parts[i][1] || parts[i][0], o); o += parts[i][0].length; }
                c = peakOf([L, R]);
                var c48 = outSr ? Math.round(c * 48000 / outSr) : c;
                return { ok: true, codec: codec, samples: n, outRate: outSr, framesPerChunk: fpc, peak: c, vsFfmpeg: c48 - REF_PEAK, format: fmt, ms: Math.round(now() - t0) };
            });
        }).catch(function (e) { return { ok: false, err: errStr(e) }; });
    }
    function dadTest(ctx) {
        var u = b64(CLICK_B64), t0 = now();
        return new Promise(function (res, rej) {
            var p = ctx.decodeAudioData(u.buffer.slice(0), res, rej);
            if (p && p.then) p.then(res, rej);
        }).then(function (ab) {
            var ch = [ab.getChannelData(0), ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)], pk = peakOf(ch);
            var pk48 = Math.round(pk * 48000 / ab.sampleRate);
            return { ok: true, samples: ab.length, sr: ab.sampleRate, peak: pk, peak48k: pk48, vsFfmpeg: pk48 - REF_PEAK, ms: Math.round(now() - t0) };
        }, function (e) { return { ok: false, err: errStr(e) }; });
    }
    function audioContextTest() {
        var AC = w.AudioContext || w.webkitAudioContext, ctx, o = {};
        if (!AC) return Promise.resolve({ ok: false, err: 'no_AudioContext' });
        try { ctx = new AC({ latencyHint: 'playback', sampleRate: 48000 }); } catch (e) { try { ctx = new AC(); o.fallbackCtor = true; } catch (e2) { return Promise.resolve({ ok: false, err: errStr(e2) }); } }
        o.sampleRate = ctx.sampleRate; o.state0 = ctx.state;
        var p0, c0;
        return Promise.resolve(ctx.resume ? ctx.resume() : null).then(null, function () {}).then(function () {
            p0 = now(); c0 = ctx.currentTime;
            return sleep(1500);
        }).then(function () {
            var el = (now() - p0) / 1000, ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
            o.state = ctx.state; o.clockRatio = rnd((ctx.currentTime - c0) / el, 4);
            o.baseLatencyMs = rnd((ctx.baseLatency || 0) * 1000, 1); o.outputLatencyMs = ctx.outputLatency !== undefined ? rnd(ctx.outputLatency * 1000, 1) : null;
            if (ts && ts.performanceTime) o.outputTs = { ctxMinusTsMs: rnd((ctx.currentTime - ts.contextTime) * 1000, 1), perfAgeMs: rnd(now() - ts.performanceTime, 1) };
            o.ok = ctx.state === 'running' && o.clockRatio > 0.9 && o.clockRatio < 1.1;
            return dadTest(ctx);
        }).then(function (d) {
            o.dad = d;
            try { ctx.close(); } catch (e) {}
            return o;
        }, function (e) { o.ok = false; o.err = errStr(e); try { ctx.close(); } catch (x) {} return o; });
    }

    // ------------------------------------------------------------------ verdict
    function verdict(r) {
        var out = { codes: [], rates: {}, next: [] }, base = null, i, x, ok = 0, ign = 0, other = 0;
        for (i = 0; i < r.rates.length; i++) if (r.rates[i].req === 1 && !r.rates[i].label) base = r.rates[i];
        for (i = 0; i < r.rates.length; i++) {
            x = r.rates[i];
            if (x.req === 1) continue;
            var key = x.req + (x.label ? '_' + x.label : ''), st;
            if (x.eff === null || x.paused) st = 'NO_DATA';
            else if (Math.abs(x.ratio - 1) <= 0.03) st = 'OK';
            else if (Math.abs(x.eff - 1) <= 0.03) st = 'IGNORED';
            else st = 'WRONG(' + x.eff + ')';
            if (st === 'OK') ok++; else if (st === 'IGNORED') ign++; else other++;
            if (x.events.loadstart || x.events.emptied) st += '+RELOAD';
            else if (x.events.waiting || x.events.seeking) st += '+STALL';
            if (base && base.aBytesPerS > 0 && typeof x.aBytesPerS === 'number' && x.aBytesPerS < base.aBytesPerS * 0.1) st += '+AUDIO_STOPPED';
            if (base && base.framesPerS > 5 && typeof x.framesPerS === 'number' && x.framesPerS < 0.5 * Math.min(base.framesPerS * x.req, 60)) st += '+LOW_FPS(' + x.framesPerS + ')';
            out.rates[key] = st;
        }
        if (ok && !ign && !other) out.codes.push('NATIVE_RATE_OK');
        else if (ign && !ok) out.codes.push('RATE_IGNORED');
        else out.codes.push('RATE_PARTIAL');
        var wc = r.decoders.webcodecs, dad = r.audioContext && r.audioContext.dad;
        out.decoder = wc && wc.ok ? 'wc' : (dad && dad.ok ? 'dad' : 'none');
        if (wc && wc.ok && dad && dad.ok) out.dadShift = dad.peak48k - wc.peak;
        else if (dad && dad.ok) out.dadShift = dad.vsFfmpeg;
        out.webaudio = !!(r.audioContext && r.audioContext.ok);
        out.audioOnly = !!(r.audioFetch && r.audioFetch.ok);
        var af = r.audioFetch || {}, ls = af.luna ? af.luna.state : 'n/a';
        out.net = af.ok ? 'direct' : (ls === 'patched_ok' ? 'luna' : (af.proxy && af.proxy.state === 'ok' ? 'proxy' : 'blocked'));
        out.luna = ls;
        if (out.codes[0] === 'NATIVE_RATE_OK') {
            out.next.push('Видео нативно ускоряется. Проверь тон на слух: await STTVProbe.ear(1.5). ' +
                'B (pitch ON) звучит нормально, а C (OFF) пищит, значит нативный preservesPitch работает: достаточно localStorage.STTV_SPEED_MODE="native". ' +
                'Если B и C одинаково пищат (или звук пропадает), ставь sttv-speed.js в режиме auto.');
        } else if (out.codes[0] === 'RATE_IGNORED') {
            out.next.push('ТВ игнорирует playbackRate у нативного HLS. sttv-speed.js тут не поможет (видео не ускорится). Нужен MSE-путь (hls.js) с hls-recover-fix.js.');
        } else {
            out.next.push('Скорость применяется частично, смотри rates. Движок sttv-speed.js сам проверяет фактическую скорость видео и откатывается на 1×, если она не совпадает.');
        }
        if (out.decoder === 'none') out.next.push('Нет AAC-декодера (WebCodecs/decodeAudioData), движок sttv-speed.js работать не сможет.');
        else if (out.decoder === 'dad' && out.dadShift) out.next.push('Только decodeAudioData: localStorage.STTV_SPEED_DAD_SHIFT="' + out.dadShift + '".');
        if (!out.webaudio) out.next.push('WebAudio не запускается (state=' + (r.audioContext && r.audioContext.state) + '). Нужен беззвучный жест/запуск после нажатия кнопки.');
        if (!out.audioOnly && /cors|network/.test(String(af.err))) {
            if (out.net === 'luna' || out.net === 'proxy') out.next.push('Прямой XHR к CDN блокирует CORS, но путь «' + out.net + '» работает: движок переключится на него сам.');
            else if (ls === 'reachable_unpatched') out.next.push('CORS блокирует XHR к CDN. Сервис приложения доступен, но без патча: deploy/install.sh поставит sttv_media_fetch.js (или задай STTV_SPEED_PROXY).');
            else out.next.push('CORS блокирует XHR к CDN и сервис недоступен (' + ls + '): нужен прокси, см. proxy/README.md (localStorage.STTV_SPEED_PROXY).');
        } else if (!out.audioOnly) out.next.push('audio_only не скачался (' + af.err + '). Движок попробует звук из видео-варианта.');
        return out;
    }

    var running = false;
    function run(opts) {
        opts = opts || {};
        if (running) return Promise.reject(new Error('already_running'));
        var v = mainVideo(), r = { t: new Date().toISOString(), env: env() }, snap, rates = opts.rates || [1, 0.75, 1.25, 1.5, 2];
        var settle = opts.settle || 1200, dwell = opts.dwell || 5000;
        r.video0 = vstate(v);
        if (!v) { r.verdict = { codes: ['NO_VIDEO'], next: ['Открой VOD в приложении и запусти пробу во время воспроизведения.'] }; return Promise.resolve(r); }
        if (v.paused || v.readyState < 3) { r.verdict = { codes: ['NOT_PLAYING'], next: ['Видео на паузе/не готово: запусти VOD и повтори.'] }; return Promise.resolve(r); }
        if (!isFinite(v.duration)) r.warn = 'duration is not finite (live?); rate tests are meaningful on VOD only';
        running = true;
        snap = snapshot(v);
        r.rates = [];
        log('start; rates ' + rates.join(',') + ' (~' + Math.round((rates.length + 1) * (settle + dwell) / 1000 + 4) + ' s)');
        var chain = pipeline(v).then(function (p) {
            r.pipeline = { kind: p.kind, entries: p.entries, endlist: p.endlist, fmp4: p.fmp4, hint: p.hint, err: p.err };
            r._pipe = p;
        });
        rates.forEach(function (rate) {
            chain = chain.then(function () {
                log('rate ' + rate);
                return measure(v, { rate: rate, pitch: true, settle: settle, dwell: dwell }).then(function (m) { r.rates.push(m); });
            });
        });
        if (opts.muted !== false) {
            chain = chain.then(function () {
                log('rate 1.5 muted');
                return measure(v, { rate: 1.5, pitch: true, muted: true, settle: settle, dwell: dwell, label: 'muted' }).then(function (m) { r.rates.push(m); });
            });
        }
        chain = chain.then(function () { restore(v, snap); r.video1 = vstate(v); });
        chain = chain.then(function () { return wcTest(); }).then(function (x) { r.decoders = { webcodecs: x }; return wcTest(true); }).then(function (x) { r.decoders.webcodecsHlsjsHeAac = x; });
        chain = chain.then(function () { return audioContextTest(); }).then(function (x) { r.audioContext = x; });
        chain = chain.then(function () { return audioFetchTest(r._pipe || {}); }).then(function (x) { r.audioFetch = x; });
        return chain.then(function () {
            delete r._pipe;
            r.verdict = verdict(r);
            running = false;
            log('done: ' + r.verdict.codes.join(',') + ' ' + JSON.stringify(r.verdict.rates));
            w.__sttvProbeLast = r;
            return r;
        }, function (e) {
            running = false;
            restore(v, snap);
            delete r._pipe;
            r.error = errStr(e);
            w.__sttvProbeLast = r;
            return r;
        });
    }

    // ------------------------------------------------------------------ listening tests
    function banner(text) {
        var el = doc.getElementById('sttv_probe_banner');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'sttv_probe_banner';
            el.style.cssText = 'position:fixed;left:50%;top:6%;transform:translateX(-50%);z-index:2147483647;padding:18px 34px;' +
                'background:rgba(0,0,0,.82);color:#fff;font:600 34px/1.3 sans-serif;border-radius:14px;text-align:center;max-width:80%';
            (doc.body || doc.documentElement).appendChild(el);
        }
        el.textContent = text;
        return el;
    }
    function ear(rate, secs) {
        rate = parseFloat(rate) || 1.5; secs = (parseFloat(secs) || 7) * 1000;
        var v = mainVideo();
        if (!v || v.paused) return Promise.reject(new Error('play a VOD first'));
        var snap = snapshot(v), plan = [
            { r: 1, pp: true, t: 'A · 1× · эталон голоса' },
            { r: rate, pp: true, t: 'B · ' + rate + '× · preservesPitch ON' },
            { r: rate, pp: false, t: 'C · ' + rate + '× · preservesPitch OFF' },
            { r: rate, pp: true, t: 'B · ' + rate + '× · preservesPitch ON (повтор)' },
            { r: 1, pp: true, t: 'A · 1×' }
        ], log2 = [], chain = Promise.resolve();
        plan.forEach(function (p) {
            chain = chain.then(function () {
                setPitch(v, p.pp);
                if (p.r !== 1) v.playbackRate = 1;          // re-apply: some players read pitch mode only on a rate change
                v.playbackRate = p.r;
                banner(p.t);
                log2.push({ step: p.t, rate: v.playbackRate, pp: v.preservesPitch, muted: v.muted });
                return sleep(secs);
            });
        });
        return chain.then(function () {
            restore(v, snap);
            var b = banner('Готово. Сравни B и C'); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 4000);
            return { steps: log2, question: 'B = нормальный голос, C = писк: native работает. B = C = писк: preservesPitch игнорируется. Нет звука на B/C: ТВ глушит звук при rate≠1.' };
        }, function (e) { restore(v, snap); throw e; });
    }
    function beep(freq, ms) {
        var AC = w.AudioContext || w.webkitAudioContext;
        if (!AC) return Promise.reject(new Error('no_AudioContext'));
        var ctx = new AC({ latencyHint: 'playback' }), o = ctx.createOscillator(), g = ctx.createGain(), dur = (ms || 700) / 1000;
        o.frequency.value = freq || 660; g.gain.value = 0.12;
        o.connect(g); g.connect(ctx.destination);
        return Promise.resolve(ctx.resume ? ctx.resume() : null).then(function () {
            var t = ctx.currentTime + 0.05;
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.setValueAtTime(0.12, t + dur - 0.03); g.gain.linearRampToValueAtTime(0, t + dur);
            o.start(t); o.stop(t + dur + 0.02);
            banner('WebAudio beep ' + (freq || 660) + ' Hz');
            return sleep(dur * 1000 + 400);
        }).then(function () {
            var r = { state: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: rnd((ctx.baseLatency || 0) * 1000, 1), outputLatencyMs: ctx.outputLatency !== undefined ? rnd(ctx.outputLatency * 1000, 1) : null };
            try { ctx.close(); } catch (e) {}
            var b = doc.getElementById('sttv_probe_banner'); if (b && b.parentNode) b.parentNode.removeChild(b);
            r.question = 'Слышен ли короткий писк поверх звука видео?';
            return r;
        });
    }

    w.STTVProbe = { version: VERSION, run: run, ear: ear, beep: beep, env: env, video: function () { return vstate(mainVideo()); },
        _internals: { deriveAudioOnly: deriveAudioOnly, masterAudio: masterAudio, wcTest: wcTest, dadTest: dadTest, fit: fit, verdict: verdict } };
    log('loaded v' + VERSION + ': await STTVProbe.run() | STTVProbe.ear(1.5) | STTVProbe.beep()');
})(typeof window !== 'undefined' ? window : this);
