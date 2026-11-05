/*!
 * hls-recover-fix.js - fix for the MEDIA_ERROR -> recoverMediaError() reload loop of the old MSE prototype (mainHls).
 * Root cause: the prototype's handler called recoverMediaError() on EVERY MEDIA_ERROR, including non-fatal ones
 * (bufferStalledError, bufferNudgeOnStall, bufferSeekOverHole, ...), which hls.js already handles itself.
 * recoverMediaError() = detachMedia() + attachMedia(): new MediaSource, new src, 'emptied' + 'loadstart', and the
 * pending play() is rejected ("interrupted by a new load request"). That stalls again, raises the next error, and loops.
 * Fix: recover only fatal errors, at most once per burst, swapAudioCodec() on the 2nd attempt, then stop (circuit
 * breaker -> onGiveUp, e.g. back to 1x/native). Restores playbackRate and calls play() once on 'canplay'.
 *   // replace:  mainHls.on(Hls.Events.ERROR, function (e, d) { if (d.type === Hls.ErrorTypes.MEDIA_ERROR) mainHls.recoverMediaError(); });
 *   var rec = STTVHlsRecovery.attach(mainHls, video, { onGiveUp: function (why) { ...fallback... } });
 */
(function (w) {
    'use strict';
    function attach(hls, video, opts) {
        opts = opts || {};
        var H = opts.Hls || w.Hls, E = H.Events, T = H.ErrorTypes;
        var WINDOW = opts.mediaWindowMs || 20000, GAP = opts.minGapMs || 1500, NET_MAX = opts.netRetries || 3;
        var st = { media: 0, net: 0, lastMediaAt: 0, nonFatal: 0, recovered: 0, gaveUp: false, log: [] }, timer = 0, waitPlay = false;
        function note(type, d) {
            st.log.push({ t: Date.now(), type: type, d: d });
            if (st.log.length > 50) st.log.shift();
            if (opts.debug) { try { console.log('[hls-recover] ' + type, d || ''); } catch (e) {} }
        }
        function giveUp(why) {
            if (st.gaveUp) return;
            st.gaveUp = true;
            note('give_up', why);
            if (opts.onGiveUp) { try { opts.onGiveUp(why, st); } catch (e) {} }
        }
        function playWhenReady() {
            if (waitPlay) return;
            waitPlay = true;
            var go = function () {
                video.removeEventListener('canplay', go);
                waitPlay = false;
                var p = video.play();
                if (p && p.catch) p.catch(function () {});
            };
            video.addEventListener('canplay', go);
        }
        function recoverMedia(data) {
            var t = Date.now();
            if (t - st.lastMediaAt > WINDOW) st.media = 0;
            if (t - st.lastMediaAt < GAP) {                       // collapse bursts into one recovery
                if (!timer) timer = setTimeout(function () { timer = 0; if (!st.gaveUp) recoverMedia(data); }, GAP - (t - st.lastMediaAt));
                return;
            }
            st.lastMediaAt = t;
            st.media++;
            var playing = !video.paused, rate = video.playbackRate, pos = video.currentTime;
            if (st.media === 1) { note('recover_media', data.details); hls.recoverMediaError(); }
            else if (st.media === 2) { note('swap_audio_codec_recover', data.details); try { hls.swapAudioCodec(); } catch (e) {} hls.recoverMediaError(); }
            else { giveUp('media:' + data.details); return; }
            st.recovered++;
            try { video.defaultPlaybackRate = rate; video.playbackRate = rate; } catch (e) {}   // re-attach resets the rate
            var back = function () {                              // re-attach may restart at config.startPosition
                video.removeEventListener('loadedmetadata', back);
                if (pos > 0 && Math.abs(video.currentTime - pos) > 0.5) { try { video.currentTime = pos; } catch (e) {} }
                try { video.playbackRate = rate; } catch (e2) {}
            };
            video.addEventListener('loadedmetadata', back);
            if (playing) playWhenReady();
        }
        function onError(evt, data) {
            if (!data || st.gaveUp) return;
            if (!data.fatal) { st.nonFatal++; return; }          // hls.js handles these itself (nudge / retry / switch)
            if (data.type === T.MEDIA_ERROR) { recoverMedia(data); return; }
            if (data.type === T.NETWORK_ERROR && st.net < NET_MAX) {
                st.net++;
                note('network_retry', data.details);
                setTimeout(function () { if (!st.gaveUp) hls.startLoad(); }, 1000 * st.net);
                return;
            }
            giveUp(String(data.type) + ':' + data.details);
        }
        function onFrag() { st.net = 0; }
        hls.on(E.ERROR, onError);
        hls.on(E.FRAG_BUFFERED, onFrag);
        return {
            state: st,
            detach: function () { hls.off(E.ERROR, onError); hls.off(E.FRAG_BUFFERED, onFrag); if (timer) clearTimeout(timer); }
        };
    }
    // At speed r the buffer drains r times faster: scale the forward buffer (hls.js reads config at runtime).
    function tuneForRate(hls, rate) {
        var c = hls.config, r = Math.max(1, rate || 1);
        c.maxBufferLength = Math.round(30 * r);
        c.maxMaxBufferLength = Math.max(c.maxMaxBufferLength || 600, Math.round(60 * r));
        c.nudgeMaxRetry = Math.max(c.nudgeMaxRetry || 3, 6);
    }
    w.STTVHlsRecovery = { attach: attach, tuneForRate: tuneForRate };
})(typeof window !== 'undefined' ? window : this);
