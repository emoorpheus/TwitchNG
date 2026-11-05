/*
 * ng-ui.js 1.0.0 pre-release 06 - Twitch NG "Next-Gen UI" text layer, ES5 (stage 1: live grid, side menu, header; DESIGN.md).
 * Loaded by release/index.html right after twitchng.js (build/build-app.mjs --brand twitchng). twitchng.js switches the UI on / off
 * (html.ng-ui + ng-ui.css / ng-icons.css; localStorage.TWITCHNG_UI = '0' or TwitchNG.ui(false) = the OLED preset look); with the
 * class off this file changes nothing. It reshapes a few texts main.js renders, as DOM post-processing, textContent only:
 *   - live cards (html class ng-live on the holder): viewers badge on the picture ("20,7 тыс." / "20.7K"), "game · 7 ч 32 мин"
 *     (the "Playing" prefix and the seconds go), language chip without brackets
 *   - header: clock = date (quiet) + time (bold), "updated 5 min ago" instead of "(Last refreshed: 5m)"
 *   - side menu: the rail icon mirrors the focused / current row, the bottom entries get icons (ng-ico-*)
 * Observers: #screens_holder (cards), #side_panel_new_holder, #topbar and #clock_holder - not the player / chat; one pass per
 * animation frame over the changed cards only. window.NgUi = { version, state(), run() } for tests and the console.
 * GPL-3.0. Not affiliated with Twitch Interactive.
 */
(function (w) {
    'use strict';
    var d = w.document, html = d && d.documentElement;
    if (!html || w.NgUi) return;
    var VERSION = '1.0.0-pre06', stats = { passes: 0, cards: 0, chrome: 0 };

    function has(el, c) { return !!el && el.nodeType === 1 && (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
    function setClass(el, c, on) {
        if (!el || has(el, c) === !!on) return;
        el.className = on ? (el.className ? el.className + ' ' : '') + c : (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
    }
    function on() { return has(html, 'ng-ui'); }
    function byId(id) { return d.getElementById(id); }
    function set(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
    function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
    // app language: ru (also be / kk, as twitchng.js), en (also every language main.js has no translation for), or the code
    function lang() {
        var l = String(lsGet('app_lang_string') || (w.navigator && w.navigator.language) || '').replace(/^"/, '').slice(0, 2).toLowerCase();
        if (/^(ru|be|kk)$/.test(l)) return 'ru';
        return /^(es|fr|pt|tr|uk)$/.test(l) ? l : 'en';
    }
    var NB = '\u00a0';

    // ---- numbers / times
    function compact(n, L) {
        var r;
        if (L === 'ru') {
            if (n >= 1e6) r = (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + NB + 'млн';
            else if (n >= 1e4) r = (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + NB + 'тыс.';
            else return n >= 1000 ? String(n).replace(/(\d)(?=(\d{3})+$)/, '$1' + NB) : String(n);
            return r.replace('.0' + NB, NB).replace('.', ',');
        }
        if (n >= 1e6) r = (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
        else if (n >= 1e3) r = (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
        else return String(n);
        return r.replace('.0', '');
    }
    function hm(h, m, L) { return L === 'ru' ? (h ? h + NB + 'ч ' : '') + m + NB + 'мин' : (h ? h + 'h ' : '') + m + 'm'; }
    // upstream since-timer "Уже 07:32:17" / "Since 42:06" / "1:02:03:04" (days) -> "7 ч 32 мин" / "42m"
    function uptime(t, L) {
        var m = /(\d+(?::\d+)+)/.exec(t || ''), p, i, h = 0, mi;
        if (!m) return null;
        p = m[1].split(':');
        for (i = 0; i < p.length; i++) p[i] = parseInt(p[i], 10) || 0;
        if (p.length >= 4) { h = p[0] * 24 + p[1]; mi = p[2]; } else if (p.length === 3) { h = p[0]; mi = p[1]; } else mi = p[0];
        return hm(h, mi, L);
    }
    // "(посл. обновление: 1h 5m)" / " (Last refreshed: 2d 3h 0m)" -> "обновлено 1 ч 5 мин назад" / "updated 3h 0m ago"
    function refreshed(t, L) {
        var m = /(?:(\d+)d\s*)?(?:(\d+)h\s*)?(\d+)m\s*\)?\s*$/.exec(t || ''), h, mi;
        if (!m || (L !== 'ru' && L !== 'en')) return null;
        h = (parseInt(m[1], 10) || 0) * 24 + (parseInt(m[2], 10) || 0); mi = parseInt(m[3], 10) || 0;
        if (!h && !mi) return L === 'ru' ? 'обновлено только что' : 'updated just now';
        return L === 'ru' ? 'обновлено ' + hm(h, mi, L) + ' назад' : 'updated ' + hm(h, mi, L) + ' ago';
    }
    var GAME_PREFIX = /^\s*(?:Стрим по|Playing|Jugando|Joue à|Jogando|Oynuyor|Грає в)\s+/;

    // ---- live cards
    function card(holder, L) {
        var name = holder.querySelector('.stream_info_live_name'), icon = name && name.querySelector('.live_icon');
        setClass(holder, 'ng-live', !!icon);
        if (!icon) return;
        stats.cards++;
        var img = holder.querySelector('.stream_thumbnail_live_img'), views = holder.querySelector('[id*="_views_"]'),
            since = holder.querySelector('[id*="_since_"]'), game = holder.querySelector('[id*="_game_"]'),
            row = holder.querySelector('.stream_text_holder > div'), chip = row && row.querySelector('.stream_info_live'), b, n, u;
        if (views && img) {
            n = parseInt((views.textContent || '').replace(/[^\d]/g, ''), 10);
            b = img.querySelector('.ng-badge');
            if (!isNaN(n)) {
                if (!b) { b = d.createElement('span'); b.className = 'ng-badge'; img.appendChild(b); }
                set(b, compact(n, L));
            }
        }
        if (since && /\d:\d/.test(since.textContent)) { u = uptime(since.textContent, L); if (u) set(since, u); }
        if (game) set(game, (game.textContent || '').replace(GAME_PREFIX, ''));
        if (chip) set(chip, (chip.textContent || '').replace(/[\[\]]/g, '').replace(/^\s+|\s+$/g, ''));
    }
    function holderOf(n, stop) {
        for (; n && n !== stop; n = n.parentNode) if (has(n, 'stream_thumbnail_live_holder')) return n;
        return null;
    }

    // ---- side panel / header
    var BOTTOM = ['ng-ico-settings', 'ng-ico-about', 'ng-ico-controls', 'ng-ico-exit', 'ng-ico-news'];
    function side() {
        var i, fx, mv, f, act;
        setClass(byId('side_panel_new_holder'), 'ng-icons', true);
        for (i = 10; i <= 14; i++) setClass(byId('side_panel_movel_new_' + i), BOTTOM[i - 10], true);
        for (i = 0; i < 10; i++) {   // open menu: the focused row / current section also lights the rail icon of that row
            fx = byId('side_panel_new_' + i); mv = byId('side_panel_movel_new_' + i);
            if (!fx || !mv) continue;
            f = has(mv, 'side_panel_new_icons_text') || has(mv, 'side_panel_new_icons_text_botton');
            setClass(fx, 'ng-row-focus', f);
            act = has(fx, 'side_panel_new_icons_start');
            setClass(mv, 'ng-row-active', act);
        }
    }
    function header(L) {
        var c = byId('label_clock'), m, a, b, l;
        setClass(byId('topbar'), 'ng-icons', true);
        setClass(byId('controls_div'), 'ng-icons', true);
        if (c && !c.querySelector('.ng-clock-time')) {   // "Чт, 5 Ноя, 12:48" -> "Чт, 5 ноя" (quiet) + "12:48" (bold)
            m = /^(.*?),?\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*$/i.exec(c.textContent || '');
            if (m) {
                a = d.createElement('span'); a.className = 'ng-clock-date';
                a.textContent = L === 'ru' ? m[1].replace(/(\d\s+)([А-ЯЁ])/, function (x, p, q) { return p + q.toLowerCase(); }) : m[1];
                b = d.createElement('span'); b.className = 'ng-clock-time'; b.textContent = m[2];
                while (c.firstChild) c.removeChild(c.firstChild);
                c.appendChild(a); c.appendChild(b);
            }
        }
        l = byId('label_last_refresh');
        if (l && /\(/.test(l.textContent || '')) { m = refreshed(l.textContent, L); if (m) set(l, m); }
    }

    // ---- scheduling: changed cards + chrome flags, one pass per frame
    var pend = [], all = false, wantSide = false, wantHead = false, queued = false, raf = w.requestAnimationFrame || function (f) { return w.setTimeout(f, 16); };
    function pass() {
        queued = false;
        var L = lang(), list = pend, i, sh;
        if (!on()) { for (i = 0; i < list.length; i++) list[i].ngQueued = false; pend = []; all = wantSide = wantHead = false; return; }
        pend = []; stats.passes++;
        for (i = 0; i < list.length; i++) list[i].ngQueued = false;
        if (all) { sh = byId('screens_holder'); list = sh ? sh.querySelectorAll('.stream_thumbnail_live_holder') : []; all = false; }
        for (i = 0; i < list.length; i++) if (list[i].parentNode) card(list[i], L);
        if (wantSide) { wantSide = false; side(); stats.chrome++; }
        if (wantHead) { wantHead = false; header(L); }
    }
    function queue() { if (!queued) { queued = true; raf(pass); } }
    function add(h) { if (!h.ngQueued) { h.ngQueued = true; pend.push(h); } }
    function onCards(recs) {
        var sh = byId('screens_holder'), i, j, r, h, a, l, k;
        for (i = 0; i < recs.length && !all; i++) {
            r = recs[i];
            h = holderOf(r.target, sh);
            if (h) { add(h); continue; }
            a = r.addedNodes;
            for (j = 0; a && j < a.length; j++) {
                if (a[j].nodeType !== 1) continue;
                if (has(a[j], 'stream_thumbnail_live_holder')) { add(a[j]); continue; }
                l = a[j].querySelectorAll('.stream_thumbnail_live_holder');
                for (k = 0; k < l.length; k++) add(l[k]);
            }
            if (pend.length > 400) all = true;
        }
        if (pend.length || all) queue();
    }
    function watch(id, fn, opt) {
        var e = byId(id);
        if (!e || !w.MutationObserver) return false;
        new w.MutationObserver(fn).observe(e, opt);
        return true;
    }
    var started = false;
    function start() {
        if (started) return;
        started = true;
        var txt = { childList: true, subtree: true, characterData: true };
        watch('screens_holder', function (r) { if (on()) onCards(r); }, txt);
        watch('side_panel_new_holder', function () { if (on()) { wantSide = true; queue(); } },
            { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        watch('topbar', function () { if (on()) { wantHead = true; queue(); } }, txt);
        watch('clock_holder', function () { if (on()) { wantHead = true; queue(); } }, txt);
        all = wantSide = wantHead = true;
        queue();
    }
    w.NgUi = {
        version: VERSION,
        run: function () { all = wantSide = wantHead = true; pass(); return stats; },
        state: function () { return { version: VERSION, on: on(), started: started, lang: lang(), passes: stats.passes, cards: stats.cards, chrome: stats.chrome }; }
    };
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start); else start();
})(window);
