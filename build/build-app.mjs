#!/usr/bin/env node
/*
 * build-app.mjs 1.0.0 - standalone webOS IPK: the TV web app with sttv-speed built in (optional Twitch NG app layer).
 * Base: a SmartTwitchWebOSTV checkout (webOS wrapper app + webosCompatBridge.js + the bundled web app in release/),
 * used as is except:
 *   release/index.html   + <script src="githubio/js/sttv-speed.js?v=X" data-v2b="auto"> right after the bridge tag
 *   release/githubio/js  + sttv-speed.js, sttv-v2b.js, sttv-hls.min.js (../sttv-speed)
 *   service              + sttv_media_fetch.js and one hook line in its main file (media over Luna = CORS fallback)
 *   appinfo.json         id / version / title;  services.json + package.json: service id <id>.hls;  + LICENSE (GPL text)
 *   index.js             DEFAULT_TARGET_URL (local: release/index.html inside the IPK, hosted: --target-url)
 *   release/             dev-only files dropped (githubio/temp, scripts, main_uncompressed.js, *.xcf; --keep-dev-files)
 * --brand twitchng: "Twitch NG" 1.0.0 (pre-release; NG = Next-Gen) - a standalone app: id com.twitchng.tv, own version
 *   line (default 1.0.0, independent of the engine), icon / splash from brand/twitchng/variants/<--icon>/,
 *   release/githubio/{js/twitchng.js, css/twitchng.css} (+ <link> in head, <script> after sttv-speed: OLED preset on by
 *   default, intro, About, What's new), main.js exact patches (each with a count check): speed menu
 *   0.25/0.5/0.75/1/1.25/1.5/2 in VOD + clips only, app name, purple default focus; About / update dialog /
 *   changelog / side-menu entry / sign-in help from twitchng.js, no update check or update settings, local
 *   empty-screen image and icon-font fallback; index.html without the Firebase / Google Analytics tags and the preconnects of the original
 *   project; donation images dropped.
 *   --icon L3  (default) own TV mark drawn in Twitch's outline style, white on Twitch purple (two 'eye' bars);
 *              --icon L4 the same TV with a play sign. Original artwork, but Twitch-like: own TV / GitHub, not a store
 *   --icon A   official-style Glitch + "NG" badge (the Glitch is a Twitch trademark: personal use only)
 *   --icon B   own mark (double play-chevron) + "NG" badge;  --icon C  "NG" letters  (B / C: publishable artwork)
 *   --title T  app name everywhere (launcher, title, app texts, About); for a public release pick one without "Twitch"
 *   --source-url URL   shown in About + sign-in help (GPL-3.0 section 6: tell users where the source is)
 * Modes:
 *   local  (default) the web app is inside the IPK: no hosting needed
 *   hosted the wrapper opens --target-url (must end in /release/index.html); publish <out>/pages/ there
 * Usage:
 *   node build/build-app.mjs [--repo DIR | --ref v1.1.0] [--mode local|hosted] [--target-url URL]
 *        [--id ID | --replace] [--title T] [--version X.Y.Z] [--v2b auto|off|force] [--out DIR]
 *        [--brand none|twitchng] [--icon L3|L4|A|B|C] [--source-url URL] [--ares PATH] [--no-package] [--keep-dev-files]
 * Needs Node >= 18, git (without --repo), ares-package (npm i -g @webos-tools/cli) unless --no-package.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = path.join(KIT, 'sttv-speed');
const SVC_EXT = path.join(KIT, 'deploy', 'service', 'sttv_media_fetch.js');
const ENGINE_FILES = ['sttv-speed.js', 'sttv-v2b.js', 'sttv-hls.min.js'];
const UPSTREAM_GIT = 'https://github.com/TBSniller/SmartTwitchWebOSTV.git';
const DEFAULT_REF = 'v1.1.0';
const STOCK_ID = 'com.tbsniller.smarttwitchwebostv';
const HOOK = "try { require('./sttv_media_fetch').hookService(require('webos-service')); } catch (e) {} // sttv-speed";
const PRUNE = ['githubio/temp', 'scripts', 'githubio/js/main_uncompressed.js'];      // + **/*.xcf (not used at runtime)
const BRIDGE_RE = /<script\b(?=[^>]*\bsrc\s*=\s*['"][^'"]*githubio\/js\/webosCompatBridge\.js(?:\?[^'"]*)?['"])[^>]*>\s*<\/script>/i;
const MAIN_RE = /<script\b(?=[^>]*\bsrc\s*=\s*['"][^'"]*githubio\/js\/main\.js(?:\?[^'"]*)?['"])[^>]*>\s*<\/script>/i;
const SPEED_RE_G = /<script\b(?=[^>]*\bsrc\s*=\s*['"][^'"]*sttv-speed\.js(?:\?[^'"]*)?['"])[^>]*>\s*<\/script>/gi;
// ---- TwitchNG brand layer (--brand twitchng)
const BRAND_DIR = path.join(KIT, 'brand', 'twitchng');
const NG = { id: 'com.twitchng.tv', title: 'Twitch NG', version: '1.0.0', iconColor: { L3: '#9146FF', L4: '#9146FF', A: '#9146FF', B: '#2F6FE0', C: '#2F6FE0' } };
const NG_WEB = [['web/twitchng.js', 'githubio/js/twitchng.js'], ['web/twitchng.css', 'githubio/css/twitchng.css']];
// pre-release number comes from the app layer (twitchng.js: PRE = true, PRE_N = '02'), the one place to bump per build;
// null = release build (PRE = false)
function ngPreRelease() {
    const s = fs.readFileSync(path.join(BRAND_DIR, 'web', 'twitchng.js'), 'utf8');
    if (!/\bPRE\s*=\s*true\b/.test(s)) return null;
    const m = /\bPRE_N\s*=\s*'(\d*)'/.exec(s);
    return m ? m[1] : '';
}
// LG appinfo spec: icon 80x80, largeIcon 130x130 (same design, opaque, >= 5 px padding), splash 1920x1080;
// brand/twitchng/variants/<L3|L4|A|B|C>/ (icon.png 512 = master, empty.png = the app's empty-screen banner image)
const NG_ASSETS = [['icon-80.png', 'assets/icon.png'], ['icon-130.png', 'assets/largeIcon.png'], ['splash.png', 'assets/splash.png']];
const NG_EMPTY = ['empty.png', 'githubio/images/twitchng-empty.png'];
const NG_PRUNE = ['githubio/images/bitcoin.png', 'githubio/images/paypal.png',      // donation artwork of the original project
    // + artwork of the original project's web site, store listings and Android build that the TV app never loads (its 404
    // images are data: URIs in main.js, smarthub.json is a Samsung Smart Hub feed): ~13 MB unpacked, ~4.6 MB of the IPK.
    // Build check (unusedRefs): none of these names may appear in a shipped text file, else the build stops.
    'githubio/images/icon_512.png', 'githubio/images/icon_black_round_corner.png', 'githubio/images/icon_black.png',
    'githubio/images/banner_test.png', 'githubio/images/banner_store.png', 'githubio/images/banner_store_500.png',
    'githubio/images/icon_circle_debug.png', 'githubio/images/icon_circle.png', 'githubio/images/w_90d.png',
    'githubio/images/icon_512_yelow.png', 'githubio/images/icon_yelow.png', 'githubio/images/joy.png',
    'githubio/images/free-banner-background.jpg', 'githubio/images/free-banner-background-1639360.jpg', 'githubio/images/temp.mp4',
    'githubio/images/404_game.png', 'githubio/images/404_video.png', 'githubio/images/404_logo.png', 'githubio/images/refresh.png',
    'githubio/json/smarthub.json', 'githubio/images/games.png', 'githubio/images/add_user.png'];
// index.html: analytics of the original project (Firebase / gtag -> its Google Analytics property) + its preconnects
const NG_INDEX_DROP = [
    { what: 'Firebase + Google Analytics tags', n: 3, re: /<script\b[^>]*\bsrc\s*=\s*['"]https:\/\/www\.(?:gstatic\.com\/firebasejs|googletagmanager\.com)\/[^'"]*['"][^>]*>\s*<\/script>/gi },
    { what: 'dns-prefetch / preconnect to the original project site', n: 2, re: /<link\b[^>]*\brel\s*=\s*['"](?:dns-prefetch|preconnect)['"][^>]*\bhref\s*=\s*['"]https:\/\/fgl27\.github\.io\/?['"][^>]*>/gi }
];
const NG_TAG_RE_G = /<script\b(?=[^>]*\bsrc\s*=\s*['"][^'"]*twitchng\.js(?:\?[^'"]*)?['"])[^>]*>\s*<\/script>/gi;
const NG_LINK_RE_G = /<link\b(?=[^>]*\bhref\s*=\s*['"][^'"]*twitchng\.css(?:\?[^'"]*)?['"])[^>]*>/gi;
// main.js (minified bundled web app) - exact strings, each must occur exactly `n` times; T = app name (--title)
const NG_GATE = 'window.TwitchNG&&TwitchNG.';
function ngMain(T) {
    return [
    { what: 'speed menu: VOD + clips only (no speed in live / PP / multi on this TV)', n: 1,
        from: 'ShowInLive:!0,ShowInVod:!0,ShowInClip:!0,ShowInPP:!0,ShowInMulti:!0,ShowInChat:!1,ShowInAudio:!1,ShowInAudioPP:!1,ShowInAudioMulti:!1,ShowInPreview:!1,ShowInStay:!1,icons:"speedometer"',
        to: 'ShowInLive:!1,ShowInVod:!0,ShowInClip:!0,ShowInPP:!1,ShowInMulti:!1,ShowInChat:!1,ShowInAudio:!1,ShowInAudioPP:!1,ShowInAudioMulti:!1,ShowInPreview:!1,ShowInStay:!1,icons:"speedometer"' },
    { what: 'speed menu: 0.25 0.5 0.75 1 1.25 1.5 2 (1x stays index 3 = defaultValue / Play_CurrentSpeed reset)', n: 1,
        from: 'values:[.25,.5,.75,1,1.05,1.1,1.15,1.2,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,5,6,7,8],defaultValue:3',
        to: 'values:[.25,.5,.75,1,1.25,1.5,2],defaultValue:3' },
    { what: 'app name en (exit dialog)', n: 1, from: 'exit the SmartTV Client for Twitch?', to: 'exit ' + T + '?' },
    { what: 'app name en/fr', n: 2, from: 'SmartTV Client for Twitch', to: T },
    { what: 'app name es (exit dialog)', n: 1, from: 'del Cliente SmartTV para Twitch', to: 'de ' + T },
    { what: 'app name es/pt', n: 3, from: 'Cliente SmartTV para Twitch', to: T },
    { what: 'app name ru/uk', n: 3, from: 'SmartTV Client \u0434\u043b\u044f Twitch', to: T },
    { what: 'app name tr (exit dialog)', n: 1, from: 'Twitch i\u00e7in SmartTV \u0130stemcisinden', to: T + ' uygulamas\u0131ndan' },
    { what: 'app name tr', n: 1, from: 'Twitch i\u00e7in SmartTV \u0130stemcisi', to: T },
    { what: 'default focus style: purple border + watched bar (Settings > style "Default")', n: 1,
        from: '=[["rgba(0,0,0,1)","rgba(255,255,255,1)","rgba(235,235,235,1)","rgba(195,0,0,1)"],[],',
        to: '=[["rgba(0,0,0,1)","rgba(255,255,255,1)","rgba(145,70,255,1)","rgba(145,70,255,1)"],[],' },
    // ---- standalone app (1.0.0): no identity, update channel, contact / donation links or remote images of the original project
    { what: 'About: this app (TwitchNG.aboutHtml: version, platform, run time, license + no-warranty notice)', n: 1,
        from: 'r("dialog_about_text",lh+a+c+Wf+sg+"</div>"+c+\'<span id="about_runningtime"></span>\'+rh)',
        to: 'r("dialog_about_text",' + NG_GATE + 'aboutHtml?TwitchNG.aboutHtml(ua):lh+a+c+Wf+sg+"</div>"+c+\'<span id="about_runningtime"></span>\'+rh)' },
    { what: 'update dialog: What\'s new of this app instead of the original version / changelog', n: 1,
        from: 'r("update_dialog_text",e+="</div>")', to: 'r("update_dialog_text",' + NG_GATE + 'newsHtml?TwitchNG.newsHtml():e+="</div>")' },
    { what: 'changelog view: What\'s new of this app', n: 1,
        from: 'r("dialog_changelod_text",t+Xf+pa+"</div></div>")', to: 'r("dialog_changelod_text",' + NG_GATE + 'newsHtml?TwitchNG.newsHtml(pa):t+Xf+pa+"</div></div>")' },
    { what: 'side menu: "What\'s new" instead of "Updates & Changelog"', n: 1,
        from: 'r("side_panel_movel_new_14",p+Ju)', to: 'r("side_panel_movel_new_14",p+(' + NG_GATE + 'newsLabel?TwitchNG.newsLabel(Ju):Ju))' },
    { what: 'no update check (update dialog button)', n: 1, from: 'function xj(){ZC=!0,', to: 'function xj(){if(window.TwitchNG)return;ZC=!0,' },
    { what: 'settings: no "Updates" section', n: 1,
        from: '+cQ("update_settings",[wi],nc,null))', to: '+(window.TwitchNG?"":cQ("update_settings",[wi],nc,null)))' },
    { what: 'sign-in help: this app\'s source link (--source-url) or none', n: 1,
        from: 'Ua=_h("https://github.com/fgl27/SmartTwitchTV#authorization",Ua,!0)',
        to: 'Ua=' + NG_GATE + 'authHelp?TwitchNG.authHelp(Ua,_h):_h("https://github.com/fgl27/SmartTwitchTV#authorization",Ua,!0)' },
    { what: 'empty-screen banner image: local file (was loaded from the original project site)', n: 1,
        from: 'image:"https://fgl27.github.io/SmartTwitchTV/apk/app/src/main/res/mipmap-nodpi/ic_splash.png"', to: 'image:"' + NG_EMPTY[1] + '"' },
    { what: 'proxy info: TTV LOL home page instead of its donation page', n: 1, from: 'gh("https://ttv.lol/donate")', to: 'gh("https://ttv.lol")' },
    { what: 'icon-font check fallback: reload the local stylesheet (was the copy on the original project site)', n: 1,
        from: '"https://fgl27.github.io/SmartTwitchTV/release/githubio/css/icons.min.css"', to: '"githubio/css/icons.min.css"' }
    ];
}
const NG_TITLE_FROM = '<title>SmartTV Twitch</title>';
const htmlEsc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const titleTag = (t) => '<title>' + htmlEsc(t) + '</title>';

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => JSON.parse(read(f));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ENGINE_VER = (/var VERSION = '([^']+)'/.exec(read(path.join(ENGINE_DIR, 'sttv-speed.js'))) || [])[1];

function die(msg) { console.error('build-app: ' + msg); process.exit(2); }
function step(msg) { console.log('== ' + msg); }
function run(cmd, args, opts = {}) {
    // .cmd shims (Windows npm) need a shell since Node 18.20 / 20.12
    const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: /\.cmd$/i.test(cmd), ...opts });
    if (r.error) die(cmd + ': ' + r.error.message);
    if (r.status !== 0) die(cmd + ' ' + args.join(' ') + ' -> exit ' + r.status + (opts.capture ? '\n' + r.stdout + r.stderr : ''));
    return r;
}
function usage() {
    const m = /\/\*\n([\s\S]*?)\n \*\//.exec(read(fileURLToPath(import.meta.url)));
    console.log(m ? m[1].split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n') : 'see the header of build/build-app.mjs');
}

function parseArgs(argv) {
    const a = { repo: '', ref: DEFAULT_REF, mode: 'local', targetUrl: '', id: '', replace: false, title: '', version: '',
        v2b: 'auto', out: path.join(KIT, 'dist'), ares: '', pkg: true, keepDev: false, brand: 'none', icon: '', sourceUrl: '' };
    const flags = { '--replace': () => { a.replace = true; }, '--no-package': () => { a.pkg = false; }, '--keep-dev-files': () => { a.keepDev = true; } };
    const vals = { '--repo': 'repo', '--ref': 'ref', '--mode': 'mode', '--target-url': 'targetUrl', '--id': 'id', '--title': 'title',
        '--version': 'version', '--v2b': 'v2b', '--out': 'out', '--ares': 'ares', '--brand': 'brand', '--icon': 'icon', '--source-url': 'sourceUrl' };
    for (let i = 0; i < argv.length; i++) {
        let k = argv[i], v;
        if (k === '-h' || k === '--help') { usage(); process.exit(0); }
        const eq = k.indexOf('=');
        if (k.startsWith('--') && eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
        if (flags[k] && v === undefined) { flags[k](); continue; }
        if (!vals[k]) die('unknown argument ' + argv[i] + ' (--help)');
        if (v === undefined) { v = argv[++i]; if (v === undefined) die('missing value for ' + k); }
        a[vals[k]] = v;
    }
    if (!ENGINE_VER) die('cannot read VERSION from ' + path.join(ENGINE_DIR, 'sttv-speed.js'));
    if (!/^(local|hosted)$/.test(a.mode)) die('--mode must be local or hosted');
    if (!/^(auto|off|force)$/.test(a.v2b)) die('--v2b must be auto, off or force');
    if (!/^(none|twitchng)$/.test(a.brand)) die('--brand must be none or twitchng');
    a.ng = a.brand === 'twitchng';
    if (!a.ng && (a.icon || a.sourceUrl)) die('--icon / --source-url need --brand twitchng');
    a.icon = String(a.icon || 'L3').toUpperCase();
    if (!/^(L3|L4|A|B|C)$/.test(a.icon)) die('--icon must be L3, L4, A, B or C');
    if (a.sourceUrl && !/^https:\/\/[^\s"'<>\\]+$/.test(a.sourceUrl)) die('--source-url must be an https:// URL');
    if (a.replace && a.id && a.id !== STOCK_ID) die('--replace means --id ' + STOCK_ID);
    a.id = a.replace ? STOCK_ID : (a.id || (a.ng ? NG.id : STOCK_ID + '.speed'));
    if (!/^[a-z0-9][a-z0-9.+-]*[a-z0-9]$/.test(a.id) || /^(com\.palm|com\.webos|com\.lge)\./.test(a.id)) die('invalid app id ' + a.id);
    a.version = a.version || (a.ng ? NG.version : ENGINE_VER);   // Twitch NG has its own version line (engine: build-info)
    if (!/^\d+\.\d+\.\d+$/.test(a.version)) die('--version must be X.Y.Z (numbers only)');
    a.title = a.title || (a.ng ? NG.title : (a.id === STOCK_ID ? 'SmartTwitchTV' : 'SmartTwitchTV Speed'));
    if (a.ng && !/^[^"'\\<>&]{1,40}$/.test(a.title)) die('--title: 1-40 characters without quotes, backslash, < > &');
    if (a.mode === 'hosted') {
        if (!/^https:\/\/[^\s'"<>]+\/release\/index\.html$/.test(a.targetUrl)) die('--mode hosted needs --target-url https://.../release/index.html');
    } else if (a.targetUrl) die('--target-url is only for --mode hosted');
    a.out = path.resolve(a.out);
    return a;
}

function getRepo(a) {
    const dir = a.repo ? path.resolve(a.repo) : path.join(a.out, 'src', 'SmartTwitchWebOSTV');
    if (!a.repo) {
        step('clone ' + UPSTREAM_GIT + ' @ ' + a.ref);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        run('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', a.ref, UPSTREAM_GIT, dir]);
    }
    for (const f of ['webos/app/appinfo.json', 'webos/app/index.js', 'webos/service/services.json', 'webos/service/package.json',
        'webos/bridge/webosCompatBridge.js', 'release/index.html', 'tools/upstream/prepareHostedRelease.js']) {
        if (!fs.existsSync(path.join(dir, f))) die('not a SmartTwitchWebOSTV checkout (missing ' + f + '): ' + dir);
    }
    const git = (args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
    const isGit = git(['rev-parse', '--git-dir']) !== null;
    // build-info.json goes into release notes / bug reports: no local paths, no credentials from a remote URL
    const remote = a.repo && isGit ? git(['remote', 'get-url', 'origin']) : null;
    const source = a.repo ? (remote ? remote.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1') : 'local checkout (--repo)') : UPSTREAM_GIT;
    return { dir, source, ref: a.repo ? null : a.ref, commit: isGit ? git(['rev-parse', 'HEAD']) : null,
        tags: isGit ? (git(['tag', '--points-at', 'HEAD']) || '').split('\n').filter(Boolean) : null, dirty: isGit ? !!git(['status', '--porcelain']) : null };
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}
function bytesOf(p) { return fs.statSync(p).isDirectory() ? walk(p).reduce((n, f) => n + fs.statSync(f).size, 0) : fs.statSync(p).size; }
function prune(root) {
    const removed = [];
    const rm = (rel) => {
        const p = path.join(root, rel);
        if (!fs.existsSync(p)) return;
        removed.push({ path: rel, bytes: bytesOf(p) });
        fs.rmSync(p, { recursive: true, force: true });
    };
    PRUNE.forEach(rm);
    walk(root).filter((f) => /\.xcf$/i.test(f)).forEach((f) => rm(path.relative(root, f).split(path.sep).join('/')));
    return removed;
}

function speedTag(v2b) { return '<script src="githubio/js/sttv-speed.js?v=' + ENGINE_VER + '" data-v2b="' + v2b + '"></script>'; }
function checkIndex(html, tag) {
    const n = (html.match(SPEED_RE_G) || []).length, b = html.search(BRIDGE_RE), s = html.indexOf(tag), m = html.search(MAIN_RE);
    if (n !== 1 || s < 0) return 'sttv-speed tag count ' + n;
    if (b < 0 || m < 0) return 'bridge or main.js tag missing';
    if (!(b < s && s < m)) return 'tag order is not bridge < sttv-speed < main.js';
    return '';
}
function injectEngine(web, v2b) {
    const js = path.join(web, 'githubio', 'js');
    for (const f of ENGINE_FILES) fs.copyFileSync(path.join(ENGINE_DIR, f), path.join(js, f));
    const idx = path.join(web, 'index.html'), tag = speedTag(v2b);
    let html = read(idx).replace(SPEED_RE_G, '');
    if (!BRIDGE_RE.test(html)) die('webosCompatBridge.js tag not found in ' + idx);
    html = html.replace(BRIDGE_RE, (m) => m + tag);
    const bad = checkIndex(html, tag);
    if (bad) die('index.html: ' + bad);
    fs.writeFileSync(idx, html);
    return tag;
}
// ---- TwitchNG brand layer
function ngTags(a) {
    const at = ' data-name="' + htmlEsc(a.title) + '" data-variant="' + a.icon + '"' + (a.sourceUrl ? ' data-source="' + htmlEsc(a.sourceUrl) + '"' : '');
    return { link: '<link rel="stylesheet" href="githubio/css/twitchng.css?v=' + a.version + '">',
        script: '<script src="githubio/js/twitchng.js?v=' + a.version + '"' + at + '></script>' };
}
function checkNgIndex(html, tags, a) {
    const nl = (html.match(NG_LINK_RE_G) || []).length, ns = (html.match(NG_TAG_RE_G) || []).length;
    if (nl !== 1 || ns !== 1) return 'twitchng link/script count ' + nl + '/' + ns;
    const l = html.indexOf(tags.link), t = html.indexOf(tags.script), sp = html.search(SPEED_RE_G), m = html.search(MAIN_RE), d = html.indexOf('<div');
    if (l < 0 || t < 0) return 'twitchng tags differ';
    if (!(l < d)) return 'twitchng.css link is not in the head';
    if (!(sp < t && t < m)) return 'tag order is not sttv-speed < twitchng < main.js';
    if (html.indexOf(titleTag(a.title)) < 0) return 'title';
    for (const x of NG_INDEX_DROP) { x.re.lastIndex = 0; if (x.re.test(html)) return 'still in index.html: ' + x.what; }
    return '';
}
// local references to dropped files (by basename) left in a shipped text file of the app; skipped: other names that end
// with the same text (smart_games.png) and absolute URLs (https://.../bitcoin.png is a remote image, not the dropped file)
function unusedRefs(root, names) {
    const hits = [];
    for (const f of walk(root)) {
        if (!/\.(?:js|mjs|html?|css|json|xml|svg|txt)$/i.test(f)) continue;
        const t = fs.readFileSync(f, 'utf8');
        for (const n of names) {
            for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) {
                if (i > 0 && /[\w.-]/.test(t[i - 1])) continue;
                let b = i;
                while (b > 0 && !/["'`()\s<>=,;]/.test(t[b - 1])) b--;
                if (t.slice(b, i).indexOf('://') >= 0) continue;
                hits.push(n + ' in ' + path.relative(root, f).split(path.sep).join('/'));
                break;
            }
        }
    }
    return hits;
}
function patchMain(src, list) {
    const done = [];
    for (const p of list) {
        const n = src.split(p.from).length - 1;
        if (n !== p.n) die('main.js: "' + p.what + '" expects ' + p.n + ' x ' + JSON.stringify(p.from.slice(0, 60)) + ', found ' + n + ' (bundled web app changed?)');
        src = src.split(p.from).join(p.to);
        done.push({ what: p.what, n });
    }
    return { src, done };
}
function injectBrand(web, a) {
    for (const [from, to] of NG_WEB) fs.copyFileSync(path.join(BRAND_DIR, from), path.join(web, to));
    fs.copyFileSync(path.join(BRAND_DIR, 'variants', a.icon, NG_EMPTY[0]), path.join(web, NG_EMPTY[1]));
    const idx = path.join(web, 'index.html'), tags = ngTags(a), dropped = [];
    let html = read(idx).replace(NG_LINK_RE_G, '').replace(NG_TAG_RE_G, '');
    for (const x of NG_INDEX_DROP) {
        const n = (html.match(x.re) || []).length;
        if (n !== x.n) die('index.html: "' + x.what + '" expects ' + x.n + ', found ' + n);
        html = html.replace(x.re, '');
        dropped.push({ what: x.what, n });
    }
    if (html.split(NG_TITLE_FROM).length !== 2) die('index.html: ' + NG_TITLE_FROM + ' not found once');
    html = html.replace(NG_TITLE_FROM, titleTag(a.title) + tags.link);
    const sp = html.match(SPEED_RE_G);
    if (!sp || sp.length !== 1) die('index.html: sttv-speed tag missing (inject the engine first)');
    html = html.replace(sp[0], sp[0] + tags.script);
    const bad = checkNgIndex(html, tags, a);
    if (bad) die('index.html (twitchng): ' + bad);
    fs.writeFileSync(idx, html);
    const mainJs = path.join(web, 'githubio', 'js', 'main.js'), r = patchMain(read(mainJs), ngMain(a.title));
    fs.writeFileSync(mainJs, r.src);
    const pruned = [];
    for (const f of NG_PRUNE) { const q = path.join(web, f); if (fs.existsSync(q)) { pruned.push({ path: f, bytes: fs.statSync(q).size }); fs.rmSync(q); } }
    return { tags, main: r.done, index: dropped, pruned, mainSha256: sha256(fs.readFileSync(mainJs)) };
}
function brandApp(app, ai, a) {
    const dir = path.join(BRAND_DIR, 'variants', a.icon);
    for (const [from, to] of NG_ASSETS) fs.copyFileSync(path.join(dir, from), path.join(app, to));
    Object.assign(ai, { vendor: a.title.replace(/\s+/g, ''), iconColor: NG.iconColor[a.icon], icon: 'assets/icon.png', largeIcon: 'assets/largeIcon.png', splashBackground: 'assets/splash.png' });
    const ih = path.join(app, 'index.html');
    if (fs.existsSync(ih)) fs.writeFileSync(ih, read(ih).replace(/<title>[^<]*<\/title>/, titleTag(a.title)));
}
function patchTarget(indexJs, target) {
    const src = read(indexJs), re = /var DEFAULT_TARGET_URL = '[^']*';/;
    if (!re.test(src)) die('DEFAULT_TARGET_URL not found in ' + indexJs);
    fs.writeFileSync(indexJs, src.replace(re, "var DEFAULT_TARGET_URL = '" + target + "';"));
}
function insertHook(file) {
    let src = read(file);
    src = src.split('\n').filter((l) => l.indexOf('sttv_media_fetch') < 0).join('\n');
    const lines = src.split('\n');
    let at = -1;
    for (let i = 0; i < Math.min(20, lines.length); i++) if (/^\s*["']use strict["']/.test(lines[i])) { at = i; break; }
    if (at < 0 && /^#!/.test(lines[0] || '')) at = 0;
    lines.splice(at + 1, 0, HOOK);
    fs.writeFileSync(file, lines.join('\n'));
    if (read(file).split('sttv_media_fetch').length !== 2) die('service hook not inserted exactly once in ' + file);
}
function serviceSelfTest(svcDir, mainFile, sid) {
    // runs the patched service against a stub webos-service: name, registered methods, {sttvMedia, ping} -> pong
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sttv-svc-'));
    fs.mkdirSync(path.join(tmp, 'webos-service'));
    fs.writeFileSync(path.join(tmp, 'webos-service', 'index.js'),
        'function Service(name) { this.name = name; global.__svc = { name: name, methods: {} }; }\n' +
        'Service.prototype.register = function (m, cb) { global.__svc.methods[m] = cb; return { on: function () {} }; };\n' +
        'Service.prototype.subscriptionAdd = function () {};\nmodule.exports = Service;\n');
    const probe = 'require(' + JSON.stringify(path.join(svcDir, mainFile)) + ');\n' +
        'var s = global.__svc, out = { name: s && s.name, methods: s ? Object.keys(s.methods) : [] };\n' +
        'if (s && s.methods.fetchPlaylist) s.methods.fetchPlaylist({ payload: { sttvMedia: true, ping: true }, respond: function (r) { out.pong = r; } });\n' +
        'setTimeout(function () { console.log(JSON.stringify(out)); process.exit(0); }, 100);\n';
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, NODE_PATH: tmp }, timeout: 20000 });
    fs.rmSync(tmp, { recursive: true, force: true });
    let res = null;
    try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) {}
    const ok = !!res && res.name === sid && res.methods.indexOf('fetchPlaylist') >= 0 && !!res.pong && res.pong.pong === true;
    if (!ok) die('service self-test failed: ' + JSON.stringify(res) + ' ' + (r.stderr || '').slice(0, 400));
    return res;
}

function findAres(a) {
    const exe = process.platform === 'win32' ? 'ares-package.cmd' : 'ares-package';
    const c = [a.ares, path.join(KIT, 'node_modules', '.bin', exe)].concat((process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, exe)));
    for (const p of c) if (p && fs.existsSync(p)) return p;
    return '';
}
function readAr(buf) {
    if (buf.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error('not an ar archive');
    const m = {};
    let off = 8;
    while (off + 60 <= buf.length) {
        const name = buf.toString('latin1', off, off + 16).trim().replace(/\/$/, '');
        const size = parseInt(buf.toString('latin1', off + 48, off + 58).trim(), 10);
        m[name] = buf.subarray(off + 60, off + 60 + size);
        off += 60 + size + (size & 1);
    }
    return m;
}
function readTarGz(buf) {
    const t = zlib.gunzipSync(buf), files = {};
    let off = 0, longName = null;
    while (off + 512 <= t.length) {
        const h = t.subarray(off, off + 512);
        if (h.every((x) => x === 0)) break;
        let name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
        const size = parseInt(h.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        if (prefix && h.toString('latin1', 257, 262) === 'ustar') name = prefix + '/' + name;
        if (longName) { name = longName; longName = null; }
        const body = t.subarray(off + 512, off + 512 + size);
        if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
        else if (type === 'x') { const mm = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); if (mm) longName = mm[1]; }
        else if (type === '0') files[name.replace(/^\.\//, '')] = body;
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}
function verifyIpk(ipk, a, tag, sid, mainFile) {
    const ar = readAr(fs.readFileSync(ipk)), errs = [];
    const need = (c, msg) => { if (!c) errs.push(msg); };
    need(ar['debian-binary'] && ar['debian-binary'].toString() === '2.0\n', 'debian-binary');
    const ctl = ar['control.tar.gz'] ? readTarGz(ar['control.tar.gz']) : {}, control = (ctl.control || Buffer.from('')).toString();
    need(new RegExp('^Package: ' + a.id.replace(/[.+]/g, '\\$&') + '$', 'm').test(control) && new RegExp('^Version: ' + a.version + '$', 'm').test(control), 'control Package/Version');
    const d = ar['data.tar.gz'] ? readTarGz(ar['data.tar.gz']) : {};
    const A = 'usr/palm/applications/' + a.id + '/', S = 'usr/palm/services/' + sid + '/', P = 'usr/palm/packages/' + a.id + '/packageinfo.json';
    const j = (k) => { try { return JSON.parse(d[k].toString()); } catch (e) { return null; } };
    const ai = j(A + 'appinfo.json'), pi = j(P), sj = j(S + 'services.json');
    need(ai && ai.id === a.id && ai.version === a.version && ai.title === a.title, 'appinfo.json id/version/title');
    need(pi && pi.id === a.id && pi.app === a.id && Array.isArray(pi.services) && pi.services.indexOf(sid) >= 0, 'packageinfo.json app + service');
    need(sj && sj.id === sid && sj.services && sj.services[0] && sj.services[0].name === sid, 'services.json id/name');
    need(d[A + 'index.js'] && d[A + 'index.js'].toString().indexOf("var DEFAULT_TARGET_URL = '" + (a.mode === 'local' ? 'release/index.html' : a.targetUrl) + "';") >= 0, 'index.js target');
    const svcMain = d[S + mainFile] ? d[S + mainFile].toString() : '';
    need(svcMain.split('sttv_media_fetch').length === 2, 'service hook line once');
    need(d[S + 'sttv_media_fetch.js'] && sha256(d[S + 'sttv_media_fetch.js']) === sha256(fs.readFileSync(SVC_EXT)), 'sttv_media_fetch.js byte-identical');
    if (a.mode === 'local') {
        const R = A + 'release/';
        need(d[R + 'index.html'] && !checkIndex(d[R + 'index.html'].toString(), tag), 'release/index.html tags');
        for (const f of ENGINE_FILES) need(d[R + 'githubio/js/' + f] && sha256(d[R + 'githubio/js/' + f]) === sha256(fs.readFileSync(path.join(ENGINE_DIR, f))), f + ' byte-identical');
        need(d[R + 'githubio/js/main.js'] && d[R + 'githubio/js/webosCompatBridge.js'], 'main.js + bridge present');
        if (a.ng) {
            need(d[R + 'index.html'] && !checkNgIndex(d[R + 'index.html'].toString(), ngTags(a), a), 'twitchng tags in release/index.html, no analytics tags');
            for (const [from, to] of NG_WEB) need(d[R + to] && sha256(d[R + to]) === sha256(fs.readFileSync(path.join(BRAND_DIR, from))), to + ' byte-identical');
            const mj = d[R + 'githubio/js/main.js'] ? d[R + 'githubio/js/main.js'].toString() : '';
            for (const p of ngMain(a.title)) need(mj.indexOf(p.from) < 0 || p.to.indexOf(p.from) >= 0, 'main.js patched: ' + p.what);
            need(d[R + NG_EMPTY[1]] && sha256(d[R + NG_EMPTY[1]]) === sha256(fs.readFileSync(path.join(BRAND_DIR, 'variants', a.icon, NG_EMPTY[0]))), NG_EMPTY[1]);
            for (const f of NG_PRUNE) need(!d[R + f], 'pruned ' + f);
            need(mj.indexOf('values:[.25,.5,.75,1,1.25,1.5,2],defaultValue:3') >= 0, 'main.js speed values');
        }
    }
    if (a.ng) {
        for (const [from, to] of NG_ASSETS) need(d[A + to] && sha256(d[A + to]) === sha256(fs.readFileSync(path.join(BRAND_DIR, 'variants', a.icon, from))), to + ' (brand ' + a.icon + ')');
        need(ai && ai.icon === 'assets/icon.png' && ai.largeIcon === 'assets/largeIcon.png' && ai.splashBackground === 'assets/splash.png' && ai.iconColor === NG.iconColor[a.icon], 'appinfo brand fields');
    }
    need(!fs.existsSync(path.join(a.repoDir || '', 'LICENSE')) || (d[A + 'LICENSE'] && /GNU GENERAL PUBLIC LICENSE/.test(d[A + 'LICENSE'].toString().slice(0, 200))), 'LICENSE (GPL text) in the app');
    const names = Object.keys(d);
    return { errs, files: names.length, bytes: names.reduce((n, k) => n + d[k].length, 0) };
}

function main() {
    if (+process.versions.node.split('.')[0] < 18) die('Node >= 18 required (found ' + process.version + ')');
    const a = parseArgs(process.argv.slice(2));
    const sid = a.id + '.hls';
    console.log('sttv-speed ' + ENGINE_VER + ' -> ' + a.id + ' ' + a.version + ' (' + a.mode + ', v2b default ' + a.v2b + (a.ng ? ', ' + a.title + ', icon ' + a.icon : '') + ')');
    if (a.ng && (/^(A|L3|L4)$/.test(a.icon) || /twitch/i.test(a.title) || /twitch/i.test(a.id))) console.log('note: Twitch trademarks in ' + [a.icon === 'A' ? 'the icon (Glitch)' : /^L[34]$/.test(a.icon) ? 'the icon style (Twitch purple + outline look, own artwork)' : '', /twitch/i.test(a.title) ? 'the name' : '', /twitch/i.test(a.id) ? 'the app id' : ''].filter(Boolean).join(', ') + ' - fine for your own TV; for a public release use --icon B|C, --title and --id without "Twitch"');
    fs.mkdirSync(a.out, { recursive: true });
    const repo = getRepo(a);
    a.repoDir = repo.dir;
    const stage = path.join(a.out, 'stage');
    fs.rmSync(stage, { recursive: true, force: true });

    step('web app: upstream release + bridge (prepareHostedRelease.js), then sttv-speed');
    run(process.execPath, [path.join(repo.dir, 'tools', 'upstream', 'prepareHostedRelease.js'), '--out-dir', path.join(stage, 'web'), '--channel', 'release']);
    const web = path.join(stage, 'web', 'release');
    const tag = injectEngine(web, a.v2b);
    let brand = null;
    if (a.ng) {
        step('app layer: ' + a.title + ' ' + a.version + ' (twitchng.js/css, icon ' + a.icon + ', main.js + index.html patches)');
        brand = injectBrand(web, a);
        for (const p of brand.main) console.log('  main.js ' + p.n + 'x ' + p.what);
        for (const p of brand.index) console.log('  index.html -' + p.n + ' ' + p.what);
        for (const p of brand.pruned) console.log('  dropped ' + p.path);
    }
    const pruned = a.keepDev ? [] : prune(web);
    if (a.ng) {
        const refs = unusedRefs(web, NG_PRUNE.map((f) => path.basename(f)));
        if (refs.length) die('dropped files are still referenced (keep them or patch the reference): ' + refs.join('; '));
    }
    let upstreamWeb = null;
    try { const v = readJson(path.join(web, 'githubio', 'version', 'version.json')); upstreamWeb = { WebVersion: v.WebVersion, WebTag: v.WebTag }; } catch (e) {}

    step('wrapper app ' + a.id);
    const app = path.join(stage, 'app');
    fs.cpSync(path.join(repo.dir, 'webos', 'app'), app, { recursive: true });
    const ai = readJson(path.join(app, 'appinfo.json'));
    const base = { id: ai.id, version: ai.version, title: ai.title };
    const ngPre = a.ng ? ngPreRelease() : null;
    Object.assign(ai, { id: a.id, version: a.version, title: a.title,
        appDescription: a.ng ? a.title + ' ' + a.version + (ngPre === null ? '' : ' (pre-release' + (ngPre ? ' ' + ngPre : '') + ')')
            + ' - unofficial client for Twitch on LG webOS, pitch-preserving VOD speed'
            : String(ai.appDescription || 'SmartTwitchTV') + ' + sttv-speed ' + ENGINE_VER + ' (pitch-preserving VOD speed)' });
    if (a.ng) brandApp(app, ai, a);
    writeJson(path.join(app, 'appinfo.json'), ai);
    // GPL-3.0 sections 4 + 6: every copy of the app carries the license text (a file in the package, not UI)
    const license = fs.existsSync(path.join(repo.dir, 'LICENSE')) ? 'LICENSE' : null;
    if (license) fs.copyFileSync(path.join(repo.dir, 'LICENSE'), path.join(app, 'LICENSE'));
    const target = a.mode === 'local' ? 'release/index.html' : a.targetUrl;
    patchTarget(path.join(app, 'index.js'), target);
    let pages = null;
    if (a.mode === 'local') fs.cpSync(web, path.join(app, 'release'), { recursive: true });
    else {
        pages = path.join(a.out, 'pages');
        fs.rmSync(pages, { recursive: true, force: true });
        fs.cpSync(web, path.join(pages, 'release'), { recursive: true });
        fs.writeFileSync(path.join(pages, '.nojekyll'), '');
    }

    step('service ' + sid + ' + sttv_media_fetch.js');
    const svc = path.join(stage, 'service');
    fs.cpSync(path.join(repo.dir, 'webos', 'service'), svc, { recursive: true });
    const sj = readJson(path.join(svc, 'services.json')), pj = readJson(path.join(svc, 'package.json'));
    if (!Array.isArray(sj.services) || sj.services.length !== 1) die('services.json: expected exactly one service');
    sj.id = sid; sj.services[0].name = sid; pj.name = sid;
    if (a.ng) sj.description = pj.description = a.title + ' local HLS playlist service';   // standalone app: own name in the metadata
    writeJson(path.join(svc, 'services.json'), sj);
    writeJson(path.join(svc, 'package.json'), pj);
    fs.copyFileSync(SVC_EXT, path.join(svc, 'sttv_media_fetch.js'));
    const mainFile = pj.main || 'hls_service.js';
    insertHook(path.join(svc, mainFile));
    run(process.execPath, ['--check', path.join(svc, mainFile)]);
    const selftest = serviceSelfTest(svc, mainFile, sid);
    console.log('service self-test: ' + JSON.stringify(selftest));

    const info = {
        kit: ENGINE_VER, builtAt: new Date().toISOString(), node: process.version,
        base: { source: repo.source, ref: repo.ref, commit: repo.commit, tags: repo.tags, dirty: repo.dirty, app: base, upstreamWeb,
            bridgeSha256: sha256(fs.readFileSync(path.join(web, 'githubio', 'js', 'webosCompatBridge.js'))) },
        app: { id: a.id, version: a.version, preRelease: a.ng ? ngPre : undefined, title: a.title, mode: a.mode, target, serviceId: sid, v2bDefault: a.v2b, brand: a.brand, engine: ENGINE_VER },
        brand: brand ? { name: 'twitchng', icon: a.icon, sourceUrl: a.sourceUrl || null, tags: brand.tags, mainPatches: brand.main, indexDropped: brand.index,
            pruned: brand.pruned, mainSha256: brand.mainSha256,
            files: Object.fromEntries(NG_WEB.map(([f]) => [f, sha256(fs.readFileSync(path.join(BRAND_DIR, f)))])
                .concat(NG_ASSETS.concat([NG_EMPTY]).map(([f]) => ['variants/' + a.icon + '/' + f, sha256(fs.readFileSync(path.join(BRAND_DIR, 'variants', a.icon, f)))]))) } : null,
        injected: { tag, hook: HOOK, files: Object.fromEntries(ENGINE_FILES.map((f) => [f, sha256(fs.readFileSync(path.join(ENGINE_DIR, f)))]).concat([['sttv_media_fetch.js', sha256(fs.readFileSync(SVC_EXT))]])) },
        pruned, license: license ? 'GPL-3.0-or-later (LICENSE in the app dir)' : null, pages: pages ? { dir: pages, publishAs: a.targetUrl } : null, ipk: null
    };
    if (a.pkg) {
        const ares = findAres(a);
        if (!ares) die('ares-package not found: npm i -g @webos-tools/cli (or --ares PATH, or --no-package)');
        step('package (' + ares + ')');
        const ipkName = a.id + '_' + a.version + '_all.ipk', ipk = path.join(a.out, ipkName);
        fs.rmSync(ipk, { force: true });
        run(ares, ['--no-minify', app, svc, '-o', a.out]);      // byte-identical files (ares-package minifies JS by default)
        if (!fs.existsSync(ipk)) die('ares-package did not produce ' + ipk);
        const v = verifyIpk(ipk, a, tag, sid, mainFile);
        if (v.errs.length) die('IPK check failed: ' + v.errs.join('; '));
        const buf = fs.readFileSync(ipk);
        info.ipk = { file: ipkName, bytes: buf.length, sha256: sha256(buf), files: v.files, unpackedBytes: v.bytes,
            ares: (run(ares, ['--version'], { capture: true }).stdout || '').trim() };
        fs.writeFileSync(path.join(a.out, 'SHA256SUMS'), info.ipk.sha256 + '  ' + ipkName + '\n');
        console.log('IPK ok: ' + ipk + ' (' + (buf.length / 1048576).toFixed(1) + ' MB, ' + v.files + ' files, sha256 ' + info.ipk.sha256 + ')');
    } else console.log('--no-package: staged dirs in ' + stage);
    writeJson(path.join(a.out, 'build-info.json'), info);
    const ipkName = a.id + '_' + a.version + '_all.ipk';
    console.log('\nInstall (Developer Mode, device set up with ares-setup-device):  ares-install -d <device> ' + ipkName);
    console.log("Install (root SSH / Homebrew Channel):  scp " + ipkName + " root@TV:/tmp/ && ssh root@TV \"luna-send -i -f " +
        "luna://com.webos.appInstallService/dev/install '{\\\"id\\\":\\\"" + a.id + "\\\",\\\"ipkUrl\\\":\\\"/tmp/" + ipkName + "\\\",\\\"subscribe\\\":true}'\"");
    if (pages) console.log('Publish ' + pages + '/ so that ' + a.targetUrl + ' serves pages/release/index.html');
}

main();
