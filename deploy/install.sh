#!/bin/sh
# install.sh 1.3.3 - put sttv-speed into SmartTwitchTV on the TV (root SSH). Idempotent; every run makes a timestamped backup.
#   ./install.sh [TV_IP] [--no-service] [--no-restart] [--v2b=auto|off|force]   (TV_IP default: $TV_HOST, see tv.env.example; v2b auto)
# Layout is auto-detected (index.html at the app root or in release/; JS dir = the dir of webosCompatBridge.js;
# service entry = package.json "main" of services/<app>.hls). What it changes (all reverted by rollback.sh):
#   <jsdir>/sttv-speed.js, sttv-v2b.js, sttv-hls.min.js     new files (the last two are loaded only when v2b is used)
#   <index.html>                                           + <script src=".../sttv-speed.js?v=X" data-v2b="auto"> after webosCompatBridge.js
#                                                          (1.3.1: data-v2b = v2b default; localStorage.STTV_SPEED_V2B still wins;
#                                                          --v2b=off = 1.3 behaviour: v2b only after STTVSpeed.v2b('auto'))
#   services/<app>.hls/sttv_media_fetch.js                 new file (CORS-free fetch for the engine / v2b)
#   services/<app>.hls/<main>.js                           + 1 line after 'use strict' (hookService); v1.1 lines removed
# NOT changed: webosCompatBridge.js. 1.3 backs it up too (rollback.sh --restore puts it back, --bridge restores only it)
# and reports foreign edits (e.g. a startMainHls bypass made by hand): ./rollback.sh TV --bridge-status
set -eu
TV=${TV_HOST:-}; SERVICE=1; RESTART=1; V2B=auto
for a in "$@"; do
  case "$a" in
    --no-service) SERVICE=0 ;;
    --no-restart) RESTART=0 ;;
    --v2b=auto|--v2b=off|--v2b=force) V2B=${a#--v2b=} ;;
    -*) echo "unknown option $a"; exit 1 ;;
    *) TV=$a ;;
  esac
done
[ -n "$TV" ] || { echo "usage: $0 <TV_IP> ... (or export TV_HOST=<TV_IP>, see tv.env.example)" >&2; exit 1; }
case "$TV" in -*|*[!A-Za-z0-9._:-]*) echo "bad TV address: $TV" >&2; exit 1 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../sttv-speed"
SVCJS="$HERE/service/sttv_media_fetch.js"
APPID=com.tbsniller.smarttwitchwebostv
TS=$(date +%Y%m%d-%H%M%S)
VER=$(sed -n "s/.*var VERSION = '\([^']*\)'.*/\1/p" "$SRC/sttv-speed.js" | head -1)
SSH="ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new root@$TV"
for f in sttv-speed.js sttv-v2b.js sttv-hls.min.js; do [ -f "$SRC/$f" ] || { echo "missing $SRC/$f"; exit 1; }; done
[ -f "$SVCJS" ] || { echo "missing $SVCJS"; exit 1; }
echo "== TV $TV, sttv-speed $VER (v2b default $V2B), backup tag $TS"

# 1) detect layout
DET=$($SSH sh -s "$APPID" <<'REMOTE'
set -eu
APPID=$1
APP=/media/developer/apps/usr/palm/applications/$APPID
SVC=/media/developer/apps/usr/palm/services/$APPID.hls
IDX=""
for c in "$APP/release/index.html" "$APP/index.html"; do [ -f "$c" ] && grep -q 'webosCompatBridge' "$c" && { IDX=$c; break; }; done
[ -n "$IDX" ] || for c in "$APP/release/index.html" "$APP/index.html"; do [ -f "$c" ] && { IDX=$c; break; }; done
[ -n "$IDX" ] || { echo "ERR=app_not_found:$APP"; exit 0; }
BR=$(grep -o 'src="[^"]*webosCompatBridge\.js[^"]*"' "$IDX" | head -1 | sed 's/^src="//; s/"$//; s/[?#].*//')
JSREL=githubio/js
[ -n "$BR" ] && JSREL=$(dirname "$BR")
JSDIR=$(dirname "$IDX")/$JSREL
[ -d "$JSDIR" ] || { echo "ERR=jsdir_not_found:$JSDIR"; exit 0; }
MAIN=""
if [ -f "$SVC/package.json" ]; then MAIN=$(sed -n 's/.*"main"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SVC/package.json" | head -1 | sed 's#^\./##'); fi
[ -n "$MAIN" ] && [ -f "$SVC/$MAIN" ] || MAIN=""
if [ -z "$MAIN" ]; then for c in hls_service.js service.js index.js hls_playlist_client.js; do [ -f "$SVC/$c" ] && { MAIN=$c; break; }; done; fi
echo "IDX='$IDX'"; echo "JSDIR='$JSDIR'"; echo "JSREL='$JSREL'"; echo "SVC='$SVC'"; echo "MAIN='$MAIN'"
REMOTE
)
echo "$DET"
case "$DET" in *ERR=*) echo "layout detection failed"; exit 2 ;; esac
eval "$(echo "$DET" | grep -E "^(IDX|JSDIR|JSREL|SVC|MAIN)='")"
[ "$SERVICE" = 1 ] && [ -z "$MAIN" ] && { echo "service entry not found in $SVC: continuing without service (--no-service)"; SERVICE=0; }

# 2) backup on the TV (/media/developer/sttv_speed_backups/<ts>, first clean one also as 'pristine')
$SSH sh -s "$TS" "$IDX" "$JSDIR" "$SVC" <<'REMOTE'
set -eu
TS=$1; IDX=$2; JSDIR=$3; SVC=$4
ROOT=/media/developer/sttv_speed_backups
BK=$ROOT/$TS
mkdir -p "$BK/js" "$BK/svc"
cp -p "$IDX" "$BK/index.html"
echo "$IDX" > "$BK/IDX"; echo "$JSDIR" > "$BK/JSDIR"; echo "$SVC" > "$BK/SVC"
for f in sttv-speed.js sttv-v2b.js sttv-hls.min.js; do [ -f "$JSDIR/$f" ] && cp -p "$JSDIR/$f" "$BK/js/" || true; done
if [ -f "$JSDIR/webosCompatBridge.js" ]; then
  cp -p "$JSDIR/webosCompatBridge.js" "$BK/js/webosCompatBridge.js"
  BMD5=$(md5sum "$JSDIR/webosCompatBridge.js" | cut -c1-32)
  NH=$(grep -c 'startMainHls' "$JSDIR/webosCompatBridge.js" || true)
  NI=$(grep -c 'Hls\.isSupported' "$JSDIR/webosCompatBridge.js" || true)
  echo "bridge: webosCompatBridge.js md5 $BMD5, startMainHls lines: $NH, Hls.isSupported lines: $NI (not modified by this kit; backed up)"
  for c in "$JSDIR"/webosCompatBridge.js?*; do [ -f "$c" ] && echo "bridge: other copy $(basename "$c") md5 $(md5sum "$c" | cut -c1-32)" || true; done
fi
if [ -d "$SVC" ]; then for f in "$SVC"/*.js "$SVC/package.json"; do [ -f "$f" ] && cp -p "$f" "$BK/svc/" || true; done; fi
if [ ! -d "$ROOT/pristine" ] && ! grep -q 'sttv-speed' "$IDX" && ! grep -qs 'sttv_media_fetch' "$SVC"/*.js; then cp -rp "$BK" "$ROOT/pristine"; echo "pristine backup: $ROOT/pristine"; fi
echo "backup: $BK"; ls -la "$BK" "$BK/js" "$BK/svc" | sed 's/^/   /'
REMOTE

# 3) upload (cat over ssh: works without scp/sftp on the TV)
for f in sttv-speed.js sttv-v2b.js sttv-hls.min.js; do
  $SSH "cat > '$JSDIR/$f.new' && mv '$JSDIR/$f.new' '$JSDIR/$f'" < "$SRC/$f"
done
[ "$SERVICE" = 1 ] && $SSH "cat > '$SVC/sttv_media_fetch.js.new' && mv '$SVC/sttv_media_fetch.js.new' '$SVC/sttv_media_fetch.js'" < "$SVCJS"

# 4) edit index.html + service entry, verify, restore the backup on any failure
# (ssh joins arguments into one string: an empty one would vanish - the possibly empty MAIN goes last)
$SSH sh -s "$TS" "$IDX" "$JSREL" "$VER" "$SERVICE" "$SVC" "$APPID" "$V2B" "$MAIN" <<'REMOTE'
set -eu
TS=$1; IDX=$2; JSREL=$3; VER=$4; SERVICE=$5; SVC=$6; APPID=$7; V2B=$8; MAIN=${9:-}
BK=/media/developer/sttv_speed_backups/$TS
TAG='<script src="'$JSREL'/sttv-speed.js?v='$VER'" data-v2b="'$V2B'"></script>'
HOOK="try { require('./sttv_media_fetch').hookService(require('webos-service')); } catch (e) {} // sttv-speed"
fail() {
  echo "FAILED: $1 -> restoring backup $BK"
  cp -p "$BK/index.html" "$IDX"
  for f in "$BK"/svc/*.js; do [ -f "$f" ] && cp -p "$f" "$SVC/" || true; done
  exit 3
}
# index.html: drop older tags (any path / version), insert after the bridge tag (fallback: before main.js)
sed -i 's#<script src="[^"]*sttv-speed\.js[^"]*"[^>]*></script>##g' "$IDX"
sed -i 's#\(<script src="[^"]*webosCompatBridge\.js[^"]*"[^>]*></script>\)#\1'"$TAG"'#' "$IDX"
grep -q 'sttv-speed.js' "$IDX" || sed -i 's#<script src="[^"]*main\.js#'"$TAG"'&#' "$IDX"
[ "$(grep -o 'sttv-speed\.js' "$IDX" | wc -l)" = 1 ] || fail "script tag not inserted exactly once"
grep -q 'webosCompatBridge.js' "$IDX" || echo "warning: webosCompatBridge.js tag not found (tag was put before main.js)"
echo "index.html: tag ok ($TAG)"
if [ "$SERVICE" = 1 ]; then
  # remove v1.1 lines (install(module.exports), wherever an older installer appended them)
  for f in "$SVC"/*.js; do
    [ "$(basename "$f")" = sttv_media_fetch.js ] && continue
    grep -q 'sttv_media_fetch' "$f" && { sed -i '/sttv_media_fetch/d' "$f"; echo "service: removed old hook line from $(basename "$f")"; } || true
  done
  F=$SVC/$MAIN
  SL=$(head -n 20 "$F" | grep -n "^[[:space:]]*[\"']use strict[\"']" | head -1 | cut -d: -f1 || true)
  if [ -z "$SL" ] && head -n 1 "$F" | grep -q '^#!'; then SL=1; fi
  if [ -n "$SL" ]; then awk -v L="$HOOK" -v N="$SL" '{ print } NR == N { print L }' "$F" > "$F.sttv"; else { echo "$HOOK"; cat "$F"; } > "$F.sttv"; fi
  mv "$F.sttv" "$F"
  [ "$(grep -c 'sttv_media_fetch' "$F")" = 1 ] || fail "service hook not inserted exactly once"
  if command -v node >/dev/null 2>&1; then
    node --check "$F" || fail "patched $MAIN has a syntax error"
    (cd "$SVC" && node -e "var m=require('./sttv_media_fetch.js'); if (typeof m.hookService !== 'function') process.exit(5)") || fail "sttv_media_fetch.js does not load"
    echo "service: hook line in $MAIN (line $(grep -n 'sttv_media_fetch' "$F" | cut -d: -f1)), syntax + load ok"
  else
    echo "service: hook line in $MAIN (node not in PATH: load test skipped)"
  fi
  # restart the JS service so the hook is picked up (it is started on demand again). /proc scan: works with busybox ps,
  # and skips this shell + its parent (their command lines contain the service path as an argument)
  for d in /proc/[0-9]*; do
    p=${d#/proc/}; [ "$p" = "$$" ] || [ "$p" = "$PPID" ] && continue
    c=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
    case "$c" in *"services/$APPID.hls"*) kill "$p" 2>/dev/null && echo "service: restarted (pid $p)" || true ;; esac
  done
fi
REMOTE

# 5) restart the app, then ping the service hook
if [ "$RESTART" = 1 ]; then
  $SSH "luna-send -n 1 luna://com.webos.service.applicationmanager/closeByAppId '{\"id\":\"$APPID\"}' >/dev/null 2>&1 || true; sleep 2; luna-send -n 1 luna://com.webos.service.applicationmanager/launch '{\"id\":\"$APPID\"}' >/dev/null" || echo "restart the app manually"
fi
if [ "$SERVICE" = 1 ]; then
  sleep 3
  P=$($SSH "luna-send -n 1 -w 8000 luna://$APPID.hls/fetchPlaylist '{\"sttvMedia\":true,\"ping\":true}' 2>&1" || true)
  case "$P" in
    *pong*) echo "service ping: ok ($P)" ;;
    *) echo "service ping from the shell failed ($P) - check from the app: STTVSpeed.status().net (README 10.4)" ;;
  esac
fi
echo "== done. Kill switch (DevTools): localStorage.STTV_SPEED_MODE='off'; v2b default $V2B (override: STTVSpeed.v2b('off'|'auto')); revert: ./rollback.sh $TV"
