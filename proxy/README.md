# sttv-cors-proxy (optional)

Needed only if the probe reports `audioFetch: network_or_cors` AND the app-service patch is not used.

A machine in the TV's LAN (`<lan-host>` below), any of:

```sh
node sttv-cors-proxy.js --port 8787
# or docker
docker run -d --name sttv-proxy --restart unless-stopped -p 8787:8787 \
  -v "$PWD/sttv-cors-proxy.js:/app/p.js:ro" node:20-alpine node /app/p.js --quiet
# or systemd: see sttv-cors-proxy.service
```

TV (DevTools console or `node sttv-cdp.mjs eval ...`):

```js
STTVSpeed.setProxy('http://<lan-host>:8787/')   // STTVSpeed.setProxy(null) to remove
```

Only Twitch media hosts (`*.cloudfront.net`, `*.ttvnw.net`, `*.jtvnw.net`, `*.live-video.net`, `*.akamaized.net`, `*.twitch.tv`) and media paths (`.m3u8 .ts .mp4 .m4s .m4a .aac`) are allowed.

## Safety (1.1.0)

- **LAN clients only.** Requests from addresses outside loopback / RFC 1918 / `100.64/10` (CGNAT, e.g. Tailscale) /
  link-local / IPv6 ULA get `403`, so a machine with a public address is not an open proxy. `--allow-public`
  (or `STTV_PROXY_ALLOW_PUBLIC=1`) turns this off; do not use it on a machine reachable from the internet.
- **Upstream:** `https` only (redirects re-checked, at most 3), default port, no `user:pass@`, the hosts and
  file types above. URL length is capped at 4096 characters.
- **Responses:** `Content-Type` comes from the file extension (never from the CDN), plus
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`: anyone can host
  files on `cloudfront.net` / `akamaized.net`, and such a file must not run as a web page on your LAN origin.
  Upstream cookies and other headers are not passed on.
- Logs (without `--quiet`) contain host + the end of the path, never the query string (Twitch tokens).
- Tests: `node tests/proxy/run.mjs` (no network needed).

