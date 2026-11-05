# AGENTS.md

Canonical instructions for AI coding agents (Codex, Claude Code, Gemini CLI, ...) working in this repository.
`CLAUDE.md` only imports this file; keep policy here, in one place.

## Project

- **sttv-speed**: pitch-preserving VOD playback speed (0.25-2x) for SmartTwitchTV on LG webOS 24/25. The engine
  hooks the app's player; where the TV ignores `playbackRate` (webOS 25 native HLS) it switches to **v2b**: a private
  hls.js 1.5.20 + MSE timeline compression, audio through WebAudio WSOLA.
- **Twitch NG (Next-Gen)**: a separate webOS app (`com.twitchng.tv`, version line 1.0.0 + pre-release number), built
  from a SmartTwitchWebOSTV checkout (TBSniller's webOS port of fgl27's SmartTwitchTV) + the engine + the brand layer.
- License GPL-3.0 (upstream). Not affiliated with Twitch.

## Layout

| Path | What |
| --- | --- |
| `sttv-speed/sttv-speed.js` | engine, ES5, `VERSION` here (e.g. `1.3.8`) |
| `sttv-speed/sttv-v2b.js` | v2b MSE hook, ES2015, GPL-3.0-only; `sttv-hls.min.js` vendored hls.js (do not edit) |
| `brand/twitchng/web/twitchng.{js,css}` | Twitch NG layer, ES5: intro, OLED preset, About, What's new; `PRE_N` here |
| `brand/twitchng/web/ng-ui.{css,js}`, `ng-icons.css`, `fonts/` | Next-Gen UI (in the build since pre-release 06, on by default with the OLED preset; `TWITCHNG_UI='0'` = off): `DESIGN.md`; generators `tools/make-ng-{icons.mjs,fonts.py}` (Onest, Lucide sharp), screenshots `tools/ui-lab.mjs` |
| `brand/twitchng/src/` | brand generator: `make_assets.py` (SVG + generated blocks) and `render.mjs` (PNG) |
| `build/build-app.mjs` | builds the IPK from a SmartTwitchWebOSTV checkout (exact `main.js` patches with count checks) |
| `deploy/` | `install.sh` / `rollback.sh` (patch the stock app over SSH), `service/sttv_media_fetch.js` (Luna media fetch) |
| `probe/sttv-cdp.mjs` | DevTools CLI for the TV (`check`, `watch`, `mem`, `report`, `key`, `shot`, ...) |
| `proxy/` | optional LAN CORS proxy |
| `tests/` | sandbox tests (Chromium + Node); `tests/run-all.sh` runs all of them |
| `README.md`, `CODEX_TV_TEST.md`, `ROADMAP.md` | docs in Russian: history and reasons, TV test procedure, plans |
| `SECURITY.md` | threat model, what is protected, residual risks |

## Build and test

```sh
node build/build-app.mjs --repo <SmartTwitchWebOSTV checkout> --brand twitchng --out dist-ng [--ares <ares-package>]
#   -> dist-ng/com.twitchng.tv_1.0.0_all.ipk + SHA256SUMS + build-info.json
sh tests/run-all.sh dist-ng/com.twitchng.tv_1.0.0_all.ipk [logDir]     # the gate: every line must be "ok"
node tests/hygiene.mjs                                                  # nothing private in the repo (part of run-all)
python3 brand/twitchng/src/make_assets.py && node brand/twitchng/src/render.mjs   # after any brand change
```

Needs Node >= 18 (the probe: 22+, or `npm i ws` in `probe/`), Playwright with Chromium (`CHROMIUM=<path>` to override), `ar`, `tar`,
`ares-package` (`npm i -g @webos-tools/cli`) for the IPK, Python 3 + Pillow + numpy for the brand. Test media
(Twitch VOD segments, not redistributed) live in `tests/testdata/` or `$STTV_TESTDATA` (`tests/_paths.mjs`).
A single suite: `node tests/unit.mjs`, `node tests/app/twitchng.mjs <ipk>`, ... (see `tests/run-all.sh`). Memory: `node tests/app/leak.mjs <ipk> [dir] --cycles 20` (speed cycles; heap, DOM, MediaSource, ArrayBuffer, segment cache).

## Rules

1. **Do not modify upstream sources.** The SmartTwitchWebOSTV checkout is input; changes to the app go through
   `build-app.mjs` patches (exact match + count check, the build fails when upstream changes) or the brand layer.
2. **Every fix comes with a test** that fails on the old code and passes on the new one. Never weaken or delete a
   test to make it pass; if a test is wrong, say why in the commit.
3. **Before handing over a build**: `sh tests/run-all.sh <ipk>` is all `ok`; deliver the IPK with its SHA-256.
4. **Versions live in one place each**: engine `VERSION` in `sttv-speed.js`, pre-release `PRE_N` in `twitchng.js`
   (the app itself stays 1.0.0). `probe check` and the tests read them from the sources: do not hardcode versions
   in tests. A new pre-release also needs: the `twitchng.js` header line + What's new (ru and en), the README
   title + status row + section, the `CODEX_TV_TEST.md` header and "what changed".
5. **Generated code is generated**: the `<ng-logo>` block in `twitchng.js`, `brand/twitchng/variants/**`, icons and
   splash come from `make_assets.py` / `render.mjs`. Edit the generator, regenerate, commit both.
6. **Runtime constraints**: `sttv-speed.js`, `twitchng.js` and `sttv_media_fetch.js` stay ES5 (old webOS browsers and
   the TV's Node); `sttv-v2b.js` ES2015. No new dependencies in shipped code.
7. **Security** (details in `SECURITY.md`): no `eval`, no `innerHTML` with remote data, no new network
   destinations or telemetry. The media fetch allowlists (service + proxy) stay https-only and tested.
8. **Nothing private in the repo or in reports**: no TV / LAN addresses (use `$TV_HOST`, `<lan-host>`,
   `192.0.2.x`), local paths, e-mail, tokens, cookies, heap snapshots. The TV address lives in `tv.env`
   (git-ignored, copy `tv.env.example`). The git history ships with the project archive (owner rule below): a
   commit with private data cannot be taken back, so `node tests/hygiene.mjs` before every commit, and the archive
   is checked commit by commit before it is handed over.
9. **Honest status**: sandbox tests (Chromium) are not TV results. Say what was checked where, and what needs the
   TV or a person (sound, pitch, lip-sync, how the icon looks).

## Owner rules

Decisions of the project owner; they win over defaults and habits.

1. **Every reply to the owner attaches all project files**, not only what changed: the project archive **with the git
   history** (a zip that contains `.git`, or a `git bundle` of all commits), the IPK with its SHA-256, the kit zip when
   there is one, and the other files of that reply (screenshots, reports). Commit first, so the archive holds the
   state the reply describes. (pre-release 06)
2. The Russian texts of the app may be fixed freely: counted `main.js` patches in `build/build-app.mjs` (checked by
   `tests/app/twitchng.mjs`) or the `ng-ui.js` text layer. (pre-release 06)
3. Next-Gen UI: font Onest, icons Lucide with sharp corners (variant B); details and rules in `DESIGN.md`. (pre-release 06)

## Working with the TV

Only with access the owner gave you, and only by `CODEX_TV_TEST.md` (its rules win over anything here):

- allowed: copy the IPK to `/tmp`, install / remove **only** `com.twitchng.tv`, launch / close apps, read logs,
  run JS in the app page through `probe/sttv-cdp.mjs`;
- not allowed: touching the stock app `com.tbsniller.smarttwitchwebostv` (no `deploy/install.sh` / `rollback.sh`
  without an explicit request), editing installed files by hand, system settings, reboots, network changes;
- first `node probe/sttv-cdp.mjs check` (build gate: engine, app id, pre-release); stop if it fails;
- never print or save sign-in values from `localStorage` (`AddUser*`, anything with token / oauth / auth): only
  whether a key exists and its length. The probe redacts its output by default; keep it that way (`--raw 1` is for
  local debugging only).

## Communication

- Code, comments, commit messages, `AGENTS.md`, `SECURITY.md`: English. `README.md`, `CODEX_TV_TEST.md`,
  `ROADMAP.md` and replies / reports to the owner: Russian, short, facts first, hypotheses marked as such.
- Plans and ideas go to `ROADMAP.md`; findings from TV runs go to the README section of that release.
