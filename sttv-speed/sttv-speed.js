/*!
 * sttv-speed.js v1.3.8 - pitch-preserving VOD playback speed for SmartTwitchTV on webOS.
 * Load AFTER webosCompatBridge.js. Two ways to speed the video up, one audio engine:
 *   native  the platform player honours playbackRate: <video> keeps playing natively at `speed` (muted)
 *   v2b     the platform player ignores playbackRate (LG webOS 25 / M59LA: native HLS and MSE both locked at 1.00x):
 *           VOD playback is moved to hls.js + MediaSource with the init segments re-timed (mvhd/mdhd timescale x S),
 *           so the decoder runs the content S x faster while the element itself stays at rate 1.0
 *           (sttv-hls.min.js + sttv-v2b.js, loaded on first use; opt-in in 1.2.0: localStorage.STTV_SPEED_V2B='auto')
 * Audio: the Twitch "audio_only" rendition is fetched separately, decoded (WebCodecs AudioDecoder or decodeAudioData),
 * time-stretched with WSOLA and played via WebAudio, slaved to video.currentTime. Any failure -> native audio / 1x.
 * v1.1: verify-then-engage, per-firmware rate capability cache, output-latency tracker, coarse-clock bias fix.
 * v1.2: honest pipeline detection (blob: m3u8 text = native HLS, blob: MediaSource = MSE; v1.1 called both 'mse'),
 *       cache schema 2 (v1.1 entries dropped), v2b timeline compression with takeover/adopt strategies,
 *       hls.js loader over direct XHR / LAN proxy / app Luna service (2 MB ranges), per-stream v2b fuse.
 * v1.3: TV report "no sound at any speed != 1x" (v2b video OK, engine anchored, nothing audible). Audio output fixes:
 *       v2b never hardware-mutes the element (it carries no audio track), AudioContext with platform defaults (v1.2
 *       forced 48 kHz + 'playback'), a fresh context per v2b engine (the shared one could date from the native
 *       pre-flight = another media pipeline), output meter (status().engine.audioOut, events audio_rendering /
 *       audio_silent), STTVSpeed.audioDiag(): numbered listening test of 6 output paths + codec capabilities.
 * v1.3.1: build-time v2b default from the script tag: <script src=".../sttv-speed.js" data-v2b="auto"> (set by the
 *       standalone app build build/build-app.mjs and by install.sh 1.3.1); localStorage.STTV_SPEED_V2B still wins,
 *       STTVSpeed.v2b(x) stores only deviations from the build default (so 'off' sticks when the default is 'auto').
 * v1.3.2: TV report on 1.3.1 "VOD duration in the player UI is S x too long": sttv-v2b.js 1.3.2 rebases a
 *       MediaSource.duration that hls.js set before the hook's session existed. Self-check: status().v2b.timeline
 *       compares video.duration (what the bridge UI shows) with the playlist end, event v2b_timeline_mismatch.
 *       Audio output accounting: renderingS + quietS + silentTotalS + startS + unanchS (silentS = current streak).
 * v1.3.3: TV report (engine 1.3.0 in the stock app): 0.25x was refused ("unsupported_speed"), 1.05-1.2x hit the native
 *       pipeline that ignores playbackRate. v2b speeds 0.25 / 0.5 / 0.75 / 1.25 / 1.5 / 1.75 / 2 (0.25 new; the TwitchNG
 *       build offers exactly 0.25-2 without 1.75). When this firmware's pipeline is known to ignore playbackRate, the
 *       element is no longer poked with speeds v2b cannot take (it changed nothing and can stall/reload the pipeline).
 * v1.3.4: TV report (Twitch NG, rapid speed changes): every respeed is a new MediaSource = a ~2 s platform pipeline load
 *       on webOS 25, each one stalls once while it fills, and 5 of those tripped the 'stalls' fuse -> fallback to 1x +
 *       120 s cooldown, the next request then got "the TV does not apply the speed". Now: stalls while a switch attaches,
 *       up to 4 s after it plays and after a seek are not counted (status().v2b.switchStalls); respeeds are coalesced
 *       (350 ms after the last request, never while a switch is still attaching); a respeed / restore during a switch
 *       keeps the switch's start position (the attaching element can read 0 -> "jump to 00:00"); an explicit speed
 *       change by the user retries v2b once after a failure (requests during a restore are queued); honest toasts for
 *       cooldown / budget; a failed native restore is retried once before the app sees the error; the last 120 events
 *       survive an app restart: STTVSpeed.prevLog(); status().app = { id, name, version } of the host app.
 *       Position hold: while a switch / restore re-attaches the element, video.currentTime reads 0 for up to ~3 s and
 *       the bridge reported 00:00 (progress bar, chat sync, the saved resume point). Android.gettime / getsavedtime
 *       and the Play_ShowVideoStatus position now return the switch position until the element is back there.
 * v1.3.5: TV report (Twitch NG 1.0.0, webOS 25 / M59LA, 13 scenarios). Root cause of the "VOD restarts from 00:00" family:
 *       1.3.3/1.3.4 still wrote the v2b speeds to the NATIVE element ("v2b takes over anyway") - after every restore,
 *       quality change and in clips the native pipeline ran at 0.25-2x, which on webOS 25 freezes (or crawls without
 *       sound), and the bridge's stall recovery then restarted the VOD. Now the native element of a pipeline known to
 *       ignore playbackRate is always kept at 1.0 (clips: toast). Restore watchdog (stuck -> rate 1 + seek + play, then
 *       one more native load). The bridge's stall reload (mv.load()) while v2b plays is absorbed (hls.js re-request) instead
 *       of a native reload (WAN outage). Network-aware v2b: engaging timeout follows the download progress (kick after 8 s
 *       of silence, fail after 15 s silent / 40 s), fatal hls.js network errors -> startLoad again, stalls above 1x step down
 *       to a variant the measured link can carry at that speed (before the 'stalls' fuse; proactively when the buffer
 *       drains), the audio engine retries playlists / segments longer and is restarted twice on network failures.
 *       PCM silence (= content) no longer toasts. status().v2b.net, restoreNudges, engineRetries.
 * v1.3.6: TV run 2026-11-05 (Twitch NG pre-release 02). A fast menu burst (0.25 / 1.5 / 1 within 2 s) right after a
 *       restore started a new takeover on a native pipeline that had not resumed yet; that stopped the restore
 *       watchdog silently, the final 1x found no hls.js yet (prefetch phase) and left the element stuck until the
 *       bridge's stall reload sent the VOD to 00:00. Now a speed change waits until the restore is confirmed
 *       (v2b_restore_ok / give-up), a restore in the prefetch phase keeps the watchdog on the native element, and a
 *       restore without loadedmetadata in 15 s is logged (v2b_restore_timeout). Audio meter: 'graph_silent' (gain
 *       toast, fresh AudioContext next time) needs 3 s of consecutive graph-silent windows; a silent intro followed
 *       by speech no longer toasts (PCM is metered when scheduled, the output when played).
 * v1.3.7: TV run 2026-11-05 (pre-release 03, T7): OK on the quality button at 2x restarted the VOD from 00:00. The app
 *       reloads the player (Android.RestartPlayer -> the bridge's setMain with the resume point) and re-selects its
 *       quality from Play_getQualities ~10-70 ms later; the bridge's SetQuality then takes the resume point from
 *       video.currentTime, which reads 0 on the reloading element (with v2b the released element has no source yet).
 *       The hook now remembers the RestartPlayer / StartAuto resume point and the last good position (1 s samples) and
 *       puts the element back there when SetQuality is called on a VOD / clip element reading ~0 (quality_resume; the
 *       app sees the position through the hold meanwhile). A user seek (mseekTo) / stopVideo forget the positions.
 * v1.3.8: memory (tests/app/leak.mjs, 20 speed cycles): the v2b segment cache (up to 24 MB of video/audio segments)
 *       outlived the player - it is now emptied on stopVideo and on a new stream (late downloads of the old one are not
 *       cached); sttv-v2b.js 1.3.8 no longer keeps every MediaSource of the page alive (+2 per engage / respeed).
 * v1.3.9: TV report / Roadmap Item 13 (observation D3): restore from v2b (1.5x/2x -> 1x) stood for 10-24 s on webOS 25.
 *       Root cause: webOS native HLS resumes at segment keyframe (p0 - 0.5s); watchdog required ct > p0 + 0.3, then
 *       poked v.currentTime = p0 + 0.05, flushing the decoder pipeline inside the segment and freezing it. Now:
 *       forward movement (ct > lastCt + 0.08 within 15 s of p0) confirms v2b_restore_ok; no in-segment seek; early
 *       nudge at ~1.5 s on stalled decoder (readyState >= 3) without seek.
 * Kill switch:   localStorage.STTV_SPEED_MODE = 'off'    (modes: auto | native | off)
 * v2b:           localStorage.STTV_SPEED_V2B = 'auto' (use when the TV ignores playbackRate) | 'force' | 'off'
 *                default = the script tag's data-v2b attribute (app build / install.sh 1.3.1: 'auto'), else 'off'
 *                localStorage.STTV_SPEED_V2B_MAXH = 720  (optional: cap v2b to <= 720p when the network is tight)
 * A/V trim:      localStorage.STTV_SPEED_AV_OFFSET_MS = 0     (positive = delay audio; output latency is compensated
 *                automatically - use only for the TV's video-processing delay measured with a flash/beep test)
 * Rate cache:    localStorage.STTV_SPEED_RATECAP (auto), STTVSpeed.rateCap(), STTVSpeed.resetRateCap();
 *                localStorage.STTV_SPEED_RATEGATE = 'off' disables the cache gate
 * CORS fallback: localStorage.STTV_SPEED_PROXY = 'http://<lan-host>:8787/'  or the patched app service (auto)
 * Audio output:  localStorage.STTV_SPEED_ACTX = 'default' (1.3) | 'playback' | '48k' (= 1.2: 48 kHz + 'playback')
 *                localStorage.STTV_SPEED_MUTE = 'auto' (1.3: hardware mute only for the native pipe) | 'hw' (= 1.2) | 'off'
 *                localStorage.STTV_SPEED_ACTX_FRESH = '0' (= 1.2: one shared context for every engine)
 *                or STTVSpeed.audio({ actx: '48k', mute: 'hw', fresh: false }) - applies to the next engine start
 * Diagnostics:   await STTVSpeed.audioDiag()  - test N = N beeps + toast; report which test numbers were AUDIBLE
 *                STTVSpeed.beep(2)            - 2 beeps through a fresh default AudioContext
 * Console:       STTVSpeed.status(), STTVSpeed.pipe(), STTVSpeed.v2b('auto'), STTVSpeed.setOffset(0), STTVSpeed.debug(true)
 */
(function (w) {
    'use strict';
    if (!w || (w.STTVSpeed && w.STTVSpeed.version)) return;
    var VERSION = '1.3.9';
    var SELF_EL = (w.document && w.document.currentScript) || null;
    var SELF_SRC = (SELF_EL && SELF_EL.src) || '';
    var doc = w.document;
    var LS_MODE = 'STTV_SPEED_MODE', LS_OFFSET = 'STTV_SPEED_AV_OFFSET_MS', LS_DEBUG = 'STTV_SPEED_DEBUG', LS_CAP = 'STTV_SPEED_RATECAP';
    var ENGINE_MIN = 0.25, ENGINE_MAX = 2.5;                    // 1.3.3: 0.25 (was 0.5)

    function now() { return (w.performance && w.performance.now) ? w.performance.now() : Date.now(); }
    function lsGet(k) { try { return w.localStorage ? w.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) {
        try {
            if (v === null || v === undefined) w.localStorage.removeItem(k);
            else w.localStorage.setItem(k, String(v));
        } catch (e) {}
    }
    function normMode(m) { m = String(m || '').toLowerCase(); return (m === 'native' || m === 'off') ? m : 'auto'; }
    function normV2b(m) { m = String(m || '').toLowerCase(); return (m === 'auto' || m === 'force') ? m : 'off'; }
    function selfAttr(n) { try { return SELF_EL && SELF_EL.getAttribute ? SELF_EL.getAttribute(n) : null; } catch (e) { return null; } }
    // build-time default (1.3.1): data-v2b on our own script tag, or window.STTV_SPEED_BUILD = { v2b: 'auto' } set before it
    var BUILD_V2B = normV2b(selfAttr('data-v2b') || (w.STTV_SPEED_BUILD && w.STTV_SPEED_BUILD.v2b));
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function toNum(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
    function errStr(e) { return e ? String(e.message || e.name || e) : 'error'; }

    var cfg = {
        mode: normMode(lsGet(LS_MODE)),
        offsetMs: toNum(lsGet(LS_OFFSET), 0),
        debug: lsGet(LS_DEBUG) === '1',
        rateGate: lsGet('STTV_SPEED_RATEGATE') !== 'off',
        v2b: 'off', v2bMaxH: 0, v2bWorker: true,
        actx: 'default', actxFresh: true, mute: 'auto'
    };
    function audioConf() {
        var a = String(lsGet('STTV_SPEED_ACTX') || '').toLowerCase(), m = String(lsGet('STTV_SPEED_MUTE') || '').toLowerCase();
        cfg.actx = (a === '48k' || a === 'playback') ? a : 'default';
        cfg.mute = (m === 'hw' || m === 'off') ? m : 'auto';
        cfg.actxFresh = lsGet('STTV_SPEED_ACTX_FRESH') !== '0';
    }
    audioConf();
    function v2bConf() {
        cfg.v2b = normV2b(lsGet('STTV_SPEED_V2B') || BUILD_V2B);
        cfg.v2bMaxH = Math.max(0, toNum(lsGet('STTV_SPEED_V2B_MAXH'), 0));
        cfg.v2bWorker = lsGet('STTV_SPEED_V2B_WORKER') !== '0';
    }
    v2bConf();

    // ---------------------------------------------------------------- event log / toast
    var events = [], evCount = 0;
    function ev(type, data) {
        var e = { t: Math.round(now()), type: type };
        if (data !== undefined) e.data = data;
        events.push(e); evCount++;
        if (events.length > 400) events.splice(0, events.length - 400);
        if (cfg.debug) { try { w.console.log('[sttv-speed] ' + type, data === undefined ? '' : data); } catch (x) {} }
    }
    var RU = /^(ru|uk|be|kk)/i.test(String((w.navigator && w.navigator.language) || ''));
    var MSG = {
        on: ['Скорость %s× · звук: аудио-движок', 'Speed %s× · audio engine'],
        silent: ['Аудио-движок выдаёт тишину (%s)', 'Audio engine output is silent (%s)'],
        diag: ['Тест звука %s — слушайте', 'Audio test %s — listen'],
        fail: ['Коррекция тона выключена (%s) · обычный звук', 'Pitch correction off (%s) · native audio'],
        rate: ['ТВ не меняет скорость видео для этого потока', 'TV ignores video speed for this stream'],
        gate: ['ТВ не применяет скорость к этому видео · %s× без эффекта', 'The TV does not apply the speed to this video · %s× has no effect'],
        gate_clip: ['Скорость клипов этот ТВ не меняет · %s× без эффекта', 'This TV cannot change the speed of clips · %s× has no effect'],
        v2b_wait: ['Скорость %s× · подготовка…', 'Speed %s× · preparing…'],
        v2b_on: ['Скорость %s× · v2b', 'Speed %s× · v2b'],
        v2b_fail: ['Ускорение недоступно (%s) · 1×', 'Speed-up unavailable (%s) · 1×'],
        v2b_cool: ['Ускорение недоступно ещё %s с после сбоя · 1×', 'Speed-up unavailable for %s s after a failure · 1×'],
        v2b_budget: ['Слишком частая смена скорости · подождите %s с', 'Too many speed changes · wait %s s'],
        v2b_down: ['Скорость %s · сеть не успевает, качество %s', 'Speed %s · network too slow, quality %s']
    };
    var toastEl = null, toastTimer = 0;
    function toast(key, arg) {
        var m = MSG[key];
        if (!m) return;
        var args = Object.prototype.toString.call(arg) === '[object Array]' ? arg : [arg], k = 0;
        var text = (RU ? m[0] : m[1]).replace(/%s/g, function () { var a = args[k++]; return a === undefined ? '' : String(a); });
        ev('toast', text);
        if (!doc || !doc.body) return;
        try {
            if (!toastEl) {
                toastEl = doc.createElement('div');
                toastEl.id = 'sttv_speed_toast';
                toastEl.style.cssText = 'position:fixed;left:50%;top:6%;transform:translateX(-50%);z-index:2147483647;' +
                    'background:rgba(0,0,0,.8);color:#fff;font:600 22px/1.3 sans-serif;padding:10px 22px;border-radius:10px;' +
                    'pointer-events:none;transition:opacity .3s;opacity:0';
                doc.body.appendChild(toastEl);
            }
            toastEl.textContent = text;
            toastEl.style.opacity = '1';
            if (toastTimer) w.clearTimeout(toastTimer);
            toastTimer = w.setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 3500);
        } catch (e) {}
    }

    // ---------------------------------------------------------------- rate capability cache (per firmware + pipeline)
    // { k: <firmware key>, s: 2, native: { v: 'ignored'|'ok', sp: [verified speeds], ratio, at }, mse: {...}, v2b: {...} }
    // s: 2 (v1.2): v1.1 entries are dropped - v1.1 filed blob: m3u8 text (native HLS) under 'mse'.
    // 'ignored' is written only by the pre-flight (2 windows, video measured at 1.00x while speed != 1),
    // expires after 30 days or on any UA / deviceInfo version change (firmware update).
    var CAP_TTL = 30 * 864e5, fwKeyMemo = null;
    function fwKey() {
        if (fwKeyMemo) return fwKeyMemo;
        var s = String((w.navigator && w.navigator.userAgent) || ''), di = null, keys = [], k, h = 5381, i;
        try { di = w.PalmSystem && w.PalmSystem.deviceInfo; if (typeof di === 'string') di = JSON.parse(di); } catch (e) { di = null; }
        if (di && typeof di === 'object') {
            for (k in di) if (Object.prototype.hasOwnProperty.call(di, k) && /version|model/i.test(k)) keys.push(k + '=' + di[k]);
            keys.sort();
            s += '|' + keys.join('|');
        }
        for (i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        fwKeyMemo = h.toString(36);
        return fwKeyMemo;
    }
    function capLoad() {
        var o = null;
        try { o = JSON.parse(lsGet(LS_CAP) || 'null'); } catch (e) { o = null; }
        return (o && typeof o === 'object' && o.k === fwKey() && o.s === 2) ? o : { k: fwKey(), s: 2 };
    }
    function capGet(pipe) {
        var c = capLoad()[pipe], t = Date.now();
        return (c && typeof c === 'object' && t >= c.at && t - c.at < CAP_TTL) ? c : null;
    }
    function capPut(pipe, c) {
        if (pipe !== 'native' && pipe !== 'mse' && pipe !== 'v2b') return;
        var o = capLoad();
        c.at = Date.now();
        o[pipe] = c;
        lsSet(LS_CAP, JSON.stringify(o));
        ev('rate_cap', { pipe: pipe, v: c.v, sp: c.sp, ratio: c.ratio });
    }
    function capIgnored(pipe) { var c = capGet(pipe); return !!(c && c.v === 'ignored'); }
    function capSpeedOk(pipe, s) {
        var c = capGet(pipe), i;
        if (!c || c.v !== 'ok' || !c.sp) return false;
        for (i = 0; i < c.sp.length; i++) if (Math.abs(c.sp[i] - s) < 0.001) return true;
        return false;
    }
    function capMarkOk(pipe, s, ratio) {
        if (capSpeedOk(pipe, s)) return;
        var c = capGet(pipe);
        var sp = (c && c.v === 'ok' && c.sp) ? c.sp.slice(-7) : [];
        sp.push(s);
        capPut(pipe, { v: 'ok', sp: sp, ratio: ratio });
    }
    function capMarkIgnored(pipe, s, ratio) { capPut(pipe, { v: 'ignored', sp: [s], ratio: ratio }); }

    // ---------------------------------------------------------------- network (XHR: allowCrossDomain apps bypass CORS)
    // 1.3.5: onProg (optional) = bytes are arriving (XHR progress / load): v2b tells a slow download from a hung one
    function rawXhr(url, type, range, timeoutMs, onProg) {
        var req = null, done = false;
        function prog() { if (onProg) { try { onProg(); } catch (e) {} } }
        var p = new Promise(function (resolve, reject) {
            try {
                req = new XMLHttpRequest();
                req.open('GET', url, true);
                req.responseType = type || 'arraybuffer';
                if (range) req.setRequestHeader('Range', 'bytes=' + range[0] + '-' + range[1]);
                req.timeout = timeoutMs || 20000;
                if (onProg) req.onprogress = prog;
                req.onload = function () {
                    done = true; prog();
                    var ok = (req.status >= 200 && req.status < 300) || (req.status === 0 && !!req.response);
                    if (ok) resolve(req.response); else reject(new Error('http_' + req.status));
                };
                req.onerror = function () { done = true; reject(new Error('net')); };
                req.ontimeout = function () { done = true; reject(new Error('timeout')); };
                req.onabort = function () { done = true; reject(new Error('abort')); };
                req.send();
            } catch (e) { done = true; reject(e); }
        });
        p.abort = function () { if (!done && req) { try { req.abort(); } catch (e) {} } };
        return p;
    }

    // ---------------------------------------------------------------- what is behind a blob: src? (v1.1 called every blob: 'mse')
    // The xenking bridge plays media playlists from blob: URLs of the m3u8 TEXT (= native HLS, not MSE). createObjectURL is
    // wrapped from the start, so we know what each blob: URL was made of; unregistered ones are probed once by XHR
    // (m3u8 text -> 'hls'; a MediaSource URL cannot be fetched -> 'mse').
    var objKinds = {}, objOrder = [], objProbe = {};
    function objNote(u, k) {
        if (!Object.prototype.hasOwnProperty.call(objKinds, u)) { objOrder.push(u); if (objOrder.length > 96) delete objKinds[objOrder.shift()]; }
        objKinds[u] = k;
    }
    (function () {
        var U = w.URL;
        if (!U || typeof U.createObjectURL !== 'function' || U.createObjectURL.__sttvReg) return;
        var orig = U.createObjectURL, f = function (obj) {
            var u = orig.apply(this, arguments);
            try {
                var k = 'blob';
                if ((w.MediaSource && obj instanceof w.MediaSource) || (w.ManagedMediaSource && obj instanceof w.ManagedMediaSource)) k = 'mse';
                else if (obj && /mpegurl/i.test(String(obj.type || ''))) k = 'hls';
                objNote(String(u), k);
            } catch (e) {}
            return u;
        };
        f.__sttvReg = true;
        try { U.createObjectURL = f; } catch (e) {}
    })();
    function srcOf(v) { return String((v && (v.currentSrc || v.src)) || ''); }
    function blobKind(u) {
        var k = objKinds[u];
        if (k === 'hls' || k === 'mse') return k;
        if (!objProbe[u]) {
            objProbe[u] = 1;
            rawXhr(u, 'text', null, 4000).then(function (t) { objNote(u, /^\s*#EXTM3U/.test(String(t || '')) ? 'hls' : 'blob'); },
                function () { objNote(u, k === 'blob' ? 'blob' : 'mse'); });
        }
        return 'unknown';
    }
    // native = <video> plays an m3u8 itself (https: or blob: text); mse = MediaSource (app's own player); v2b = ours
    function pipeKind(v) {
        if (v2b.state !== 'idle' && v === v2b.v) return 'v2b';
        var s = srcOf(v);
        if (!/^blob:/i.test(s)) return 'native';
        var k = blobKind(s);
        return k === 'hls' ? 'native' : (k === 'mse' ? 'mse' : 'unknown');
    }
    function pipeDetail(v) {
        var s = srcOf(v);
        return { pipe: v ? pipeKind(v) : null, blob: /^blob:/i.test(s) ? (objKinds[s] || 'unregistered') : null, src: s.slice(0, 120) };
    }

    // ---------------------------------------------------------------- network: direct XHR -> LAN proxy -> app Luna service
    // Twitch's VOD CDN only sends CORS headers for twitch.tv. The <video> element doesn't care, but our XHRs do on webOS
    // builds that enforce CORS for apps. Fallbacks (decided once per page, on the first CORS/network failure):
    //   proxy: localStorage.STTV_SPEED_PROXY = 'http://<lan-host>:8787/'  (proxy/sttv-cors-proxy.js)
    //   luna:  the app's own JS service (<appId>.hls/fetchPlaylist with sttvMedia:true, patched by deploy/install.sh)
    // Force a path: localStorage.STTV_SPEED_NET = direct | proxy | luna   (default auto)
    var net = { mode: 'auto', decided: '', proxy: '', fails: 0 };
    function netConf() {
        var m = String(lsGet('STTV_SPEED_NET') || 'auto').toLowerCase(), px = String(lsGet('STTV_SPEED_PROXY') || '');
        net.mode = /^(direct|proxy|luna)$/.test(m) ? m : 'auto';
        net.proxy = /^https?:\/\//i.test(px) ? (px.charAt(px.length - 1) === '/' ? px : px + '/') : '';
    }
    netConf();
    function lunaName() {
        try {
            var id = w.PalmSystem && w.PalmSystem.identifier ? String(w.PalmSystem.identifier).split(' ')[0] : '';
            return id ? id + '.hls' : '';
        } catch (e) { return ''; }
    }
    function lunaOk() { return typeof w.PalmServiceBridge === 'function' && !!lunaName(); }
    function b64ToBuf(s) {
        var bin = w.atob(s || ''), n = bin.length, u = new Uint8Array(n), i;
        for (i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
        return u.buffer;
    }
    function lunaXhr(url, type, range, timeoutMs, meta, onProg) {
        var bridge = null, done = false, timer = 0, rej = null;
        function cleanup() {
            if (timer) { w.clearTimeout(timer); timer = 0; }
            if (bridge) { try { bridge.onservicecallback = null; } catch (e) {} try { bridge.cancel(); } catch (e2) {} bridge = null; }
        }
        var p = new Promise(function (resolve, reject) {
            rej = reject;
            function fin(err, val) {
                if (done) return;
                done = true;
                cleanup();
                if (err) reject(err); else resolve(val);
            }
            if (!lunaOk()) { fin(new Error('luna_unavailable')); return; }
            try { bridge = new w.PalmServiceBridge(); } catch (e) { fin(new Error('luna_bridge')); return; }
            bridge.onservicecallback = function (msg) {
                var r = null;
                try { r = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch (e) {}
                if (!r || !r.returnValue || !r.sttvMedia) { fin(new Error('luna_' + (r ? (r.errorCode || r.status || 'bad') : 'bad'))); return; }
                if (meta) { meta.status = r.status; meta.contentRange = r.contentRange || ''; meta.ms = r.ms; }
                if (onProg) { try { onProg(); } catch (e) {} }
                try { fin(null, type === 'text' ? String(r.text || '') : b64ToBuf(r.body64)); } catch (e) { fin(e); }
            };
            timer = w.setTimeout(function () { fin(new Error('timeout')); }, (timeoutMs || 20000) + 1000);
            try {
                bridge.call('luna://' + lunaName() + '/fetchPlaylist', JSON.stringify({
                    sttvMedia: true, url: url, range: range ? range[0] + '-' + range[1] : '',
                    encoding: type === 'text' ? 'utf8' : 'base64', timeoutMs: timeoutMs || 20000
                }));
            } catch (e) { fin(new Error('luna_call')); }
        });
        p.abort = function () { if (!done) { done = true; cleanup(); if (rej) rej(new Error('abort')); } };
        return p;
    }
    // Binary bodies over Luna in 2 MB ranges (the service caps one response at 8 MB; a 1080p60 segment is ~9 MB),
    // 2 in flight, assembled in place. The first chunk's Content-Range gives the size.
    var LUNA_CHUNK = Math.max(65536, toNum(lsGet('STTV_SPEED_LUNA_CHUNK'), 2097152)), LUNA_PAR = 2;
    function lunaRanged(url, range, timeoutMs, onProg) {
        var live = {}, aborted = false, rej = null, s0 = range ? range[0] : 0, e0 = range ? range[1] : -1;
        function abortAll() { var k; for (k in live) if (Object.prototype.hasOwnProperty.call(live, k) && live[k].abort) live[k].abort(); live = {}; }
        var p = new Promise(function (resolve, reject) {
            rej = reject;
            function part(a, b, meta) {
                var r = lunaXhr(url, 'arraybuffer', [a, b], timeoutMs, meta, onProg);
                live[a] = r;
                return r.then(function (ab) { delete live[a]; return ab; }, function (e) { delete live[a]; throw e; });
            }
            var m0 = {};
            part(s0, e0 >= 0 ? Math.min(e0, s0 + LUNA_CHUNK - 1) : s0 + LUNA_CHUNK - 1, m0).then(function (ab0) {
                if (aborted) return;
                var mm = /\/(\d+)\s*$/.exec(String(m0.contentRange || '')), size = mm ? +mm[1] : -1, last = e0 >= 0 ? (size > 0 ? Math.min(e0, size - 1) : e0) : size - 1;
                if (m0.status !== 206) { resolve(range && m0.status === 200 && ab0.byteLength > e0 ? ab0.slice(s0, e0 + 1) : ab0); return; }
                if (last < 0 || s0 + ab0.byteLength > last) { resolve(ab0); return; }
                var offs = [], bufs = {}, next = 0, inflight = 0, failed = false, o;
                for (o = s0 + ab0.byteLength; o <= last; o += LUNA_CHUNK) offs.push(o);
                bufs[s0] = ab0;
                function pump() {
                    if (aborted || failed) return;
                    if (next >= offs.length && !inflight) {
                        var out = new Uint8Array(last - s0 + 1), k, b;
                        for (k in bufs) if (Object.prototype.hasOwnProperty.call(bufs, k)) { b = new Uint8Array(bufs[k]); if (+k - s0 + b.length > out.length) { reject(new Error('range_overflow')); return; } out.set(b, +k - s0); }
                        resolve(out.buffer);
                        return;
                    }
                    while (inflight < LUNA_PAR && next < offs.length) {
                        (function (a) {
                            var b = Math.min(last, a + LUNA_CHUNK - 1);
                            inflight++;
                            part(a, b, null).then(function (ab) {
                                inflight--;
                                if (ab.byteLength !== b - a + 1) { failed = true; abortAll(); reject(new Error('range_short')); return; }
                                bufs[a] = ab; pump();
                            }, function (e) { inflight--; if (!failed) { failed = true; abortAll(); reject(e); } });
                        })(offs[next++]);
                    }
                }
                pump();
            }, function (e) { reject(e); });
        });
        p.abort = function () { if (aborted) return; aborted = true; abortAll(); if (rej) rej(new Error('abort')); };
        return p;
    }
    function viaPath(m, url, type, range, timeoutMs, onProg) {
        if (m === 'proxy') return rawXhr(net.proxy + url, type, range, timeoutMs, onProg);
        if (m === 'luna') return type === 'text' ? lunaXhr(url, type, range, timeoutMs, null, onProg) : lunaRanged(url, range, timeoutMs, onProg);
        return rawXhr(url, type, range, timeoutMs, onProg);
    }
    function netDecide(m) {
        if (net.decided) return;
        net.decided = m;
        ev('net_path', { path: m, proxy: m === 'proxy' ? net.proxy : undefined });
    }
    function xhr(url, type, range, timeoutMs, onProg) {
        if (!/^https?:/i.test(String(url)) || (w.location && String(url).indexOf(w.location.origin + '/') === 0)) return rawXhr(url, type, range, timeoutMs, onProg);
        var m = net.mode !== 'auto' ? net.mode : net.decided;
        if (m) return viaPath(m, url, type, range, timeoutMs, onProg);
        var cur = rawXhr(url, type, range, timeoutMs, onProg), aborted = false;
        var p = cur.then(function (r) { netDecide('direct'); return r; }, function (err) {
            if (aborted || errStr(err) !== 'net' || net.decided) {
                if (net.decided && !aborted && errStr(err) === 'net') { cur = viaPath(net.decided, url, type, range, timeoutMs, onProg); return cur; }
                throw err;
            }
            var alts = [];
            if (net.proxy) alts.push('proxy');
            if (lunaOk()) alts.push('luna');
            function next(i, last) {
                if (aborted) throw new Error('abort');
                if (i >= alts.length) {
                    net.fails++;
                    ev('net_blocked', { url: String(url).replace(/[?#].*$/, '').slice(0, 120), tried: ['direct'].concat(alts), err: errStr(last) });
                    throw last;
                }
                cur = viaPath(alts[i], url, type, range, timeoutMs, onProg);
                return cur.then(function (r) { netDecide(alts[i]); return r; }, function (e2) { return next(i + 1, e2); });
            }
            return next(0, err);
        });
        p.abort = function () { aborted = true; if (cur && cur.abort) cur.abort(); };
        return p;
    }

    // ---------------------------------------------------------------- HLS playlists
    function absUrl(base, rel) { try { return new URL(rel, base || w.location.href).href; } catch (e) { return rel; } }
    function attrs(s) {
        var o = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, m;
        while ((m = re.exec(s))) o[m[1]] = m[2].charAt(0) === '"' ? m[2].slice(1, -1) : m[2];
        return o;
    }
    function isMasterText(t) { return typeof t === 'string' && t.indexOf('#EXT-X-STREAM-INF') >= 0; }
    function isMediaText(t) { return typeof t === 'string' && t.indexOf('#EXTINF') >= 0; }
    function isAudioOnlyVariant(v) {
        var c = String(v.codecs || '').toLowerCase();
        if (v.video === 'audio_only' || /\/audio_only\//.test(v.uri)) return true;
        return !!c && c.indexOf('mp4a') >= 0 && !/avc|hvc|hev|av01|vp0|vp9/.test(c);
    }
    function hasAudioCodec(v) { var c = String(v.codecs || '').toLowerCase(); return !c || c.indexOf('mp4a') >= 0; }
    function parseMaster(text, base) {
        var lines = String(text || '').split(/\r?\n/), out = [], cur = null, i, l, a;
        for (i = 0; i < lines.length; i++) {
            l = lines[i].trim();
            if (!l) continue;
            if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
                a = attrs(l.slice(18));
                cur = { bw: parseInt(a.BANDWIDTH, 10) || 0, codecs: a.CODECS || '', video: a.VIDEO || '', res: a.RESOLUTION || '', uri: '' };
            } else if (l.charAt(0) !== '#' && cur) {
                cur.uri = absUrl(base, l);
                cur.audioOnly = isAudioOnlyVariant(cur);
                out.push(cur);
                cur = null;
            }
        }
        return out;
    }
    var QUALITY_DIR = /^(chunked|audio_only|\d{3,4}p\d{0,3})$/i;
    // https://cdn/<hash>_<chan>_<id>_<ts>/<quality>/index-dvr.m3u8 -> .../audio_only/index-dvr.m3u8
    function deriveAudioOnly(url) {
        var m = /^(https?:\/\/[^?#]*\/)([^\/?#]+)\/([^\/?#]+\.m3u8)(\?[^#]*)?$/i.exec(String(url || ''));
        if (!m || !QUALITY_DIR.test(m[2])) return null;
        if (m[2].toLowerCase() === 'audio_only') return url;
        return m[1] + 'audio_only/' + m[3] + (m[4] || '');
    }
    function pickSources(vars, cur) {
        var audio = null, lowA = null, video = null, i, v;
        for (i = 0; i < vars.length; i++) {
            v = vars[i];
            if (v.audioOnly) { if (!audio) audio = v; continue; }
            if (cur && v.uri === cur) video = v;
            if (hasAudioCodec(v) && (!lowA || v.bw < lowA.bw)) lowA = v;
        }
        if (!video) {
            for (i = 0; i < vars.length; i++) {
                if (!vars[i].audioOnly && (!video || vars[i].bw < video.bw)) video = vars[i];
            }
        }
        return {
            audio: audio ? audio.uri : (lowA ? lowA.uri : null),
            audioKind: audio ? 'audio_only' : (lowA ? 'variant' : ''),
            video: video ? video.uri : null
        };
    }
    function byteRange(s, defOff) {
        var p = String(s).split('@'), n = parseInt(p[0], 10), o = p.length > 1 ? parseInt(p[1], 10) : defOff;
        return [o, o + n - 1];
    }
    function parseMedia(text, base) {
        var lines = String(text || '').split(/\r?\n/), segs = [], t = 0, dur = -1, disc = 0, map = null, br = null;
        var ended = false, nextOff = 0, i, l, a, seg;
        for (i = 0; i < lines.length; i++) {
            l = lines[i].trim();
            if (!l) continue;
            if (l.charAt(0) === '#') {
                if (l.indexOf('#EXTINF:') === 0) dur = parseFloat(l.slice(8));
                else if (l === '#EXT-X-DISCONTINUITY') disc++;
                else if (l === '#EXT-X-ENDLIST') ended = true;
                else if (l.indexOf('#EXT-X-MAP:') === 0) {
                    a = attrs(l.slice(11));
                    map = { uri: absUrl(base, a.URI || ''), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null };
                } else if (l.indexOf('#EXT-X-BYTERANGE:') === 0) br = byteRange(l.slice(17), nextOff);
                continue;
            }
            if (!(dur >= 0)) continue;
            seg = { i: segs.length, uri: absUrl(base, l), dur: dur, start: t, disc: disc, map: map, range: br };
            if (br) nextOff = br[1] + 1;
            segs.push(seg);
            t += dur; dur = -1; br = null;
        }
        return { segs: segs, total: t, ended: ended, fmp4: !!(segs.length && segs[0].map) };
    }
    function segAt(pl, t) {
        var s = pl.segs, lo = 0, hi = s.length - 1, mid;
        if (!s.length) return -1;
        if (t <= 0) return 0;
        while (lo < hi) { mid = (lo + hi + 1) >> 1; if (s[mid].start <= t) lo = mid; else hi = mid - 1; }
        return lo;
    }

    // ---------------------------------------------------------------- MPEG-TS demux (audio PES + ADTS)
    var SR_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    var PTS_WRAP = 8589934592;
    function concatU8(chunks, total) {
        var out = new Uint8Array(total), o = 0, i;
        for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
        return out;
    }
    function readPts(b, o) {
        return (b[o] & 0x0e) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 0xfe) * 16384 + b[o + 3] * 128 + (b[o + 4] & 0xfe) / 2;
    }
    function pesHeader(u8, o, end) {
        if (end - o < 9 || u8[o] !== 0 || u8[o + 1] !== 0 || u8[o + 2] !== 1) return null;
        var flags = u8[o + 7], hl = u8[o + 8], pts = -1;
        if ((flags & 0x80) && end - o >= 14) pts = readPts(u8, o + 9);
        return { pts: pts, data: o + 9 + hl };
    }
    function parsePat(u8, o, e) {
        if (o + 8 > e || u8[o] !== 0) return -1;
        var sl = ((u8[o + 1] & 0x0f) << 8) | u8[o + 2], end = Math.min(o + 3 + sl - 4, e), i;
        for (i = o + 8; i + 4 <= end; i += 4) {
            if (((u8[i] << 8) | u8[i + 1]) !== 0) return ((u8[i + 2] & 0x1f) << 8) | u8[i + 3];
        }
        return -1;
    }
    function parsePmt(u8, o, e) {
        if (o + 12 > e || u8[o] !== 2) return null;
        var sl = ((u8[o + 1] & 0x0f) << 8) | u8[o + 2], end = Math.min(o + 3 + sl - 4, e);
        var pil = ((u8[o + 10] & 0x0f) << 8) | u8[o + 11], i = o + 12 + pil, r = { apid: -1, atype: 0, vpid: -1 };
        while (i + 5 <= end) {
            var st = u8[i], pid = ((u8[i + 1] & 0x1f) << 8) | u8[i + 2], eil = ((u8[i + 3] & 0x0f) << 8) | u8[i + 4];
            if (r.apid < 0 && (st === 0x0f || st === 0x11)) { r.apid = pid; r.atype = st; }
            else if (r.vpid < 0 && (st === 0x1b || st === 0x24)) r.vpid = pid;
            i += 5 + eil;
        }
        return r;
    }
    // ADTS frames from one PES payload. st carries partial frames between PES packets.
    function adtsParse(st, data, pesPts, res) {
        var buf = data, carryLen = 0, n, i = 0, k = 0, fpts;
        if (st.carry) {
            carryLen = st.carry.length;
            buf = concatU8([st.carry, data], carryLen + data.length);
            st.carry = null;
        }
        if (pesPts < 0) pesPts = st.lastPts >= 0 ? st.lastPts + st.frameDur90 : 0;
        n = buf.length;
        while (i + 7 <= n) {
            if (buf[i] !== 0xff || (buf[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
            var prot = buf[i + 1] & 1, aot = ((buf[i + 2] >> 6) & 3) + 1, sfi = (buf[i + 2] >> 2) & 15;
            var ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
            var flen = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
            var hlen = prot ? 7 : 9;
            if (sfi > 12 || flen <= hlen) { i++; continue; }
            if (i + flen > n) break;
            if (!st.sr) { st.sr = SR_TABLE[sfi]; st.ch = ch; st.aot = aot; st.frameDur90 = 1024 * 90000 / st.sr; }
            if (i < carryLen && st.carryPts >= 0) fpts = st.carryPts;
            else { fpts = pesPts + k * st.frameDur90; k++; }
            res.frames.push({ pts: fpts, data: buf.subarray(i + hlen, i + flen), adts: buf.subarray(i, i + flen) });
            st.lastPts = fpts;
            i += flen;
        }
        if (i < n) {
            st.carry = buf.slice(i);
            st.carryPts = st.lastPts >= 0 ? st.lastPts + st.frameDur90 : pesPts;
        }
    }
    // Returns { frames:[{pts (90 kHz, raw 33-bit), data (raw AAC), adts}], sr, ch, aot, firstAudioPts, firstVideoPts }
    function demuxTS(u8) {
        var n = u8.length, pmt = -1, apid = -1, vpid = -1, atype = 0, p = 0, q;
        var res = { frames: [], sr: 0, ch: 0, aot: 0, firstAudioPts: -1, firstVideoPts: -1, atype: 0 };
        var st = { carry: null, carryPts: -1, lastPts: -1, frameDur90: 1920, sr: 0, ch: 0, aot: 0 };
        var pes = null, pesLen = 0;
        function flushPes() {
            if (!pes) return;
            var buf = pes.length === 1 ? pes[0] : concatU8(pes, pesLen);
            pes = null; pesLen = 0;
            var h = pesHeader(buf, 0, buf.length);
            if (!h || h.data > buf.length) return;
            if (h.pts >= 0 && res.firstAudioPts < 0) res.firstAudioPts = h.pts;
            if (atype === 0x0f) adtsParse(st, buf.subarray(h.data), h.pts, res);
        }
        while (p + 188 < n && !(u8[p] === 0x47 && u8[p + 188] === 0x47)) p++;
        if (p + 188 >= n) p = 0;
        for (; p + 188 <= n; p += 188) {
            if (u8[p] !== 0x47) {
                q = p + 1;
                while (q + 188 <= n && !(u8[q] === 0x47 && (q + 188 === n || u8[q + 188] === 0x47))) q++;
                p = q - 188;
                continue;
            }
            var b1 = u8[p + 1], pid = ((b1 & 0x1f) << 8) | u8[p + 2], pusi = (b1 & 0x40) !== 0;
            var afc = (u8[p + 3] >> 4) & 3, o = p + 4, e = p + 188;
            if (afc === 0 || afc === 2) continue;
            if (afc === 3) { o += 1 + u8[o]; if (o >= e) continue; }
            if (pid === 0) {
                if (pusi) o += 1 + u8[o];
                var pm = parsePat(u8, o, e);
                if (pm > 0) pmt = pm;
            } else if (pid === pmt) {
                if (pusi) o += 1 + u8[o];
                var r = parsePmt(u8, o, e);
                if (r) { apid = r.apid; atype = r.atype; vpid = r.vpid; res.atype = atype; }
            } else if (pid === apid) {
                if (pusi) { flushPes(); pes = []; pesLen = 0; }
                if (pes) { pes.push(u8.subarray(o, e)); pesLen += e - o; }
            } else if (pid === vpid && pusi && res.firstVideoPts < 0) {
                var vh = pesHeader(u8, o, e);
                if (vh && vh.pts >= 0) res.firstVideoPts = vh.pts;
            }
        }
        flushPes();
        res.sr = st.sr; res.ch = st.ch; res.aot = st.aot;
        return res;
    }
    function makeAsc(aot, sr, ch) {
        var sfi = SR_TABLE.indexOf(sr);
        if (sfi < 0) sfi = 3;
        return new Uint8Array([((aot & 31) << 3) | (sfi >> 1), ((sfi & 1) << 7) | ((ch & 15) << 3)]);
    }
    function unwrapPts(pts, expected) { return pts + Math.round((expected - pts) / PTS_WRAP) * PTS_WRAP; }

    // ---------------------------------------------------------------- fMP4 (CMAF) audio demux
    function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
    function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
    function boxes(b, s, e, fn) {
        var p = s;
        while (p + 8 <= e) {
            var size = u32(b, p), type = fourcc(b, p + 4), h = 8;
            if (size === 1) { size = u64(b, p + 8); h = 16; } else if (size === 0) size = e - p;
            if (size < h || p + size > e) break;
            if (fn(type, p + h, p + size, p) === false) break;
            p += size;
        }
    }
    function findBox(b, s, e, path) {
        var r = null;
        boxes(b, s, e, function (t, cs, ce, bs) {
            if (t !== path[0]) return;
            r = path.length === 1 ? { s: cs, e: ce, b: bs } : findBox(b, cs, ce, path.slice(1));
            if (r) return false;
        });
        return r;
    }
    function parseEsds(b, s, e) {
        function desc(p) {
            var tag = b[p++], len = 0, c, k = 0;
            do { c = b[p++]; len = (len << 7) | (c & 0x7f); } while ((c & 0x80) && ++k < 4);
            return { tag: tag, len: len, p: p };
        }
        if (s >= e) return null;
        var d = desc(s), p, fl;
        if (d.tag !== 3) return null;
        fl = b[d.p + 2];
        p = d.p + 3;
        if (fl & 0x80) p += 2;
        if (fl & 0x40) p += 1 + b[p];
        if (fl & 0x20) p += 2;
        d = desc(p);
        if (d.tag !== 4) return null;
        d = desc(d.p + 13);
        if (d.tag !== 5 || d.p + d.len > e) return null;
        return b.slice(d.p, d.p + d.len);
    }
    function parseMp4Init(b) {
        var moov = findBox(b, 0, b.length, ['moov']);
        if (!moov) return null;
        var out = { audio: null, trex: {} };
        boxes(b, moov.s, moov.e, function (t, s, e) {
            if (t === 'trak') {
                var tk = { id: 0, handler: '', timescale: 0, asc: null, sr: 0, ch: 0 };
                var tkhd = findBox(b, s, e, ['tkhd']);
                if (tkhd) tk.id = b[tkhd.s] === 1 ? u32(b, tkhd.s + 20) : u32(b, tkhd.s + 12);
                var mdhd = findBox(b, s, e, ['mdia', 'mdhd']);
                if (mdhd) tk.timescale = b[mdhd.s] === 1 ? u32(b, mdhd.s + 20) : u32(b, mdhd.s + 12);
                var hdlr = findBox(b, s, e, ['mdia', 'hdlr']);
                if (hdlr) tk.handler = fourcc(b, hdlr.s + 8);
                var stsd = tk.handler === 'soun' ? findBox(b, s, e, ['mdia', 'minf', 'stbl', 'stsd']) : null;
                if (stsd) {
                    boxes(b, stsd.s + 8, stsd.e, function (et, es, ee) {
                        if (et === 'mp4a' || et === 'enca') {
                            tk.ch = (b[es + 16] << 8) | b[es + 17];
                            tk.sr = u32(b, es + 24) >>> 16;
                            var esds = findBox(b, es + 28, ee, ['esds']);
                            if (esds) tk.asc = parseEsds(b, esds.s + 4, esds.e);
                        }
                        return false;
                    });
                }
                if (tk.handler === 'soun' && !out.audio) out.audio = tk;
            } else if (t === 'mvex') {
                boxes(b, s, e, function (mt, ms) {
                    if (mt === 'trex') out.trex[u32(b, ms + 4)] = { dur: u32(b, ms + 12), size: u32(b, ms + 16) };
                });
            }
        });
        return out;
    }
    // Returns { frames:[{pts (timescale units), data}], timescale }
    function parseMp4Fragment(b, init) {
        var tk = init && init.audio, frames = [];
        if (!tk) return null;
        boxes(b, 0, b.length, function (t, s, e, bs) {
            if (t !== 'moof') return;
            var moofStart = bs;
            boxes(b, s, e, function (tt, ts, te) {
                if (tt !== 'traf') return;
                var tfhd = findBox(b, ts, te, ['tfhd']);
                if (!tfhd) return;
                var fl = u32(b, tfhd.s) & 0xffffff, id = u32(b, tfhd.s + 4), q = tfhd.s + 8;
                if (id !== tk.id) return;
                var trex = init.trex[id] || {}, base = moofStart, defDur = trex.dur || 1024, defSize = trex.size || 0;
                if (fl & 0x01) { base = u64(b, q); q += 8; }
                if (fl & 0x02) q += 4;
                if (fl & 0x08) { defDur = u32(b, q); q += 4; }
                if (fl & 0x10) { defSize = u32(b, q); q += 4; }
                var tfdt = findBox(b, ts, te, ['tfdt']), dts = 0;
                if (tfdt) dts = b[tfdt.s] === 1 ? u64(b, tfdt.s + 4) : u32(b, tfdt.s + 4);
                boxes(b, ts, te, function (rt, rs) {
                    if (rt !== 'trun') return;
                    var rf = u32(b, rs) & 0xffffff, cnt = u32(b, rs + 4), r = rs + 8, off = base, i, d, sz;
                    if (rf & 0x01) { off = base + (u32(b, r) | 0); r += 4; }
                    if (rf & 0x04) r += 4;
                    for (i = 0; i < cnt; i++) {
                        d = defDur; sz = defSize;
                        if (rf & 0x100) { d = u32(b, r); r += 4; }
                        if (rf & 0x200) { sz = u32(b, r); r += 4; }
                        if (rf & 0x400) r += 4;
                        if (rf & 0x800) r += 4;
                        if (sz > 0 && off + sz <= b.length) frames.push({ pts: dts, data: b.subarray(off, off + sz) });
                        off += sz; dts += d;
                    }
                });
            });
        });
        return { frames: frames, timescale: tk.timescale || tk.sr || 48000 };
    }

    // ---------------------------------------------------------------- PCM store: content timeline in integer samples
    var BLOCK = 65536;
    function PcmStore(sr, ch) { this.sr = sr; this.ch = ch; this.blocks = []; }
    PcmStore.prototype._idx = function (pos) {
        var b = this.blocks, lo = 0, hi = b.length - 1, mid, r = -1;
        while (lo <= hi) { mid = (lo + hi) >> 1; if (b[mid].s <= pos) { r = mid; lo = mid + 1; } else hi = mid - 1; }
        return r;
    };
    // Writes n samples at integer position pos. Existing data wins on overlap; joins within 2 samples are snapped.
    PcmStore.prototype.write = function (pos, planes, n) {
        var blocks = this.blocks, off = 0, c, guard = 0;
        pos = Math.round(pos);
        while (n > 0 && guard++ < 100000) {
            var i = this._idx(pos), b = i >= 0 ? blocks[i] : null, next, room, m;
            if (b) {
                var end = b.s + b.n;
                if (pos < end) { m = Math.min(n, end - pos); pos += m; off += m; n -= m; continue; }
                if (pos - end <= 2) pos = end;
            }
            next = blocks[i + 1] || null;
            if (next && pos >= next.s) { i = i + 1; continue; }
            if (b && pos === b.s + b.n && b.n < BLOCK) room = BLOCK - b.n;
            else {
                b = { s: pos, n: 0, d: [] };
                for (c = 0; c < this.ch; c++) b.d.push(new Float32Array(BLOCK));
                blocks.splice(i + 1, 0, b);
                room = BLOCK;
            }
            m = Math.min(n, room);
            if (next && pos + m > next.s) m = next.s - pos;
            if (m <= 0) { if (b.n === 0) blocks.splice(blocks.indexOf(b), 1); break; }
            for (c = 0; c < this.ch; c++) b.d[c].set(planes[Math.min(c, planes.length - 1)].subarray(off, off + m), b.n);
            b.n += m; pos += m; off += m; n -= m;
        }
    };
    // True if [pos, end) is covered, tolerating holes up to maxGap samples.
    PcmStore.prototype.covered = function (pos, end, maxGap) {
        var b = this.blocks, i = this._idx(pos), cur = pos;
        if (i < 0) i = 0;
        for (; i < b.length && cur < end; i++) {
            var be = b[i].s + b[i].n;
            if (be <= cur) continue;
            if (b[i].s > cur + maxGap) return false;
            cur = be;
        }
        return cur >= end;
    };
    // Copies [pos, pos+n) into out planes at outOff; holes are zero-filled.
    PcmStore.prototype.read = function (pos, n, out, outOff) {
        var blocks = this.blocks, i = this._idx(pos), cur = pos, end = pos + n, o = outOff || 0, c, oc = out.length;
        if (i < 0) i = 0;
        while (cur < end) {
            var b = blocks[i];
            if (!b || b.s >= end) { for (c = 0; c < oc; c++) out[c].fill(0, o + cur - pos, o + n); break; }
            var be = b.s + b.n;
            if (be <= cur) { i++; continue; }
            if (b.s > cur) { for (c = 0; c < oc; c++) out[c].fill(0, o + cur - pos, o + b.s - pos); cur = b.s; }
            var m = Math.min(be, end) - cur, so = cur - b.s;
            for (c = 0; c < oc; c++) out[c].set(b.d[Math.min(c, this.ch - 1)].subarray(so, so + m), o + cur - pos);
            cur += m; i++;
        }
    };
    PcmStore.prototype.prune = function (from, to) {
        var b = this.blocks, keep = [], i;
        for (i = 0; i < b.length; i++) if (b[i].n > 0 && b[i].s + b[i].n >= from && b[i].s <= to) keep.push(b[i]);
        var removed = b.length - keep.length;
        this.blocks = keep;
        return removed;
    };
    PcmStore.prototype.clear = function () { this.blocks = []; };
    PcmStore.prototype.ranges = function () {
        var r = [], b = this.blocks, i, sr = this.sr;
        for (i = 0; i < b.length; i++) {
            var s = b[i].s / sr, e = (b[i].s + b[i].n) / sr;
            if (r.length && Math.abs(r[r.length - 1][1] - s) < 0.001) r[r.length - 1][1] = e; else r.push([s, e]);
        }
        return r.map(function (x) { return [+x[0].toFixed(3), +x[1].toFixed(3)]; });
    };
    function resampleLinear(planes, n, from, to) {
        var m = Math.round(n * to / from), out = [], c, i, r = from / to;
        for (c = 0; c < planes.length; c++) {
            var src = planes[c], dst = new Float32Array(m);
            for (i = 0; i < m; i++) {
                var x = i * r, k = x | 0, f = x - k, a = k < n ? src[k] : 0, b = k + 1 < n ? src[k + 1] : a;
                dst[i] = a + (b - a) * f;
            }
            out.push(dst);
        }
        return out;
    }

    // ---------------------------------------------------------------- AAC decoding (WebCodecs, fallback decodeAudioData)
    function copyAudioData(ad, planes) {
        var n = ad.numberOfFrames, ch = ad.numberOfChannels, c, i, fmt = ad.format, t;
        try { for (c = 0; c < ch; c++) ad.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' }); return; } catch (e) {}
        if (fmt === 'f32-planar') { for (c = 0; c < ch; c++) ad.copyTo(planes[c], { planeIndex: c }); return; }
        if (fmt === 'f32' || fmt === 's16' || fmt === 's32') {
            t = fmt === 'f32' ? new Float32Array(n * ch) : (fmt === 's16' ? new Int16Array(n * ch) : new Int32Array(n * ch));
            var k = fmt === 'f32' ? 1 : (fmt === 's16' ? 1 / 32768 : 1 / 2147483648);
            ad.copyTo(t, { planeIndex: 0 });
            for (c = 0; c < ch; c++) { var p = planes[c]; for (i = 0; i < n; i++) p[i] = t[i * ch + c] * k; }
            return;
        }
        if (fmt === 's16-planar' || fmt === 's32-planar') {
            var k2 = fmt === 's16-planar' ? 1 / 32768 : 1 / 2147483648;
            for (c = 0; c < ch; c++) {
                t = fmt === 's16-planar' ? new Int16Array(n) : new Int32Array(n);
                ad.copyTo(t, { planeIndex: c });
                for (i = 0; i < n; i++) planes[c][i] = t[i] * k2;
            }
            return;
        }
        throw new Error('audio_format_' + fmt);
    }
    // One WebCodecs decoder per contiguous run of frames (AAC overlap state stays intact across segments).
    function WcRun(codecCfg, onPcm, onErr) {
        var self = this;
        this.fifo = []; this.lastEnd = 0; this.lastIn = -1e9; this.dead = false; this.onPcm = onPcm;
        this.dec = new w.AudioDecoder({
            output: function (ad) { self._out(ad); },
            error: function (e) { if (!self.dead) { self.dead = true; onErr(e); } }
        });
        this.dec.configure(codecCfg);
    }
    WcRun.prototype.feed = function (t, d, data) {
        this.fifo.push({ t: t, d: d });
        this.lastIn = t + d;
        this.dec.decode(new w.EncodedAudioChunk({ type: 'key', timestamp: Math.round(t * 1e6), duration: Math.round(d * 1e6), data: data }));
    };
    WcRun.prototype._out = function (ad) {
        try {
            if (this.dead) return;
            var n = ad.numberOfFrames, rate = ad.sampleRate, e = this.fifo.shift(), t, cover, planes = [], c;
            if (e) {
                t = e.t; cover = e.d;
                while (this.fifo.length && cover + this.fifo[0].d * 0.5 < n / rate) cover += this.fifo.shift().d;
            } else t = this.lastEnd;
            this.lastEnd = t + n / rate;
            for (c = 0; c < ad.numberOfChannels; c++) planes.push(new Float32Array(n));
            copyAudioData(ad, planes);
            this.onPcm(t, planes, n, rate);
        } catch (err) {
            ev('wc_output_error', errStr(err));
        } finally {
            try { ad.close(); } catch (x) {}
        }
    };
    WcRun.prototype.close = function () {
        var dec = this.dec, self = this;
        if (this.closing) return;
        this.closing = true;
        function fin() { self.dead = true; try { dec.close(); } catch (e) {} }
        try { dec.flush().then(fin, fin); } catch (e) { fin(); }
    };
    WcRun.prototype.kill = function () { this.dead = true; try { this.dec.close(); } catch (e) {} };

    function decodeAudio(ctx, ab) {
        return new Promise(function (resolve, reject) {
            try {
                var p = ctx.decodeAudioData(ab, resolve, reject);
                if (p && p.then) p.then(resolve, reject);
            } catch (e) { reject(e); }
        });
    }
    function adtsWrap(raw, info) {
        var sfi = SR_TABLE.indexOf(info.sr), aot = info.aot || 2, ch = info.ch || 2, fl = raw.length + 7, h = new Uint8Array(fl);
        if (sfi < 0) sfi = 3;
        h[0] = 0xff; h[1] = 0xf1;
        h[2] = (((aot - 1) & 3) << 6) | (sfi << 2) | ((ch >> 2) & 1);
        h[3] = ((ch & 3) << 6) | ((fl >> 11) & 3);
        h[4] = (fl >> 3) & 0xff;
        h[5] = ((fl & 7) << 5) | 0x1f;
        h[6] = 0xfc;
        h.set(raw, 7);
        return h;
    }
    // Decoder front-end. frames: [{t (content s), d (s), data (raw AAC), adts|null}]
    function AudioDec(kind, eng) {
        this.kind = kind; this.e = eng; this.run = null; this.tail = null; this.closed = false; this.inflight = 0;
        this.dadShift = toNum(lsGet('STTV_SPEED_DAD_SHIFT'), 0);
    }
    AudioDec.prototype.push = function (frames, info) {
        if (this.closed || !frames.length) return;
        if (this.kind === 'wc') this._wc(frames, info); else this._dad(frames, info);
    };
    AudioDec.prototype._wc = function (frames, info) {
        var self = this, i, f0 = frames[0];
        if (!this.run || this.run.dead || Math.abs(this.run.lastIn - f0.t) > 0.006) {
            if (this.run) this.run.close();
            var asc = info.asc || makeAsc(info.aot || 2, info.sr, info.ch);
            var aot = (asc[0] >> 3) || 2;
            this.run = new WcRun(
                { codec: 'mp4a.40.' + aot, sampleRate: info.sr, numberOfChannels: info.ch, description: asc },
                function (t, planes, n, rate) { if (!self.closed) self.e.onPcm(t, planes, n, rate); },
                function (err) { if (!self.closed) self.e.decoderError(err); }
            );
        }
        try {
            for (i = 0; i < frames.length; i++) this.run.feed(frames[i].t, frames[i].d, frames[i].data);
        } catch (e) {
            this.run.dead = true;
            this.e.decoderError(e);
        }
    };
    AudioDec.prototype._dad = function (frames, info) {
        var self = this, pre = [], i, f0 = frames[0], last = frames[frames.length - 1], parts = [], total = 0;
        if (this.tail && Math.abs(this.tail.end - f0.t) < 0.006) pre = this.tail.frames;
        this.tail = { end: last.t + last.d, frames: frames.slice(-2) };
        var all = pre.concat(frames);
        for (i = 0; i < all.length; i++) { var a = all[i].adts || adtsWrap(all[i].data, info); parts.push(a); total += a.length; }
        var buf = concatU8(parts, total), t0 = all[0].t, skipSec = f0.t - t0;
        this.inflight++;
        decodeAudio(this.e.ctx, buf.buffer).then(function (ab) {
            self.inflight--;
            if (self.closed) return;
            // decodeAudioData output index i <-> content t0 + (i - dadShift)/rate (dadShift: measured by sttv-probe click test)
            var rate = ab.sampleRate, want = Math.round(skipSec * rate) + self.dadShift, skip = Math.max(0, want);
            var n = ab.length - skip, planes = [], c;
            if (n <= 0) return;
            for (c = 0; c < ab.numberOfChannels; c++) planes.push(ab.getChannelData(c).subarray(skip));
            self.e.onPcm(skip === want ? f0.t : t0 + (skip - self.dadShift) / rate, planes, n, rate);
        }, function (err) {
            self.inflight--;
            if (!self.closed) self.e.decoderError(err);
        });
    };
    AudioDec.prototype.close = function () {
        this.closed = true;
        if (this.run) { this.run.kill(); this.run = null; }
    };

    // ---------------------------------------------------------------- WSOLA time-stretch (pitch preserved)
    // 46 ms periodic-Hann frames, 50% overlap (constant overlap-add), +-12 ms waveform-similarity search on L+R,
    // coarse step 2 + refine, normalized cross-correlation on every 2nd sample.
    function Wsola(sr, ch, coarse) {
        var N = 2 * Math.round(sr * 0.023), i, c;
        this.cs = coarse === 2 ? 2 : 4;
        this.sr = sr; this.ch = ch; this.N = N; this.H = N >> 1; this.L = N >> 1;
        this.D = Math.round(sr * 0.012); this.Dmax = Math.round(sr * 0.024);
        this.win = new Float32Array(N);
        for (i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
        this.cap = 4 * N + 2 * this.Dmax + 16;
        this.acc = []; this.wb = [];
        for (c = 0; c < ch; c++) { this.acc.push(new Float32Array(N)); this.wb.push(new Float32Array(this.cap)); }
        this.mono = new Float32Array(this.cap);
        this.pos = 0; this.prev = -1; this.lastShift = 0;
    }
    Wsola.prototype.reset = function (pos) {
        this.pos = pos; this.prev = -1;
        for (var c = 0; c < this.ch; c++) this.acc[c].fill(0);
    };
    // Search radius grows with speed (12 ms up to 1.25x -> 24 ms at 2x+): better splice similarity at high speeds.
    Wsola.prototype.dFor = function (s) {
        return Math.round(this.sr * clamp(0.012 + 0.016 * (s - 1.25), 0.012, 0.024));
    };
    // Input sample range needed for the next `hops` steps at speed s.
    Wsola.prototype.range = function (hops, s) {
        var a = Math.round(this.pos), D = this.dFor(s), lo = a - D;
        if (this.prev >= 0) lo = Math.min(lo, this.prev + this.H);
        return [lo - 2, Math.round(this.pos + (hops - 1) * this.H * s) + D + this.N + 2];
    };
    // One synthesis hop -> H samples into out[c][oo..). Returns the content position (samples) of the first one.
    Wsola.prototype.step = function (store, s, out, oo) {
        var N = this.N, H = this.H, D = this.dFor(s), L = this.L, ch = this.ch, a = Math.round(this.pos), x = a, c, i, w0 = -1;
        if (this.prev >= 0) {
            var tpl = this.prev + H, lo = Math.min(a - D, tpl), hi = Math.max(a + D + N, tpl + L), wl = hi - lo;
            if (wl <= this.cap) {
                w0 = lo;
                store.read(w0, wl, this.wb, 0);
                var m = this.mono, p0 = this.wb[0], p1 = this.wb[ch > 1 ? 1 : 0];
                for (i = 0; i < wl; i++) m[i] = p0[i] + p1[i];
                x = a + this._search(m, tpl - w0, a - w0, D, L);
            }
        }
        if (w0 < 0) { w0 = a; x = a; store.read(a, N, this.wb, 0); }
        var so = x - w0, win = this.win;
        for (c = 0; c < ch; c++) {
            var acc = this.acc[c], src = this.wb[c], o = out[c];
            for (i = 0; i < N; i++) acc[i] += win[i] * src[so + i];
            for (i = 0; i < H; i++) o[oo + i] = acc[i];
            acc.copyWithin(0, H, N);
            acc.fill(0, N - H, N);
        }
        this.lastShift = x - a;
        this.prev = x;
        this.pos += H * s;
        return a;
    };
    // Coarse pass: lag step cs on every cs-th sample (cs = 4 default, 2 = high quality),
    // then refine +-(cs-1) lags on every 2nd sample.
    Wsola.prototype._search = function (m, t0, c0, D, L) {
        var cs = this.cs, Le = L - (L % cs), j, d, k, te = 0, e = 0, cor, sc, best = 0, bestSc = -1e30, lo, hi;
        for (j = 0; j < Le; j += cs) te += m[t0 + j] * m[t0 + j];
        if (te < 1e-7) { this.lastCorr = 0; return 0; }
        k = c0 - D;
        for (j = 0; j < Le; j += cs) e += m[k + j] * m[k + j];
        for (d = -D; d <= D; d += cs) {
            k = c0 + d;
            cor = 0;
            for (j = 0; j < Le; j += cs) cor += m[t0 + j] * m[k + j];
            sc = cor / Math.sqrt(e + 1e-9);
            if (sc > bestSc) { bestSc = sc; best = d; }
            e += m[k + Le] * m[k + Le] - m[k] * m[k];
            if (e < 0) e = 0;
        }
        lo = Math.max(-D, best - cs + 1); hi = Math.min(D, best + cs - 1); bestSc = -1e30; te = 0;
        for (j = 0; j < Le; j += 2) te += m[t0 + j] * m[t0 + j];
        for (d = lo; d <= hi; d++) {
            k = c0 + d; cor = 0; e = 0;
            for (j = 0; j < Le; j += 2) { cor += m[t0 + j] * m[k + j]; e += m[k + j] * m[k + j]; }
            sc = cor / Math.sqrt(e + 1e-9);
            if (sc > bestSc) { bestSc = sc; best = d; }
        }
        this.lastCorr = bestSc / Math.sqrt(te + 1e-9);
        return best;
    };

    // ---------------------------------------------------------------- audio source (HLS: audio_only rendition or A/V variant)
    function resolveSources(info, v) {
        var cur = info.srcOverride || (v ? String(v.currentSrc || v.src || '') : ''), base = info.u || w.location.href;
        var vars = isMasterText(info.pl) ? parseMaster(info.pl, base) : [];
        if (vars.length) {
            var s = pickSources(vars, cur);
            if (s.audio) return Promise.resolve(s);
        }
        if (/^https?:/i.test(cur)) {
            var d = deriveAudioOnly(cur);
            return Promise.resolve({ audio: d || cur, audioKind: d ? 'derived' : 'same', video: cur, alt: d ? cur : null });
        }
        if (/^blob:/i.test(cur)) {
            return xhr(cur, 'text', null, 5000).then(function (txt) {
                if (isMasterText(txt)) {
                    var s2 = pickSources(parseMaster(txt, base), '');
                    if (s2.audio) return s2;
                }
                if (isMediaText(txt)) {
                    var pl = parseMedia(txt, base), first = pl.segs.length ? pl.segs[0].uri : '';
                    var d2 = first ? deriveAudioOnly(first.replace(/\/[^\/?#]*(\?[^#]*)?$/, '/index-dvr.m3u8')) : null;
                    return { audio: d2 || cur, audioKind: d2 ? 'derived' : 'same', video: null, videoText: txt, alt: d2 ? cur : null };
                }
                throw new Error('no_playlist');
            });
        }
        return Promise.reject(new Error('no_source'));
    }
    function HlsSource(eng) {
        this.e = eng; this.pl = null; this.mp4 = null; this.info = null; this.ref = {}; this.inflight = 0;
        this.reqs = {}; this.live = {}; this.dead = false; this.bytes = 0; this.noAudio = 0; this.s = null;
    }
    // 1.3.5 (TV report: engine:source:timeout after a re-engage on a saturated link): a playlist request that times out /
    // fails on the network is retried once (15 s) before the engine gives up; VOD playlists are cached for 5 min
    // (every v2b engagement starts a new engine = the same audio playlist again).
    var plCache = { map: {}, order: [] };
    function plText(u, self) {
        var c = plCache.map[u];
        if (c && now() - c.at < 300000) return Promise.resolve(c.text);
        function put(t) {
            if (isMediaText(t) && /#EXT-X-ENDLIST/.test(t)) {
                if (!plCache.map[u]) { plCache.order.push(u); if (plCache.order.length > 8) delete plCache.map[plCache.order.shift()]; }
                plCache.map[u] = { text: t, at: now() };
            }
            return t;
        }
        return xhr(u, 'text', null, 10000).then(put, function (err) {
            var m = errStr(err);
            if ((self && self.dead) || !/^(timeout|net|http_5\d\d)$/.test(m)) throw err;
            ev('playlist_retry', { url: String(u).replace(/[?#].*$/, '').slice(-60), err: m });
            return xhr(u, 'text', null, 15000).then(put);
        });
    }
    HlsSource.prototype.open = function (s) {
        var self = this, info = this.e.info;
        function baseOf(u) { return /^blob:/i.test(u) ? (info.u || w.location.href) : u; }
        var base = baseOf(s.audio);
        return plText(s.audio, self).then(null, function (err) {
            if (!s.alt) throw err;
            ev('audio_playlist_fallback', { from: s.audio, err: errStr(err) });
            s.audio = s.alt; s.audioKind = 'same'; s.alt = null; base = baseOf(s.audio);
            return plText(s.audio, self);
        }).then(function (txt) {
            if (self.dead) throw new Error('stopped');
            if (isMasterText(txt)) {
                var p = pickSources(parseMaster(txt, base), '');
                if (!p.audio) throw new Error('no_audio_variant');
                s.audio = p.audio; base = p.audio;
                if (!s.video) s.video = p.video;
                return plText(s.audio, self);
            }
            return txt;
        }).then(function (txt) {
            if (self.dead) throw new Error('stopped');
            var pl = parseMedia(txt, base);
            if (!pl.segs.length) throw new Error('empty_playlist');
            self.pl = pl; self.s = s;
            var jobs = [self._baseRef(s)];
            if (pl.fmp4) {
                jobs.push(xhr(pl.segs[0].map.uri, 'arraybuffer', pl.segs[0].map.range, 10000).then(function (ab) {
                    self.mp4 = parseMp4Init(new Uint8Array(ab));
                    if (!self.mp4 || !self.mp4.audio) throw new Error('no_audio_track');
                }));
            }
            ev('source_open', { audio: s.audio, kind: s.audioKind, segs: pl.segs.length, total: Math.round(pl.total), fmp4: pl.fmp4 });
            return Promise.all(jobs);
        });
    };
    // Content time 0 = first PTS of segment 0 of the *video* rendition (that is what native players report as 0).
    HlsSource.prototype._baseRef = function (s) {
        var self = this, info = this.e.info, vtxt, rp = info.refProvider ? info.refProvider() : null;
        if (rp) {
            // v2b: hls.js maps media time t <-> PTS initPTS + t (per discontinuity); use exactly that
            if (!this.ref[0]) { this.ref[0] = rp; ev('base_ref', { pts: +rp.pts.toFixed(4), src: rp.src }); }
            return Promise.resolve();
        }
        if (this.pl.fmp4) return Promise.resolve();
        if (s.videoText) vtxt = Promise.resolve(s.videoText);
        else if (s.video && s.video !== s.audio && !/^blob:/i.test(s.video)) vtxt = xhr(s.video, 'text', null, 10000);
        else vtxt = Promise.resolve(null);
        return vtxt.then(function (txt) {
            var vpl = (txt && isMediaText(txt)) ? parseMedia(txt, s.video || info.u || w.location.href) : self.pl;
            var seg0 = vpl.segs[0];
            if (!seg0 || vpl.fmp4) return;
            var r0 = seg0.range ? seg0.range[0] : 0, r1 = seg0.range ? Math.min(seg0.range[1], r0 + 65535) : 65535;
            return xhr(seg0.uri, 'arraybuffer', [r0, r1], 10000).then(function (ab) {
                // Video PTS is identical across Twitch renditions; audio start differs per rendition (up to ~1 frame).
                var r = demuxTS(new Uint8Array(ab)), p0 = r.firstVideoPts >= 0 ? r.firstVideoPts : r.firstAudioPts;
                if (p0 >= 0 && !self.ref[0]) {
                    self.ref[0] = { pts: p0 / 90000, t: 0, src: (vpl === self.pl ? 'own_' : 'video_') + (r.firstVideoPts >= 0 ? 'vpts' : 'apts') };
                    ev('base_ref', { pts: +self.ref[0].pts.toFixed(4), src: self.ref[0].src });
                }
            });
        }).then(null, function (e) { ev('base_ref_failed', errStr(e)); });
    };
    HlsSource.prototype.pump = function (ct, ahead) {
        if (!this.pl || this.dead) return;
        var segs = this.pl.segs, i0 = segAt(this.pl, Math.max(0, ct - 0.3)), i1 = segAt(this.pl, ct + ahead), i, sg, t = now();
        if (i0 < 0) return;
        for (i = i0; i <= i1; i++) {
            sg = segs[i];
            // self-heal: fed long ago but PCM missing (pruned / decoder hiccup) -> refetch
            if (sg.st === 2 && t - sg.fedAt > 3000 && this.e.store && !this.e.segCovered(sg, ct - 0.5)) { sg.st = 0; ev('seg_refetch', sg.i); }
        }
        for (i = i0; i <= i1 && this.inflight < 2; i++) {
            sg = segs[i];
            if (sg.st === 1 || sg.st === 2 || sg.st === 4) continue;
            if (sg.st === 3 && t < sg.retryAt) continue;
            this._fetch(sg);
        }
        for (i = i0; i <= i1; i++) {
            sg = segs[i];
            if (sg.st === 2) continue;
            if (sg.st !== 4) break;
            this._decode(sg);
        }
    };
    HlsSource.prototype._fetch = function (sg) {
        var self = this, req = xhr(sg.uri, 'arraybuffer', sg.range, 15000);
        sg.st = 1; this.inflight++; this.reqs[sg.i] = req;
        req.then(function (ab) {
            self.inflight--; delete self.reqs[sg.i];
            if (self.dead) return;
            sg.st = 4; sg.data = ab; sg.tries = 0; sg.err0 = 0; self.live[sg.i] = sg; self.bytes += ab.byteLength;
            self.e.kick();
        }, function (err) {
            self.inflight--; delete self.reqs[sg.i];
            if (self.dead) return;
            var t = now();
            sg.tries = (sg.tries || 0) + 1; sg.st = 3; sg.retryAt = t + Math.min(8000, 500 * Math.pow(2, sg.tries));
            if (!sg.err0) sg.err0 = t;
            ev('seg_error', { i: sg.i, err: errStr(err), tries: sg.tries });
            // 1.3.5: the native pipe falls back to the element's own audio quickly; v2b has none (TV report: a 20 s WAN
            // outage at 2x ended in engine:net) -> keep retrying for 45 s
            if (sg.tries >= 4 && (self.e.pipe !== 'v2b' || t - sg.err0 > 45000)) self.e.fail('net');
        });
    };
    HlsSource.prototype._decode = function (sg) {
        var ab = sg.data, frames = null;
        sg.data = null; sg.st = 2; sg.fedAt = now();
        try { frames = this._frames(sg, ab); } catch (e) { ev('demux_error', { i: sg.i, err: errStr(e) }); }
        if (!frames || !frames.length) {
            ev('seg_no_audio', sg.i);
            if (++this.noAudio > 2) this.e.fail('no_audio');
            return;
        }
        this.e.dec.push(frames, this.info);
    };
    HlsSource.prototype._ref = function (sg, firstSec, isTs) {
        var ref = this.ref[sg.disc], p;
        if (ref) {
            p = isTs ? unwrapPts(firstSec * 90000, (ref.pts + sg.start - ref.t) * 90000) / 90000 : firstSec;
            if (Math.abs(ref.t + p - ref.pts - sg.start) > 30) { ev('ref_reset', { i: sg.i, disc: sg.disc }); ref = null; }
        }
        if (!ref) ref = this.ref[sg.disc] = { pts: firstSec, t: sg.start, src: 'seg' + sg.i };
        return ref;
    };
    HlsSource.prototype._frames = function (sg, ab) {
        var u8 = new Uint8Array(ab), out = [], i, f, ref;
        if (this.pl.fmp4) {
            var r = parseMp4Fragment(u8, this.mp4);
            if (!r || !r.frames.length) return out;
            var a = this.mp4.audio, ts = r.timescale;
            if (!this.info) this.info = { sr: a.sr || 48000, ch: a.ch || 2, aot: a.asc ? (a.asc[0] >> 3) : 2, asc: a.asc };
            ref = this._ref(sg, r.frames[0].pts / ts, false);
            for (i = 0; i < r.frames.length; i++) {
                f = r.frames[i];
                var nx = r.frames[i + 1];
                out.push({ t: ref.t + f.pts / ts - ref.pts, d: nx ? (nx.pts - f.pts) / ts : 1024 / this.info.sr, data: f.data, adts: null });
            }
            return out;
        }
        var res = demuxTS(u8);
        if (!res.frames.length || !res.sr) return out;
        if (!this.info) this.info = { sr: res.sr, ch: res.ch || 2, aot: res.aot || 2, asc: makeAsc(res.aot || 2, res.sr, res.ch || 2) };
        ref = this._ref(sg, res.frames[0].pts / 90000, true);
        var exp = (ref.pts + sg.start - ref.t) * 90000, dur = 1024 / res.sr;
        for (i = 0; i < res.frames.length; i++) {
            f = res.frames[i];
            out.push({ t: ref.t + unwrapPts(f.pts, exp) / 90000 - ref.pts, d: dur, data: f.data, adts: f.adts });
        }
        return out;
    };
    HlsSource.prototype.forget = function (from, to) {
        var k, sg;
        for (k in this.live) {
            if (!Object.prototype.hasOwnProperty.call(this.live, k)) continue;
            sg = this.live[k];
            if (sg.st === 1) continue;
            if (sg.start + sg.dur < from || sg.start > to) { sg.st = 0; sg.data = null; delete this.live[k]; }
        }
    };
    HlsSource.prototype.resetFed = function () {
        var k;
        for (k in this.live) {
            if (!Object.prototype.hasOwnProperty.call(this.live, k)) continue;
            if (this.live[k].st !== 1) { this.live[k].st = 0; this.live[k].data = null; }
        }
        this.live = {};
    };
    HlsSource.prototype.close = function () {
        var k;
        this.dead = true;
        for (k in this.reqs) if (Object.prototype.hasOwnProperty.call(this.reqs, k)) this.reqs[k].abort();
        this.reqs = {};
        this.resetFed();
        if (this.pl) for (k = 0; k < this.pl.segs.length; k++) { this.pl.segs[k].st = 0; this.pl.segs[k].data = null; }
    };

    // ---------------------------------------------------------------- keeps <video> hardware-muted while the app still "sees" its own mute state
    function MuteGuard(v) { this.v = v; this.active = false; this.appMuted = false; this.proto = null; }
    MuteGuard.prototype.engage = function () {
        if (this.active) return true;
        var self = this, v = this.v, d = w.HTMLMediaElement && Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'muted');
        if (!d || !d.get || !d.set) return false;
        this.proto = d;
        try {
            this.appMuted = !!d.get.call(v);
            Object.defineProperty(v, 'muted', {
                configurable: true, enumerable: true,
                get: function () { return self.appMuted; },
                set: function (x) { self.appMuted = !!x; }
            });
            d.set.call(v, true);
            this.active = true;
            ev('mute_guard_on', { appMuted: this.appMuted });
            return true;
        } catch (e) { ev('mute_guard_error', errStr(e)); return false; }
    };
    MuteGuard.prototype.enforce = function () {
        if (this.active && this.proto && !this.proto.get.call(this.v)) { try { this.proto.set.call(this.v, true); } catch (e) {} }
    };
    MuteGuard.prototype.release = function () {
        if (!this.active) return;
        try { delete this.v.muted; } catch (e) {}
        try { this.proto.set.call(this.v, this.appMuted); } catch (e2) {}
        this.active = false;
        ev('mute_guard_off', { appMuted: this.appMuted });
    };

    // ---------------------------------------------------------------- video clock model (robust to coarse currentTime updates)
    function VClock() { this.pts = []; this.lastCt = -1; this.lastTw = 0; this.lastMove = -1e9; this.lastChange = -1; this.iv = []; this.tk = 0; }
    VClock.prototype.reset = function () { this.pts.length = 0; this.lastChange = -1; this.iv.length = 0; };
    VClock.prototype.sample = function (ct, tw, speed) {
        var dtk = tw - this.lastTw;
        if (this.lastTw > 0 && dtk > 0 && dtk < 0.5) this.tk = this.tk ? this.tk + 0.1 * (dtk - this.tk) : dtk;
        if (this.lastCt >= 0) {
            var d = ct - this.lastCt, lim = Math.max(1, speed);
            if (d > 0 && d < lim) this.lastMove = tw;
            if (d !== 0) {
                // Coarse clocks (webOS starfish steps currentTime every ~100-250 ms): the new value became current somewhere
                // in (lastTw, tw], not at tw -> timestamp it at the midpoint (removes a systematic tick/2 * speed lag).
                var tp = (this.tk > 0 && this.granularity() > 1.6 * this.tk && dtk > 0 && dtk < 0.25) ? tw - dtk / 2 : tw;
                if (d < 0 || d >= lim) this.reset();
                else if (this.pts.length && Math.abs(ct - this.estimate(tp, speed)) > 0.06 + 0.04 * speed) this.reset(); // stall / rate step
                if (this.lastChange > 0) { this.iv.push(tw - this.lastChange); if (this.iv.length > 15) this.iv.shift(); }
                this.lastChange = tw;
                this.pts.push({ tw: tp, ct: ct });
                while (this.pts.length > 16 || (this.pts.length && tw - this.pts[0].tw > 3)) this.pts.shift();
            }
        }
        this.lastCt = ct; this.lastTw = tw;
    };
    VClock.prototype.granularity = function () {
        if (!this.iv.length) return 0;
        var a = this.iv.slice().sort(function (x, y) { return x - y; });
        return a[a.length >> 1];
    };
    VClock.prototype.ready = function () {
        var p = this.pts;
        return p.length >= 3 && p[p.length - 1].tw - p[0].tw >= 0.06;
    };
    VClock.prototype.moving = function (tw) { return tw - this.lastMove < Math.max(0.6, 2.5 * this.granularity()); };
    VClock.prototype.estimate = function (tw, speed) {
        var n = this.pts.length, s = 0, i;
        if (!n) return this.lastCt;
        for (i = 0; i < n; i++) s += this.pts[i].ct + (tw - this.pts[i].tw) * speed;
        return s / n;
    };
    function mean(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
    function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }
    function pctl(a, p) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; }

    // ---------------------------------------------------------------- effective video rate: least-squares slope of currentTime(wall)
    function RateMeter() { this.p = []; }
    RateMeter.prototype.reset = function () { this.p.length = 0; };
    RateMeter.prototype.add = function (tw, ct) {
        var p = this.p, n = p.length;
        if (n && (ct < p[n - 1].ct - 0.001 || ct - p[n - 1].ct > (this.slow ? 4 : 1) || tw - p[n - 1].tw > (this.slow ? 2.5 : 0.5))) p.length = 0;
        p.push({ tw: tw, ct: ct });
        while (p.length > 2 && tw - p[0].tw > 12) p.shift();
    };
    RateMeter.prototype.span = function () { var p = this.p; return p.length > 1 ? p[p.length - 1].tw - p[0].tw : 0; };
    RateMeter.prototype.slope = function (minN) {
        var p = this.p, n = p.length, mx = 0, my = 0, sxx = 0, sxy = 0, i, dx;
        if (n < (minN || 8)) return null;
        for (i = 0; i < n; i++) { mx += p[i].tw; my += p[i].ct; }
        mx /= n; my /= n;
        for (i = 0; i < n; i++) { dx = p[i].tw - mx; sxx += dx * dx; sxy += dx * (p[i].ct - my); }
        return sxx > 0 ? sxy / sxx : null;
    };

    // ---------------------------------------------------------------- audio output latency tracker
    // Raw: getOutputTimestamp() (preferred) or baseLatency + outputLatency. TV sinks report 96..136 ms of jitter around a
    // stable true delay, so the applied value is a 3 s median with 4 ms hysteresis, slewed at <= 5 ms/s; the slew rate is
    // fed forward into the WSOLA rate (no drift ramp). A sustained change > 40 ms (BT headset, sound output switch)
    // is applied at once and the engine re-anchors (60 ms gap) instead of drifting for seconds.
    function LatTracker() { this.raw = []; this.applied = null; this.med = null; this.ff = 0; this.src = ''; this.lastTw = 0; this.jumps = 0; this.lastRaw = 0; }
    LatTracker.prototype.read = function (c) {
        if (c.getOutputTimestamp) {
            try {
                var ts = c.getOutputTimestamp();
                if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
                    var d = c.currentTime - (ts.contextTime + (now() - ts.performanceTime) / 1000);
                    if (d > 0.002 && d < 0.6) { this.src = 'ots'; return d; }
                }
            } catch (e) {}
        }
        this.src = 'prop';
        return (c.baseLatency > 0 ? c.baseLatency : 0) + (c.outputLatency > 0 ? c.outputLatency : 0);
    };
    LatTracker.prototype.update = function (c, tw) {
        var raw = this.read(c), dt = this.lastTw ? clamp(tw - this.lastTw, 0, 0.25) : 0, step = 0, m, diff;
        this.lastTw = tw; this.lastRaw = raw;
        this.raw.push(raw);
        if (this.raw.length > 75) this.raw.shift();
        m = this.med = median(this.raw);
        this.ff = 0;
        if (this.applied === null || this.raw.length < 25) { this.applied = m; return false; }
        diff = m - this.applied;
        if (Math.abs(diff) > 0.04) { this.applied = m; this.jumps++; return true; }
        if (Math.abs(diff) > 0.004 && dt > 0) {
            step = clamp(diff, -0.005 * dt, 0.005 * dt);
            this.applied += step;
            this.ff = step / dt;
        }
        return false;
    };

    // ---------------------------------------------------------------- engine
    // v1.3: platform defaults first (v1.2 forced { sampleRate: 48000, latencyHint: 'playback' } - the TV then ran the
    // engine "anchored" with nothing audible; the known-audible webOS reference engine uses new AudioContext()).
    var sharedCtx = null, ctxMeta = null;
    function ctxOptions(m) {
        if (m === '48k') return [{ sampleRate: 48000, latencyHint: 'playback' }, { latencyHint: 'playback' }, null];
        if (m === 'playback') return [{ latencyHint: 'playback' }, null];
        return [null, { latencyHint: 'playback' }];
    }
    function optLabel(o) { return !o ? 'default' : (o.sampleRate ? o.sampleRate + '/' : '') + (o.latencyHint || 'default'); }
    function newContext(m) {
        var AC = w.AudioContext || w.webkitAudioContext, opts = ctxOptions(m), i, c = null, err = '';
        if (!AC) return { ctx: null, opts: '', err: 'no_webaudio' };
        for (i = 0; i < opts.length && !c; i++) {
            try { c = opts[i] ? new AC(opts[i]) : new AC(); } catch (e) { c = null; err = errStr(e); }
        }
        return { ctx: c, opts: c ? optLabel(opts[i - 1]) : '', err: err };
    }
    function closeContext(why) {
        var c = sharedCtx;
        sharedCtx = null;
        if (!c) return;
        try { if (c.state !== 'closed') c.close(); } catch (e) {}
        ev('audio_context_closed', why || '');
    }
    function getContext(fresh, owner) {
        if (fresh) closeContext(fresh);
        if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
        var r = newContext(cfg.actx);
        sharedCtx = r.ctx;
        if (!sharedCtx) { ev('audio_context_error', r.err); return null; }
        ctxMeta = { opts: r.opts, owner: owner || '', at: now(), why: fresh || 'first', silent: false };
        ev('audio_context', { opts: r.opts, owner: ctxMeta.owner, why: ctxMeta.why, sr: sharedCtx.sampleRate, base: sharedCtx.baseLatency,
            out: sharedCtx.outputLatency, state: sharedCtx.state });
        return sharedCtx;
    }
    function db(x) { return x > 1e-6 ? +(20 * Math.log10(x)).toFixed(1) : -120; }
    // one meter window (0.5 s): pcm = WSOLA output fed to the graph, out = graph output after the fade + volume gains
    function audioClass(pcmDb, outDb) {
        if (outDb !== null && outDb > -70) return 'rendering';
        if (pcmDb !== null && pcmDb <= -85) return 'pcm_silent';
        if (pcmDb !== null && pcmDb > -60) return 'graph_silent';
        return 'quiet';
    }
    function realMuted(v) {
        var d = w.HTMLMediaElement && Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'muted');
        try { return d && d.get ? !!d.get.call(v) : !!v.muted; } catch (e) { return null; }
    }
    function wantDecoder() {
        var forced = String(lsGet('STTV_SPEED_DECODER') || '').toLowerCase();
        if (forced === 'dad') return Promise.resolve('dad');
        if (!w.AudioDecoder || !w.EncodedAudioChunk) return Promise.resolve('dad');
        try {
            return w.AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 })
                .then(function (r) { return r && r.supported ? 'wc' : 'dad'; }, function () { return 'dad'; });
        } catch (e) { return Promise.resolve('dad'); }
    }
    function Engine(v, info, speed) {
        this.v = v; this.info = info; this.key = info.key; this.speed = speed; this.eff = speed;
        this.dead = false; this.ready = false; this.anch = false; this.nodes = []; this.dw = []; this.resyncs = [];
        this.vc = new VClock(); this.guard = new MuteGuard(v); this.src = new HlsSource(this);
        this.store = null; this.ws = null; this.dec = null; this.ch = 2; this.outBuf = null;
        this.lead = 0.6; this.lastCt = 0; this.ahead = 12; this.unanchoredAt = 0; this.anchorBackoffUntil = 0; this.anchorTw = 0;
        this.rateStrikes = 0; this.rateRatio = null; this.lastPrune = 0; this.meanDrift = 0; this.lastDrift = 0;
        this.latS = null; this.curVol = -1; this.dadErrors = 0; this.starving = false;
        this.pipe = info.pipe || pipeKind(v); this.rmeter = new RateMeter(); this.lat = new LatTracker();
        this.rateOk = !cfg.rateGate ? false : capSpeedOk(this.pipe, speed);   // verified earlier on this firmware -> no pre-flight
        this.ignStrikes = 0; this.misStrikes = 0; this.lastTickTw = 0;
        this.q = { playS: 0, anchS: 0, abs: [] };
        this.am = { pcmSq: 0, pcmN: 0, pcmDb: null, outDb: null, peakDb: null, at: 0, ctxT: 0, clock: null, cls: '', silentS: 0, okS: 0, flagged: '',
            quietS: 0, silentTotalS: 0, startS: 0, unanchS: 0 };
        this.stats = { anchors: 0, resyncs: 0, underruns: 0, chunks: 0, pcmSec: 0 };
        this.startedAt = now();
    }
    Engine.prototype.start = function () {
        var self = this;
        // v2b: fresh context, opened after the MSE pipeline is playing (the shared one may be from the native pre-flight)
        var fresh = (this.pipe === 'v2b' && cfg.actxFresh) ? 'v2b_start' : ((ctxMeta && ctxMeta.silent) ? 'was_silent' : '');
        this.ctx = getContext(fresh, this.pipe);
        if (!this.ctx) { this.fail('no_webaudio'); return; }
        this.ctxOpts = ctxMeta ? ctxMeta.opts : '';
        try { if (this.ctx.state !== 'running') this.ctx.resume(); } catch (e) {}
        this.fade = this.ctx.createGain(); this.fade.gain.value = 0;
        this.vol = this.ctx.createGain(); this.vol.gain.value = 1;
        this.fade.connect(this.vol); this.vol.connect(this.ctx.destination);
        this.meter = null;
        try { this.meter = this.ctx.createAnalyser(); this.meter.fftSize = 2048; this.meterBuf = new Float32Array(2048); this.vol.connect(this.meter); }
        catch (e) { this.meter = null; }
        this._bind();
        this.timer = w.setInterval(function () { self.tick(); }, 40);
        ev('engine_start', { speed: this.speed, key: this.key });
        Promise.all([wantDecoder(), resolveSources(this.info, this.v)]).then(function (r) {
            if (self.dead) return;
            self.dec = new AudioDec(r[0], self);
            return self.src.open(r[1]);
        }).then(function () {
            if (self.dead) return;
            self.ready = true;
            ev('engine_ready', { decoder: self.dec.kind, ms: Math.round(now() - self.startedAt) });
            self.kick();
        }).then(null, function (e) { if (!self.dead) self.fail('source:' + errStr(e)); });
    };
    Engine.prototype._bind = function () {
        var self = this, v = this.v, k;
        this.handlers = {
            seeking: function () { self.vc.reset(); self.rmeter.reset(); self.unanchor('seeking'); },
            pause: function () { self.vc.reset(); self.rmeter.reset(); self.unanchor('pause'); },
            waiting: function () { self.vc.reset(); self.rmeter.reset(); self.unanchor('waiting'); },
            playing: function () { self.vc.reset(); self.rmeter.reset(); },
            ratechange: function () { self.vc.reset(); self.rmeter.reset(); },
            emptied: function () { self.vc.reset(); self.rmeter.reset(); self.unanchor('emptied'); },
            ended: function () { self.unanchor('ended'); },
            error: function () { self.unanchor('video_error'); }
        };
        for (k in this.handlers) if (Object.prototype.hasOwnProperty.call(this.handlers, k)) v.addEventListener(k, this.handlers[k]);
    };
    Engine.prototype._unbind = function () {
        var k;
        if (!this.handlers) return;
        for (k in this.handlers) if (Object.prototype.hasOwnProperty.call(this.handlers, k)) this.v.removeEventListener(k, this.handlers[k]);
        this.handlers = null;
    };
    Engine.prototype.kick = function () {
        if (!this.dead && this.ready) { try { this.src.pump(this.lastCt, this.ahead); } catch (e) { ev('pump_error', errStr(e)); } }
    };
    Engine.prototype.segCovered = function (sg, from) {
        var sr = this.store.sr, a = Math.round(Math.max(sg.start + 0.1, from || 0) * sr), b = Math.round((sg.start + sg.dur - 0.1) * sr);
        return b <= a || this.store.covered(a, b, Math.round(0.03 * sr));
    };
    Engine.prototype.tick = function () {
        if (this.dead) return;
        try { this._tick(); } catch (e) {
            ev('tick_error', errStr(e) + (e && e.stack ? ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ') : ''));
            this.fail('internal');
        }
    };
    Engine.prototype._tick = function () {
        var v = this.v, tw = now() / 1000, ct = v.currentTime || 0;
        var playing = !v.paused && !v.seeking && !v.ended && v.readyState >= 2;
        this.vc.sample(ct, tw, this.speed);
        var moving = playing && this.vc.moving(tw);
        // 1.3.5: while a v2b switch re-attaches the element, currentTime reads 0 (TV: the engine fetched audio segment 0 and
        // pruned the PCM around the real position) -> fetch / keep audio around the switch position
        var pct = (this.pipe === 'v2b' && v2b.state === 'engaging' && v2b.v === v && v2b.switchAt && v2b.startPos > 0 && Math.abs(ct - v2b.startPos) > 3) ? v2b.startPos : ct;
        this.lastCt = pct;
        this.ahead = Math.max(12, 8 * this.speed);
        var dtt = this.lastTickTw ? clamp(tw - this.lastTickTw, 0, 0.5) : 0;
        this.lastTickTw = tw;
        if (moving) { this.q.playS += dtt; if (this.anch) this.q.anchS += dtt; }
        if (this.ctx && this.ctx.state === 'running' && this.lat.update(this.ctx, tw) && this.anch) {
            ev('latency_jump', { to: +this.lat.applied.toFixed(3) });
            this.unanchor('latency_jump'); this.anchorBackoffUntil = tw + 0.06;
        }
        this.latS = this.lat.applied;
        this._rateCheck(moving, ct, tw);
        if (this.dead) return;
        if (this.ready) {
            this.src.pump(pct, this.ahead);
            if (this.store && tw - this.lastPrune > 1 && pct === ct) {
                this.lastPrune = tw;
                var sr = this.store.sr;
                this.store.prune(Math.round((ct - 8) * sr), Math.round((ct + this.ahead + 25) * sr));
                this.src.forget(ct - 5, ct + this.ahead + 20);
            }
        }
        this.guard.enforce();
        this._applyVolume();
        this._meter(tw);
        if (this.anch) {
            if (!moving) this.unanchor('frozen');
            else this._service(tw);
        } else if (moving && this.vc.ready() && this.store && this.ws) this._tryAnchor(tw);
        if (!this.anch && this.guard.active && moving && tw - this.unanchoredAt > 3) {
            this.guard.release();
            ev('native_audio_while_waiting');
        }
    };
    Engine.prototype._applyVolume = function () {
        var muted = this.guard.active ? this.guard.appMuted : !!this.v.muted;
        var target = muted ? 0 : clamp(+this.v.volume || 0, 0, 1);
        if (Math.abs(target - this.curVol) < 0.001) return;
        this.curVol = target;
        try { this.vol.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02); } catch (e) { this.vol.gain.value = target; }
    };
    Engine.prototype._guardWanted = function () {
        if (cfg.mute === 'off') return false;
        if (cfg.mute === 'hw') return true;
        return this.pipe !== 'v2b';
    };
    Engine.prototype._meter = function (tw) {
        var a = this.am, c = this.ctx, i, x, sq = 0, pk = 0, dt;
        if (!c || tw - a.at < 0.5) return;
        dt = a.at ? tw - a.at : 0;
        a.clock = dt > 0 ? +((c.currentTime - a.ctxT) / dt).toFixed(3) : null;
        a.at = tw; a.ctxT = c.currentTime;
        a.pcmDb = a.pcmN ? db(Math.sqrt(a.pcmSq / a.pcmN)) : null;
        a.pcmSq = 0; a.pcmN = 0;
        if (this.meter) {
            try {
                this.meter.getFloatTimeDomainData(this.meterBuf);
                for (i = 0; i < this.meterBuf.length; i++) { x = this.meterBuf[i]; sq += x * x; if (x < 0) x = -x; if (x > pk) pk = x; }
                a.outDb = db(Math.sqrt(sq / this.meterBuf.length)); a.peakDb = db(pk);
            } catch (e) { a.outDb = null; }
        }
        // 1.3.2: every meter interval lands in exactly one bucket (renderingS / quietS / silentTotalS / startS / unanchS);
        // silentS stays the CURRENT silent streak (reset by rendering) that drives the 3 s audio_silent flag.
        if (!this.anch || tw - this.anchorTw < 1.5) { a.cls = this.anch ? 'starting' : ''; if (this.anch) a.startS += dt; else a.unanchS += dt; return; }
        a.cls = audioClass(a.pcmDb, a.outDb);
        if (a.cls === 'rendering') { a.okS += dt; a.silentS = 0; }
        else if (a.cls === 'pcm_silent' || a.cls === 'graph_silent') { a.silentS += dt; a.silentTotalS += dt; }
        else a.quietS += dt;
        // 1.3.6: the graph verdict has its own streak. PCM is metered when scheduled (lead ~0.6 s), the output when played:
        // a silent intro followed by speech gives one or two 'graph_silent' windows at the transition (TV 2026-11-05: a
        // false "gain" toast at 0.75x). Only >= 3 s of CONSECUTIVE graph-silent windows mean the graph swallows the PCM.
        a.gsS = a.cls === 'graph_silent' ? (a.gsS || 0) + dt : 0;
        if (!this.renderNote && a.okS >= 1) {
            this.renderNote = true;
            ev('audio_rendering', { outDb: a.outDb, pcmDb: a.pcmDb, ctx: this.ctxOpts, out: c.outputLatency, base: c.baseLatency, guard: this.guard.active, muted: realMuted(this.v) });
            if (cfg.debug) toast('on', this.speed);
        }
        if (!a.flagged && a.silentS >= 3) {
            // 1.3.5: decoded PCM below -85 dB = the content itself is silent (TV report: stream intros, a seek -> sound at once)
            a.flagged = a.gsS >= 3 ? 'graph_silent' : 'pcm_silent';
            meterSilentEv(this, a.flagged);
        }
        if (!a.gsFlagged && a.gsS >= 3) {
            a.gsFlagged = true;
            if (a.flagged !== 'graph_silent') { a.flagged = 'graph_silent'; meterSilentEv(this, 'graph_silent'); }
            if (ctxMeta && c === sharedCtx) ctxMeta.silent = true;       // 1.3.6: only a graph problem asks for a fresh context
            toast('silent', 'gain');
        }
    };
    function meterSilentEv(e, cause) {
        var a = e.am, c = e.ctx;
        ev('audio_silent', { cause: cause, pcmDb: a.pcmDb, outDb: a.outDb, fade: +e.fade.gain.value.toFixed(3), vol: +e.vol.gain.value.toFixed(3),
            muted: realMuted(e.v), appMuted: !!e.v.muted, volume: +(+e.v.volume || 0).toFixed(2), ctx: c.state, guard: e.guard.active,
            ct: +(e.lastCt || 0).toFixed(1), gsS: +(a.gsS || 0).toFixed(1) });
    }
    Engine.prototype._latency = function () {
        if (this.lat.applied === null) this.lat.update(this.ctx, now() / 1000);
        this.latS = this.lat.applied;
        return this.latS;
    };
    Engine.prototype._target = function (tw, when) {
        return this.vc.estimate(tw, this.speed) + (when - this.ctx.currentTime + this._latency() - cfg.offsetMs / 1000) * this.speed;
    };
    Engine.prototype._tryAnchor = function (tw) {
        if (tw < this.anchorBackoffUntil) return;
        if (!this.rateOk) {
            // pre-flight: native audio stays on until _rateCheck() has measured the video at `speed`
            if (this.guard.active) { this.guard.release(); ev('preflight_native_audio'); }
            if (!this.preLogged) { this.preLogged = true; ev('rate_verify', { speed: this.speed, pipe: this.pipe }); }
            return;
        }
        // Mute first, anchor ~0.3 s later on a fresh clock: muting can step the media clock (Chrome swaps the audio sink
        // of a muted element: currentTime jumps ~40 ms) - anchoring across that step cost 2-3 s of -40..-80 ms error.
        // v1.3: only where the element plays audio itself (native pipe). v2b elements carry no audio track, and on webOS
        // the element mute is suspected to silence the app's WebAudio output as well (README 11).
        var useGuard = this._guardWanted();
        if (!useGuard && this.guard.active) this.guard.release();
        if (useGuard && !this.guard.active && this.guard.engage()) {
            this.vc.reset(); this.settleUntil = tw + 0.3; this.unanchoredAt = tw;
            ev('mute_settle');
            return;
        }
        if (tw < (this.settleUntil || 0)) return;
        var ctx = this.ctx;
        if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) {} return; }
        var sr = this.store.sr, when = ctx.currentTime + 0.1, target = Math.max(0, this._target(tw, when));
        var pos = Math.round(target * sr), a = pos - this.ws.Dmax - 2, b = pos + Math.round(0.8 * this.speed * sr) + this.ws.N + this.ws.Dmax;
        if (!this.store.covered(a, b, Math.round(0.03 * sr))) {
            if (!this.waitLogged) { this.waitLogged = true; ev('anchor_wait_data', +target.toFixed(2)); }
            return;
        }
        this.waitLogged = false;
        this.ws.reset(pos);
        this.nextWhen = when;
        this.anch = true; this.dw.length = 0; this.eff = this.speed; this.anchorTw = tw;
        this.stats.anchors++;
        if (useGuard && !this.guard.active) this.guard.engage();
        this._fade(1, when, 0.06);
        ev('anchor', { ct: +this.lastCt.toFixed(3), target: +target.toFixed(3), speed: this.speed, lat: +(this.latS || 0).toFixed(3) });
        this._fill();
    };
    Engine.prototype._service = function (tw) {
        var nowC = this.ctx.currentTime, sr = this.store.sr;
        if (this.nextWhen < nowC + 0.015) { this.stats.underruns++; this.unanchor('underrun'); this.anchorBackoffUntil = tw + 0.05; return; }
        var drift = this.ws.pos / sr - this._target(tw, this.nextWhen);
        this.lastDrift = drift;
        this.dw.push(drift);
        if (this.dw.length > 30) this.dw.shift();
        if (tw - this.anchorTw > 0.5) { this.q.abs.push(Math.abs(drift)); if (this.q.abs.length > 750) this.q.abs.shift(); }
        var med5 = median(this.dw.slice(-5));
        if (tw - this.anchorTw > 0.3 && (Math.abs(drift) > 0.6 || (this.dw.length >= 5 && Math.abs(med5) > 0.15))) { this.resync('drift', med5); return; }
        if (this.dw.length >= 10) {
            var m = mean(this.dw);
            this.meanDrift = m;
            var rel = Math.abs(m) < 0.012 ? 0 : clamp(-m / (1.5 * this.speed), -0.06, 0.06);
            this.eff = this.speed * (1 + rel + this.lat.ff);     // + latency slew feed-forward (<= 0.5 %)
        } else if (this.lat.ff) this.eff = this.speed * (1 + this.lat.ff);
        this._fill();
    };
    Engine.prototype._fill = function () {
        var ctx = this.ctx, nowC = ctx.currentTime, sr = this.store.sr, ws = this.ws, H = ws.H;
        var hops = Math.max(1, Math.round(0.1 * sr / H)), len = hops * H, g = 0, c, k;
        if (!this.outBuf || this.outBuf[0].length !== len) { this.outBuf = []; for (c = 0; c < this.ch; c++) this.outBuf.push(new Float32Array(len)); }
        while (this.anch && this.nextWhen < nowC + this.lead && g++ < 10) {
            var rng = ws.range(hops, this.eff);
            if (!this.store.covered(rng[0], rng[1], Math.round(0.03 * sr))) { this.starving = true; break; }
            this.starving = false;
            var c0 = ws.pos, L0 = this.outBuf[0], e2 = 0;
            for (k = 0; k < hops; k++) ws.step(this.store, this.eff, this.outBuf, k * H);
            for (k = 0; k < len; k += 4) e2 += L0[k] * L0[k];
            this.am.pcmSq += e2; this.am.pcmN += Math.ceil(len / 4);
            var buf = ctx.createBuffer(this.ch, len, sr);
            for (c = 0; c < this.ch; c++) {
                if (buf.copyToChannel) buf.copyToChannel(this.outBuf[c], c); else buf.getChannelData(c).set(this.outBuf[c]);
            }
            var node = ctx.createBufferSource();
            node.buffer = buf;
            node.connect(this.fade);
            node.start(this.nextWhen);
            this.nodes.push({ n: node, end: this.nextWhen + len / sr });
            if (w.__sttvSpeedTap) {
                try { w.__sttvSpeedTap({ when: this.nextWhen, c0: c0 / sr, c1: ws.pos / sr, len: len, sr: sr, speed: this.speed, eff: this.eff, planes: this.outBuf }); } catch (e) {}
            }
            this.nextWhen += len / sr;
            this.stats.chunks++;
        }
        while (this.nodes.length && this.nodes[0].end < nowC - 0.05) this.nodes.shift();
    };
    Engine.prototype._fade = function (val, at, dur) {
        var g = this.fade.gain, nowC = this.ctx.currentTime;
        if (at < nowC) at = nowC;
        try {
            var cur = g.value;
            g.cancelScheduledValues(nowC);
            g.setValueAtTime(cur, nowC);
            if (at > nowC) g.setValueAtTime(cur, at);
            g.linearRampToValueAtTime(val, at + dur);
        } catch (e) { try { g.value = val; } catch (x) {} }
    };
    Engine.prototype.unanchor = function (reason) {
        if (!this.anch) return;
        var nowC = this.ctx.currentTime, i;
        this._fade(0, nowC, 0.025);
        for (i = 0; i < this.nodes.length; i++) { try { this.nodes[i].n.stop(nowC + 0.035); } catch (e) {} }
        this.nodes = [];
        this.anch = false; this.unanchoredAt = now() / 1000; this.starving = false;
        ev('unanchor', reason);
    };
    Engine.prototype.resync = function (reason, d) {
        var tw = now() / 1000;
        this.resyncs.push(tw);
        while (this.resyncs.length && tw - this.resyncs[0] > 30) this.resyncs.shift();
        this.stats.resyncs++;
        ev('resync', { reason: reason, drift: d === undefined ? null : +d.toFixed(3) });
        this.unanchor('resync');
        this.anchorBackoffUntil = tw + 0.06;
        if (this.resyncs.length > 8) this.fail('unstable');
    };
    Engine.prototype.setSpeed = function (s) {
        if (s === this.speed) return;
        ev('engine_speed', { from: this.speed, to: s });
        this.speed = s; this.eff = s;
        this.vc.reset(); this.rmeter.reset(); this.rateStrikes = 0; this.ignStrikes = 0; this.misStrikes = 0;
        this.rateOk = !cfg.rateGate ? false : capSpeedOk(this.pipe, s); this.preLogged = false;
        if (this.anch) { this.unanchor('speed'); this.anchorBackoffUntil = now() / 1000 + 0.06; }
    };
    // Pre-flight + fuse. Effective video rate = least-squares slope of currentTime over >= 2.5 s windows.
    // Pre-flight (rateOk false): the engine does not touch the audio; 1 window at `speed` -> verified (cached);
    // 2 windows at 1.00x while speed != 1 -> 'rate_ignored' (cached per firmware: never engaged again);
    // 3 windows of anything else -> 'rate_mismatch' (this stream only). After verification: v1.0 fuse (3 s windows, 12 %).
    Engine.prototype._rateCheck = function (ok, ct, tw) {
        var m = this.rmeter;
        if (!ok) { m.reset(); return; }
        m.add(tw, ct);
        if (m.span() < (this.rateOk ? 3 : 2.5)) return;
        var r = m.slope();
        m.reset();
        if (r === null) return;
        var rr = +r.toFixed(3), rel = r / this.speed - 1;
        this.rateRatio = r;
        if (this.pipe === 'unknown') this.pipe = pipeKind(this.v);     // blob: probe has finished by now
        ctl.lastRate = { ratio: rr, speed: this.speed, pipe: this.pipe, at: Math.round(now()) };
        if (!this.rateOk) {
            if (Math.abs(rel) <= 0.05) {
                this.rateOk = true; this.ignStrikes = 0; this.misStrikes = 0;
                ev('rate_ok', { ratio: rr, speed: this.speed, pipe: this.pipe });
                if (cfg.rateGate) capMarkOk(this.pipe, this.speed, rr);
                return;
            }
            ev('rate_strike', { ratio: rr, speed: this.speed, pre: true });
            if (Math.abs(r - 1) < 0.05 && Math.abs(this.speed - 1) >= 0.15) {
                if (++this.ignStrikes >= 2) {
                    if (cfg.rateGate) capMarkIgnored(this.pipe, this.speed, rr);
                    this.fail('rate_ignored');
                }
            } else if (++this.misStrikes >= 3) this.fail('rate_mismatch');
            return;
        }
        if (Math.abs(rel) > 0.12) {
            this.rateStrikes++;
            ev('rate_strike', { ratio: rr, speed: this.speed });
            if (this.rateStrikes >= 2) this.fail(Math.abs(r - 1) < 0.06 ? 'rate_ignored' : 'rate_mismatch');
        } else this.rateStrikes = 0;
    };
    Engine.prototype.onPcm = function (t, planes, n, rate) {
        if (this.dead) return;
        if (!this.store) {
            this.store = new PcmStore(rate, 2);
            this.ws = new Wsola(rate, 2);
            ev('pcm_ready', { rate: rate, ch: planes.length, decoder: this.dec ? this.dec.kind : '?' });
        }
        if (rate !== this.store.sr) { planes = resampleLinear(planes, n, rate, this.store.sr); n = planes[0].length; }
        this.store.write(Math.round(t * this.store.sr), planes, n);
        this.stats.pcmSec += n / this.store.sr;
    };
    Engine.prototype.decoderError = function (err) {
        if (this.dead) return;
        ev('decoder_error', { kind: this.dec ? this.dec.kind : '?', err: errStr(err) });
        if (this.dec && this.dec.kind === 'wc') {
            this.dec.close();
            this.dec = new AudioDec('dad', this);
            this.src.resetFed();
            if (this.store) this.store.clear();
            this.unanchor('decoder_fallback');
            return;
        }
        if (++this.dadErrors >= 3) this.fail('decode');
    };
    Engine.prototype.stop = function (reason) {
        if (this.dead) return;
        this.dead = true;
        w.clearInterval(this.timer);
        this._unbind();
        var self = this, nowC = this.ctx ? this.ctx.currentTime : 0, i;
        if (this.ctx && this.fade) {
            this._fade(0, nowC, 0.05);
            for (i = 0; i < this.nodes.length; i++) { try { this.nodes[i].n.stop(nowC + 0.06); } catch (e) {} }
        }
        this.nodes = [];
        this.anch = false;
        w.setTimeout(function () {
            self.guard.release();
            try { self.fade.disconnect(); self.vol.disconnect(); if (self.meter) self.meter.disconnect(); } catch (e) {}
        }, 70);
        try { this.src.close(); } catch (e2) {}
        if (this.dec) this.dec.close();
        this.store = null;
        ev('engine_stop', reason || '');
    };
    Engine.prototype.fail = function (reason) {
        if (this.dead) return;
        this.failReason = reason;
        ev('engine_fail', reason);
        this.stop('fail:' + reason);
        if (this.onFail) { try { this.onFail(reason); } catch (e) {} }
    };
    Engine.prototype.status = function () {
        var c = this.ctx;
        return {
            state: this.dead ? 'stopped' : (this.anch ? 'playing' : (this.ready ? 'waiting' : 'starting')),
            speed: this.speed, eff: +this.eff.toFixed(4), decoder: this.dec ? this.dec.kind : null,
            audio: this.src.s ? { url: this.src.s.audio, kind: this.src.s.audioKind } : null,
            baseRef: this.src.ref[0] || null,
            drift: { last: +this.lastDrift.toFixed(3), mean: +this.meanDrift.toFixed(3) },
            latency: this.latS === null ? null : +this.latS.toFixed(3), offsetMs: cfg.offsetMs,
            latencyTracker: { applied: this.lat.applied === null ? null : +this.lat.applied.toFixed(4), median: this.lat.med === null ? null : +this.lat.med.toFixed(4),
                raw: +this.lat.lastRaw.toFixed(4), src: this.lat.src, jumps: this.lat.jumps },
            pipe: this.pipe, rateVerified: this.rateOk,
            quality: { playS: +this.q.playS.toFixed(1), anchoredPct: this.q.playS > 1 ? +(100 * this.q.anchS / this.q.playS).toFixed(1) : null,
                driftP50Ms: this.q.abs.length ? +(pctl(this.q.abs, 0.5) * 1000).toFixed(1) : null,
                driftP95Ms: this.q.abs.length ? +(pctl(this.q.abs, 0.95) * 1000).toFixed(1) : null },
            clockGranularity: +this.vc.granularity().toFixed(3),
            rateRatio: this.rateRatio === null ? null : +this.rateRatio.toFixed(3),
            buffered: this.store ? this.store.ranges() : [], muteGuard: this.guard.active, starving: this.starving,
            ctx: c ? { sr: c.sampleRate, state: c.state, base: c.baseLatency, out: c.outputLatency, opts: this.ctxOpts || '' } : null,
            audioOut: { cls: this.am.cls, pcmDb: this.am.pcmDb, outDb: this.am.outDb, peakDb: this.am.peakDb, clock: this.am.clock,
                renderingS: +this.am.okS.toFixed(1), quietS: +this.am.quietS.toFixed(1), silentTotalS: +this.am.silentTotalS.toFixed(1),
                startS: +this.am.startS.toFixed(1), unanchS: +this.am.unanchS.toFixed(1), silentS: +this.am.silentS.toFixed(1), flagged: this.am.flagged || null,
                fade: this.fade ? +this.fade.gain.value.toFixed(3) : null, vol: this.vol ? +this.vol.gain.value.toFixed(3) : null,
                guard: this.guard.active, guardPolicy: cfg.mute, elementMuted: realMuted(this.v), volume: +(+this.v.volume || 0).toFixed(2) },
            stats: this.stats, recentResyncs: this.resyncs.length, fetchedKB: Math.round(this.src.bytes / 1024),
            failReason: this.failReason || null
        };
    };

    // ---------------------------------------------------------------- v2b: timeline compression (TV ignores playbackRate)
    // A private hls.js + the MSE hook (sttv-v2b.js): init segments are re-timed (timescale x S), the element plays at 1.0
    // and the content advances S x faster. The hook shims currentTime/duration/buffered/seekable/playbackRate on the
    // element (content time), so the app UI and the audio engine stay in content time. The hook's audio SourceBuffer is a
    // null sink: the audio comes from the engine (audio_only rendition + WSOLA), exactly like on native.
    //   takeover: pipe native (<video src=m3u8>): our hls.js plays the same media playlist on #sttv_main, restore = old src
    //   adopt:    pipe mse with the app's own hls.js: re-attach it while the hook is set to S
    // 1.3.3: + 0.25 (the hook supports 0.25-2; WSOLA works at any ratio). Other speeds go to the native pipeline.
    var V2B_SPEEDS = [0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2];
    var V2B_STALL_GRACE_MS = 4000, V2B_RESPEED_MS = 350, V2B_COOLDOWN_MS = 120000;     // 1.3.4
    var V2B_NET_OUTAGE_MS = 90000;                                                       // 1.3.5
    var BASE = SELF_SRC ? SELF_SRC.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') : '';
    var BUST = (/[?&]v=([^&#]+)/.exec(SELF_SRC) || [0, VERSION])[1];
    var v2b = { state: 'idle', mode: '', v: null, hls: null, Hls: null, hook: null, libs: null, libErr: null, libErrAt: 0,
        internal: 0, msSpeed: 1, orig: null, speed: 1, key: '', t0: 0, switchAt: 0, gen: 0, want: null, stable: 0, fail: null,
        takeovers: 0, failures: 0, reeng: [], lastError: null, lastRestore: null, frags: 0, stalls: [], initPts: null,
        engageMs: null, played: false, recovered: 0, restoring: null, shieldOn: false, guarded: null, plUrl: '', variant: null,
        bytes: 0, netErrors: 0, appHls: null, appHlsMedia: null, unavailNote: '',
        switchStalls: 0, activeAt: 0, seekAt: 0, startPos: 0, pending: null, pendingTimer: 0, respeeds: 0, coalesced: 0,
        retries: 0, lastBlock: '', hold: null, holds: 0, holdMax: 0,
        tl: { checks: 0, bad: 0, mismatches: 0, noted: -1, last: null },
        // 1.3.5: network awareness (TV report on 1.3.4 / Twitch NG 1.0.0)
        netAt: 0, kicked: false, kicks: 0, lastKick: 0, absorbAt: [], absorbed: 0, netEp: null, netRecovers: 0,
        bwEst: 0, bwN: 0, master: null, downs: { key: '', n: 0 }, stepDowns: 0, downCap: null, lowSince: 0,
        restoreNudges: 0, rwTimer: 0, engRetry: { key: '', n: 0, at: 0 }, engineRetries: 0 };
    function v2bNetSeen() { v2b.netAt = now(); }
    function v2bOwns(v) { return v2b.state !== 'idle' && !!v && v === v2b.v; }
    function loadScript(name, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (!doc || !BASE) { reject(new Error('no_base')); return; }
            var s = doc.createElement('script'), t = w.setTimeout(function () { s.onload = s.onerror = null; reject(new Error('timeout:' + name)); }, timeoutMs || 20000);
            s.onload = function () { w.clearTimeout(t); resolve(); };
            s.onerror = function () { w.clearTimeout(t); reject(new Error('load:' + name)); };
            s.src = BASE + name + '?v=' + BUST;
            (doc.head || doc.documentElement).appendChild(s);
        });
    }
    function v2bLibs() {
        if (v2b.libs) return v2b.libs;
        v2b.libs = (w.STTVMseHook ? Promise.resolve() : loadScript('sttv-v2b.js')).then(function () {
            if (v2b.Hls) return;
            var had = Object.prototype.hasOwnProperty.call(w, 'Hls'), prev = w.Hls;      // ours stays private (v2b.Hls)
            return loadScript('sttv-hls.min.js', 30000).then(function () {
                var H = w.Hls;
                if (had) w.Hls = prev; else { try { delete w.Hls; } catch (e) { w.Hls = undefined; } }
                if (!H || typeof H.isSupported !== 'function' || !H.isSupported()) throw new Error('hls_unsupported');
                v2b.Hls = H;
            });
        }).then(function () {
            if (!w.STTVMseHook || typeof w.STTVMseHook.installMseHook !== 'function') throw new Error('hook_missing');
            if (!v2b.hook) {
                var sink = function () { return { configure: function () {}, push: function () {}, discard: function () {}, reset: function () {}, destroy: function () {} }; };
                v2b.hook = w.STTVMseHook.installMseHook(w, {
                    getSpeed: function () { return v2b.msSpeed; },
                    createAudioSink: sink,
                    onRateRequest: function (r) { ev('v2b_rate_request', r); },
                    onError: function (e) { v2bHookError(e); },
                    onNativeAudio: function () {}
                });
            }
            ev('v2b_libs', { hls: v2b.Hls && v2b.Hls.version, hook: w.STTVMseHook.version });
        });
        v2b.libs.then(null, function (e) { v2b.libErr = errStr(e); v2b.libErrAt = now(); v2b.libs = null; ev('v2b_libs_failed', v2b.libErr); });
        return v2b.libs;
    }
    function v2bHookError(e) {
        var m = errStr(e);
        ev('v2b_hook_error', m);
        if (v2b.state !== 'idle' && /muxed/i.test(m)) w.setTimeout(function () { v2bFail('muxed_av'); }, 0);
    }
    // ---- segment cache (prefetched before the switch; survives an hls.js re-create on a speed change).
    // Copies are handed out: hls.js transfers the ArrayBuffers to its worker.
    // 1.3.8: emptied on stopVideo / a new stream (it kept up to 24 MB after the player closed); gen drops late downloads
    var segCache = { map: {}, order: [], bytes: 0, max: 24 * 1048576, pend: {}, gen: 0 };
    function cacheKey(u, r) { return String(u).replace(/#.*$/, '') + (r ? '@' + r[0] + '-' + r[1] : ''); }
    function cacheGet(k) {
        var b = segCache.map[k], i;
        if (!b) return null;
        i = segCache.order.indexOf(k);
        if (i >= 0) { segCache.order.splice(i, 1); segCache.order.push(k); }
        return b.slice(0);
    }
    function cachePut(k, ab) {
        if (!ab || !ab.byteLength || ab.byteLength > segCache.max / 2 || segCache.map[k]) return;
        segCache.map[k] = ab.slice(0); segCache.order.push(k); segCache.bytes += ab.byteLength;
        while (segCache.bytes > segCache.max && segCache.order.length) {
            var o = segCache.order.shift();
            segCache.bytes -= segCache.map[o].byteLength; delete segCache.map[o];
        }
    }
    function cacheClear() { segCache.map = {}; segCache.order = []; segCache.bytes = 0; segCache.gen++; }
    function segFetch(url, range, timeoutMs, onProg) {
        var k = cacheKey(url, range), hit = cacheGet(k), p;
        if (hit) { p = Promise.resolve(hit); p.abort = function () {}; p.cached = true; return p; }
        if (segCache.pend[k]) { p = segCache.pend[k].then(function (ab) { if (onProg) onProg(); return ab.slice(0); }); p.abort = function () {}; p.shared = true; return p; }
        var req = xhr(url, 'arraybuffer', range, timeoutMs, onProg), gen = segCache.gen;
        segCache.pend[k] = req;
        p = req.then(function (ab) { if (segCache.pend[k] === req) delete segCache.pend[k]; if (gen === segCache.gen) cachePut(k, ab); v2b.bytes += ab.byteLength; return ab; },
            function (e) { if (segCache.pend[k] === req) delete segCache.pend[k]; throw e; });
        p.abort = function () { if (segCache.pend[k] === req) delete segCache.pend[k]; req.abort(); };
        return p;
    }
    // ---- hls.js loader over our network paths (direct XHR / LAN proxy / app Luna service)
    function newStats() {
        return { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
            loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
    }
    function V2bLoader(config) { this.config = config; this.stats = newStats(); this.context = null; this.cbs = null; this.req = null; this.timer = 0; this.done = true; }
    V2bLoader.prototype.load = function (context, config, callbacks) {
        var self = this, url = String(context.url || ''), text = context.responseType !== 'arraybuffer';
        var range = (context.rangeEnd > 0 && context.rangeEnd > (context.rangeStart || 0)) ? [context.rangeStart || 0, context.rangeEnd - 1] : null;
        var lp = config && config.loadPolicy, tmo = Math.min(60000, Math.max(8000, (lp && lp.maxLoadTimeMs) || (config && config.timeout) || 30000));
        this.stats = newStats(); this.context = context; this.cbs = callbacks; this.done = false;
        this.stats.loading.start = w.performance.now();
        // 1.3.5: v2bNetSeen = bytes arriving for the v2b pipeline (engaging timeout / hung-request kick)
        this.req = text ? (/^(blob|data):/i.test(url) ? rawXhr(url, 'text', null, tmo) : xhr(url, 'text', null, tmo, v2bNetSeen)) : segFetch(url, range, tmo, v2bNetSeen);
        this.timer = w.setTimeout(function () { self._fin('timeout'); }, tmo + 3000);
        this.req.then(function (d) { self._fin(null, d); }, function (e) { self._fin(e || new Error('error')); });
    };
    V2bLoader.prototype._fin = function (err, data) {
        if (this.done) return;
        this.done = true;
        if (this.timer) { w.clearTimeout(this.timer); this.timer = 0; }
        var st = this.stats, cb = this.cbs, ctx = this.context, t = w.performance.now(), m;
        if (!cb) return;
        if (err === 'timeout' || errStr(err) === 'timeout') {
            if (this.req && this.req.abort) this.req.abort();
            v2b.netErrors++;
            if (cb.onTimeout) cb.onTimeout(st, ctx, null);
            return;
        }
        if (err) {
            // hls.js retries 5xx only (0 = CORS = permanent): transient Luna / network failures are reported as 502
            m = /(?:http_|STATUS_)(\d{3})/.exec(errStr(err));
            v2b.netErrors++;
            cb.onError({ code: m ? +m[1] : 502, text: errStr(err) }, ctx, null, st);
            return;
        }
        var n = typeof data === 'string' ? data.length : (data ? data.byteLength : 0);
        // 1.3.5: link throughput from real segment downloads (not cache hits / shared prefetches) -> variant step-down
        if (typeof data !== 'string' && n >= 262144 && this.req && !this.req.cached && !this.req.shared && t - st.loading.start > 40) {
            m = n * 8000 / (t - st.loading.start);
            v2b.bwEst = v2b.bwN ? v2b.bwEst * 0.7 + m * 0.3 : m; v2b.bwN++;
        }
        st.loading.first = Math.max(st.loading.start, t - 1); st.loading.end = t;
        st.loaded = st.total = n; st.chunkCount = 1;
        cb.onSuccess({ url: ctx.url, data: data, code: 200 }, st, ctx, null);
    };
    V2bLoader.prototype.abort = function () {
        if (this.done) return;
        this.done = true; this.stats.aborted = true;
        if (this.timer) { w.clearTimeout(this.timer); this.timer = 0; }
        if (this.req && this.req.abort) this.req.abort();
        if (this.cbs && this.cbs.onAbort) this.cbs.onAbort(this.stats, this.context, null);
    };
    V2bLoader.prototype.destroy = function () { this.cbs = null; this.abort(); this.context = null; };
    V2bLoader.prototype.getCacheAge = function () { return null; };
    V2bLoader.prototype.getResponseHeader = function () { return null; };
    function v2bHlsConfig(pos) {
        function pol(ttfb, max, n) {
            return { default: { maxTimeToFirstByteMs: ttfb, maxLoadTimeMs: max, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
                errorRetry: { maxNumRetry: n, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } };
        }
        return { debug: false, enableWorker: cfg.v2bWorker, startPosition: pos, autoStartLoad: true, lowLatencyMode: false,
            maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 40 * 1000 * 1000, backBufferLength: 10,
            startFragPrefetch: false, testBandwidth: false, capLevelToPlayerSize: false, nudgeMaxRetry: 5, loader: V2bLoader,
            fragLoadPolicy: pol(30000, 60000, 4), playlistLoadPolicy: pol(10000, 20000, 2), manifestLoadPolicy: pol(10000, 20000, 2) };
    }
    // ---- which media playlist hls.js gets: the one the element plays (blob: text or https), or a <= MAXH variant
    function variantHeight(x) {
        var m = /x(\d{3,4})/.exec(x.res || '');
        if (m) return +m[1];
        m = /(\d{3,4})p\d*/.exec(String(x.video || '') + ' ' + String(x.uri || ''));
        return m ? +m[1] : 0;
    }
    function v2bPickVariant(vars, maxH, cur, maxBw) {
        var c = [], i, best = null, h;
        for (i = 0; i < vars.length; i++) if (!vars[i].audioOnly && vars[i].uri) c.push(vars[i]);
        if (!c.length) return null;
        if (cur && (!maxH || variantHeight(cur) <= maxH) && (!maxBw || !(cur.bw > maxBw))) return cur;
        for (i = 0; i < c.length; i++) {
            h = variantHeight(c[i]);
            if (maxH && h > maxH) continue;
            if (maxBw && c[i].bw > maxBw) continue;
            if (!best || c[i].bw > best.bw) best = c[i];
        }
        if (!best) for (i = 0; i < c.length; i++) if (!best || c[i].bw < best.bw) best = c[i];
        return best;
    }
    function v2bPlaylist(orig, st) {
        var src = orig.src, isBlob = /^blob:/i.test(src), base = (st && st.u) || w.location.href;
        var master = (st && isMasterText(st.pl)) ? parseMaster(st.pl, base) : [];
        // 1.3.5: a variant this stream had to step down from at this speed (network too slow) is not picked again
        var cap = (v2b.downCap && st && v2b.downCap.key === st.key && v2b.speed > 0) ? Math.floor(v2b.downCap.bps / v2b.speed) : 0;
        function get(u) { return /^(blob|data):/i.test(u) ? rawXhr(u, 'text', null, 6000) : xhr(u, 'text', null, 12000); }
        function fromMaster(cur, why) {
            var vv = v2bPickVariant(master, cfg.v2bMaxH, cur, cap);
            if (!vv) throw new Error('no_media_playlist:' + why);
            return get(vv.uri).then(function (t) {
                if (!isMediaText(t)) throw new Error('bad_variant_playlist');
                return { url: vv.uri, text: t, master: master, variant: { h: variantHeight(vv), bw: vv.bw, video: vv.video || null, from: 'master:' + why } };
            });
        }
        return get(src).then(function (txt) {
            if (isMasterText(txt)) { master = parseMaster(txt, isBlob ? base : src); return fromMaster(null, 'src_is_master'); }
            if (!isMediaText(txt)) throw new Error('src_not_m3u8');
            var pm = parseMedia(txt, isBlob ? base : src), seg0 = pm.segs[0], cur = null, i, dir;
            if (!seg0) throw new Error('empty_playlist');
            for (i = 0; i < master.length && !cur; i++) {
                dir = master[i].uri.replace(/[^\/]*([?#].*)?$/, '');
                if (!master[i].audioOnly && dir && seg0.uri.indexOf(dir) === 0) cur = master[i];
            }
            if (!/^https?:/i.test(seg0.uri)) return fromMaster(cur, 'relative_uris');
            if (cfg.v2bMaxH && cur && variantHeight(cur) > cfg.v2bMaxH) return fromMaster(cur, 'maxh');
            if (cap && cur && cur.bw > cap) return fromMaster(cur, 'netcap');
            return { url: src, text: txt, master: master, variant: cur ? { h: variantHeight(cur), bw: cur.bw, video: cur.video || null, from: 'element' } : { from: 'element' } };
        });
    }
    function v2bPrefetch(pl, v, gen) {
        var pm = parseMedia(pl.text, /^blob:/i.test(pl.url) ? w.location.href : pl.url), t0 = now(), n = 0, kb = 0;
        var i0 = segAt(pm, (v.currentTime || 0) + 1);
        function next(k) {
            if (gen !== v2b.gen || k < 0 || k >= pm.segs.length || n >= 2 || now() - t0 > 20000) return Promise.resolve();
            var sg = pm.segs[k];
            if (n > 0 && sg.start > (v.currentTime || 0) + 8) return Promise.resolve();
            n++;
            return segFetch(sg.uri, sg.range, 20000, v2bNetSeen).then(function (ab) { kb += ab.byteLength / 1024; return next(k + 1); },
                function (e) { ev('v2b_prefetch_error', errStr(e)); });
        }
        return next(i0).then(function () { ev('v2b_prefetched', { n: n, kb: Math.round(kb), ms: Math.round(now() - t0) }); });
    }
    // ---- element protection while v2b owns it
    function v2bRealRate1(v) {
        var P = w.HTMLMediaElement.prototype, d1 = Object.getOwnPropertyDescriptor(P, 'playbackRate'), d2 = Object.getOwnPropertyDescriptor(P, 'defaultPlaybackRate');
        try { if (d2 && d2.set) d2.set.call(v, 1); } catch (e) {}
        try { if (d1 && d1.set) d1.set.call(v, 1); } catch (e2) {}
    }
    function v2bShieldHandler(e) {
        var v = v2b.v, r;
        if (!v || e.target !== v) return;
        if (v2b.restoring) {
            r = v2b.restoring;
            if (e.type === 'loadedmetadata') {
                // back on the native source: the bridge would seek to its stale StartAuto resume point
                e.stopImmediatePropagation();
                v2b.restoring = null; v2bShield(false);
                applyNative(v, 1);          // 1.3.5: webOS 25 native pipeline froze at the v2b speed (TV report T5/T6/T8)
                try { if (r.pos > 0.5) v.currentTime = r.pos; } catch (x) {}
                if (r.play) { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (x2) {} }
                ev('v2b_restored', { pos: +r.pos.toFixed(2), ms: Math.round(now() - r.at), attempt: r.attempt || 1 });
                v2bRestoreWatch(v, r);
            } else if (e.type === 'error') {
                // 1.3.4: the platform can refuse the native source right after the MediaSource pipeline was torn down;
                // one silent retry before the bridge / app sees the error (it may close the player)
                if (!r.retry && r.src) {
                    r.retry = 1; e.stopImmediatePropagation();
                    ev('v2b_restore_error', { code: v.error ? v.error.code : null, retry: true });
                    w.setTimeout(function () { if (v2b.restoring !== r) return; v2bHold(r.pos, 'restore'); v2b.internal++; try { v.src = r.src; } catch (x3) {} finally { v2b.internal--; } }, 500);
                } else { v2b.restoring = null; v2bShield(false); ev('v2b_restore_error', { code: v.error ? v.error.code : null, retry: false }); }
            }
            return;
        }
        if (v2b.state === 'idle') return;
        e.stopImmediatePropagation();
        if (e.type === 'error') v2bFail('media_error:' + (v.error ? v.error.code : '?'));
    }
    function v2bShield(on) {
        if (on && !v2b.shieldOn) { w.addEventListener('loadedmetadata', v2bShieldHandler, true); w.addEventListener('error', v2bShieldHandler, true); }
        if (!on && v2b.shieldOn) { w.removeEventListener('loadedmetadata', v2bShieldHandler, true); w.removeEventListener('error', v2bShieldHandler, true); }
        v2b.shieldOn = !!on;
    }
    var srcGuardOk = false;
    function v2bSrcGuard() {
        // prototype level (below the hook's per-element shim, which calls down to it): app writes to src release v2b
        if (srcGuardOk) return;
        var P = w.HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, 'src');
        if (!d || !d.set || !d.configurable) return;
        srcGuardOk = true;
        Object.defineProperty(P, 'src', { configurable: true, enumerable: d.enumerable, get: d.get, set: function (val) {
            if (this === v2b.v && !v2b.internal && v2b.state !== 'idle') v2bExternal('src');
            return d.set.call(this, val);
        } });
    }
    function v2bGuard(v) {
        if (v2b.guarded === v) return;
        v2bUnguard();
        v2bSrcGuard();
        var P = w.HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, 'src');
        v.load = function () {
            if (!v2b.internal && v2b.state !== 'idle' && this === v2b.v) {
                // 1.3.5: the bridge's stall recovery (8 s without progress -> mv.load()) while hls.js plays: re-request the
                // data instead of tearing v2b down (TV report T10: WAN outage at 2x -> native reload offline -> VOD closed)
                if (v2b.hls && v2bAbsorbLoad()) return;
                // bridge hard reload (stall recovery): put its own source back first
                var o = v2b.orig, had = !!v2b.hls;
                v2bExternal('load');
                if (had && o && o.src && d && d.set) { v2b.internal++; try { d.set.call(this, o.src); } finally { v2b.internal--; } }
            }
            return P.load.apply(this, arguments);
        };
        v.removeAttribute = function (n) {
            if (!v2b.internal && v2b.state !== 'idle' && this === v2b.v && String(n).toLowerCase() === 'src') v2bExternal('removeAttribute');
            return w.Element.prototype.removeAttribute.apply(this, arguments);
        };
        v.setAttribute = function (n) {
            if (!v2b.internal && v2b.state !== 'idle' && this === v2b.v && String(n).toLowerCase() === 'src') v2bExternal('setAttribute');
            return w.Element.prototype.setAttribute.apply(this, arguments);
        };
        v2b.guarded = v;
    }
    function v2bUnguard() {
        var v = v2b.guarded;
        if (!v) return;
        try { delete v.load; delete v.removeAttribute; delete v.setAttribute; } catch (e) {}
        v2b.guarded = null;
    }
    function v2bExternal(what) { ev('v2b_external', what); v2bRelease('external_' + what); }
    // 1.3.5: buffered content seconds ahead of the playhead (content time through the hook's shim)
    function v2bAhead(v) {
        var b, ct, i;
        try { b = v.buffered; ct = v.currentTime; for (i = 0; i < b.length; i++) if (ct >= b.start(i) - 0.3 && ct <= b.end(i)) return +(b.end(i) - ct).toFixed(1); } catch (e) {}
        return 0;
    }
    function realRate(v) {
        var d = w.HTMLMediaElement && Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'playbackRate');
        try { return d && d.get ? d.get.call(v) : v.playbackRate; } catch (e) { return null; }
    }
    // hls.js stopLoad + startLoad at the content position = drop a hung request and ask again
    function v2bKick(why) {
        var hls = v2b.hls, v = v2b.v, pos;
        if (!hls || v2b.state === 'idle') return false;
        pos = v2bPos(v);
        v2b.kicks++; v2b.lastKick = now();
        ev('v2b_kick', { why: why, state: v2b.state, pos: +pos.toFixed(2), idleMs: Math.round(now() - lastOf(v2b.netAt, v2b.switchAt)), ahead: v2bAhead(v) });
        v2b.internal++;
        try { hls.stopLoad(); hls.startLoad(pos); } catch (e) { ev('v2b_kick_error', errStr(e)); } finally { v2b.internal--; }
        return true;
    }
    function v2bAbsorbLoad() {
        var t = now(), v = v2b.v;
        while (v2b.absorbAt.length && t - v2b.absorbAt[0] > 60000) v2b.absorbAt.shift();
        if (v2b.absorbAt.length >= 3) { ev('v2b_absorb_budget', v2b.absorbAt.length); return false; }
        v2b.absorbAt.push(t); v2b.absorbed++;
        ev('v2b_absorb_load', { n: v2b.absorbAt.length, state: v2b.state, ahead: v2bAhead(v), rs: v ? v.readyState : null });
        v2bKick('bridge_load');
        return true;
    }
    // 1.3.5: the restored native pipeline must really play again. TV report: a restore that left the element at the v2b
    // speed froze at the restore position, the bridge's stall recovery then restarted the VOD from 0.
    // 1.3.6: a restore is pending from v2bRestore until the native element plays on (v2b_restore_ok) or the watchdog gives up
    // 1.3.9: detection of moving playback without waiting for ct > p0 + 0.3. On webOS native HLS, restore starts at
    // the segment keyframe (p0 - 0.5s or earlier). Advancing time within 15s of p0 marks v2b_restore_ok; no in-segment seek;
    // early nudge at ~1.5 s on stalled decoder (readyState >= 3) without flushing the decoder pipeline.
    function v2bRestorePending() { return !!(v2b.restoring || v2b.rwTimer); }
    function v2bRestoreWatch(v, r) {
        if (v2b.rwTimer) w.clearInterval(v2b.rwTimer);
        var t0 = now(), p0 = r.pos, gen = v2b.gen, step = 0, attempt = r.attempt || 1;
        var lastCt = -1, lastCtAt = t0;
        function stop(type, data) { if (v2b.rwTimer) { w.clearInterval(v2b.rwTimer); v2b.rwTimer = 0; } if (type) ev(type, data); }
        v2b.rwTimer = w.setInterval(function () {
            var tn = now(), t = tn - t0, ct = 0, x, rr;
            if (v2b.state !== 'idle' || v2b.gen !== gen || v2b.restoring || mainVideo() !== v || srcOf(v) !== r.src || v.ended) { stop(); return; }
            if (ctl.userPauseAt > r.at) { stop(); return; }                   // paused by the user: not stuck
            try { ct = v.currentTime || 0; } catch (e) {}

            var advancing = (lastCt >= 0 && ct > lastCt + 0.08 && Math.abs(ct - p0) < 15);
            if (!v.paused && (ct > p0 + 0.2 || advancing)) {
                stop('v2b_restore_ok', { ms: Math.round(now() - r.at), nudges: step, attempt: attempt, ct: +ct.toFixed(2), pos: +p0.toFixed(2) });
                return;
            }
            if (lastCt < 0 || Math.abs(ct - lastCt) > 0.04) {
                lastCt = ct;
                lastCtAt = tn;
            }

            var stalledMs = tn - lastCtAt;
            // 1.3.9: early nudge if readyState >= 3 and stalled for > 1.4s (or general step 0 at 3.5s).
            // Never seek inside the segment (no p0 + 0.05). Only seek if severe drift (> 4.0s off).
            if (step === 0 && (t > 3500 || (v.readyState >= 3 && stalledMs > 1400 && t > 1500))) {
                step = 1; v2b.restoreNudges++;
                ev('v2b_restore_stuck', { step: 1, ct: +ct.toFixed(2), pos: +p0.toFixed(2), rate: realRate(v), rs: v.readyState, paused: v.paused, stalledMs: Math.round(stalledMs) });
                applyNative(v, 1);
                if (Math.abs(ct - p0) > 4.0 && p0 > 0.5) {
                    try { v.currentTime = p0; } catch (e1) {}
                }
                try { x = v.play(); if (x && x.catch) x.catch(function () {}); } catch (e2) {}
            } else if (step === 1 && t > 8000 && attempt < 2 && r.src) {
                step = 2; v2b.restoreNudges++;
                ev('v2b_restore_stuck', { step: 2, ct: +ct.toFixed(2), pos: +p0.toFixed(2), rate: realRate(v), rs: v.readyState, paused: v.paused });
                stop();
                rr = v2b.restoring = { pos: p0, at: r.at, play: true, src: r.src, retry: 1, attempt: 2 };
                v2bHold(p0, 'restore');
                v2bShield(true);
                v2b.internal++;
                try { v.src = r.src; } catch (e3) { v2b.restoring = null; v2bShield(false); } finally { v2b.internal--; }
                w.setTimeout(function () { v2bRestoreTimeout(v, rr); }, 15000);
            } else if (t > 20000) stop('v2b_restore_giveup', { ct: +ct.toFixed(2), pos: +p0.toFixed(2), rs: v.readyState, paused: v.paused });
        }, 250);
    }
    // ---- lifecycle
    function v2bReset(state, keepApp) {
        v2b.gen++;
        if (ctl.engine && ctl.engine.v === v2b.v) stopEngine('v2b_' + state);
        var hls = v2b.hls, v = v2b.v;
        v2b.hls = null; v2b.msSpeed = 1; v2b.state = 'idle'; v2b.played = false;
        v2bPendingClear();
        if (hls && v2b.mode === 'adopt' && keepApp) { if (v2b.adoptOffs) { v2b.adoptOffs.forEach(function (x) { hls.off(x[0], x[1]); }); v2b.adoptOffs = null; } hls = null; }
        if (hls) {
            v2b.internal++;
            try { if (v2b.mode === 'adopt') v2bAdoptDetach(hls); else hls.destroy(); } catch (e) { ev('v2b_destroy_error', errStr(e)); } finally { v2b.internal--; }
        }
        return { had: !!hls, v: v };
    }
    function v2bRelease(reason) {
        // someone else (bridge / app) takes the element over: drop hls.js, restore nothing
        if (v2b.state === 'idle') return;
        ev('v2b_release', reason);
        v2b.restoring = null; v2b.hold = null;
        v2bReset('release', true);
        v2bShield(false); v2bUnguard();
        v2b.lastRestore = { reason: reason, at: Math.round(now()), released: true };
    }
    function v2bRestore(reason) {
        if (v2b.state === 'idle') return;
        var v = v2b.v, orig = v2b.orig, pos = v2bPos(v), play = true, r;
        try { play = !v.paused || !v2b.played; } catch (e) {}
        ev('v2b_restore', { reason: reason, pos: +pos.toFixed(2), mode: v2b.mode });
        r = v2bReset('restore');
        v2b.lastRestore = { reason: reason, at: Math.round(now()) };
        if (v2b.mode === 'takeover' && r.had && orig && orig.src && mainVideo() === v) {
            var rr = v2b.restoring = { pos: pos, at: now(), play: play, src: orig.src, attempt: 1 };
            v2bHold(pos, 'restore');
            v2bShield(true);
            v2b.internal++;
            try { v.src = orig.src; } catch (e) { v2b.restoring = null; v2bShield(false); } finally { v2b.internal--; }
            w.setTimeout(function () { v2bRestoreTimeout(v, rr); }, 15000);
        } else {
            v2bShield(false);
            // 1.3.6: no hls.js yet (takeover still preparing): the element never left the native source, but it may not
            // have resumed after an earlier restore (TV T6: a burst 0.25 / 1.5 / 1) - keep the watchdog on it
            if (v2b.mode === 'takeover' && !v.paused && mainVideo() === v && orig && orig.src && srcOf(v) === orig.src) {
                ev('v2b_restore_native', { pos: +pos.toFixed(2), rs: v.readyState, paused: v.paused });
                v2bRestoreWatch(v, { pos: pos, at: now(), play: true, src: orig.src, attempt: 1 });
            }
        }
        v2bUnguard();
        try { applyNative(v, 1); } catch (e3) {}
    }
    // 1.3.6: a restore whose native loadedmetadata never came was dropped silently after 15 s; log it and keep watching
    function v2bRestoreTimeout(v, rr) {
        if (v2b.restoring !== rr) return;
        v2b.restoring = null; v2bShield(false);
        var rs = null, ns = null;
        try { rs = v.readyState; ns = v.networkState; } catch (e) {}
        ev('v2b_restore_timeout', { pos: +rr.pos.toFixed(2), attempt: rr.attempt || 1, rs: rs, ns: ns, src: srcOf(v) === rr.src });
        if (v2b.state === 'idle' && mainVideo() === v && srcOf(v) === rr.src && !v2b.rwTimer) v2bRestoreWatch(v, { pos: rr.pos, at: rr.at, play: rr.play, src: rr.src, attempt: rr.attempt || 1 });
    }
    // 1.3.4: content position for a respeed / restore. While a new pipeline is still attaching (engaging after
    // v2bStartHls / v2bAdoptApply) the element can read 0 or a stale time: the switch's start position is the truth.
    function v2bPos(v) {
        var ct = 0;
        try { ct = (v && v.currentTime) || 0; } catch (e) {}
        if (v2b.state === 'engaging' && v2b.switchAt && v2b.startPos > 0) return v2b.startPos;
        return ct;
    }
    // 1.3.4: app-visible position hold. While v2b attaches a new pipeline (switch / adopt re-attach) or a restore reloads
    // the native source, video.currentTime reads 0 (TV: up to ~3 s). The bridge reports that as the VOD position:
    // progress bar 00:00, chat sync and the resume point the app saves (PlayVod_SaveOffset / history on exit).
    // Android.gettime / getsavedtime and the status payload (Play_ShowVideoStatus value[9]) see the held position
    // until the element is back near it; a user seek (mseekTo), stopVideo or a new StartAuto drop the hold.
    function v2bHold(pos, why) {
        var t = ctl.stream ? ctl.stream.t : 0;
        if (!(pos > 0.5) || (t !== 2 && t !== 3)) return;
        v2b.hold = { pos: pos, at: now(), why: why, n: 0 };
    }
    function heldMs(ms) {
        var h = v2b.hold, raw = +ms;
        if (!h) return ms;
        if (now() - h.at > 20000) { v2b.hold = null; return ms; }
        if (isFinite(raw) && raw >= (h.pos - 1.5) * 1000 && raw <= (h.pos + 45) * 1000) { v2b.hold = null; return ms; }   // caught up
        h.n++; v2b.holds++;
        if (now() - h.at > v2b.holdMax) v2b.holdMax = Math.round(now() - h.at);
        if (h.n === 1) ev('v2b_hold', { why: h.why, pos: +h.pos.toFixed(2), raw: isFinite(raw) ? Math.round(raw) : String(ms) });
        return Math.floor(h.pos * 1000);
    }
    // 1.3.7: quality change on a reloading element (TV T7, pre-release 03). The bridge's SetQuality takes its resume point from
    // video.currentTime; right after RestartPlayer / StartAuto (setMain) or a v2b release the element reads 0 -> the VOD
    // restarted from 00:00. posSample (1 s, maintain) keeps the last good VOD / clip position; RestartPlayer / StartAuto
    // remember their resume point; SetQuality on an element reading ~0 puts it back (default playback start position while
    // the new source loads, again on loadedmetadata if needed) and holds the app-visible position meanwhile.
    function posSample(v) {
        var st = ctl.stream, ct = 0;
        if (!v || !st || (st.t !== 2 && st.t !== 3)) return;
        try { ct = v2bPos(v); } catch (e) { return; }
        if (ct > 0.5 && v.readyState >= 2 && !v.seeking) ctl.lastPos = { pos: ct, at: now(), key: st.key };
    }
    function qualityKeep(v) {
        var st = ctl.stream, ct = 0, t = now(), mr = ctl.mainRestart, lp = ctl.lastPos, h = v2b.hold;
        if (!v || !st || (st.t !== 2 && st.t !== 3) || cfg.mode === 'off') return null;
        try { ct = v.currentTime || 0; } catch (e) {}
        if (ct > 0.5) return null;                                   // a real position: the bridge reads it itself
        if (mr && mr.key === st.key && t - mr.at < 15000 && mr.rs > 500) return { pos: mr.rs / 1000, from: 'restart', ct: ct };
        if (h && h.pos > 0.5) return { pos: h.pos, from: 'hold', ct: ct };
        if (lp && lp.key === st.key && t - lp.at < 15000 && lp.pos > 0.5) return { pos: lp.pos, from: 'sample', ct: ct };
        return null;
    }
    function qualityResume(v, k) {
        var pos = k.pos, src = '', done = false, tmr = 0;
        try { src = String(v.src || ''); } catch (e) {}
        ev('quality_resume', { pos: +pos.toFixed(2), from: k.from, ct: +(+k.ct).toFixed(2), rs: v.readyState, v2b: v2b.state });
        v2bHold(pos, 'quality');
        function finish() { done = true; if (tmr) w.clearTimeout(tmr); try { v.removeEventListener('loadedmetadata', onMeta); } catch (e) {} }
        function put(why) {
            var ct = 0, s2 = '';
            if (done) return;
            try { s2 = String(v.src || ''); } catch (e0) {}
            if (mainVideo() !== v || s2 !== src) { finish(); return; }     // another source meanwhile: it brings its own position
            try { ct = v.currentTime || 0; } catch (e1) {}
            if (Math.abs(ct - pos) < 2) { if (why === 'meta') finish(); return; }
            if (why === 'meta' && ct > 0.5) { finish(); return; }          // positioned by someone else (user seek / bridge)
            try { v.currentTime = pos; } catch (e2) {}
            if (why === 'meta') { finish(); ev('quality_resume_meta', { pos: +pos.toFixed(2), ct: +ct.toFixed(2) }); }
        }
        function onMeta() { put('meta'); }
        try { v.addEventListener('loadedmetadata', onMeta); } catch (e3) {}
        tmr = w.setTimeout(finish, 20000);
        put('now');
    }
    function v2bFail(reason) {
        if (v2b.state === 'idle') return;
        v2b.failures++;
        v2b.fail = { key: v2b.key, reason: reason, at: now() };
        v2b.want = null;
        ev('v2b_fail', reason);
        v2bRestore('fail:' + reason);
        toast('v2b_fail', String(reason).split(':')[0]);
    }
    function v2bBegin(v, st, s, mode) {
        v2b.state = 'engaging'; v2b.mode = mode; v2b.v = v; v2b.speed = s; v2b.key = st.key;
        v2b.orig = { src: srcOf(v), ct: v.currentTime || 0 };
        v2b.t0 = now(); v2b.switchAt = 0; v2b.frags = 0; v2b.stalls = []; v2b.initPts = null; v2b.engageMs = null;
        v2b.played = false; v2b.recovered = 0; v2b.lastError = null; v2b.takeovers++;
        v2b.levelInfo = null; v2b.tl.bad = 0;                     // 1.3.2: no stale playlist end from an earlier VOD
        ev('v2b_engage', { mode: mode, speed: s, ct: +v2b.orig.ct.toFixed(2), src: v2b.orig.src.slice(0, 80) });
        toast('v2b_wait', s);
        return ++v2b.gen;
    }
    function v2bTakeover(v, st, s) {
        var gen = v2bBegin(v, st, s, 'takeover'), orig = v2b.orig;
        v2bLibs().then(function () {
            if (gen !== v2b.gen) throw new Error('superseded');
            return v2bPlaylist(orig, st);
        }).then(function (pl) {
            if (gen !== v2b.gen) throw new Error('superseded');
            v2b.plUrl = pl.url; v2b.variant = pl.variant; v2b.master = pl.master || null;
            return v2bPrefetch(pl, v, gen);
        }).then(function () {
            if (gen !== v2b.gen) throw new Error('superseded');
            if (mainVideo() !== v || srcOf(v) !== orig.src) throw new Error('src_changed');
            v2bGuard(v);
            v2bStartHls(v, v.currentTime || orig.ct, v2b.speed, gen);
        }).then(null, function (e) {
            if (gen !== v2b.gen || errStr(e) === 'superseded') return;
            if (v2b.hls) v2bFail('start:' + errStr(e));
            else { v2b.failures++; v2b.fail = { key: v2b.key, reason: errStr(e), at: now() }; v2b.want = null; ev('v2b_fail', 'prepare:' + errStr(e)); v2bReset('abort'); toast('v2b_fail', errStr(e).split(':')[0]); }
        });
    }
    function v2bStartHls(v, pos, s, gen) {
        var H = v2b.Hls, hls = new H(v2bHlsConfig(pos)), E = H.Events;
        v2b.hls = hls; v2b.speed = s; v2b.switchAt = now(); v2b.played = false; v2b.state = 'engaging';
        v2b.startPos = pos; v2b.activeAt = 0; v2b.kicked = false; v2b.lowSince = 0;
        v2bHold(pos, 'switch');
        v2bSeekMark(v);
        hls.on(E.BUFFER_CREATED, function () { if (gen === v2b.gen) v2b.msSpeed = 1; });
        hls.on(E.INIT_PTS_FOUND, function (n, d) { if (gen === v2b.gen) v2bInitPts(d); });
        hls.on(E.FRAG_BUFFERED, function () { if (gen === v2b.gen) v2bFragBuffered(); });
        hls.on(E.LEVEL_LOADED, function (n, d) { if (gen === v2b.gen && d && d.details) v2bLevelInfo(d.details); });
        hls.on(E.ERROR, function (n, d) { if (gen === v2b.gen) v2bHlsError(d); });
        v2bShield(true);
        v2bRealRate1(v);
        v2b.msSpeed = s;
        v2b.internal++;
        try { hls.loadSource(v2b.plUrl); hls.attachMedia(v); } finally { v2b.internal--; }
        v2bOnPlaying(v, gen);
        ev('v2b_switch', { pos: +pos.toFixed(2), speed: s, prepMs: Math.round(v2b.switchAt - v2b.t0) });
    }
    // end = hls.js levelDuration (what it writes to MediaSource.duration) = the length the bridge UI must show (1.3.2)
    function v2bLevelInfo(dt) {
        var f0 = dt.fragments && dt.fragments.length ? dt.fragments[0].start || 0 : 0;
        v2b.levelInfo = { frags: dt.fragments ? dt.fragments.length : null, total: Math.round(dt.totalduration || 0),
            end: +(f0 + (dt.totalduration || 0)).toFixed(3), live: !!dt.live };
    }
    function v2bInitPts(d) {
        var ip = d && d.initPTS, ts = (d && d.timescale) || 90000;
        if (ip && typeof ip === 'object') { ts = ip.timescale || ts; ip = ip.baseTime; }
        if (typeof ip === 'number' && isFinite(ip) && !(d.frag && d.frag.cc)) v2b.initPts = ip / ts;
    }
    function v2bFragBuffered() {
        v2b.frags++;
        if (!v2b.played && v2b.state === 'engaging') {
            v2b.played = true;
            try { var p = v2b.v.play(); if (p && p.catch) p.catch(function (e) { ev('v2b_play_rejected', errStr(e)); }); } catch (e) {}
        }
    }
    function v2bOnPlaying(v, gen) {
        var f = function () {
            if (gen !== v2b.gen) { v.removeEventListener('playing', f); return; }
            if (v2b.state !== 'engaging' || !v2b.frags) return;           // ignore a late 'playing' of the old pipeline
            v.removeEventListener('playing', f);
            v2b.state = 'active'; v2b.activeAt = now();
            if (v2b.fail && v2b.fail.key === v2b.key && v2b.fail.retried) v2b.fail = null;   // 1.3.4: the user's retry worked
            if (v2b.engageMs === null) v2b.engageMs = Math.round(now() - v2b.t0);
            ev('v2b_active', { speed: v2b.speed, ms: Math.round(now() - v2b.t0), switchMs: Math.round(now() - v2b.switchAt), ct: +(v.currentTime || 0).toFixed(2),
                dur: isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration) });
            toast('v2b_on', v2b.speed);
            var e = ctl.engine;
            if (e && !e.dead && e.v === v && e.info && e.info.pipe === 'v2b') { if (e.speed !== v2b.speed) e.setSpeed(v2b.speed); }
            else v2bStartEngine(v);
        };
        v.addEventListener('playing', f);
    }
    function v2bStartEngine(v) {
        var st = ctl.stream;
        if (!st || cfg.mode !== 'auto') return;
        stopEngine('v2b');
        var info = { u: st.u, pl: st.pl, t: 2, key: st.key, pipe: 'v2b', srcOverride: v2b.mode === 'takeover' ? v2b.orig.src : '',
            refProvider: function () { return v2b.initPts !== null ? { pts: v2b.initPts, t: 0, src: 'hlsjs_initpts' } : null; } };
        var e = new Engine(v, info, v2b.speed);
        e.onFail = function (reason) { onEngineFail(e, reason); };
        ctl.engine = e;
        e.start();
    }
    function v2bHlsError(d) {
        if (!d) return;
        var det = String(d.details || ''), t = now(), H = v2b.Hls || (v2b.hls && v2b.hls.constructor);
        if (det === 'bufferStalledError') {
            // 1.3.4: a new pipeline stalls while it fills (TV: ~2 s per switch) and so does a seek: not a network problem
            if (v2b.state !== 'active' || t - v2b.activeAt < V2B_STALL_GRACE_MS || t - v2b.seekAt < V2B_STALL_GRACE_MS) {
                v2b.switchStalls++;
                ev('v2b_stall_switch', { n: v2b.switchStalls, state: v2b.state, afterActiveMs: v2b.activeAt ? Math.round(t - v2b.activeAt) : null });
                return;
            }
            v2b.stalls.push(t);
            while (v2b.stalls.length && t - v2b.stalls[0] > 60000) v2b.stalls.shift();
            ev('v2b_stall', v2b.stalls.length);
            // 1.3.5: above 1x the link may not keep up (TV report T8: 1080p60 at 2x = 12.8 Mbit/s on a ~12 Mbit/s link ->
            // 5 stalls in 7 min -> fallback to 1x): a lower variant at the same speed comes before the fuse
            if (v2b.speed > 1 && v2bStepDown('stall')) return;
            if (v2b.stalls.length > 4) v2bFail('stalls');
            return;
        }
        if (!d.fatal) { if (!/^buffer(Nudge|SeekOver)/.test(det)) ev('v2b_hls_warn', det); return; }
        v2b.lastError = { type: d.type, details: det, at: Math.round(t) };
        if (H && d.type === H.ErrorTypes.MEDIA_ERROR && v2b.recovered < 1 && v2b.hls) {
            v2b.recovered++;
            ev('v2b_recover', det);
            v2b.msSpeed = v2b.speed;
            v2b.internal++;
            try { v2b.hls.recoverMediaError(); } finally { v2b.internal--; }
            return;
        }
        // 1.3.5: fragment / playlist retries exhausted (TV report T10: WAN outage) -> hls.startLoad again (v2bNetRecover)
        if (H && d.type === H.ErrorTypes.NETWORK_ERROR && v2b.hls && !/^manifest/i.test(det) && v2bNetRecover(det)) return;
        v2bFail('hls:' + det);
    }
    // One network episode lasts until bytes arrive again. v2b keeps the VOD through up to 90 s of it: a fallback to
    // native while offline reloads the native source offline and the bridge ends the VOD (TV report T10, WAN off 20 s).
    // hls.js spends ~15 s on its own retries (1+2+4+8 s) before each fatal error; we wait 2-8 s and start loading again.
    function v2bNetRecover(det) {
        var t = now(), gen = v2b.gen, ep = v2b.netEp, delay;
        if (!ep || v2b.netAt > ep.last || t - ep.last > 60000) ep = v2b.netEp = { t0: t, n: 0, last: t };
        if (t - ep.t0 > V2B_NET_OUTAGE_MS) { ev('v2b_net_giveup', { details: det, n: ep.n, sinceMs: Math.round(t - ep.t0) }); return false; }
        ep.n++; ep.last = t; v2b.netRecovers++;
        delay = Math.min(2000 * ep.n, 8000);
        ev('v2b_net_recover', { details: det, n: ep.n, state: v2b.state, sinceMs: Math.round(t - ep.t0), delayMs: delay });
        w.setTimeout(function () {
            if (gen !== v2b.gen || !v2b.hls || v2b.state === 'idle') return;
            v2b.internal++;
            try { v2b.hls.startLoad(v2bPos(v2b.v)); } catch (e) { ev('v2b_kick_error', errStr(e)); } finally { v2b.internal--; }
        }, delay);
        return true;
    }
    // 1.3.5: variant step-down at the same speed (takeover only: the app's own hls.js in adopt mode has its own ABR).
    // Needed bandwidth = variant BANDWIDTH x speed; the estimate comes from our segment downloads (v2b.bwEst).
    function variantName(x) {
        var n = String((x && x.video) || '');
        if (/^\d{3,4}p\d*$/i.test(n)) return n;
        var h = x ? (x.h || variantHeight(x)) : 0;
        return h ? h + 'p' : (n || '?');
    }
    function v2bStepDown(why) {
        var cur = v2b.variant, list = v2b.master || [], S = v2b.speed, lower = [], pick = null, i, c, known = v2b.bwN >= 2 && v2b.bwEst > 0;
        if (v2b.mode !== 'takeover' || v2b.state !== 'active' || !v2b.hls || !cur || !(cur.bw > 0) || !list.length) return false;
        // a stall with plenty of measured headroom is a hiccup, not a slow link
        if (known && v2b.bwEst >= cur.bw * S * 1.3) return false;
        if (v2b.downs.key !== v2b.key) v2b.downs = { key: v2b.key, n: 0 };
        if (v2b.downs.n >= 3) return false;
        for (i = 0; i < list.length; i++) { c = list[i]; if (!c.audioOnly && c.uri && c.bw > 0 && c.bw < cur.bw * 0.95) lower.push(c); }
        if (!lower.length) return false;
        lower.sort(function (a, b) { return b.bw - a.bw; });
        if (known) for (i = 0; i < lower.length && !pick; i++) if (lower[i].bw * S * 1.25 <= v2b.bwEst) pick = lower[i];
        if (!pick) pick = known ? lower[lower.length - 1] : lower[0];
        var v = v2b.v, pos = v2bPos(v), gen = ++v2b.gen, old = v2b.hls, from = variantName(cur);
        v2b.downs.n++; v2b.stepDowns++;
        v2b.downCap = { key: v2b.key, bps: Math.round(pick.bw * S) };
        ev('v2b_step_down', { why: why, speed: S, from: from, to: variantName(pick), needMbps: +(cur.bw * S / 1e6).toFixed(2),
            bwEstMbps: known ? +(v2b.bwEst / 1e6).toFixed(2) : null, ahead: v2bAhead(v), pos: +pos.toFixed(2), n: v2b.downs.n });
        v2b.plUrl = pick.uri;
        v2b.variant = { h: variantHeight(pick), bw: pick.bw, video: pick.video || null, from: 'step_down:' + why };
        v2b.stalls = []; v2b.lowSince = 0;
        v2b.hls = null; v2b.t0 = now();
        v2b.internal++;
        try { old.destroy(); } catch (e) {} finally { v2b.internal--; }
        v2bStartHls(v, pos, S, gen);
        toast('v2b_down', [S + '×', variantName(pick)]);
        return true;
    }
    // 1.3.5 (active, takeover, speed > 1): step down BEFORE the stall when the buffer drains (< 4 s of wall-clock playback
    // left) and the measured link is below what the variant needs at this speed; a stalled element with nothing arriving
    // for 10 s gets a kick (hls.js itself waits up to 60 s for a hung fragment request)
    function v2bNetWatch(v) {
        var t = now(), ahead, cur = v2b.variant;
        if (v2b.state !== 'active' || !v2b.hls || v.paused || v.seeking || v.ended) { v2b.lowSince = 0; return; }
        ahead = v2bAhead(v);
        if (v.readyState < 3 && ahead < 1 && t - lastOf(v2b.netAt, v2b.activeAt) > 10000 && (!v2b.lastKick || t - v2b.lastKick > 30000)) { v2bKick('stall_idle'); return; }
        if (!(v2b.speed > 1) || v2b.mode !== 'takeover' || !cur || !(cur.bw > 0) || t - v2b.activeAt < 30000 || t - v2b.seekAt < 15000) { v2b.lowSince = 0; return; }
        if (ahead < 4 * v2b.speed && v2b.bwN >= 3 && v2b.bwEst < cur.bw * v2b.speed * 1.1) {
            if (!v2b.lowSince) v2b.lowSince = t;
            else if (t - v2b.lowSince > 5000) { v2b.lowSince = 0; v2bStepDown('low_buffer'); }
        } else v2b.lowSince = 0;
    }
    // 1.3.5: engaging timeout follows the network. TV report: slow-but-moving downloads (4-24 Mbit/s, one 9 MB 1080p60
    // segment = 3-18 s) hit the fixed 15 s -> fallback to 1x. Now: a kick after 8 s if nothing arrived for 6 s; fail only
    // after 15 s with 10 s of silence, or after 40 s in any case; no timeout while the user keeps it paused.
    function lastOf(a, b) { return a && a > b ? a : b; }        // later of two timestamps (a may be 0 = never)
    function v2bEngageWatch() {
        var t = now(), since = t - v2b.switchAt, idle = t - lastOf(v2b.netAt, v2b.switchAt);
        if (ctl.userPauseAt > v2b.switchAt && v2b.frags > 0 && v2b.v && v2b.v.paused) return;
        if (!v2b.kicked && since > 8000 && idle > 6000 && v2b.hls) { v2b.kicked = true; v2bKick('engaging_idle'); return; }
        if ((since > 15000 && idle > 10000) || since > 40000) {
            ev('v2b_engage_timeout', { sinceMs: Math.round(since), idleMs: Math.round(idle), frags: v2b.frags, kicked: v2b.kicked });
            v2bFail('timeout');
        }
    }
    function v2bSetSpeed(s) {
        if (s === 1 || V2B_SPEEDS.indexOf(s) < 0) {
            v2bPendingClear();
            v2b.want = null;
            v2bRestore(s === 1 ? 'speed_1' : 'unsupported_speed');
            if (s !== 1) toast('v2b_fail', s + '×');
            return;
        }
        if (s === v2b.speed && (v2b.hls || v2b.state === 'engaging')) { v2bPendingClear(); return; }
        if (!v2b.hls) { v2b.speed = s; return; }                       // still preparing: starts at the new speed
        // 1.3.4: a burst of requests (menu stepping, TV report: 6 pipelines in 20 s) becomes one switch to the last speed
        if (v2b.pending !== null) v2b.coalesced++;
        v2b.pending = s;
        if (v2b.pendingTimer) w.clearTimeout(v2b.pendingTimer);
        v2b.pendingTimer = w.setTimeout(v2bPendingRun, V2B_RESPEED_MS);
    }
    function v2bPendingClear() {
        if (v2b.pendingTimer) w.clearTimeout(v2b.pendingTimer);
        v2b.pendingTimer = 0; v2b.pending = null;
    }
    function v2bPendingRun() {
        v2b.pendingTimer = 0;
        var s = v2b.pending;
        if (s === null) return;
        if (v2b.state === 'idle' || !v2b.hls) { v2b.pending = null; return; }
        // one platform pipeline load at a time: wait until the switch in flight plays (it fails itself after 15 s)
        if (v2b.state === 'engaging') { v2b.pendingTimer = w.setTimeout(v2bPendingRun, 250); return; }
        v2b.pending = null;
        if (s !== v2b.speed) safe(function () { v2bRespeed(s); });
    }
    function v2bRespeed(s) {
        var v = v2b.v, pos = v2bPos(v), gen = ++v2b.gen, old = v2b.hls;
        v2b.respeeds++;
        ev('v2b_respeed', { from: v2b.speed, to: s, pos: +pos.toFixed(2) });
        v2b.hls = null; v2b.t0 = now();
        if (v2b.mode === 'adopt') { v2b.hls = old; v2bAdoptApply(old, v, pos, s, gen); }
        else {
            v2b.internal++;
            try { old.destroy(); } catch (e) {} finally { v2b.internal--; }
            v2bStartHls(v, pos, s, gen);
        }
        if (ctl.engine && !ctl.engine.dead && ctl.engine.v === v) ctl.engine.setSpeed(s);
    }
    // ---- adopt: the app plays through its own hls.js (pipe mse)
    function v2bWatchAppHls() {
        var H = w.Hls;
        if (!H || H === v2b.Hls || !H.prototype || H.prototype.__sttvAdopt || typeof H.prototype.attachMedia !== 'function') return;
        var oa = H.prototype.attachMedia, od = H.prototype.destroy;
        H.prototype.attachMedia = function (m) { if (!v2b.internal || this !== v2b.hls) { v2b.appHls = this; v2b.appHlsMedia = m; } return oa.apply(this, arguments); };
        if (typeof od === 'function') H.prototype.destroy = function () { if (this === v2b.appHls) { v2b.appHls = null; v2b.appHlsMedia = null; if (this === v2b.hls) v2bRelease('app_hls_destroy'); } return od.apply(this, arguments); };
        H.prototype.__sttvAdopt = true;
        ev('v2b_app_hls', H.version || '?');
    }
    function v2bAdopt(v, st, s) {
        var gen = v2bBegin(v, st, s, 'adopt'), hls = v2b.appHls;
        v2bLibs().then(function () {
            if (gen !== v2b.gen) return;
            if (hls !== v2b.appHls || v2b.appHlsMedia !== v) throw new Error('app_hls_gone');
            v2b.hls = hls;
            v2bAdoptApply(hls, v, v.currentTime || 0, v2b.speed, gen);
        }).then(null, function (e) { if (gen === v2b.gen) v2bFail('adopt:' + errStr(e)); });
    }
    function v2bAdoptApply(hls, v, pos, s, gen) {
        var E = hls.constructor.Events, offs = [];
        function on(n, f) { hls.on(n, f); offs.push([n, f]); }
        if (v2b.adoptOffs) v2b.adoptOffs.forEach(function (x) { hls.off(x[0], x[1]); });
        v2b.adoptOffs = offs;
        on(E.BUFFER_CREATED, function () { if (gen === v2b.gen) v2b.msSpeed = 1; });
        on(E.INIT_PTS_FOUND, function (n, d) { if (gen === v2b.gen) v2bInitPts(d); });
        on(E.FRAG_BUFFERED, function () { if (gen === v2b.gen) v2bFragBuffered(); });
        on(E.ERROR, function (n, d) { if (gen === v2b.gen && d && (d.fatal || d.details === 'bufferStalledError')) v2bHlsError(d); });
        on(E.LEVEL_LOADED, function (n, d) { if (gen === v2b.gen && d && d.details) v2bLevelInfo(d.details); });
        try { var L = hls.levels && hls.levels[Math.max(0, hls.currentLevel)]; if (L && L.details) v2bLevelInfo(L.details); } catch (e0) {}
        v2b.switchAt = now(); v2b.played = false; v2b.state = 'engaging';
        v2b.startPos = pos; v2b.activeAt = 0; v2b.kicked = false; v2b.lowSince = 0;
        v2bHold(pos, 'switch');
        v2bSeekMark(v);
        v2bShield(true);
        v2bRealRate1(v);
        v2b.msSpeed = s;
        v2b.internal++;
        try { hls.detachMedia(); hls.attachMedia(v); } finally { v2b.internal--; }
        var once = function () { hls.off(E.MEDIA_ATTACHED, once); try { hls.startLoad(pos); } catch (e) {} };
        hls.on(E.MEDIA_ATTACHED, once);
        v2bOnPlaying(v, gen);
        ev('v2b_switch', { pos: +pos.toFixed(2), speed: s, mode: 'adopt' });
    }
    function v2bAdoptDetach(hls) {
        // back to 1x: re-attach the app's hls.js with the hook at 1 (plain MediaSource), at the current position
        var v = v2b.v, pos = 0, E = hls.constructor.Events;
        try { pos = v.currentTime || 0; } catch (e) {}
        if (v2b.adoptOffs) { v2b.adoptOffs.forEach(function (x) { hls.off(x[0], x[1]); }); v2b.adoptOffs = null; }
        v2b.msSpeed = 1;
        v2bHold(pos, 'detach');
        hls.detachMedia(); hls.attachMedia(v);
        var once = function () { hls.off(E.MEDIA_ATTACHED, once); try { hls.startLoad(pos); } catch (e) {} };
        hls.on(E.MEDIA_ATTACHED, once);
        try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e2) {}
    }
    function v2bSeekMark(v) {
        if (!v || v.__sttvV2bSeek) return;
        v.__sttvV2bSeek = true;
        v.addEventListener('seeking', function () { if (v2bOwns(v)) v2b.seekAt = now(); });
    }
    function v2bCoolLeftS() { return v2b.fail ? Math.max(1, Math.ceil((V2B_COOLDOWN_MS - (now() - v2b.fail.at)) / 1000)) : 0; }
    // ---- routing (called from decide / maintain)
    function v2bBlocked(st, user, retry) {
        // 1.3.4: after a failure an explicit speed change by the user retries once (v2bRoute marks fail.retried and
        // the queued want carries retry: true for v2bMaintain)
        if (v2b.fail && st && v2b.fail.key === st.key && now() - v2b.fail.at < V2B_COOLDOWN_MS && !retry && !(user && !v2b.fail.retried)) return 'cooldown';
        if (cfg.rateGate && capIgnored('v2b')) return 'v2b_ignored(cached)';
        if (v2b.libErr && now() - v2b.libErrAt < 300000) return 'libs:' + v2b.libErr;
        if (!w.MediaSource || !BASE) return 'no_mse';
        return '';
    }
    function v2bRoute(v, st, s, pipe, user) {
        // true = v2b handles this request (now or as soon as the native element plays steadily)
        v2b.lastBlock = '';
        if (cfg.v2b === 'off' || V2B_SPEEDS.indexOf(s) < 0) return false;
        var why = v2bBlocked(st, user), retry = false;
        if (!why && pipe === 'mse' && !(v2b.appHls && v2b.appHlsMedia === v)) why = 'mse_foreign';
        if (!why && pipe !== 'unknown' && pipe !== 'native' && pipe !== 'mse') why = 'pipe_' + pipe;
        if (!why && user && v2b.fail && v2b.fail.key === st.key && !v2b.fail.retried && now() - v2b.fail.at < V2B_COOLDOWN_MS) {
            v2b.fail.retried = true; v2b.retries++; retry = true; ev('v2b_retry', v2b.fail.reason);
        }
        if (!why && pipe === 'unknown') { v2b.want = { key: st.key, speed: s, pipe: pipe, at: now(), user: !!user, retry: retry }; return true; }   // blob: probe pending
        if (why) {
            v2b.lastBlock = why;
            if (v2b.unavailNote !== st.key + '|' + s + '|' + why) { v2b.unavailNote = st.key + '|' + s + '|' + why; ev('v2b_unavailable', why); }
            return false;
        }
        v2b.want = { key: st.key, speed: s, pipe: pipe, at: now(), user: !!user, retry: retry };
        // 1.3.4: queued during a restore; 1.3.6: also until the restored native pipeline really plays (watchdog on)
        if (!v.paused && !v.seeking && v.readyState >= 3 && !v2bRestorePending()) v2bEngage(v, st, s, pipe, user);
        return true;
    }
    function v2bEngage(v, st, s, pipe, user) {
        var t = now();
        while (v2b.reeng.length && t - v2b.reeng[0].at > 300000) v2b.reeng.shift();
        var n = 0, i, first = null;
        for (i = 0; i < v2b.reeng.length; i++) if (v2b.reeng[i].key === st.key) { n++; if (!first) first = v2b.reeng[i]; }
        // automatic re-engagements: 4 per 5 min per stream (fail loops); the user's own requests: 12 (1.3.4)
        if (n >= (user ? 12 : 4)) {
            v2b.want = null; v2b.lastBlock = 'reengage_budget'; ev('v2b_unavailable', 'reengage_budget');
            if (user) toast('v2b_budget', Math.max(1, Math.ceil((300000 - (t - first.at)) / 1000)));
            return;
        }
        v2b.reeng.push({ key: st.key, at: t });
        v2b.stable = 0;
        if (pipe === 'mse') v2bAdopt(v, st, s); else v2bTakeover(v, st, s);
    }
    // 1.3.2 self-check: the bridge UI shows video.duration / video.currentTime (getMainDurationMs / gettime). In v2b both
    // go through the hook's shim and must equal the playlist (content) timeline: 1.3.1 showed S x the VOD length.
    function nativeDuration(v) {
        var d = w.HTMLMediaElement && Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'duration');
        try { return d && d.get ? d.get.call(v) : NaN; } catch (e) { return NaN; }
    }
    function v2bTimelineCheck(v) {
        var li = v2b.levelInfo, tl = v2b.tl, d, err;
        if (!li || !(li.end > 0) || li.live) return;
        try { d = v.duration; } catch (e) { return; }
        if (typeof d !== 'number' || !isFinite(d) || d <= 0) return;   // NaN while (re)attaching
        err = Math.abs(d - li.end);
        tl.checks++;
        tl.last = { dur: +d.toFixed(2), end: li.end, native: +(+nativeDuration(v) || 0).toFixed(2), speed: v2b.speed };
        if (err <= Math.max(2, li.end * 0.002)) { tl.bad = 0; return; }
        if (++tl.bad >= 3 && tl.noted !== v2b.gen) {
            tl.noted = v2b.gen; tl.mismatches++;
            ev('v2b_timeline_mismatch', { dur: tl.last.dur, end: li.end, native: tl.last.native, speed: v2b.speed, ratio: +(d / li.end).toFixed(3),
                hook: v2b.hook && v2b.hook.stats ? { sessions: v2b.hook.stats.sessions, rebased: v2b.hook.stats.durationRebased, errors: v2b.hook.stats.rebaseErrors } : null });
        }
    }
    function v2bMaintain(v) {
        v2bWatchAppHls();
        if (v2b.state !== 'idle') {
            if (v !== v2b.v) { v2bRelease('element_changed'); return; }
            if (v2b.state === 'active') { v2bTimelineCheck(v); v2bNetWatch(v); }
            if (v2b.state === 'engaging') {
                if (v2b.switchAt) v2bEngageWatch();
                else if (now() - v2b.t0 > 45000) v2bFail('prepare_timeout');
            }
            return;
        }
        var wn = v2b.want, st = ctl.stream;
        if (!wn) return;
        if (!st || st.key !== wn.key || ctl.speed === 1 || V2B_SPEEDS.indexOf(ctl.speed) < 0 || cfg.mode !== 'auto' || cfg.v2b === 'off') { v2b.want = null; return; }
        if (!v || v.paused || v.seeking || v.readyState < 3 || v2bRestorePending()) { v2b.stable = 0; return; }
        if (!v2b.stable) { v2b.stable = now(); return; }
        if (now() - v2b.stable < 2000) return;
        var pipe = pipeKind(v);
        if (pipe === 'unknown') { if (now() - wn.at > 10000) { v2b.want = null; ev('v2b_unavailable', 'pipe_unknown'); } return; }
        if (v2bBlocked(st, wn.user, wn.retry) || (pipe !== 'native' && !(pipe === 'mse' && v2b.appHls && v2b.appHlsMedia === v))) { v2b.want = null; return; }
        v2bEngage(v, st, ctl.speed, pipe, wn.user);
    }
    function v2bTimeline(v) {
        var hs = v2b.hook && v2b.hook.stats, li = v2b.levelInfo, out = { checks: v2b.tl.checks, mismatches: v2b.tl.mismatches, last: v2b.tl.last,
            hook: hs ? { sessions: hs.sessions, rebased: hs.durationRebased, errors: hs.rebaseErrors, lastRebase: hs.lastRebase } : null };
        try {
            if (v && v2b.state !== 'idle') {
                out.duration = isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration);
                out.nativeDuration = +(+nativeDuration(v) || 0).toFixed(2);
                out.currentTime = +(v.currentTime || 0).toFixed(2);
                out.playlistEnd = li ? li.end : null;
                out.ok = li && li.end > 0 && isFinite(v.duration) ? Math.abs(v.duration - li.end) <= Math.max(2, li.end * 0.002) : null;
            }
        } catch (e) {}
        return out;
    }
    function v2bStatus() {
        var v = v2b.v, ahead = null, q = null, lvl = null, b, ct, i;
        try {
            if (v && v2b.state !== 'idle') {
                b = v.buffered; ct = v.currentTime;
                for (i = 0; i < b.length; i++) if (ct >= b.start(i) - 0.3 && ct <= b.end(i)) ahead = +(b.end(i) - ct).toFixed(1);
            }
        } catch (e) {}
        try { if (v && v2b.state !== 'idle' && v.getVideoPlaybackQuality) { var pq = v.getVideoPlaybackQuality(); q = { total: pq.totalVideoFrames, dropped: pq.droppedVideoFrames }; } } catch (e2) {}
        try { if (v2b.hls && v2b.hls.levels && v2b.hls.levels.length) { var L = v2b.hls.levels[Math.max(0, v2b.hls.currentLevel)]; lvl = { h: L.height, bw: L.bitrate, codecs: L.codecSet || L.attrs && L.attrs.CODECS }; } } catch (e3) {}
        return {
            cfg: cfg.v2b, cfgDefault: BUILD_V2B, maxH: cfg.v2bMaxH || null, worker: cfg.v2bWorker, state: v2b.state, mode: v2b.mode || null, speed: v2b.speed,
            speeds: V2B_SPEEDS.slice(),
            libs: v2b.Hls ? 'hls.js ' + v2b.Hls.version : (v2b.libErr ? 'error: ' + v2b.libErr : 'not loaded'), base: BASE || null,
            takeovers: v2b.takeovers, failures: v2b.failures, fail: v2b.fail ? { reason: v2b.fail.reason, agoS: Math.round((now() - v2b.fail.at) / 1000), retried: !!v2b.fail.retried } : null,
            lastError: v2b.lastError, lastRestore: v2b.lastRestore, want: v2b.want, engageMs: v2b.engageMs, frags: v2b.frags,
            stalls60s: v2b.stalls.length, switchStalls: v2b.switchStalls, respeeds: v2b.respeeds, coalesced: v2b.coalesced,
            pending: v2b.pending, retries: v2b.retries, lastBlock: v2b.lastBlock || null,
            hold: v2b.hold ? { why: v2b.hold.why, pos: +v2b.hold.pos.toFixed(2), ageMs: Math.round(now() - v2b.hold.at) } : null, holds: v2b.holds, holdMaxMs: v2b.holdMax, bufferAheadS: ahead, level: lvl, variant: v2b.variant, levelInfo: v2b.levelInfo || null,
            // 1.3.5 network awareness
            net: { bwEstMbps: v2b.bwN ? +(v2b.bwEst / 1e6).toFixed(2) : null, samples: v2b.bwN, needMbps: v2b.variant && v2b.variant.bw ? +(v2b.variant.bw * v2b.speed / 1e6).toFixed(2) : null,
                idleMs: v2b.netAt ? Math.round(now() - v2b.netAt) : null, kicks: v2b.kicks, absorbed: v2b.absorbed, netRecovers: v2b.netRecovers,
                stepDowns: v2b.stepDowns, downCap: v2b.downCap ? { key: v2b.downCap.key, mbps: +(v2b.downCap.bps / 1e6).toFixed(2) } : null },
            restoreNudges: v2b.restoreNudges, engineRetries: v2b.engineRetries,
            initPts: v2b.initPts === null ? null : +v2b.initPts.toFixed(4), quality: q, fetchedMB: +(v2b.bytes / 1048576).toFixed(1),
            netErrors: v2b.netErrors, cache: { n: segCache.order.length, mb: +(segCache.bytes / 1048576).toFixed(1) },
            appHls: v2b.appHls ? (v2b.appHls.constructor && v2b.appHls.constructor.version) || 'yes' : null,
            timeline: v2bTimeline(v)
        };
    }

    // ---------------------------------------------------------------- controller: hooks the bridge's window.Android shim
    var ctl = { speed: 1, stream: null, engine: null, fail: null, hookedObj: null, installed: false, timer: 0,
        lastRate: null, gateNote: '', pm: null, passive: null, userPauseAt: 0, lastPos: null, mainRestart: null };
    function mainVideo() { return doc ? doc.getElementById('sttv_main') : null; }
    function safe(fn) { try { fn(); } catch (e) { ev('hook_error', errStr(e)); } }
    // 1.3.3: the pipeline of this element is known to ignore playbackRate on this firmware (rate cap 'ignored') ->
    // keep the element at 1.0: setting it changed nothing on the TV but can stall or reload the webOS pipeline
    // (TV report 1.3.0: 1.05-1.2x on native, then a jump back to the start of the VOD).
    // 1.3.5: for the v2b speeds too (1.3.3/1.3.4 let them through, "v2b takes over anyway"). The element stays native
    // until v2b owns it and again after every restore, quality change, and in clips; TV report (webOS 25, Twitch NG 1.0.0):
    // native at 0.25-2x froze at the restore position / after a quality change and crawled in clips (2x = 1.08x, no
    // sound), the bridge's stall recovery then restarted the VOD from 00:00. v2b sets its own rate (v2bRealRate1).
    function nativeRate(el, s) {
        if (s === 1 || !el || !cfg.rateGate) return s;
        return capIgnored(pipeKind(el)) ? 1 : s;
    }
    // what the bridge's own setPlaybackSpeed may write to #sttv_main (a v2b-owned element is shielded by the hook)
    function bridgeRate(s) {
        var v = mainVideo();
        if (!v || cfg.mode === 'off' || v2bOwns(v)) return s;
        return nativeRate(v, s);
    }
    function applyNative(el, s) {
        if (!el) return;
        try { el.preservesPitch = true; } catch (e) {}
        try { if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true; } catch (e2) {}
        try { if (el.defaultPlaybackRate !== s) el.defaultPlaybackRate = s; } catch (e3) {}
        try { if (el.playbackRate !== s) el.playbackRate = s; } catch (e4) { ev('rate_set_error', errStr(e4)); }
    }
    function watchVideo(v) {
        if (!v || v.__sttvSpeedWatch) return;
        v.__sttvSpeedWatch = true;
        var re = function () { if (cfg.mode !== 'off' && ctl.speed !== 1 && !v2bOwns(v) && !v2b.restoring) applyNative(v, nativeRate(v, ctl.speed)); };
        v.addEventListener('loadedmetadata', re);
        v.addEventListener('playing', re);
    }
    function streamKey(u, pl, t) {
        var m = /\/vod\/(\d+)/.exec(String(u || ''));
        if (m) return 'vod:' + m[1];
        m = /https?:\/\/[^\/\s]+\/([^\/\s]+)\/[^\/\s]+\/[^\/\s]+\.m3u8/.exec(String(pl || ''));
        if (m) return 'pl:' + m[1];
        return 'u:' + String(u || '').split('?')[0] + '|' + (t || 1);
    }
    function inferStream(v) {
        var src = String(v.currentSrc || v.src || ''), d = v.duration;
        return { u: src, pl: null, t: (isFinite(d) && d > 0) ? 2 : 1, key: 'src:' + src.split('?')[0].replace(/\/[^\/]*\/[^\/]*$/, ''), inferred: true };
    }
    function stopEngine(reason) {
        if (ctl.engine) { var e = ctl.engine; ctl.engine = null; e.stop(reason); }
    }
    function onEngineFail(e, reason) {
        if (ctl.engine === e) ctl.engine = null;
        ctl.fail = { key: e.key, reason: reason, at: now(), pipe: e.pipe };
        if (e.pipe === 'v2b') {
            // no audio without the engine (the element carries none in v2b): back to native 1x
            // 1.3.5: network trouble (TV report T7: audio playlist timeout right after a re-engage) -> 2 new engines first
            if (v2bOwns(e.v) && /^(source:|net$)/.test(reason) && v2bEngineRetry(e.v, reason)) return;
            if (v2bOwns(e.v)) v2bFail('engine:' + reason);
            return;
        }
        if (/^rate_/.test(reason) && cfg.v2b !== 'off' && cfg.mode === 'auto') {
            w.setTimeout(function () { safe(decide); }, 0);      // rate ignored natively -> v2b (it toasts itself)
            return;
        }
        if (/^rate_/.test(reason)) toast('rate'); else toast('fail', String(reason).split(':')[0]);
    }
    function v2bEngineRetry(v, reason) {
        var k = v2b.key, gen = v2b.gen, r = v2b.engRetry, t = now();
        if (r.key !== k || t - r.at > 300000) r = v2b.engRetry = { key: k, n: 0, at: t };
        if (r.n >= 2) return false;
        r.n++; r.at = t; v2b.engineRetries++;
        ev('v2b_engine_retry', { reason: reason, n: r.n });
        w.setTimeout(function () {
            // a switch in flight starts its engine itself when it plays (v2bOnPlaying)
            if (gen !== v2b.gen || !v2bOwns(v) || v2b.state !== 'active' || (ctl.engine && !ctl.engine.dead)) return;
            v2bStartEngine(v);
        }, 2500 * r.n);
        return true;
    }
    function decide(user) {
        var v = mainVideo(), st = ctl.stream, s = ctl.speed, e = ctl.engine;
        if (!st && v && (v.currentSrc || v.src)) st = ctl.stream = inferStream(v);
        if (v2b.state !== 'idle') {
            if (cfg.mode === 'auto' && cfg.v2b !== 'off' && st && st.key === v2b.key && v === v2b.v) { v2bSetSpeed(s); return; }
            v2b.want = null;
            v2bRestore(cfg.mode !== 'auto' ? 'mode_' + cfg.mode : (cfg.v2b === 'off' ? 'v2b_off' : 'stream_changed'));
        }
        var ok = cfg.mode === 'auto' && !!v && !!st && st.t === 2 && s !== 1 && s >= ENGINE_MIN && s <= ENGINE_MAX;
        var pipe = v ? pipeKind(v) : null;
        var rateBlocked = ok && ((ctl.fail && ctl.fail.key === st.key && /^rate_/.test(ctl.fail.reason) && ctl.fail.pipe !== 'v2b') || (cfg.rateGate && capIgnored(pipe)));
        if (ok && !rateBlocked && ctl.fail && ctl.fail.key === st.key && now() - ctl.fail.at < 30000) ok = false;
        if (ok && (rateBlocked || cfg.v2b === 'force') && v2bRoute(v, st, s, pipe, user)) {
            if (e && !(e.pipe === 'v2b' && v2bOwns(e.v))) stopEngine('v2b');
            return;
        }
        if (s === 1 || !ok) v2b.want = null;
        if (rateBlocked) {
            // measured (this stream) or cached (this firmware): the pipeline ignores playbackRate -> never take the audio over
            ok = false;
            if (ctl.gateNote !== st.key + '|' + s + '|' + v2b.lastBlock) {
                ctl.gateNote = st.key + '|' + s + '|' + v2b.lastBlock;
                ev('rate_gate', { pipe: pipe, speed: s, v2b: cfg.v2b, why: v2b.lastBlock || null });
                // 1.3.4: v2b in its cooldown is not "the TV does not apply the speed" (TV report 1.3.3)
                if (!e) { if (v2b.lastBlock === 'cooldown') toast('v2b_cool', v2bCoolLeftS()); else toast('gate', s); }
            }
        }
        if (!ok) { if (e) stopEngine(s === 1 ? 'speed_1' : 'ineligible'); return; }
        if (e && !e.dead && e.key === st.key && e.v === v) { e.setSpeed(s); return; }
        stopEngine('restart');
        e = new Engine(v, st, s);
        e.onFail = function (reason) { onEngineFail(e, reason); };
        ctl.engine = e;
        e.start();
    }
    function onSetSpeed(sp) {
        var s = parseFloat(sp);
        if (!isFinite(s) || s <= 0) s = 1;
        ctl.speed = s;
        ev('set_speed', s);
        if (cfg.mode === 'off') { stopEngine('mode_off'); return; }
        var v = mainVideo();
        watchVideo(v);
        if (!v2bOwns(v)) {
            var nr = nativeRate(v, s);
            if (nr !== s) {
                ev('rate_hold', { speed: s, pipe: pipeKind(v) });     // 1.3.3: known-ignored pipeline stays at 1.0
                // 1.3.5: clips (MP4) / live never reach v2b (HLS VODs only): say so instead of a silent 1x
                if (ctl.stream && ctl.stream.t !== 2 && cfg.mode === 'auto') toast('gate_clip', s);
            }
            applyNative(v, nr);
        }
        decide(true);
    }
    function beforeMain(u, pl, t) {
        var key = streamKey(u, pl, t), prev = ctl.stream;
        if (v2b.state !== 'idle') v2bRelease('start_auto');
        if (!prev || prev.key !== key) { v2b.want = null; v2b.fail = null; }
        if (!prev || prev.key !== key) {
            // New content: the app resets its speed UI to 1x without calling setPlaybackSpeed.
            ctl.speed = 1; ctl.fail = null;
            cacheClear();
            stopEngine('new_stream');
            var v = mainVideo();
            if (v && cfg.mode !== 'off') { try { v.defaultPlaybackRate = 1; } catch (e) {} }
        }
        ctl.stream = { u: u, pl: pl, t: parseInt(t, 10) || 1, key: key };
        ctl.lastStream = ctl.stream;          // survives stopVideo (used by probe/sttv-gates.js)
    }
    function afterMain() {
        if (cfg.mode === 'off') return;
        var v = mainVideo();
        watchVideo(v);
        if (v && ctl.speed !== 1 && !v2bOwns(v)) applyNative(v, nativeRate(v, ctl.speed));
        if (ctl.engine && !ctl.engine.dead && ctl.stream && ctl.engine.pipe !== 'v2b') ctl.engine.info = ctl.stream;
        decide();
    }
    function onStop() {
        if (v2b.state !== 'idle') v2bRelease('stop_video');
        v2b.want = null; v2b.hold = null; ctl.mainRestart = null; ctl.lastPos = null;
        ctl.speed = 1; ctl.stream = null; ctl.fail = null;
        cacheClear();                                  // 1.3.8: the segments of a closed player are never used again
        stopEngine('stop_video');
        var v = mainVideo();
        if (v && cfg.mode !== 'off') { try { v.defaultPlaybackRate = 1; } catch (e) {} }
    }
    function wrapMethod(A, name, make) {
        var orig = A[name];
        if (typeof orig !== 'function' || orig.__sttvSpeedWrap) return false;
        var f = make(orig);
        f.__sttvSpeedWrap = true; f.__sttvOrig = orig;
        A[name] = f;
        return true;
    }
    function restartNote(rs) {
        var r = parseFloat(rs), st = ctl.stream;
        ctl.mainRestart = isFinite(r) && r > 0 && st ? { rs: r, at: now(), key: st.key } : null;
    }
    function hook() {
        var A = w.Android;
        if (!A || (typeof A !== 'object' && typeof A !== 'function')) return;
        if (typeof A.setPlaybackSpeed !== 'function') return;
        if (A === ctl.hookedObj && A.setPlaybackSpeed.__sttvSpeedWrap) return;
        wrapMethod(A, 'setPlaybackSpeed', function (orig) {
            return function (sp) {
                // 1.3.3: the bridge writes video.playbackRate itself (before onSetSpeed): a held speed reaches it as 1
                var a = arguments, s = parseFloat(sp), hr = s;
                safe(function () { if (isFinite(s) && s > 0) hr = bridgeRate(s); });
                var r = orig.apply(this, hr !== s ? [1] : a);
                safe(function () { onSetSpeed(sp); });
                return r;
            };
        });
        wrapMethod(A, 'StartAuto', function (orig) {
            return function (u, pl, t, rs, player) {
                var main = !(player > 0);
                if (main) safe(function () { v2b.hold = null; beforeMain(u, pl, t); restartNote(rs); });
                var r = orig.apply(this, arguments);
                if (main) safe(afterMain);
                return r;
            };
        });
        wrapMethod(A, 'stopVideo', function (orig) {
            return function () { safe(onStop); return orig.apply(this, arguments); };
        });
        // 1.3.4: position hold (see heldMs); the real bridge aliases getsavedtime = gettime, each gets its own wrapper
        ['gettime', 'getsavedtime'].forEach(function (n) {
            wrapMethod(A, n, function (orig) {
                return function () { var r = orig.apply(this, arguments); if (v2b.hold) { try { r = heldMs(r); } catch (e) {} } return r; };
            });
        });
        wrapMethod(A, 'mseekTo', function (orig) {
            return function () { v2b.hold = null; ctl.mainRestart = null; ctl.lastPos = null; return orig.apply(this, arguments); };
        });
        // 1.3.7: see qualityKeep - RestartPlayer reloads the main element through setMain with its resume point (no StartAuto)
        wrapMethod(A, 'RestartPlayer', function (orig) {
            return function (t, rs, player) { if (!(player > 0)) safe(function () { restartNote(rs); }); return orig.apply(this, arguments); };
        });
        wrapMethod(A, 'SetQuality', function (orig) {
            return function () {
                var v = mainVideo(), k = null, r;
                safe(function () { k = qualityKeep(v); });
                r = orig.apply(this, arguments);
                if (k) safe(function () { qualityResume(v, k); });
                return r;
            };
        });
        // 1.3.5: the user's pause (PlayPauseChange goes through PlayPause): a paused element is not a stuck one
        wrapMethod(A, 'PlayPause', function (orig) {
            return function (st) { if (!st) ctl.userPauseAt = now(); return orig.apply(this, arguments); };
        });
        ctl.hookedObj = A;
        ev('hooked', { start: typeof A.StartAuto === 'function', stop: typeof A.stopVideo === 'function' });
    }
    // the bridge pushes the progress-bar position as value[9] of Play_ShowVideoStatus (via window.smartTwitchTV exports)
    function hookApp() {
        var T = w.smartTwitchTV;
        if (!T || typeof T !== 'object' || typeof T.Play_ShowVideoStatus !== 'function') return;
        wrapMethod(T, 'Play_ShowVideoStatus', function (orig) {
            return function (sl, wc, s) {
                var a = arguments;
                if (v2b.hold && typeof s === 'string') {
                    try { var p = JSON.parse(s), h = heldMs(p[9]); if (h !== p[9]) { p[9] = h; a = [sl, wc, JSON.stringify(p)]; } } catch (e) {}
                }
                return orig.apply(this, a);
            };
        });
    }
    // passive 1 Hz meter of the real video rate (works while the engine is off / gated) -> status().verdict
    function passiveRate(v) {
        if (!ctl.pm) { ctl.pm = new RateMeter(); ctl.pm.slow = true; }
        var tw = now() / 1000;
        if (!v || v.paused || v.seeking || v.ended || v.readyState < 2 || (ctl.pmRate !== undefined && ctl.pmRate !== v.playbackRate)) {
            ctl.pm.reset(); ctl.pmRate = v ? v.playbackRate : undefined; return;
        }
        ctl.pm.add(tw, v.currentTime || 0);
        if (ctl.pm.span() >= 6) {
            var r = ctl.pm.slope(6);
            if (r !== null) ctl.passive = { ratio: +r.toFixed(3), elementRate: v.playbackRate, at: Math.round(now()) };
            ctl.pm.p.splice(0, ctl.pm.p.length - 1);
        }
    }
    function verdict() {
        var v = mainVideo(), e = ctl.engine, pipe = v ? pipeKind(v) : null, pr = ctl.passive, fresh = pr && now() - pr.at < 15000;
        var lr = ctl.lastRate, audio = (e && !e.dead && e.anch) ? 'engine' : 'native';
        var measured = (lr && lr.speed === ctl.speed && now() - lr.at < 15000) ? lr.ratio : (fresh && v && pr.elementRate === v.playbackRate ? pr.ratio : null);
        var why = (v2b.state === 'engaging' && (!e || e.dead)) ? 'v2b_engaging' : !e ? (ctl.speed === 1 ? 'speed_1' : (ctl.fail ? ctl.fail.reason : (pipe && cfg.rateGate && capIgnored(pipe) ? 'rate_ignored(cached)' : 'idle')))
            : (e.dead ? 'stopped' : (!e.rateOk ? 'verifying_rate' : (e.anch ? 'ok' : 'waiting')));
        return {
            requested: ctl.speed, pipe: pipe, videoRateMeasured: measured, audio: audio, reason: why,
            summary: ctl.speed + 'x requested; video ' + (measured === null ? '?' : measured.toFixed(2) + 'x') + ' measured; audio ' + audio + ' (' + why + ')'
        };
    }
    // 1.3.5: clips / live play on the native element (v2b = HLS VODs). If the requested rate visibly does not apply
    // (passive 6 s meter), the element goes back to 1.0 with a toast; 'plays at 1.0x' also files the rate cap like the
    // VOD pre-flight does (TV report: clip at 2x = 1.08x without sound, 1.5x = frozen).
    function clipRateCheck(v) {
        var st = ctl.stream, pr = ctl.passive, s = ctl.speed, pipe;
        if (!v || !st || st.t === 2 || s === 1 || cfg.mode !== 'auto' || !cfg.rateGate || v2bOwns(v)) return;
        if (!pr || now() - pr.at > 3000 || Math.abs(pr.elementRate - s) > 0.001 || Math.abs(pr.ratio / s - 1) <= 0.25) return;
        pipe = pipeKind(v);
        ev('clip_rate_bad', { speed: s, ratio: pr.ratio, pipe: pipe, t: st.t });
        if (pipe === 'native' && Math.abs(pr.ratio - 1) < 0.1) capMarkIgnored('native', s, pr.ratio);
        ctl.passive = null;
        applyNative(v, 1);
        toast('gate_clip', s);
    }
    function maintain() {
        var v = mainVideo();
        passiveRate(v);
        clipRateCheck(v);
        if (v) watchVideo(v);
        posSample(v);
        if (ctl.engine && !ctl.engine.dead && ctl.engine.v !== v) { ev('video_element_changed'); decide(); }
        v2bMaintain(v);
    }
    // 1.3.4: the last 120 events survive an app restart (TV report: "the VOD closes" - the report after the relaunch had
    // only the new session). STTVSpeed.prevLog() = the previous session; written every 5 s and when the page hides.
    var LS_LASTLOG = 'STTV_SPEED_LASTLOG', prevLog, logSavedAt = -1, logTick = 0;
    function appInfo() {
        var id = null, ng = w.TwitchNG, m;
        try { id = String((w.PalmSystem && w.PalmSystem.identifier) || '').split(' ')[0] || null; } catch (e) {}
        if (!id && (m = /\/applications\/([^\/]+)\//.exec(BASE))) id = m[1];
        return { id: id, name: ng && ng.name || null, version: ng && ng.version || null };
    }
    function logSave(force) {
        if (!force && evCount === logSavedAt) return;
        logSavedAt = evCount;
        try { lsSet(LS_LASTLOG, JSON.stringify({ engine: VERSION, app: appInfo(), savedAt: new Date().toISOString(), upMs: Math.round(now()), events: events.slice(-120) })); } catch (e) {}
    }
    function install() {
        if (ctl.installed) return;
        ctl.installed = true;
        try { prevLog = JSON.parse(lsGet(LS_LASTLOG) || 'null'); } catch (e0) { prevLog = null; }
        if (w.addEventListener) {
            w.addEventListener('pagehide', function () { logSave(true); });
            w.addEventListener('beforeunload', function () { logSave(true); });
        }
        if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', function () {
            ev('visibility', { hidden: !!doc.hidden, speed: ctl.speed, v2b: v2b.state });
            if (doc.hidden) logSave(true);
        });
        // 1.3.5 diagnostics (TV report T9: after Home + relaunch the engine still ran 2x while the app menu showed 1x)
        if (doc && doc.addEventListener) doc.addEventListener('webOSRelaunch', function () {
            var v = mainVideo();
            ev('relaunch', { speed: ctl.speed, v2b: v2b.state, v2bSpeed: v2b.speed, engine: ctl.engine && !ctl.engine.dead ? ctl.engine.speed : null,
                ct: v ? +(v.currentTime || 0).toFixed(1) : null, paused: v ? v.paused : null });
        }, true);
        safe(hook);
        ctl.timer = w.setInterval(function () { safe(hook); safe(hookApp); safe(maintain); if (++logTick % 5 === 0) logSave(); }, 1000);
        if (doc && doc.addEventListener) doc.addEventListener('DOMContentLoaded', function () { safe(hook); });
        ev('installed', { version: VERSION, mode: cfg.mode });
    }

    // ---------------------------------------------------------------- audio diagnostics (README 11.5)
    // The engine cannot tell whether its output is AUDIBLE: a platform sink can consume samples silently (the context
    // runs, the clock advances, the analyser sees signal). So a person listens: test N plays N beeps (0.22 s, 0.4 s apart)
    // with a toast "Тест звука N/6"; the JSON holds the objective side (context state + latencies, level of the beep at
    // the graph output = rendered, context clock rate, element mute states, MSE / AudioEncoder codec support for plan B).
    var diagBusy = false;
    function sleepMs(ms) { return new Promise(function (r) { w.setTimeout(r, ms); }); }
    function withTimeout(p, ms, val) { return Promise.race([p, sleepMs(ms).then(function () { return val; })]); }
    function ctxInfo(c) {
        return c ? { state: c.state, sr: c.sampleRate, base: typeof c.baseLatency === 'number' ? +c.baseLatency.toFixed(4) : null,
            out: typeof c.outputLatency === 'number' ? +c.outputLatency.toFixed(4) : null } : null;
    }
    function ensureRunning(c) {
        if (!c || c.state === 'running') return Promise.resolve();
        var p = null;
        try { p = c.resume(); } catch (e) {}
        return withTimeout(p && p.then ? p.then(null, function () {}) : Promise.resolve(), 1000);
    }
    function beepTrain(ctx, n, freq, dest) {
        var t0 = ctx.currentTime + 0.15, g = ctx.createGain(), an = ctx.createAnalyser(), o = ctx.createOscillator(), buf, i, a, mx = 0, iv;
        an.fftSize = 2048; buf = new Float32Array(2048);
        g.gain.value = 0;
        for (i = 0; i < n; i++) {
            a = t0 + i * 0.4;
            g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(0.3, a + 0.006);
            g.gain.setValueAtTime(0.3, a + 0.214); g.gain.linearRampToValueAtTime(0, a + 0.22);
        }
        o.type = 'sine'; o.frequency.value = freq;
        o.connect(g); g.connect(dest || ctx.destination); g.connect(an);
        o.start(t0); o.stop(t0 + n * 0.4 + 0.05);
        var c0 = ctx.currentTime, w0 = now();
        iv = w.setInterval(function () {
            try {
                an.getFloatTimeDomainData(buf);
                var q = 0, k; for (k = 0; k < buf.length; k++) q += buf[k] * buf[k];
                q = Math.sqrt(q / buf.length); if (q > mx) mx = q;
            } catch (e) {}
        }, 40);
        return sleepMs(150 + n * 400 + 250).then(function () {
            w.clearInterval(iv);
            try { o.disconnect(); g.disconnect(); an.disconnect(); } catch (e) {}
            var dw = (now() - w0) / 1000;
            return { renderedDb: db(mx), clock: dw > 0 ? +((ctx.currentTime - c0) / dw).toFixed(3) : null };
        });
    }
    function wavBlob(n, freq) {
        // mono 16-bit 48 kHz, same beep pattern as beepTrain (0.15 s lead-in)
        var sr = 48000, len = Math.round(sr * (0.15 + n * 0.4 + 0.1)), b = new ArrayBuffer(44 + len * 2), d = new DataView(b), i, k, t, u, x;
        function str(o, z) { for (k = 0; k < z.length; k++) d.setUint8(o + k, z.charCodeAt(k)); }
        str(0, 'RIFF'); d.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt '); d.setUint32(16, 16, true);
        d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true);
        d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, len * 2, true);
        for (i = 0; i < len; i++) {
            t = i / sr - 0.15; x = 0;
            if (t >= 0) {
                k = Math.floor(t / 0.4); u = t - k * 0.4;
                if (k < n && u < 0.22) x = 0.3 * Math.min(1, u / 0.006, (0.22 - u) / 0.006) * Math.sin(2 * Math.PI * freq * t);
            }
            d.setInt16(44 + i * 2, Math.round(x * 32767), true);
        }
        return new Blob([b], { type: 'audio/wav' });
    }
    function audioCaps() {
        var out = { webcodecsDecoder: !!w.AudioDecoder, mse: {}, encoder: {}, setSinkId: false, mediaStreamDest: false, devices: null };
        var MS = w.MediaSource, AC = w.AudioContext || w.webkitAudioContext;
        ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="opus"', 'audio/webm; codecs="opus"', 'audio/mp4; codecs="flac"'].forEach(function (t) {
            try { out.mse[t] = !!(MS && MS.isTypeSupported(t)); } catch (e) { out.mse[t] = 'err'; }
        });
        out.setSinkId = !!(AC && AC.prototype && typeof AC.prototype.setSinkId === 'function');
        out.mediaStreamDest = !!(AC && AC.prototype && typeof AC.prototype.createMediaStreamDestination === 'function');
        function enc(codec) {
            if (!w.AudioEncoder || typeof w.AudioEncoder.isConfigSupported !== 'function') return Promise.resolve('no_AudioEncoder');
            try {
                return withTimeout(w.AudioEncoder.isConfigSupported({ codec: codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })
                    .then(function (r) { return !!(r && r.supported); }, function (e) { return 'err:' + errStr(e); }), 3000, 'timeout');
            } catch (e) { return Promise.resolve('err:' + errStr(e)); }
        }
        function devs() {
            var md = w.navigator && w.navigator.mediaDevices;
            if (!md || typeof md.enumerateDevices !== 'function') return Promise.resolve(null);
            return withTimeout(md.enumerateDevices().then(function (l) { return l.filter(function (x) { return x.kind === 'audiooutput'; }).length; },
                function (e) { return 'err:' + errStr(e); }), 3000, 'timeout');
        }
        return Promise.all([enc('opus'), enc('mp4a.40.2'), devs()]).then(function (r) {
            out.encoder.opus = r[0]; out.encoder.aac = r[1]; out.devices = r[2];
            return out;
        });
    }
    function beepsWord(n) { return RU ? n + (n === 1 ? ' гудок' : (n < 5 ? ' гудка' : ' гудков')) : n + (n === 1 ? ' beep' : ' beeps'); }
    function audioDiag(opts) {
        opts = opts || {};
        if (diagBusy) return Promise.reject(new Error('audioDiag already running'));
        diagBusy = true;
        var v = mainVideo(), md = w.HTMLMediaElement && Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'muted');
        var e = ctl.engine && !ctl.engine.dead ? ctl.engine : null, total = opts.media === false ? 5 : 6, freq = opts.freq || 880;
        var mute0 = v ? realMuted(v) : null;
        var res = { version: VERSION, at: new Date().toISOString(), speed: ctl.speed, v2b: v2b.state, pipe: v ? pipeKind(v) : null,
            video: v ? { paused: v.paused, ct: +(v.currentTime || 0).toFixed(2), realMuted: mute0, appMuted: !!v.muted, volume: v.volume } : null,
            engine: e ? e.status().audioOut : null, engineCtx: e && e.ctx ? ctxInfo(e.ctx) : null,
            cfg: { actx: cfg.actx, mute: cfg.mute, fresh: cfg.actxFresh }, tests: [], caps: null,
            ask: RU ? 'Какие номера тестов были СЛЫШНЫ (номер теста = число гудков)?' : 'Which test numbers were AUDIBLE (test number = number of beeps)?' };
        function setRealMuted(x) { if (v && md && md.set && x !== null) { try { md.set.call(v, !!x); } catch (er) {} } }
        // test 3 holds the hardware mute like the 1.2 MuteGuard did: the bridge's applyAudio() writes muted = false
        var tmpGuard = null;
        function holdMuted() {
            if (!v || (e && e.guard && e.guard.active)) return;
            tmpGuard = new MuteGuard(v);
            if (!tmpGuard.engage()) { tmpGuard = null; setRealMuted(true); }
        }
        function dropMuted() { if (tmpGuard) { tmpGuard.release(); tmpGuard = null; } else setRealMuted(mute0); }
        function step(id, name, label, run) {
            return function () {
                toast('diag', id + '/' + total + ' · ' + label + ' · ' + beepsWord(id));
                ev('audio_diag_step', { id: id, name: name });
                var t = { id: id, beeps: id, name: name };
                return sleepMs(700).then(run).then(function (r) {
                    var k; for (k in r) if (Object.prototype.hasOwnProperty.call(r, k)) t[k] = r[k];
                }, function (er) { t.err = errStr(er); }).then(function () { res.tests.push(t); return sleepMs(1300); });
            };
        }
        function fresh(mode, n, before, after) {
            var r = newContext(mode), c = r.ctx;
            if (!c) return Promise.resolve({ err: r.err || 'no_context' });
            if (before) before();
            var m0 = v ? realMuted(v) : null, done = false;
            function fin() { if (done) return; done = true; try { c.close(); } catch (er) {} if (after) after(); }
            return ensureRunning(c).then(function () {
                var c0 = ctxInfo(c);
                return beepTrain(c, n, freq).then(function (b) {
                    var o = { opts: r.opts, ctx0: c0, ctx: ctxInfo(c), renderedDb: b.renderedDb, clock: b.clock, elementMuted0: m0, elementMuted: v ? realMuted(v) : null };
                    fin();
                    return o;
                });
            }).then(null, function (er) { fin(); throw er; });
        }
        var chain = Promise.resolve()
            .then(step(1, 'engine_ctx', RU ? 'контекст движка' : 'engine context', function () {
                var c = e && e.ctx && e.ctx.state !== 'closed' ? e.ctx : null;
                if (!c) return { skipped: 'no_engine' };
                return ensureRunning(c).then(function () { return beepTrain(c, 1, freq); }).then(function (b) {
                    return { opts: e.ctxOpts || '', ctx: ctxInfo(c), renderedDb: b.renderedDb, clock: b.clock, elementMuted: v ? realMuted(v) : null };
                });
            }))
            .then(step(2, 'fresh_default_video_unmuted', RU ? 'новый AudioContext' : 'new AudioContext', function () {
                return fresh('default', 2, function () { setRealMuted(false); }, function () { setRealMuted(mute0); });
            }))
            .then(step(3, 'fresh_default_video_muted', RU ? 'новый AudioContext, видео muted' : 'new AudioContext, video muted', function () {
                return fresh('default', 3, holdMuted, dropMuted);
            }))
            .then(step(4, 'fresh_48k_playback', RU ? 'AudioContext как в 1.2 (48k/playback)' : 'AudioContext as in 1.2 (48k/playback)', function () {
                return fresh('48k', 4);
            }))
            .then(step(5, 'mediastream_to_audio_element', RU ? 'WebAudio → <audio>' : 'WebAudio → <audio>', function () {
                var r = newContext('default'), c = r.ctx, a, dest, pr = null, playErr = '';
                if (!c) return { err: r.err || 'no_context' };
                if (typeof c.createMediaStreamDestination !== 'function') { try { c.close(); } catch (er) {} return { skipped: 'no_MediaStreamDestination' }; }
                dest = c.createMediaStreamDestination();
                a = doc.createElement('audio');
                try { a.srcObject = dest.stream; } catch (er) { try { c.close(); } catch (x) {} return { err: 'srcObject:' + errStr(er) }; }
                try { pr = a.play(); } catch (er) { playErr = errStr(er); }
                if (pr && pr.then) pr.then(null, function (er) { playErr = errStr(er); });
                return ensureRunning(c).then(function () { return beepTrain(c, 5, freq, dest); }).then(function (b) {
                    var o = { ctx: ctxInfo(c), renderedDb: b.renderedDb, clock: b.clock, audioPaused: a.paused, playErr: playErr || null, audioErr: a.error ? a.error.code : null };
                    try { a.pause(); a.srcObject = null; } catch (er) {}
                    try { c.close(); } catch (er) {}
                    return o;
                });
            }));
        if (total === 6) chain = chain.then(step(6, 'wav_in_audio_element', RU ? 'WAV в <audio> (медиаплеер ТВ)' : 'WAV in <audio> (TV media player)', function () {
            var url = w.URL.createObjectURL(wavBlob(6, freq)), a = doc.createElement('audio'), pr = null, playErr = '';
            a.preload = 'auto'; a.src = url;
            try { pr = a.play(); } catch (er) { playErr = errStr(er); }
            if (pr && pr.then) pr.then(null, function (er) { playErr = errStr(er); });
            return sleepMs(150 + 6 * 400 + 1000).then(function () {
                var o = { audioCt: +(a.currentTime || 0).toFixed(2), audioPaused: a.paused, ended: a.ended, readyState: a.readyState,
                    audioErr: a.error ? a.error.code : null, playErr: playErr || null };
                try { a.pause(); a.removeAttribute('src'); a.load(); } catch (er) {}
                try { w.URL.revokeObjectURL(url); } catch (er) {}
                return o;
            });
        }));
        return chain.then(audioCaps).then(function (caps) {
            res.caps = caps;
            res.after = v ? { paused: v.paused, ct: +(v.currentTime || 0).toFixed(2), realMuted: realMuted(v), v2b: v2b.state } : null;
            diagBusy = false;
            lsSet('STTV_SPEED_AUDIODIAG', JSON.stringify(res));
            ev('audio_diag', res.tests.map(function (t) {
                return t.id + ':' + (t.err ? 'err' : (t.skipped ? 'skip' : (t.renderedDb !== undefined ? t.renderedDb + 'dB' : 'ct' + t.audioCt)));
            }).join(' '));
            try { w.console.log('[sttv-speed] audioDiag ' + JSON.stringify(res)); } catch (er) {}
            return res;
        }, function (er) { diagBusy = false; throw er; });
    }
    function beep(n) {
        var r = newContext(cfg.actx), c = r.ctx;
        if (!c) return Promise.reject(new Error(r.err || 'no_webaudio'));
        n = Math.max(1, Math.min(9, (n | 0) || 1));
        return ensureRunning(c).then(function () { return beepTrain(c, n, 880); }).then(function (b) {
            var o = { opts: r.opts, ctx: ctxInfo(c), renderedDb: b.renderedDb, clock: b.clock };
            try { c.close(); } catch (e) {}
            return o;
        });
    }

    // ---------------------------------------------------------------- public console API
    var api = {
        version: VERSION,
        status: function () {
            var v = mainVideo();
            return {
                version: VERSION, app: appInfo(), mode: cfg.mode, speed: ctl.speed, offsetMs: cfg.offsetMs, hooked: !!ctl.hookedObj,
                stream: ctl.stream ? { t: ctl.stream.t, key: ctl.stream.key, inferred: !!ctl.stream.inferred } : null,
                video: v ? {
                    rate: v.playbackRate, defaultRate: v.defaultPlaybackRate, preservesPitch: v.preservesPitch, muted: v.muted,
                    realMuted: realMuted(v), volume: v.volume, ct: +(v.currentTime || 0).toFixed(3), paused: v.paused, src: String(v.currentSrc || v.src || '').slice(0, 160)
                } : null,
                engine: ctl.engine ? ctl.engine.status() : null,
                verdict: verdict(), pipe: pipeDetail(v), v2b: v2bStatus(),
                rateCap: { native: capGet('native'), mse: capGet('mse'), v2b: capGet('v2b'), gate: cfg.rateGate }, lastRate: ctl.lastRate,
                lastFail: ctl.fail, webcodecs: !!w.AudioDecoder,
                net: { mode: net.mode, path: net.decided || null, proxy: net.proxy || null, luna: lunaOk() ? lunaName() : null, blocked: net.fails },
                recent: events.slice(-40)
            };
        },
        setMode: function (m) {
            cfg.mode = normMode(m);
            lsSet(LS_MODE, cfg.mode === 'auto' ? null : cfg.mode);
            if (cfg.mode !== 'off') install();
            if (cfg.mode === 'auto') decide(); else stopEngine('mode_' + cfg.mode);
            return cfg.mode;
        },
        setProxy: function (url) { lsSet('STTV_SPEED_PROXY', url ? String(url) : null); netConf(); net.decided = ''; return net.proxy || null; },
        setNet: function (m) { lsSet('STTV_SPEED_NET', m && m !== 'auto' ? String(m) : null); netConf(); net.decided = ''; return net.mode; },
        setOffset: function (ms) { cfg.offsetMs = toNum(ms, 0); lsSet(LS_OFFSET, cfg.offsetMs ? cfg.offsetMs : null); return cfg.offsetMs; },
        rateCap: function () { return { key: fwKey(), gate: cfg.rateGate, native: capGet('native'), mse: capGet('mse'), v2b: capGet('v2b') }; },
        pipe: function () { return pipeDetail(mainVideo()); },
        v2b: function (m) {
            if (m !== undefined) {
                var x = normV2b(m);
                lsSet('STTV_SPEED_V2B', x === BUILD_V2B ? null : x);      // only deviations from the build default are stored
                v2bConf(); v2b.fail = null; v2b.unavailNote = '';
                if (cfg.v2b === 'off') { v2b.want = null; v2bRestore('v2b_off'); } else decide();
            }
            return v2bStatus();
        },
        v2bRestore: function () { v2b.want = null; v2bRestore('api'); return v2bStatus(); },
        resetRateCap: function () {
            lsSet(LS_CAP, null); ctl.gateNote = '';
            if (ctl.fail && /^rate_/.test(ctl.fail.reason)) ctl.fail = null;
            ev('rate_cap_reset'); decide();
            return api.rateCap();
        },
        debug: function (on) { cfg.debug = !!on; lsSet(LS_DEBUG, on ? '1' : null); return cfg.debug; },
        events: function (n) { return events.slice(-(n || 60)); },
        prevLog: function () { return prevLog || null; },
        apply: function (s) {
            var A = w.Android;
            if (A && typeof A.setPlaybackSpeed === 'function') A.setPlaybackSpeed(s); else onSetSpeed(s);
            return api.status();
        },
        stop: function () { v2b.want = null; v2bRestore('api_stop'); stopEngine('api'); },
        audioDiag: audioDiag,
        beep: beep,
        audio: function (o) {
            if (o && typeof o === 'object') {
                if (o.actx !== undefined) lsSet('STTV_SPEED_ACTX', o.actx && o.actx !== 'default' ? String(o.actx) : null);
                if (o.mute !== undefined) lsSet('STTV_SPEED_MUTE', o.mute && o.mute !== 'auto' ? String(o.mute) : null);
                if (o.fresh !== undefined) lsSet('STTV_SPEED_ACTX_FRESH', o.fresh ? null : '0');
                audioConf();
                ev('audio_conf', { actx: cfg.actx, mute: cfg.mute, fresh: cfg.actxFresh });
            }
            var last = null;
            try { last = JSON.parse(lsGet('STTV_SPEED_AUDIODIAG') || 'null'); } catch (e) {}
            return { actx: cfg.actx, mute: cfg.mute, fresh: cfg.actxFresh,
                ctx: ctxMeta ? { opts: ctxMeta.opts, owner: ctxMeta.owner, why: ctxMeta.why, silent: ctxMeta.silent, ageS: Math.round((now() - ctxMeta.at) / 1000),
                    state: sharedCtx ? sharedCtx.state : 'closed' } : null,
                lastDiag: last ? { at: last.at, v2b: last.v2b, tests: last.tests, caps: last.caps } : null };
        },
        _getContext: getContext,
        _ctl: ctl,
        _internals: {
            parseMaster: parseMaster, parseMedia: parseMedia, deriveAudioOnly: deriveAudioOnly, pickSources: pickSources,
            segAt: segAt, demuxTS: demuxTS, adtsParse: adtsParse, makeAsc: makeAsc, unwrapPts: unwrapPts, adtsWrap: adtsWrap,
            parseMp4Init: parseMp4Init, parseMp4Fragment: parseMp4Fragment, PcmStore: PcmStore, Wsola: Wsola, VClock: VClock,
            resampleLinear: resampleLinear, streamKey: streamKey, HlsSource: HlsSource, Engine: Engine, AudioDec: AudioDec,
            resolveSources: resolveSources, MuteGuard: MuteGuard, cfg: cfg, net: net, xhr: xhr, lunaXhr: lunaXhr, netConf: netConf,
            RateMeter: RateMeter, LatTracker: LatTracker, fwKey: fwKey, capGet: capGet, pipeKind: pipeKind, verdict: verdict,
            capLoad: capLoad, capPut: capPut, objKinds: objKinds, blobKind: blobKind, pipeDetail: pipeDetail, lunaRanged: lunaRanged,
            v2bHlsError: v2bHlsError, v2bPos: v2bPos, logSave: logSave, v2bHold: v2bHold, heldMs: heldMs, hookApp: hookApp,
            V2bLoader: V2bLoader, segCache: segCache, segFetch: segFetch, cacheClear: cacheClear, v2b: v2b, v2bPickVariant: v2bPickVariant,
            v2bPlaylist: v2bPlaylist, variantHeight: variantHeight, v2bConf: v2bConf, BASE: BASE, BUILD_V2B: BUILD_V2B, normV2b: normV2b,
            audioConf: audioConf, ctxOptions: ctxOptions, newContext: newContext, audioClass: audioClass, db: db, realMuted: realMuted,
            wavBlob: wavBlob, audioCaps: audioCaps, beepsWord: beepsWord,
            v2bLevelInfo: v2bLevelInfo, v2bTimelineCheck: v2bTimelineCheck, v2bTimeline: v2bTimeline, nativeDuration: nativeDuration,
            V2B_SPEEDS: V2B_SPEEDS, ENGINE_MIN: ENGINE_MIN, nativeRate: nativeRate, onSetSpeed: onSetSpeed, applyNative: applyNative,
            bridgeRate: bridgeRate, hook: hook,
            // 1.3.5
            v2bStepDown: v2bStepDown, v2bKick: v2bKick, v2bAbsorbLoad: v2bAbsorbLoad, v2bRestoreWatch: v2bRestoreWatch, v2bEngageWatch: v2bEngageWatch,
            v2bNetWatch: v2bNetWatch, v2bNetRecover: v2bNetRecover, v2bEngineRetry: v2bEngineRetry, clipRateCheck: clipRateCheck, plCache: plCache,
            plText: plText, v2bAhead: v2bAhead, variantName: variantName, v2bMaintain: v2bMaintain, v2bFail: v2bFail, v2bRestore: v2bRestore,
            onEngineFail: onEngineFail, toast: toast, MSG: MSG,
            // 1.3.7
            posSample: posSample, qualityKeep: qualityKeep, qualityResume: qualityResume, restartNote: restartNote
        }
    };
    w.STTVSpeed = api;
    if (!w.__sttvSpeedNoAutoInstall && cfg.mode !== 'off') install();
})(typeof window !== 'undefined' ? window : this);
