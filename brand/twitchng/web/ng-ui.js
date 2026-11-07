/*
 * ng-ui.js 1.0.0 - Twitch NG "Next-Gen UI" text layer, ES5 (stages 1-3; DESIGN.md).
 * Loaded by release/index.html right after twitchng.js (build/build-app.mjs --brand twitchng). twitchng.js switches the UI on / off
 * (html.ng-ui + ng-ui.css / ng-icons.css; localStorage.TWITCHNG_UI = '0' or TwitchNG.ui(false) = the OLED preset look); with the
 * class off this file changes nothing. It reshapes a few texts main.js renders, as DOM post-processing, textContent only:
 *   - live cards (class ng-live on the holder): viewers badge on the picture ("20,7 тыс." / "20.7K"), "game · 7 ч 32 мин"
 *     (the "Playing" prefix and the seconds go), language chip without brackets
 *   - video / clip cards (ng-vod): duration + views badges on the picture, "game · 31 окт" (the "Started" / "Playing" prefixes,
 *     this year and the views line go), language chip; card lines get classes (ng-up uptime, ng-when date, ng-seen = the history
 *     "watched on ..." line) so the CSS does not depend on the line count
 *   - category cards: viewers badge on the poster, "8 257 каналов" / "8.3K channels" below the name (was two lines)
 *   - header: clock = date (quiet) + time (bold), "updated 5 min ago" instead of "(Last refreshed: 5m)"; Russian: search titles
 *     "Поиск: каналы «minecraft»", About "Приложение работает: 1 ч 5 мин"
 *   - side menu: the rail icon mirrors the focused / current row, the bottom entries get icons (ng-ico-*)
 * Observers: #screens_holder (cards), #side_panel_new_holder, #topbar, #clock_holder, #dialog_about_text - not the player / chat; one pass per
 * animation frame over the changed cards only. window.NgUi = { version, state(), run() } for tests and the console.
 * GPL-3.0. Not affiliated with Twitch Interactive.
 */
(function (w) {
    'use strict';
    var d = w.document, html = d && d.documentElement;
    if (!html || w.NgUi) return;
    var VERSION = '1.0.0', stats = { passes: 0, cards: 0, chrome: 0 };

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
    // 21 138 -> "21,1 тыс." / "21.1K"; 20 012 -> "20 тыс." / "20K"; 8 324 -> "8 324" / "8.3K"
    function compact(n, L) {
        var ru = L === 'ru', big = n >= 1e6, k = big ? 1e6 : 1e3, s;
        if (n < (ru ? 1e4 : 1e3)) return ru && n >= 1000 ? String(n).replace(/(\d)(?=(\d{3})+$)/, '$1' + NB) : String(n);
        s = (n / k).toFixed(n >= k * 100 ? 0 : 1).replace(/\.0$/, '');
        if (s === '1000' && !big) { s = '1'; big = true; }
        return ru ? s.replace('.', ',') + NB + (big ? 'млн' : 'тыс.') : s + (big ? 'M' : 'K');
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
    var GAME_PREFIX = /^\s*(?:Стрим по|Playing|Jugando|Joue à|Jogando|Oynuyor|Грає в)\s+/,
        STARTED = /^\s*(?:Started|Commencé|Iniciou|Comenzó|Запустил|Başladı|Розпочато)\s+/,
        // main.js dates: "31 Окт, 2026" (day first) / "Oct 31, 2026"
        DATE_RE = /(\d{1,2})\s+([^\s\d,.]+)\.?,?\s+(\d{4})|([^\s\d,.]+)\.?\s+(\d{1,2}),?\s+(\d{4})/;
    function digits(t) { var n = parseInt(String(t || '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; }
    function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }
    // "31 Окт, 2026" -> "31 окт" (this year) / "31 окт 2025"; "Oct 31, 2026" -> "Oct 31" / "Oct 31, 2025"
    function shortDate(m, L) {
        var y = m[3] || m[6], cur = String(new Date().getFullYear()) === y;
        if (m[1]) return m[1] + NB + (L === 'ru' ? m[2].toLowerCase() : m[2]) + (cur ? '' : ' ' + y);
        return m[4] + NB + m[5] + (cur ? '' : ', ' + y);
    }
    // "09:59:49" -> "9:59:49", "00:34" -> "0:34"
    function dur(t) { return /^\s*\d+(?::\d{2})+\s*$/.test(t || '') ? t.replace(/^\s*0(\d)/, '$1').replace(/^\s+|\s+$/g, '') : null; }
    function badge(img, cls, txt) {
        var b = img.querySelector('.' + cls);
        if (txt === null) { if (b) img.removeChild(b); return; }
        if (!b) { b = d.createElement('span'); b.className = cls === 'ng-dur' ? cls : cls === 'ng-views' ? 'ng-badge ng-ico-eye ' + cls : 'ng-badge ' + cls; img.appendChild(b); }
        set(b, txt);
    }

    // ---- live cards
    function card(holder, L) {
        var name = holder.querySelector('.stream_info_live_name'), icon = name && name.querySelector('.live_icon'), vod = !icon && holder.querySelector('[id*="_time_"]');
        setClass(holder, 'ng-live', !!icon);
        setClass(holder, 'ng-vod', !!vod);
        if (vod) return video(holder, vod, L);
        if (!icon) return;
        stats.cards++;
        var img = holder.querySelector('.stream_thumbnail_live_img'), views = holder.querySelector('[id*="_views_"]'),
            since = holder.querySelector('[id*="_since_"]'), game = holder.querySelector('[id*="_game_"]'),
            row = holder.querySelector('.stream_text_holder > div'), chip = row && row.querySelector('.stream_info_live'), b, n, u, up, seen;
        if (views && img) {
            n = parseInt((views.textContent || '').replace(/[^\d]/g, ''), 10);
            b = img.querySelector('.ng-badge');
            if (!isNaN(n)) {
                if (!b) { b = d.createElement('span'); b.className = 'ng-badge'; img.appendChild(b); }
                set(b, compact(n, L));
            }
        }
        up = since && since.parentNode; seen = up && up.nextElementSibling;   // "game · uptime" line; history: "watched on ..." line
        if (up && has(up, 'stream_info_live')) setClass(up, 'ng-up', true);
        if (seen && has(seen, 'stream_info_live')) setClass(seen, 'ng-seen', true);
        if (since && /\d:\d/.test(since.textContent)) { u = uptime(since.textContent, L); if (u) set(since, u); }
        if (game) set(game, (game.textContent || '').replace(GAME_PREFIX, ''));
        if (chip) set(chip, (chip.textContent || '').replace(/[\[\]]/g, '').replace(/^\s+|\s+$/g, ''));
    }
    function video(holder, time, L) {
        stats.cards++;
        // text holder children: name + language row, title, game, date line (a plain div), history only: "watched on ..." line
        var img = holder.querySelector('.stream_thumbnail_live_img'), th = holder.querySelector('.stream_text_holder'),
            kids = th ? th.children : [], when = kids[3] && (!kids[3].className || has(kids[3], 'ng-when')) ? kids[3] : null,
            date = when && when.querySelector('.stream_info_live'), seen = kids[4] && has(kids[4], 'stream_info_live') ? kids[4] : null,
            game = kids[2] && has(kids[2], 'stream_info_live') ? kids[2] : null, lng = time.parentNode && time.parentNode.lastElementChild, m, t;
        setClass(when, 'ng-when', !!date);
        setClass(seen, 'ng-seen', true);
        if (img) badge(img, 'ng-dur', dur(time.textContent));
        if (lng && lng !== time) {
            setClass(lng, 'ng-chip', true);
            if (/[\[\]]/.test(lng.textContent)) set(lng, lng.textContent.replace(/[\[\]\s]/g, ''));
        }
        if (game) set(game, (game.textContent || '').replace(STARTED, '').replace(GAME_PREFIX, ''));
        if (date && (m = DATE_RE.exec(date.textContent || ''))) {   // the original line only: once rewritten it has no year
            t = date.textContent.slice(m.index + m[0].length);
            if (img) badge(img, 'ng-views', digits(t) === null ? null : compact(digits(t), L));
            set(date, shortDate(m, L));
        }
    }

    // ---- category cards: "8,257 Каналы<br>для 421,726 Зрители" -> viewers badge on the poster ("421,7 тыс.", as the live cards) +
    //      "8 257 каналов" / "8.3K channels" (other languages: the channels part as main.js wrote it)
    function game(holder, L) {
        var meta = holder.querySelector('.stream_info_game_name + .stream_info_live'), img = holder.querySelector('.stream_thumbnail_live_game'),
            a = '', b = '', br = false, i, n, ch, vw;
        if (!meta || !meta.querySelector('br')) return;   // rewritten already
        stats.cards++;
        for (i = 0; i < meta.childNodes.length; i++) {
            n = meta.childNodes[i];
            if (n.nodeName === 'BR') br = true; else if (br) b += n.textContent; else a += n.textContent;
        }
        ch = digits(a); vw = digits(b);
        if (img && vw !== null) badge(img, 'ng-viewers', compact(vw, L));
        if (L === 'ru' && ch !== null) set(meta, compact(ch, L) + ' ' + (ch >= 1e4 ? 'каналов' : plural(ch, 'канал', 'канала', 'каналов')));
        else if (L === 'en' && ch !== null) set(meta, compact(ch, L) + (ch === 1 ? ' channel' : ' channels'));
        else set(meta, a.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''));
    }
    var CARD = ['stream_thumbnail_live_holder', 'stream_thumbnail_game_holder'], CARDS = '.' + CARD.join(', .');
    function holderOf(n, stop) {
        for (; n && n !== stop; n = n.parentNode) if (has(n, CARD[0]) || has(n, CARD[1])) return n;
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
        if (L !== 'ru') return;
        // search titles "Поиск Каналы 'minecraft'" -> "Поиск: каналы «minecraft»" (main.js joins two nouns with a space)
        l = byId('top_lable'); a = l && l.firstChild; b = a && a.nextSibling;
        if (a && a.nodeType === 3 && /^Поиск[\s\u00a0]+[А-ЯЁ]/.test(a.nodeValue)) a.nodeValue = a.nodeValue.replace(/^Поиск[\s\u00a0]+(.)/, function (x, q) { return 'Поиск: ' + q.toLowerCase(); });
        if (a && /^Поиск:/.test(a.nodeValue || '') && b && b.nodeType === 1 && /^'.*'$/.test(b.textContent)) set(b, '\u00ab' + b.textContent.slice(1, -1) + '\u00bb');
        // About: "Приложение работает: 1h 5m" -> "... 1 ч 5 мин"
        l = byId('about_runningtime');
        if (l && /\d+m\s*$/.test(l.textContent || '')) {
            m = /(?:(\d+)d\s*)?(?:(\d+)h\s*)?(\d+)m\s*$/.exec(l.textContent);
            set(l, l.textContent.slice(0, m.index) + hm((parseInt(m[1], 10) || 0) * 24 + (parseInt(m[2], 10) || 0), parseInt(m[3], 10) || 0, L));
        }
    }

    // ---- scheduling: changed cards + chrome flags, one pass per frame
    var pend = [], all = false, wantSide = false, wantHead = false, queued = false, raf = w.requestAnimationFrame || function (f) { return w.setTimeout(f, 16); };
    function pass() {
        queued = false;
        var L = lang(), list = pend, i, sh;
        if (!on()) { for (i = 0; i < list.length; i++) list[i].ngQueued = false; pend = []; all = wantSide = wantHead = false; return; }
        pend = []; stats.passes++;
        for (i = 0; i < list.length; i++) list[i].ngQueued = false;
        if (all) { sh = byId('screens_holder'); list = sh ? sh.querySelectorAll(CARDS) : []; all = false; }
        for (i = 0; i < list.length; i++) if (list[i].parentNode) (has(list[i], CARD[1]) ? game : card)(list[i], L);
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
                if (has(a[j], CARD[0]) || has(a[j], CARD[1])) { add(a[j]); continue; }
                l = a[j].querySelectorAll(CARDS);
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
        watch('dialog_about_text', function () { if (on()) { wantHead = true; queue(); } }, txt);
        // UI switched back on at run time (TwitchNG.ui / oled): main.js redrew texts meanwhile, unseen while off -> one full pass
        var was = on();
        if (w.MutationObserver) new w.MutationObserver(function () { var o = on(); if (o && !was) { all = wantSide = wantHead = true; queue(); } was = o; })
            .observe(html, { attributes: true, attributeFilter: ['class'] });
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
