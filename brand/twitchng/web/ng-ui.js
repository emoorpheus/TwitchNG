/*
 * ng-ui.js - Twitch NG "Next-Gen UI" (concept, stage 1). Sets html.ng-ui + .ng-icons areas, and rewrites a few upstream texts the
 * new layout needs: card meta (viewers badge, "game · 7 h 32 min", language chip), clock (date + time), hints, side-menu copy.
 * Concept = DOM post-processing (MutationObserver); the shipped version moves the text parts into main.js patches.
 */
(function () {
    'use strict';
    var d = document, html = d.documentElement;
    html.classList.add('ng-ui');
    var RU = /^ru/i.test(html.lang || '') || /^ru/i.test((function () { try { return localStorage.getItem('app_lang_string') || ''; } catch (e) { return ''; } })());

    function plural(n, f) { var a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; }
    function compact(n) {
        if (RU) {
            if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',').replace(/,0$/, '') + '\u00a0млн';
            if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace('.', ',').replace(/,0$/, '') + '\u00a0тыс.';
            return n >= 1000 ? String(n).replace(/(\d)(?=(\d{3})+$)/, '$1\u00a0') : String(n);
        }
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
        return String(n);
    }
    function uptime(t) {   // "07:32:17" / "42:06" (upstream since-timer) -> "7 ч 32 мин" / "42 мин"
        var p = (t.match(/\d+(:\d+)+/) || [''])[0].split(':').map(Number); if (!p[0] && p.length < 2) return null;
        var h = p.length > 2 ? p[0] : 0, m = p.length > 2 ? p[1] : p[0];
        if (RU) return (h ? h + '\u00a0ч ' : '') + m + '\u00a0мин';
        return (h ? h + 'h ' : '') + m + 'm';
    }
    function set(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }

    function card(holder) {
        var img = holder.querySelector('.stream_thumbnail_live_img'), views = holder.querySelector('[id*="_views_"]');
        var since = holder.querySelector('[id*="_since_"]'), game = holder.querySelector('[id*="_game_"]');
        var row = holder.querySelector('.stream_text_holder > div:first-child'), lang = row && row.querySelector('.stream_info_live');
        if (views && img) {
            var n = parseInt((views.textContent || '').replace(/[^\d]/g, ''), 10), b = img.querySelector('.ng-badge');
            if (!isNaN(n)) {
                if (!b) { b = d.createElement('span'); b.className = 'ng-badge'; img.appendChild(b); }
                set(b, compact(n));
                b.setAttribute('aria-label', RU ? n + ' ' + plural(n, ['зритель', 'зрителя', 'зрителей']) : n + ' viewers');
            }
        }
        if (since && /\d:\d/.test(since.textContent)) { var u = uptime(since.textContent); if (u) set(since, u); }
        if (game) set(game, (game.textContent || '').replace(/^\s*(Стрим по|Playing)\s+/i, ''));
        if (lang) set(lang, (lang.textContent || '').replace(/[\[\]]/g, '').trim());
    }
    function cards(root) { var l = (root || d).querySelectorAll('.stream_thumbnail_live_holder'); for (var i = 0; i < l.length; i++) card(l[i]); }

    var RU_COPY = { 'Акт. каналы': 'Каналы в эфире', 'Описание': 'О приложении', 'На главной странице': 'Рекомендуемые' };
    var BOTTOM = ['ng-ico-settings', 'ng-ico-about', 'ng-ico-controls', 'ng-ico-exit', 'ng-ico-news'];
    function chrome() {
        ['side_panel_new_holder', 'topbar', 'controls_div'].forEach(function (id) { var e = d.getElementById(id); if (e) e.classList.add('ng-icons'); });
        for (var i = 10; i <= 14; i++) { var e = d.getElementById('side_panel_movel_new_' + i); if (e) e.classList.add(BOTTOM[i - 10]); }
        for (var j = 0; j < 10; j++) {   // open menu: the row focus / current section also styles the rail icon of that row
            var fx = d.getElementById('side_panel_new_' + j), mv = d.getElementById('side_panel_movel_new_' + j);
            if (!fx || !mv) continue;
            var on = mv.classList.contains('side_panel_new_icons_text') || mv.classList.contains('side_panel_new_icons_text_botton');
            if (fx.classList.contains('ng-row-focus') !== on) fx.classList.toggle('ng-row-focus', on);
            var act = fx.classList.contains('side_panel_new_icons_start');
            if (mv.classList.contains('ng-row-active') !== act) mv.classList.toggle('ng-row-active', act);
        }
        if (RU) {
            ['side_panel_movel_top_text', 'side_panel_movel_new_4', 'side_panel_movel_new_11', 'top_lable'].forEach(function (id) {
                var e = d.getElementById(id); if (e && RU_COPY[e.textContent.trim()]) set(e, RU_COPY[e.textContent.trim()]); });
        }
        var c = d.getElementById('label_clock');   // "Чт, 5 Ноя, 12:48" -> date (quiet) + time (bold)
        if (c && !c.querySelector('.ng-clock-time')) {
            var m = /^(.*?),?\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*$/i.exec(c.textContent || '');
            if (m) c.innerHTML = '<span class="ng-clock-date">' + (RU ? m[1].replace(/(\d\s+)([А-ЯЁ])/, function (x, a, b) { return a + b.toLowerCase(); }) : m[1]).replace(/</g, '') +
                '</span><span class="ng-clock-time">' + m[2] + '</span>';
        }
        var r = d.getElementById('label_refresh_icontext'), l = d.getElementById('label_last_refresh'), t = d.getElementById('label_thumb_icontext');
        if (RU) {
            set(r, 'Удерживайте ОК — обновить');
            if (l) { var mm = /(\d+)\s*m/.exec(l.textContent || ''); if (mm) set(l, +mm[1] ? 'обновлено ' + mm[1] + '\u00a0мин назад' : 'обновлено только что'); }
            set(t, 'Удерживайте ◀ — опции карточки');
        }
    }

    var busy = false;
    function run() { if (busy) return; busy = true; try { chrome(); cards(d.getElementById('screens_holder')); } finally { busy = false; } }
    var queued = false;
    function queue() { if (queued) return; queued = true; (window.requestAnimationFrame || setTimeout)(function () { queued = false; run(); }); }
    function start() {
        run();
        new MutationObserver(function () { if (!busy) queue(); }).observe(d.body, { childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['class'] });
    }
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start); else start();
})();
