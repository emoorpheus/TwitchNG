# Security

Twitch NG / sttv-speed is a hobby kit for one kind of device: an LG webOS TV in developer / root
(Homebrew Channel) mode on a home network. This file says what the kit protects, what it cannot protect, and how to
report a problem.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**). Please do
not open a public issue for an unfixed problem, and do not attach TV reports, heap snapshots or logs that contain
your Twitch sign-in (see "Reports and snapshots" below). Problems in the SmartTwitchTV app itself belong upstream
(fgl27/SmartTwitchTV); problems in the TBSniller webOS port belong to that repository.

## What runs where

| Part | Runs on | Privileges | Network |
| --- | --- | --- | --- |
| `sttv-speed/*.js` (engine, v2b, hls.js 1.5.20) | the TV, inside the app's web page | the app's | Twitch CDN media only |
| `deploy/service/sttv_media_fetch.js` | the TV, inside the app's own JS service | the app service's | Twitch CDN media only, https |
| `deploy/install.sh`, `rollback.sh` | your computer, then `ssh root@` the TV | root on the TV | SSH to the TV address you pass |
| `probe/sttv-cdp.mjs` | your computer | DevTools access to the app | the TV's DevTools port (9998) |
| `proxy/sttv-cors-proxy.js` (optional) | a machine in your LAN | an unprivileged user | Twitch CDN media only, https |
| `build/build-app.mjs`, `tests/` | your computer | your user | none at build time; tests fetch public Twitch media |

There is no telemetry and no server of ours: nothing is sent anywhere except media requests to Twitch's CDNs and
what you send yourself (SSH, DevTools).

## What the kit does

- **Media fetch service** (1.2.1): only `payload.sttvMedia === true` calls are handled (everything else reaches the
  app's own handler untouched); https only, also after redirects (max 3, each re-checked); port 443; no
  `user:pass@`; hosts `*.cloudfront.net *.ttvnw.net *.jtvnw.net *.live-video.net *.akamaized.net *.twitch.tv`;
  paths `.m3u8 .ts .mp4 .m4s .m4a .aac`; 8 MB per response; timeouts clamped to 2-30 s; the URL that is checked is
  the URL that is requested. It cannot be pointed at the TV itself or at your LAN. Tests: `tests/service/run.mjs`.
- **LAN proxy** (1.1.0): same upstream rules; answers LAN / loopback clients only (`--allow-public` to override);
  serves media with a `Content-Type` from the file extension, `nosniff` and `Content-Security-Policy: default-src
  'none'; sandbox`, so a file on a shared CDN cannot run as a web page on your LAN origin. Tests: `tests/proxy/run.mjs`.
- **Engine / UI**: no `eval`, no `innerHTML` with remote data (the Twitch NG layer escapes everything it renders),
  no `postMessage` handlers; settings come from `localStorage` keys that only code inside the app can set.
- **Deploy scripts**: no built-in TV address (argument or `TV_HOST`); the address is validated (no `-option`,
  only `[A-Za-z0-9._:-]`); every install makes a backup first, `rollback.sh` restores it. Tests: `tests/deploy/run.sh`.
- **Probe**: everything it prints or saves is redacted by default: URL query strings (Twitch playlist URLs carry a
  signed token with the account id and IP address), `sig=` / `token=` / `access_token=` values, `"access_token": "..."`
  style fields, `Bearer` / `OAuth` values, JWTs. `--raw 1` turns this off for local debugging.
- **Repository**: `tests/hygiene.mjs` fails on LAN / public IPv4 literals, local paths, e-mail and MAC addresses,
  tokens / private keys. Your TV address lives in `tv.env` (git-ignored, see `tv.env.example`).
- **Builds**: `build-info.json` records the source remote without credentials; every IPK ships with `SHA256SUMS`.

## What it cannot protect (know these before you use it)

1. **The TV's DevTools port (9998) is open to your whole LAN** while the web inspector is on. Anyone on the network
   can then run code inside the app, read its memory and its `localStorage`, including your Twitch sign-in token.
   Use it on a network you trust (not guest Wi-Fi, not a shared flat network), and turn the inspector off when
   you are not testing.
2. **Root SSH on the TV.** The Homebrew Channel SSH server is root and ships with a well-known default password: set
   an SSH key, then disable password login (or turn SSH off when you do not need it).
3. **Reports and snapshots.** Redaction covers the probe's JSON; it cannot cover a heap snapshot (`probe ... heap`)
   or screenshots. A heap snapshot is the app's whole memory: analyse it locally, never attach it anywhere.
   Before you share any file, search it for `token`, `oauth` and your user name.
4. **The proxy answers any web page in your LAN** (`Access-Control-Allow-Origin: *` and the private-network
   preflight header are needed by the TV app). It can only fetch public Twitch media, but do not expose it to the
   internet.
5. **Developer-mode apps are unsigned.** `ares-package` IPKs are not signed by LG. Install only builds you made or
   whose SHA-256 matches the published `SHA256SUMS`.
6. **Vendored hls.js 1.5.20** (`sttv-speed/sttv-hls.min.js`, SHA-256 `3d33d813...3f4cbf`): no advisories for hls.js
   in the GitHub Advisory Database when checked (Nov 2026). Upgrading needs a TV test run, so it is a planned task,
   not an automatic one.

## Safe defaults for contributors and AI agents

- Never commit or paste a TV address, LAN address, local path, token, cookie, heap snapshot or raw report;
  `node tests/hygiene.mjs` must pass before every commit (it is part of `tests/run-all.sh`).
- Keep the service and the proxy allowlists identical, https-only and covered by tests; any widening needs a test
  and a note here.
- Do not add network destinations, telemetry, `eval`, or `innerHTML` with remote data.
