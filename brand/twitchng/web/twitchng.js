/*
 * twitchng.js 1.0.0 pre-release 06 - Twitch NG app layer, ES5. NG = Next-Gen.
 * Version line: the app stays 1.0.0 until the release; pre-releases are numbered (PRE_N: 01, 02, ...) and shown as
 *   "1.0.0 · pre-release 02" (appinfo.json version stays 1.0.0).
 * pre-release 02: About shows the webOS version + firmware from the system (luna systemproperty getSystemInfo; on webOS 25
 *   PalmSystem.deviceInfo.platformVersion is the firmware number, TV report: "webOS 33.30.97"); honest clip wording
 *   (clips are MP4: speed only where the TV itself applies it); What's new for pre-release 02.
 * pre-release 03: speed engine 1.3.6 (TV run 2026-11-05: fast speed burst after a restore, false "gain" toast); What's new.
 * pre-release 04: speed engine 1.3.7 (TV run 2026-11-05, T7: a quality change at 2x restarted the VOD from 00:00); What's new.
 * pre-release 05: "Twitch Next-Gen" launch screen + matching first-run intro (HEROS); speed engine 1.3.8 (memory: the v2b
 *   segment cache and the MediaSource objects no longer outlive the player); package ~1 MB instead of 6 MB; What's new.
 * pre-release 06: Next-Gen UI stage 1 on by default (DESIGN.md: ng-ui.css / ng-icons.css / ng-ui.js, font Onest as "NG Sans",
 *   Lucide icons in the sharp style, live grid, side menu, header); switched here (html.ng-ui + the two stylesheets);
 *   aboutLabel (side menu "About" = "О приложении" in Russian); Russian copy fixes in main.js (build patches); What's new.
 * Loaded by release/index.html right after sttv-speed.js (build/build-app.mjs --brand twitchng), before main.js (defer).
 * Script tag attributes (set by the build): data-name (app name), data-variant (icon set L3 | L4 | A | B | C, default L3), data-source (source URL).
 *   - OLED preset (githubio/css/twitchng.css): on by default; off = html.ng-classic
 *       localStorage.TWITCHNG_OLED = '0'  (or TwitchNG.oled(false) in the console; true / null = back to the default)
 *   - Next-Gen UI (githubio/css/ng-ui.css + ng-icons.css, js/ng-ui.js): on by default on top of the OLED preset = html.ng-ui
 *       and both stylesheets enabled (their @font-face remaps the app's Roboto to NG Sans, so off = the links disabled);
 *       off: localStorage.TWITCHNG_UI = '0' (or TwitchNG.ui(false)); the classic look (OLED off) also turns it off
 *   - first-run welcome dialog (#welcome_dialog_text, filled by the app) -> minimal intro; OK / Back close it as before
 *   - About, "What's new", sign-in help: HTML built here (main.js calls TwitchNG.aboutHtml / newsHtml / newsLabel /
 *     authHelp, patched in by the build); the app language (localStorage app_lang_string) picks Russian or English
 *   - window.TwitchNG = { name, version, preRelease, variant, oled(on?), ui(on?), state(), aboutHtml(), newsHtml(), aboutLabel(), ... }
 * GPL-3.0. Not affiliated with Twitch Interactive.
 */
(function (w) {
    'use strict';
    var VERSION = '1.0.0', PRE = true, PRE_N = '06', YEAR = '2026', doc = w.document, root = doc && doc.documentElement;
    if (!root || w.TwitchNG) return;
    function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { if (v === null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } catch (e) {} }
    function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
    function setClass(el, c, on) {
        if (!el || hasClass(el, c) === !!on) return;
        el.className = on ? (el.className ? el.className + ' ' : '') + c : (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var me = doc.currentScript || (function () {
        var s = doc.getElementsByTagName('script'), i;
        for (i = s.length - 1; i >= 0; i--) if (/twitchng\.js/.test(s[i].src || '')) return s[i];
        return null;
    })();
    function attr(k, d) { var v = me && me.getAttribute ? me.getAttribute(k) : null; return v ? v : d; }
    var NAME = attr('data-name', 'Twitch NG'), VARIANT = /^(L3|L4|A|B|C)$/.test(attr('data-variant', 'L3')) ? attr('data-variant', 'L3') : 'L3';
    var SOURCE = /^https:\/\/[^\s"'<>]+$/.test(attr('data-source', '')) ? attr('data-source', '') : '';
    function oledOn() { return lsGet('TWITCHNG_OLED') !== '0'; }
    function uiOn() { return oledOn() && lsGet('TWITCHNG_UI') !== '0'; }
    // the stylesheets are in the head (parsed before this script runs, so they are loaded): disabled = their rules and
    // @font-face are gone, the app's own Roboto is back
    function uiCss() {
        var l = doc.getElementsByTagName('link'), r = [], i;
        for (i = 0; i < l.length; i++) if (/\/ng-(?:ui|icons)\.css(?:\?|$)/.test(l[i].getAttribute('href') || '')) r.push(l[i]);
        return r;
    }
    function applyUi() {
        var on = uiOn(), l = uiCss(), i;
        for (i = 0; i < l.length; i++) l[i].disabled = !on;
        setClass(root, 'ng-ui', on);
        return on;
    }
    setClass(root, 'ng', true);
    setClass(root, 'ng-classic', !oledOn());
    setClass(root, 'ng-v' + VARIANT, true);
    applyUi();

    // <ng-logo>
    var LOGOS = {
        L3: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-476.0 -70.0 952.1 158.0" class="ng-logo" aria-label="Twitch NG"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-493.73 -107.53) scale(0.9036)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM91 94L113 94L113 144L91 144ZM143 94L165 94L165 144L143 144Z"/><path fill="#FFFFFF" d="M-202.7 50H-178.3V-31.3H-150.7V-51.6H-230.1V-31.3H-202.7ZM-127.4 50H-99.7L-93.4 20.4C-92.1 13.2 -91 6.1 -89.8 -2.4H-89.1C-87.7 6.1 -86.5 13.2 -85 20.4L-78.4 50H-50.1L-31.8 -27.6H-54.3L-61 7C-62.3 14.8 -63.2 22.4 -64.4 30.4H-65.1C-66.7 22.4 -68.1 14.8 -69.8 7L-78.2 -27.6H-99L-107.1 7C-109 14.7 -110.2 22.4 -111.6 30.4H-112.3C-113.5 22.4 -114.3 14.8 -115.5 7L-122.5 -27.6H-146.5ZM-18.1 50H6.2V-27.6H-18.1ZM-6 -38.4C2.1 -38.4 7.5 -43.3 7.5 -51C7.5 -58.5 2.1 -63.4 -6 -63.4C-14.2 -63.4 -19.5 -58.5 -19.5 -51C-19.5 -43.3 -14.2 -38.4 -6 -38.4ZM56.2 51.9C64.1 51.9 69.7 50.3 73.8 49L70 31.4C68.1 32.1 65.4 32.9 62.9 32.9C57.2 32.9 53.1 29.5 53.1 20.9V-8.7H71.4V-27.6H53.1V-48.2H33L30.3 -27.6L18.3 -26.7V-8.7H28.8V21.2C28.8 39.5 36.7 51.9 56.2 51.9ZM117.6 51.9C125.8 51.9 135.6 49.5 143.3 42.8L133.8 26.8C129.9 29.9 125.3 32.3 120.3 32.3C110.9 32.3 103.8 24.1 103.8 11.1C103.8 -1.7 110.5 -9.9 121.3 -9.9C124.6 -9.9 127.6 -8.7 131.1 -5.8L142.4 -21.2C136.6 -26.3 129.2 -29.5 119.8 -29.5C98.1 -29.5 79 -14.5 79 11.1C79 36.9 95.8 51.9 117.6 51.9ZM156.6 50H180.9V-1.8C185.6 -6.3 188.8 -8.8 194.3 -8.8C200.4 -8.8 203.3 -5.8 203.3 5V50H227.6V2C227.6 -17.4 220.3 -29.5 203.4 -29.5C192.9 -29.5 185.3 -24.2 179.7 -19L180.9 -32.8V-59H156.6Z"/><path fill="#9146FF" d="M279.5 50H302.7V16.3C302.7 4 300.7 -9.9 299.6 -21.2H300.3L310.2 1L335.3 50H360.2V-51.6H337V-17.9C337 -5.8 339 8.8 340.3 19.6H339.6L329.6 -2.9L304.4 -51.6H279.5ZM429.5 51.9C443.7 51.9 456.2 46.3 463.3 39.5V-8H425.5V11.9H441.6V28.3C439.4 29.9 435.6 30.9 432.1 30.9C413.1 30.9 404.1 19.2 404.1 -1C404.1 -20.8 414.9 -32.5 429.9 -32.5C438.3 -32.5 443.7 -29.1 448.7 -24.6L461.5 -40.2C454.6 -47.1 443.9 -53.4 429.1 -53.4C401.9 -53.4 379.1 -34 379.1 -0.2C379.1 34.2 401.4 51.9 429.5 51.9Z"/></svg>',
        L4: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-476.0 -70.0 952.1 158.0" class="ng-logo" aria-label="Twitch NG"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-493.73 -107.53) scale(0.9036)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM112.1 88L165.8 119L112.1 150Z"/><path fill="#FFFFFF" d="M-202.7 50H-178.3V-31.3H-150.7V-51.6H-230.1V-31.3H-202.7ZM-127.4 50H-99.7L-93.4 20.4C-92.1 13.2 -91 6.1 -89.8 -2.4H-89.1C-87.7 6.1 -86.5 13.2 -85 20.4L-78.4 50H-50.1L-31.8 -27.6H-54.3L-61 7C-62.3 14.8 -63.2 22.4 -64.4 30.4H-65.1C-66.7 22.4 -68.1 14.8 -69.8 7L-78.2 -27.6H-99L-107.1 7C-109 14.7 -110.2 22.4 -111.6 30.4H-112.3C-113.5 22.4 -114.3 14.8 -115.5 7L-122.5 -27.6H-146.5ZM-18.1 50H6.2V-27.6H-18.1ZM-6 -38.4C2.1 -38.4 7.5 -43.3 7.5 -51C7.5 -58.5 2.1 -63.4 -6 -63.4C-14.2 -63.4 -19.5 -58.5 -19.5 -51C-19.5 -43.3 -14.2 -38.4 -6 -38.4ZM56.2 51.9C64.1 51.9 69.7 50.3 73.8 49L70 31.4C68.1 32.1 65.4 32.9 62.9 32.9C57.2 32.9 53.1 29.5 53.1 20.9V-8.7H71.4V-27.6H53.1V-48.2H33L30.3 -27.6L18.3 -26.7V-8.7H28.8V21.2C28.8 39.5 36.7 51.9 56.2 51.9ZM117.6 51.9C125.8 51.9 135.6 49.5 143.3 42.8L133.8 26.8C129.9 29.9 125.3 32.3 120.3 32.3C110.9 32.3 103.8 24.1 103.8 11.1C103.8 -1.7 110.5 -9.9 121.3 -9.9C124.6 -9.9 127.6 -8.7 131.1 -5.8L142.4 -21.2C136.6 -26.3 129.2 -29.5 119.8 -29.5C98.1 -29.5 79 -14.5 79 11.1C79 36.9 95.8 51.9 117.6 51.9ZM156.6 50H180.9V-1.8C185.6 -6.3 188.8 -8.8 194.3 -8.8C200.4 -8.8 203.3 -5.8 203.3 5V50H227.6V2C227.6 -17.4 220.3 -29.5 203.4 -29.5C192.9 -29.5 185.3 -24.2 179.7 -19L180.9 -32.8V-59H156.6Z"/><path fill="#9146FF" d="M279.5 50H302.7V16.3C302.7 4 300.7 -9.9 299.6 -21.2H300.3L310.2 1L335.3 50H360.2V-51.6H337V-17.9C337 -5.8 339 8.8 340.3 19.6H339.6L329.6 -2.9L304.4 -51.6H279.5ZM429.5 51.9C443.7 51.9 456.2 46.3 463.3 39.5V-8H425.5V11.9H441.6V28.3C439.4 29.9 435.6 30.9 432.1 30.9C413.1 30.9 404.1 19.2 404.1 -1C404.1 -20.8 414.9 -32.5 429.9 -32.5C438.3 -32.5 443.7 -29.1 448.7 -24.6L461.5 -40.2C454.6 -47.1 443.9 -53.4 429.1 -53.4C401.9 -53.4 379.1 -34 379.1 -0.2C379.1 34.2 401.4 51.9 429.5 51.9Z"/></svg>',
        A: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-447.5 -85.0 895.0 170.0" class="ng-logo" aria-label="Twitch NG"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-455.07 -81.00) scale(6.7500)" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/><path fill="#FFFFFF" d="M-231.3 50H-206.8V-31.3H-179.3V-51.6H-258.7V-31.3H-231.3ZM-156 50H-128.3L-122 20.4C-120.6 13.2 -119.5 6.1 -118.3 -2.4H-117.6C-116.3 6.1 -115 13.2 -113.5 20.4L-107 50H-78.6L-60.3 -27.6H-82.8L-89.5 7C-90.9 14.8 -91.7 22.4 -92.9 30.4H-93.6C-95.2 22.4 -96.6 14.8 -98.4 7L-106.7 -27.6H-127.6L-135.6 7C-137.5 14.7 -138.8 22.4 -140.1 30.4H-140.8C-142 22.4 -142.9 14.8 -144.1 7L-151 -27.6H-175.1ZM-46.7 50H-22.4V-27.6H-46.7ZM-34.5 -38.4C-26.5 -38.4 -21 -43.3 -21 -51C-21 -58.5 -26.5 -63.4 -34.5 -63.4C-42.7 -63.4 -48 -58.5 -48 -51C-48 -43.3 -42.7 -38.4 -34.5 -38.4ZM27.7 51.9C35.6 51.9 41.2 50.3 45.3 49L41.5 31.4C39.5 32.1 36.8 32.9 34.4 32.9C28.6 32.9 24.5 29.5 24.5 20.9V-8.7H42.8V-27.6H24.5V-48.2H4.5L1.8 -27.6L-10.3 -26.7V-8.7H0.3V21.2C0.3 39.5 8.2 51.9 27.7 51.9ZM89.1 51.9C97.3 51.9 107.1 49.5 114.7 42.8L105.3 26.8C101.3 29.9 96.7 32.3 91.8 32.3C82.4 32.3 75.3 24.1 75.3 11.1C75.3 -1.7 82 -9.9 92.7 -9.9C96 -9.9 99 -8.7 102.6 -5.8L113.9 -21.2C108 -26.3 100.7 -29.5 91.2 -29.5C69.6 -29.5 50.5 -14.5 50.5 11.1C50.5 36.9 67.2 51.9 89.1 51.9ZM128.1 50H152.4V-1.8C157 -6.3 160.3 -8.8 165.7 -8.8C171.9 -8.8 174.7 -5.8 174.7 5V50H199V2C199 -17.4 191.8 -29.5 174.9 -29.5C164.4 -29.5 156.7 -24.2 151.1 -19L152.4 -32.8V-59H128.1Z"/><path fill="#9146FF" d="M251 50H274.2V16.3C274.2 4 272.1 -9.9 271.1 -21.2H271.7L281.7 1L306.8 50H331.6V-51.6H308.4V-17.9C308.4 -5.8 310.5 8.8 311.7 19.6H311L301.1 -2.9L275.8 -51.6H251ZM400.9 51.9C415.1 51.9 427.7 46.3 434.8 39.5V-8H397V11.9H413.1V28.3C410.9 29.9 407.1 30.9 403.5 30.9C384.6 30.9 375.6 19.2 375.6 -1C375.6 -20.8 386.3 -32.5 401.3 -32.5C409.8 -32.5 415.1 -29.1 420.2 -24.6L433 -40.2C426 -47.1 415.4 -53.4 400.5 -53.4C373.4 -53.4 350.6 -34 350.6 -0.2C350.6 34.2 372.8 51.9 400.9 51.9Z"/></svg>'
    };
    var MARKS = {
        L3: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-11.54 -12.02) scale(0.4808)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM91 94L113 94L113 144L91 144ZM143 94L165 94L165 144L143 144Z"/></svg>',
        L4: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-11.54 -12.02) scale(0.4808)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM112.1 88L165.8 119L112.1 150Z"/></svg>',
        A: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark"><path fill="#9146FF" fill-rule="evenodd" transform="translate(-0.00 0.00) scale(4.1667)" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>',
        B: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark"><defs><linearGradient id="ngmB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00C9B7"/><stop offset="1" stop-color="#3B5BFF"/></linearGradient></defs><path fill="url(#ngmB)" d="M5.4 25.7Q5.4 18 12.1 21.9L53.8 46.1Q60.5 50 53.8 53.9L12.1 78.1Q5.4 82 5.4 74.3Z"/><path fill="#FFFFFF" d="M39.5 25.7Q39.5 18 46.2 21.9L87.9 46.1Q94.6 50 87.9 53.9L46.2 78.1Q39.5 82 39.5 74.3Z"/></svg>',
        C: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="ng-mark"><defs><linearGradient id="ngmC" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00C9B7"/><stop offset="1" stop-color="#3B5BFF"/></linearGradient></defs><path fill="url(#ngmC)" d="M7.7 73H18.4V57.5C18.4 51.9 17.5 45.5 17 40.2H17.3L21.9 50.5L33.4 73H44.8V26.2H34.2V41.7C34.2 47.3 35.1 54 35.7 59H35.3L30.8 48.7L19.2 26.2H7.7ZM76.7 73.9C83.2 73.9 89 71.3 92.3 68.2V46.3H74.9V55.5H82.3V63C81.3 63.8 79.5 64.2 77.9 64.2C69.2 64.2 65 58.8 65 49.5C65 40.4 70 35 76.9 35C80.8 35 83.2 36.6 85.6 38.7L91.5 31.5C88.2 28.3 83.4 25.4 76.5 25.4C64 25.4 53.5 34.3 53.5 49.9C53.5 65.7 63.8 73.9 76.7 73.9Z"/></svg>'
    };
    var HEROS = {
        L3: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-522.4 -190.0 1044.9 380.0" class="ng-hero" aria-label="Twitch Next-Gen"><path fill="#FFFFFF" fill-rule="evenodd" transform="translate(-161.93 -244.19) scale(1.2651)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM91 94L113 94L113 144L91 144ZM143 94L165 94L165 144L143 144Z"/><path fill="#FFFFFF" d="M-493.2 186H-470.7V111.2H-445.4V92.5H-518.4V111.2H-493.2ZM-423.9 186H-398.4L-392.7 158.8C-391.4 152.1 -390.4 145.6 -389.3 137.8H-388.6C-387.4 145.6 -386.3 152.1 -384.9 158.8L-378.9 186H-352.8L-335.9 114.6H-356.6L-362.8 146.5C-364 153.6 -364.8 160.6 -365.9 167.9H-366.6C-368.1 160.6 -369.3 153.6 -370.9 146.5L-378.6 114.6H-397.8L-405.2 146.5C-407 153.5 -408.1 160.6 -409.4 167.9H-410C-411.1 160.6 -411.9 153.6 -413 146.5L-419.4 114.6H-441.5ZM-323.4 186H-301V114.6H-323.4ZM-312.2 104.7C-304.8 104.7 -299.8 100.2 -299.8 93.1C-299.8 86.2 -304.8 81.7 -312.2 81.7C-319.7 81.7 -324.6 86.2 -324.6 93.1C-324.6 100.2 -319.7 104.7 -312.2 104.7ZM-255 187.8C-247.7 187.8 -242.6 186.3 -238.8 185.1L-242.3 168.9C-244.1 169.6 -246.6 170.3 -248.8 170.3C-254.1 170.3 -257.9 167.2 -257.9 159.3V132H-241V114.6H-257.9V95.6H-276.3L-278.8 114.6L-289.9 115.5V132H-280.2V159.5C-280.2 176.3 -272.9 187.8 -255 187.8ZM-198.5 187.8C-191 187.8 -181.9 185.5 -174.9 179.3L-183.6 164.7C-187.2 167.5 -191.5 169.7 -196 169.7C-204.6 169.7 -211.2 162.2 -211.2 150.2C-211.2 138.4 -205 130.9 -195.1 130.9C-192.1 130.9 -189.3 132 -186.1 134.7L-175.7 120.5C-181.1 115.8 -187.8 112.8 -196.5 112.8C-216.4 112.8 -234 126.6 -234 150.2C-234 174 -218.6 187.8 -198.5 187.8ZM-162.6 186H-140.3V138.3C-136 134.2 -133 131.9 -128 131.9C-122.3 131.9 -119.7 134.7 -119.7 144.6V186H-97.3V141.8C-97.3 124 -104 112.8 -119.5 112.8C-129.2 112.8 -136.2 117.7 -141.4 122.5L-140.3 109.8V85.7H-162.6Z"/><path fill="#BF94FF" d="M-49.5 186H-28.2V155C-28.2 143.7 -30.1 130.9 -31.1 120.5H-30.4L-21.3 140.9L1.8 186H24.7V92.5H3.3V123.5C3.3 134.7 5.2 148.1 6.3 158H5.7L-3.5 137.3L-26.7 92.5H-49.5ZM77 187.8C85.3 187.8 95.1 184.9 102.5 179.6L95.1 166.2C89.9 169.2 85.2 170.7 80 170.7C71 170.7 64.2 166.7 62.2 156.9H104.1C104.6 155.1 105.1 151.2 105.1 147.2C105.1 127.8 95.1 112.8 74.5 112.8C57.3 112.8 40.6 127.1 40.6 150.2C40.6 174 56.4 187.8 77 187.8ZM61.8 142.2C63.3 133.8 68.7 129.9 74.9 129.9C83 129.9 86.2 135.2 86.2 142.2ZM109.9 186H133.1L138 174.7C139.8 170.6 141.5 166.4 143.3 162.5H143.9C146.2 166.4 148.3 170.7 150.4 174.7L157 186H180.9L159.1 151.4L179.7 114.6H156.6L152.2 125.5C150.7 129.6 148.9 133.8 147.5 137.8H146.9C144.9 133.8 142.9 129.6 141 125.5L135.1 114.6H111.1L131.7 148.8ZM215.9 187.8C223.2 187.8 228.4 186.3 232.1 185.1L228.6 168.9C226.9 169.6 224.4 170.3 222.1 170.3C216.8 170.3 213.1 167.2 213.1 159.3V132H229.9V114.6H213.1V95.6H194.6L192.1 114.6L181.1 115.5V132H190.7V159.5C190.7 176.3 198 187.8 215.9 187.8ZM235.5 157.5H271V141.8H235.5ZM330.2 187.8C343.2 187.8 354.8 182.6 361.3 176.3V132.7H326.5V151H341.3V166C339.3 167.5 335.8 168.4 332.5 168.4C315.1 168.4 306.8 157.6 306.8 139.1C306.8 120.9 316.7 110.1 330.5 110.1C338.3 110.1 343.2 113.2 347.9 117.3L359.7 103C353.3 96.6 343.5 90.9 329.8 90.9C304.8 90.9 283.8 108.7 283.8 139.8C283.8 171.4 304.3 187.8 330.2 187.8ZM410.7 187.8C419 187.8 428.8 184.9 436.2 179.6L428.8 166.2C423.7 169.2 418.9 170.7 413.7 170.7C404.7 170.7 397.9 166.7 395.9 156.9H437.8C438.3 155.1 438.9 151.2 438.9 147.2C438.9 127.8 428.8 112.8 408.2 112.8C391 112.8 374.3 127.1 374.3 150.2C374.3 174 390.2 187.8 410.7 187.8ZM395.5 142.2C397.1 133.8 402.5 129.9 408.6 129.9C416.8 129.9 419.9 135.2 419.9 142.2ZM453.2 186H475.5V138.3C479.8 134.2 482.8 131.9 487.8 131.9C493.4 131.9 496.1 134.7 496.1 144.6V186H518.4V141.8C518.4 124 511.8 112.8 496.2 112.8C486.5 112.8 479.3 117.7 473.4 123.5H473L471.4 114.6H453.2Z"/></svg>',
        L4: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-522.4 -190.0 1044.9 380.0" class="ng-hero" aria-label="Twitch Next-Gen"><path fill="#FFFFFF" fill-rule="evenodd" transform="translate(-161.93 -244.19) scale(1.2651)" d="M46 46L232 46L232 150L190 192L186 192L206 212L180 212L160 192L96 192L76 212L50 212L70 192L24 192L24 68ZM55.94 70L208 70L208 140.06L180.06 168L48 168L48 77.94ZM112.1 88L165.8 119L112.1 150Z"/><path fill="#FFFFFF" d="M-493.2 186H-470.7V111.2H-445.4V92.5H-518.4V111.2H-493.2ZM-423.9 186H-398.4L-392.7 158.8C-391.4 152.1 -390.4 145.6 -389.3 137.8H-388.6C-387.4 145.6 -386.3 152.1 -384.9 158.8L-378.9 186H-352.8L-335.9 114.6H-356.6L-362.8 146.5C-364 153.6 -364.8 160.6 -365.9 167.9H-366.6C-368.1 160.6 -369.3 153.6 -370.9 146.5L-378.6 114.6H-397.8L-405.2 146.5C-407 153.5 -408.1 160.6 -409.4 167.9H-410C-411.1 160.6 -411.9 153.6 -413 146.5L-419.4 114.6H-441.5ZM-323.4 186H-301V114.6H-323.4ZM-312.2 104.7C-304.8 104.7 -299.8 100.2 -299.8 93.1C-299.8 86.2 -304.8 81.7 -312.2 81.7C-319.7 81.7 -324.6 86.2 -324.6 93.1C-324.6 100.2 -319.7 104.7 -312.2 104.7ZM-255 187.8C-247.7 187.8 -242.6 186.3 -238.8 185.1L-242.3 168.9C-244.1 169.6 -246.6 170.3 -248.8 170.3C-254.1 170.3 -257.9 167.2 -257.9 159.3V132H-241V114.6H-257.9V95.6H-276.3L-278.8 114.6L-289.9 115.5V132H-280.2V159.5C-280.2 176.3 -272.9 187.8 -255 187.8ZM-198.5 187.8C-191 187.8 -181.9 185.5 -174.9 179.3L-183.6 164.7C-187.2 167.5 -191.5 169.7 -196 169.7C-204.6 169.7 -211.2 162.2 -211.2 150.2C-211.2 138.4 -205 130.9 -195.1 130.9C-192.1 130.9 -189.3 132 -186.1 134.7L-175.7 120.5C-181.1 115.8 -187.8 112.8 -196.5 112.8C-216.4 112.8 -234 126.6 -234 150.2C-234 174 -218.6 187.8 -198.5 187.8ZM-162.6 186H-140.3V138.3C-136 134.2 -133 131.9 -128 131.9C-122.3 131.9 -119.7 134.7 -119.7 144.6V186H-97.3V141.8C-97.3 124 -104 112.8 -119.5 112.8C-129.2 112.8 -136.2 117.7 -141.4 122.5L-140.3 109.8V85.7H-162.6Z"/><path fill="#BF94FF" d="M-49.5 186H-28.2V155C-28.2 143.7 -30.1 130.9 -31.1 120.5H-30.4L-21.3 140.9L1.8 186H24.7V92.5H3.3V123.5C3.3 134.7 5.2 148.1 6.3 158H5.7L-3.5 137.3L-26.7 92.5H-49.5ZM77 187.8C85.3 187.8 95.1 184.9 102.5 179.6L95.1 166.2C89.9 169.2 85.2 170.7 80 170.7C71 170.7 64.2 166.7 62.2 156.9H104.1C104.6 155.1 105.1 151.2 105.1 147.2C105.1 127.8 95.1 112.8 74.5 112.8C57.3 112.8 40.6 127.1 40.6 150.2C40.6 174 56.4 187.8 77 187.8ZM61.8 142.2C63.3 133.8 68.7 129.9 74.9 129.9C83 129.9 86.2 135.2 86.2 142.2ZM109.9 186H133.1L138 174.7C139.8 170.6 141.5 166.4 143.3 162.5H143.9C146.2 166.4 148.3 170.7 150.4 174.7L157 186H180.9L159.1 151.4L179.7 114.6H156.6L152.2 125.5C150.7 129.6 148.9 133.8 147.5 137.8H146.9C144.9 133.8 142.9 129.6 141 125.5L135.1 114.6H111.1L131.7 148.8ZM215.9 187.8C223.2 187.8 228.4 186.3 232.1 185.1L228.6 168.9C226.9 169.6 224.4 170.3 222.1 170.3C216.8 170.3 213.1 167.2 213.1 159.3V132H229.9V114.6H213.1V95.6H194.6L192.1 114.6L181.1 115.5V132H190.7V159.5C190.7 176.3 198 187.8 215.9 187.8ZM235.5 157.5H271V141.8H235.5ZM330.2 187.8C343.2 187.8 354.8 182.6 361.3 176.3V132.7H326.5V151H341.3V166C339.3 167.5 335.8 168.4 332.5 168.4C315.1 168.4 306.8 157.6 306.8 139.1C306.8 120.9 316.7 110.1 330.5 110.1C338.3 110.1 343.2 113.2 347.9 117.3L359.7 103C353.3 96.6 343.5 90.9 329.8 90.9C304.8 90.9 283.8 108.7 283.8 139.8C283.8 171.4 304.3 187.8 330.2 187.8ZM410.7 187.8C419 187.8 428.8 184.9 436.2 179.6L428.8 166.2C423.7 169.2 418.9 170.7 413.7 170.7C404.7 170.7 397.9 166.7 395.9 156.9H437.8C438.3 155.1 438.9 151.2 438.9 147.2C438.9 127.8 428.8 112.8 408.2 112.8C391 112.8 374.3 127.1 374.3 150.2C374.3 174 390.2 187.8 410.7 187.8ZM395.5 142.2C397.1 133.8 402.5 129.9 408.6 129.9C416.8 129.9 419.9 135.2 419.9 142.2ZM453.2 186H475.5V138.3C479.8 134.2 482.8 131.9 487.8 131.9C493.4 131.9 496.1 134.7 496.1 144.6V186H518.4V141.8C518.4 124 511.8 112.8 496.2 112.8C486.5 112.8 479.3 117.7 473.4 123.5H473L471.4 114.6H453.2Z"/></svg>',
        A: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-522.4 -200.0 1044.9 400.0" class="ng-hero" aria-label="Twitch Next-Gen"><path fill="#FFFFFF" fill-rule="evenodd" transform="translate(-115.00 -196.00) scale(9.5833)" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/><path fill="#FFFFFF" d="M-493.2 196H-470.7V121.2H-445.4V102.5H-518.4V121.2H-493.2ZM-423.9 196H-398.4L-392.7 168.8C-391.4 162.1 -390.4 155.6 -389.3 147.8H-388.6C-387.4 155.6 -386.3 162.1 -384.9 168.8L-378.9 196H-352.8L-335.9 124.6H-356.6L-362.8 156.5C-364 163.6 -364.8 170.6 -365.9 177.9H-366.6C-368.1 170.6 -369.3 163.6 -370.9 156.5L-378.6 124.6H-397.8L-405.2 156.5C-407 163.5 -408.1 170.6 -409.4 177.9H-410C-411.1 170.6 -411.9 163.6 -413 156.5L-419.4 124.6H-441.5ZM-323.4 196H-301V124.6H-323.4ZM-312.2 114.7C-304.8 114.7 -299.8 110.2 -299.8 103.1C-299.8 96.2 -304.8 91.7 -312.2 91.7C-319.7 91.7 -324.6 96.2 -324.6 103.1C-324.6 110.2 -319.7 114.7 -312.2 114.7ZM-255 197.8C-247.7 197.8 -242.6 196.3 -238.8 195.1L-242.3 178.9C-244.1 179.6 -246.6 180.3 -248.8 180.3C-254.1 180.3 -257.9 177.2 -257.9 169.3V142H-241V124.6H-257.9V105.6H-276.3L-278.8 124.6L-289.9 125.5V142H-280.2V169.5C-280.2 186.3 -272.9 197.8 -255 197.8ZM-198.5 197.8C-191 197.8 -181.9 195.5 -174.9 189.3L-183.6 174.7C-187.2 177.5 -191.5 179.7 -196 179.7C-204.6 179.7 -211.2 172.2 -211.2 160.2C-211.2 148.4 -205 140.9 -195.1 140.9C-192.1 140.9 -189.3 142 -186.1 144.7L-175.7 130.5C-181.1 125.8 -187.8 122.8 -196.5 122.8C-216.4 122.8 -234 136.6 -234 160.2C-234 184 -218.6 197.8 -198.5 197.8ZM-162.6 196H-140.3V148.3C-136 144.2 -133 141.9 -128 141.9C-122.3 141.9 -119.7 144.7 -119.7 154.6V196H-97.3V151.8C-97.3 134 -104 122.8 -119.5 122.8C-129.2 122.8 -136.2 127.7 -141.4 132.5L-140.3 119.8V95.7H-162.6Z"/><path fill="#BF94FF" d="M-49.5 196H-28.2V165C-28.2 153.7 -30.1 140.9 -31.1 130.5H-30.4L-21.3 150.9L1.8 196H24.7V102.5H3.3V133.5C3.3 144.7 5.2 158.1 6.3 168H5.7L-3.5 147.3L-26.7 102.5H-49.5ZM77 197.8C85.3 197.8 95.1 194.9 102.5 189.6L95.1 176.2C89.9 179.2 85.2 180.7 80 180.7C71 180.7 64.2 176.7 62.2 166.9H104.1C104.6 165.1 105.1 161.2 105.1 157.2C105.1 137.8 95.1 122.8 74.5 122.8C57.3 122.8 40.6 137.1 40.6 160.2C40.6 184 56.4 197.8 77 197.8ZM61.8 152.2C63.3 143.8 68.7 139.9 74.9 139.9C83 139.9 86.2 145.2 86.2 152.2ZM109.9 196H133.1L138 184.7C139.8 180.6 141.5 176.4 143.3 172.5H143.9C146.2 176.4 148.3 180.7 150.4 184.7L157 196H180.9L159.1 161.4L179.7 124.6H156.6L152.2 135.5C150.7 139.6 148.9 143.8 147.5 147.8H146.9C144.9 143.8 142.9 139.6 141 135.5L135.1 124.6H111.1L131.7 158.8ZM215.9 197.8C223.2 197.8 228.4 196.3 232.1 195.1L228.6 178.9C226.9 179.6 224.4 180.3 222.1 180.3C216.8 180.3 213.1 177.2 213.1 169.3V142H229.9V124.6H213.1V105.6H194.6L192.1 124.6L181.1 125.5V142H190.7V169.5C190.7 186.3 198 197.8 215.9 197.8ZM235.5 167.5H271V151.8H235.5ZM330.2 197.8C343.2 197.8 354.8 192.6 361.3 186.3V142.7H326.5V161H341.3V176C339.3 177.5 335.8 178.4 332.5 178.4C315.1 178.4 306.8 167.6 306.8 149.1C306.8 130.9 316.7 120.1 330.5 120.1C338.3 120.1 343.2 123.2 347.9 127.3L359.7 113C353.3 106.6 343.5 100.9 329.8 100.9C304.8 100.9 283.8 118.7 283.8 149.8C283.8 181.4 304.3 197.8 330.2 197.8ZM410.7 197.8C419 197.8 428.8 194.9 436.2 189.6L428.8 176.2C423.7 179.2 418.9 180.7 413.7 180.7C404.7 180.7 397.9 176.7 395.9 166.9H437.8C438.3 165.1 438.9 161.2 438.9 157.2C438.9 137.8 428.8 122.8 408.2 122.8C391 122.8 374.3 137.1 374.3 160.2C374.3 184 390.2 197.8 410.7 197.8ZM395.5 152.2C397.1 143.8 402.5 139.9 408.6 139.9C416.8 139.9 419.9 145.2 419.9 152.2ZM453.2 196H475.5V148.3C479.8 144.2 482.8 141.9 487.8 141.9C493.4 141.9 496.1 144.7 496.1 154.6V196H518.4V151.8C518.4 134 511.8 122.8 496.2 122.8C486.5 122.8 479.3 127.7 473.4 133.5H473L471.4 124.6H453.2Z"/></svg>'
    };
    // </ng-logo>

    var TXT = {
        ru: {
            sub: 'Неофициальный клиент Twitch для LG webOS',
            go: 'Продолжить',
            pre: 'предварительная версия',
            notAff: 'не связан с Twitch Interactive',
            version: 'Версия',
            engine: 'движок скорости',
            fw: 'прошивка',
            desc: 'Трансляции, записи, клипы и чат на телевизорах LG. Скорость записей 0.25–2× с сохранением высоты звука ' +
                '(клипов — там, где её меняет сам телевизор), OLED-тема с чистым чёрным.',
            legal: function (src) {
                return esc(NAME) + ' — свободная программа: GNU GPL v3.0, <b>без каких-либо гарантий</b>; её можно распространять и изменять ' +
                    'на условиях этой лицензии — gnu.org/licenses/gpl-3.0.html. Изменённая версия (' + YEAR + ') кода SmartTwitchTV ' +
                    '© 2017– Felipe de Leon и SmartTwitchWebOSTV © TBSniller.' + (src ? ' Исходный код: ' + esc(src) + '.' : '');
            },
            tm: 'Twitch — товарный знак Twitch Interactive, Inc. Приложение не связано с Twitch и не одобрено ею.',
            close: 'Нажмите «Назад» или OK, чтобы закрыть',
            newsLabel: 'Что нового',
            newsTitle: 'Что нового',
            aboutLabel: 'О приложении',
            news: [
                'Новый интерфейс Next-Gen (этап 1): шрифт Onest, чёткие значки, крупные карточки «В эфире» со зрителями на превью, ' +
                    'новое боковое меню и шапка; русские подсказки и названия без сокращений и опечаток.',
                'Заставка при запуске — «Twitch Next-Gen», приветствие при первом запуске в том же стиле.',
                'Пакет приложения стал меньше: около 1 МБ вместо 6 МБ (убраны неиспользуемые картинки).',
                'Исправлена утечка памяти при смене скорости: закрытая запись больше не занимает память.',
                'Смена качества записи (в том числе на 2×) больше не начинает её с 00:00.',
                'Быстрая серия смен скорости сразу после возврата к 1× больше не сбрасывает запись в 00:00; после тихого начала записи нет ложного сообщения о тишине аудио-движка.',
                'На webOS 25 запись больше не замирает и не начинается с 00:00 после возврата к 1×, смены качества или сбоя ускорения.',
                'Медленная сеть на 2× — сначала снижается качество, а не скорость; обрыв сети до ~1,5 мин запись не закрывает.',
                'Клипы (MP4) на webOS 25 играют на 1× — их скорость меняет только сам телевизор, приложение об этом сообщает.',
                'Скорость записей 0.25–2× с сохранением высоты звука — в том числе на webOS 25, где телевизор сам скорость не меняет.',
                'Быстрая смена скорости: запросы объединяются, позиция не сбрасывается в 00:00, после сбоя следующее нажатие пробует снова.',
                'OLED-тема с чистым чёрным (по умолчанию), новый стартовый экран, разделы «О программе» и «Что нового».',
                'Всё приложение внутри пакета: без внешнего хостинга, без проверки обновлений и без аналитики стороннего проекта.'
            ],
            preNote: 'Предварительная версия: 1.0.0 станет релизом, когда все найденные проблемы будут исправлены.'
        },
        en: {
            sub: 'Unofficial Twitch client for LG webOS',
            go: 'Continue',
            pre: 'pre-release',
            notAff: 'not affiliated with Twitch Interactive',
            version: 'Version',
            engine: 'speed engine',
            fw: 'firmware',
            desc: 'Live streams, videos, clips and chat on LG TVs. Pitch-preserving 0.25–2× speed for videos ' +
                '(for clips where the TV itself applies it), OLED theme with true black.',
            legal: function (src) {
                return esc(NAME) + ' is free software under the GNU GPL v3.0 and comes with <b>absolutely no warranty</b>; you may redistribute ' +
                    'and modify it under that license — gnu.org/licenses/gpl-3.0.html. Modified version (' + YEAR + ') of SmartTwitchTV ' +
                    '© 2017– Felipe de Leon and SmartTwitchWebOSTV © TBSniller.' + (src ? ' Source code: ' + esc(src) + '.' : '');
            },
            tm: 'Twitch is a trademark of Twitch Interactive, Inc. This app is not affiliated with or endorsed by Twitch.',
            close: 'Press Back or OK to close',
            newsLabel: 'What\'s new',
            newsTitle: 'What\'s new',
            aboutLabel: '',
            news: [
                'New Next-Gen interface (stage 1): the Onest font, crisp icons, large live cards with viewers on the picture, ' +
                    'a new side menu and header.',
                'Launch screen: "Twitch Next-Gen", with a first-run welcome in the same style.',
                'Smaller package: about 1 MB instead of 6 MB (unused images removed).',
                'Memory leak fixed for speed changes: a closed video no longer holds memory.',
                'Changing the quality of a video (also at 2×) no longer restarts it from 00:00.',
                'A quick series of speed changes right after going back to 1× no longer sends the video to 00:00; no false "audio engine is silent" message after a quiet start.',
                'On webOS 25 a video no longer freezes or restarts from 00:00 after going back to 1×, a quality change or a speed-up failure.',
                'Slow network at 2× — the quality steps down first, not the speed; a network drop of up to ~1.5 min no longer closes the video.',
                'Clips (MP4) play at 1× on webOS 25 — only the TV itself can change their speed, and the app says so.',
                'Pitch-preserving 0.25–2× speed for videos, also on webOS 25 where the TV ignores the playback rate itself.',
                'Fast speed changes: requests are merged, the position never jumps to 00:00, after a failure the next press retries.',
                'OLED theme with true black (default), a new start screen, About and What\'s new.',
                'The whole app ships inside the package: no external hosting, no update checks, no third-party analytics.'
            ],
            preNote: 'Pre-release: 1.0.0 becomes a release once every reported issue is fixed.'
        }
    };
    function lang() {
        var l = lsGet('app_lang_string') || (w.navigator && w.navigator.language) || '';
        return /^"?(ru|be|kk)/i.test(String(l)) ? 'ru' : 'en';
    }
    function T() { return TXT[lang()]; }
    function preLabel(t) { return (t || T()).pre + (PRE_N ? ' ' + PRE_N : ''); }
    function engineVersion() { return (w.STTVSpeed && w.STTVSpeed.version) || ''; }
    function logoHtml() {
        if (NAME === 'Twitch NG' && LOGOS[VARIANT]) return LOGOS[VARIANT];
        return '<div class="ng-lockup" aria-label="' + esc(NAME) + '">' + (MARKS[VARIANT] || '') + '<span class="ng-word">' + esc(NAME) + '</span></div>';
    }
    // pre-release 02: webOS version + firmware from the system (what webOSTV.js webOS.deviceInfo reads): sdkVersion = webOS
    // (10.3.0), firmwareVersion = 33.30.97. Fallback PalmSystem.deviceInfo: its platformVersion is the firmware number on
    // webOS 25 (a "major" of 20+ is no webOS version)
    var SYS = null, sysBridge = null;
    function sysInfo() {
        var B = w.PalmServiceBridge, b;
        if (!B || SYS || sysBridge) return;
        try {
            b = sysBridge = new B();
            b.onservicecallback = function (r) {
                var o = null;
                try { o = JSON.parse(r); } catch (e) {}
                if (o && o.returnValue !== false && (o.sdkVersion || o.firmwareVersion)) SYS = { model: o.modelName || '', sdk: o.sdkVersion || '', fw: o.firmwareVersion || '' };
                sysBridge = null;
                // main.js builds the About text once at start-up, usually before this answer: refresh it in place
                if (SYS && doc.querySelectorAll) { try { var els = doc.querySelectorAll('.ng-platform'), i; for (i = 0; i < els.length; i++) els[i].textContent = platform(); } catch (e2) {} }
            };
            b.call('luna://com.webos.service.tv.systemproperty/getSystemInfo', JSON.stringify({ keys: ['modelName', 'firmwareVersion', 'sdkVersion'] }));
        } catch (e) { sysBridge = null; }
    }
    function platform() {
        var di = null, ua = String((w.navigator && w.navigator.userAgent) || ''), m, out = [], s = SYS || {}, pv, fwLike, fw;
        try { di = JSON.parse((w.PalmSystem && w.PalmSystem.deviceInfo) || 'null'); } catch (e) {}
        pv = di && di.platformVersion ? String(di.platformVersion) : '';
        fwLike = parseInt(pv, 10) >= 20;
        if ((di && di.modelName) || s.model) out.push((di && di.modelName) || s.model);
        if (s.sdk) out.push('webOS ' + s.sdk);
        else if (pv && !fwLike) out.push('webOS ' + pv);
        fw = s.fw || (fwLike ? pv : '');
        if (fw) out.push(T().fw + ' ' + fw);
        m = /Chrome\/(\d+)/.exec(ua);
        if (m) out.push('Chromium ' + m[1]);
        return out.join(' · ');
    }
    var stats = { intro: 0, seen: 0, about: 0, news: 0, auth: 0 };

    // ---- first-run intro: continues the launch splash (same backdrop, mark above the full name "Twitch Next-Gen")
    function heroHtml() {
        if (NAME === 'Twitch NG' && HEROS[VARIANT]) return HEROS[VARIANT];
        return logoHtml();      // custom --title or --icon B / C: mark + the app name
    }
    function introHtml() {
        var t = T();
        var hero = heroHtml();
        return '<div class="ng-intro' + (hero.indexOf('ng-hero') > 0 ? ' ng-has-hero' : '') + '" data-ng-version="' + VERSION + '">' + hero +
            '<div class="ng-sub">' + t.sub + '</div>' +
            '<div class="ng-go"><span class="ng-key">OK</span>' + t.go + '</div>' +
            '<div class="ng-foot">' + esc(NAME) + ' ' + VERSION + (PRE ? ' · ' + preLabel(t) : '') + ' · ' + t.notAff + '</div></div>';
    }
    function fillIntro(el) {
        if (!el || !el.innerHTML || el.querySelector('.ng-intro')) return;
        stats.seen++;
        el.innerHTML = introHtml();
        setClass(el, 'ng-intro-text', true);
        setClass(doc.getElementById('welcome_dialog'), 'ng-intro-host', true);
        stats.intro++;
    }
    function watchIntro() {
        var el = doc.getElementById('welcome_dialog_text');
        if (!el) return false;
        fillIntro(el);
        if (w.MutationObserver) new w.MutationObserver(function () { fillIntro(el); }).observe(el, { childList: true });
        return true;
    }
    if (!watchIntro()) doc.addEventListener('DOMContentLoaded', watchIntro);

    // ---- About (main.js: dialog_about_text; #about_runningtime is filled by the app every second)
    function aboutHtml(close) {
        var t = T(), eng = engineVersion(), p = platform();
        stats.about++;
        sysInfo();
        return '<div class="ng-about">' + logoHtml() +
            '<div class="ng-about-ver">' + t.version + ' ' + VERSION + (PRE ? ' · ' + preLabel(t) : '') + (eng ? ' · ' + t.engine + ' ' + esc(eng) : '') + '</div>' +
            '<div class="ng-about-desc">' + t.desc + '</div>' +
            (p ? '<div class="ng-about-dim ng-platform">' + esc(p) + '</div>' : '') +
            '<div class="ng-about-dim"><span id="about_runningtime"></span></div>' +
            '<div class="ng-about-legal">' + t.legal(SOURCE) + '<br>' + t.tm + '</div>' +
            '<div class="ng-about-close">' + (close || t.close) + '</div></div>';
    }
    // ---- What's new (update dialog + changelog view): this app's own notes, no upstream version check
    function newsHtml(close) {
        var t = T(), i, li = '';
        stats.news++;
        for (i = 0; i < t.news.length; i++) li += '<li>' + t.news[i] + '</li>';
        return '<div class="ng-news"><div class="ng-news-title">' + t.newsTitle + ' — ' + esc(NAME) + ' ' + VERSION + (PRE ? ' (' + preLabel(t) + ')' : '') + '</div>' +
            '<ul>' + li + '</ul>' + (PRE ? '<div class="ng-news-note">' + t.preNote + '</div>' : '') +
            (close ? '<div class="ng-about-close">' + close + '</div>' : '') + '</div>';
    }
    function newsLabel() { return T().newsLabel; }
    // ---- sign-in help: the app's text links a page of the original project; link this app's source instead, or drop the sentence
    function authHelp(text, h) {
        var s = String(text || ''), r;
        stats.auth++;
        if (SOURCE && typeof h === 'function') { try { return h(SOURCE, s, true); } catch (e) {} }
        r = s.replace(/<br><br>[^<]*<br><br>\s*%x/, '');
        return r.indexOf('%x') >= 0 ? r.replace('%x', '') : r;
    }

    w.TwitchNG = {
        name: NAME, version: VERSION, preRelease: PRE, preReleaseN: PRE_N, variant: VARIANT, source: SOURCE || null,
        // on: true / false = remember; null = back to the default (on). Returns the current state.
        oled: function (on) {
            if (on !== undefined) lsSet('TWITCHNG_OLED', on === null ? null : (on ? '1' : '0'));
            setClass(root, 'ng-classic', !oledOn());
            applyUi();
            return oledOn();
        },
        // Next-Gen UI: same contract as oled(); texts already reshaped by ng-ui.js stay until the next screen refresh / restart
        ui: function (on) {
            if (on !== undefined) lsSet('TWITCHNG_UI', on === null ? null : (on ? '1' : '0'));
            return applyUi();
        },
        aboutLabel: function (def) { return T().aboutLabel || def; },
        aboutHtml: aboutHtml, newsHtml: newsHtml, newsLabel: newsLabel, authHelp: authHelp, lang: lang,
        state: function () {
            return { name: NAME, version: VERSION, preRelease: PRE, preReleaseN: PRE_N, variant: VARIANT, lang: lang(), engine: engineVersion() || null,
                oled: oledOn(), classic: hasClass(root, 'ng-classic'), ui: hasClass(root, 'ng-ui'), uiCss: uiCss().length, intro: stats.intro, about: stats.about, news: stats.news, auth: stats.auth,
                logo: !!LOGOS[VARIANT], hero: !!HEROS[VARIANT], css: !!doc.querySelector('link[href*="twitchng.css"]'), platform: platform(), sys: SYS };
        }
    };
    sysInfo();
})(window);
