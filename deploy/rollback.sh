#!/bin/sh
# rollback.sh 1.3.3 - remove sttv-speed from the TV.
#   ./rollback.sh [TV_IP]                            (TV_IP default: $TV_HOST, see tv.env.example)
#                                                    remove script tag + service hook line + our files (keeps app updates)
#   ./rollback.sh [TV_IP] --restore <ts|pristine>    copy files back from /media/developer/sttv_speed_backups/<ts>
#                                                    (1.3 backups include webosCompatBridge.js: it is restored too)
#   ./rollback.sh [TV_IP] --list                     list backups
#   ./rollback.sh [TV_IP] --bridge-status            webosCompatBridge.js: md5, startMainHls/Hls.isSupported lines, copies
#   ./rollback.sh [TV_IP] --bridge <ts|/path/file>   restore ONLY webosCompatBridge.js (from a 1.3 backup or a file);
#                                                    the current one is saved first as sttv_speed_backups/bridge-<time>.js
set -eu
TV=${TV_HOST:-}; MODE=remove; TSARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) MODE=restore; TSARG=${2:-pristine}; shift ;;
    --bridge) MODE=bridge; TSARG=${2:-}; shift ;;
    --bridge-status) MODE=bridgestatus ;;
    --list) MODE=list ;;
    *) TV=$1 ;;
  esac
  shift
done
[ -n "$TV" ] || { echo "usage: $0 <TV_IP> ... (or export TV_HOST=<TV_IP>, see tv.env.example)" >&2; exit 1; }
case "$TV" in -*|*[!A-Za-z0-9._:-]*) echo "bad TV address: $TV" >&2; exit 1 ;; esac
APPID=com.tbsniller.smarttwitchwebostv
SSH="ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new root@$TV"
$SSH sh -s "$APPID" "$MODE" "$TSARG" <<'REMOTE'
set -eu
APPID=$1; MODE=$2; TS=${3:-}
APP=/media/developer/apps/usr/palm/applications/$APPID
SVC=/media/developer/apps/usr/palm/services/$APPID.hls
ROOT=/media/developer/sttv_speed_backups
if [ "$MODE" = list ]; then ls -la "$ROOT" 2>/dev/null || echo "no backups"; exit 0; fi
IDXS=""; for c in "$APP/release/index.html" "$APP/index.html"; do [ -f "$c" ] && IDXS="$IDXS $c"; done
BRJS=""
for c in $IDXS; do
  if grep -q 'webosCompatBridge' "$c"; then
    BR=$(grep -o 'src="[^"]*webosCompatBridge\.js[^"]*"' "$c" | head -1 | sed 's/^src="//; s/"$//; s/[?#].*//')
    [ -n "$BR" ] && [ -f "$(dirname "$c")/$BR" ] && { BRJS="$(dirname "$c")/$BR"; break; }
  fi
done
binfo() { echo "$1: md5 $(md5sum "$1" | cut -c1-32), $(wc -c < "$1") bytes, startMainHls lines: $(grep -c 'startMainHls' "$1" || true), Hls.isSupported lines: $(grep -c 'Hls\.isSupported' "$1" || true)"; }
if [ "$MODE" = bridgestatus ]; then
  [ -n "$BRJS" ] || { echo "webosCompatBridge.js not found"; exit 2; }
  binfo "$BRJS"; ls -la "$BRJS"
  for c in "$BRJS"?*; do [ -f "$c" ] && binfo "$c" || true; done
  for c in "$ROOT"/*/js/webosCompatBridge.js "$ROOT"/bridge-*.js; do [ -f "$c" ] && binfo "$c" || true; done
  # copies made outside this kit (e.g. tv_customizations_*/...orig_backup): candidates for --bridge /path for the A/B test
  find /media/developer/backups -name 'webosCompatBridge.js*' -type f 2>/dev/null | head -20 | while read -r c; do binfo "$c"; done
  exit 0
fi
if [ "$MODE" = bridge ]; then
  [ -n "$BRJS" ] || { echo "webosCompatBridge.js not found"; exit 2; }
  case "$TS" in /*) SRCB=$TS ;; "") SRCB="" ;; *) SRCB=$ROOT/$TS/js/webosCompatBridge.js ;; esac
  [ -n "$SRCB" ] && [ -f "$SRCB" ] || { echo "no bridge copy at '${SRCB:-?}' (1.3 backups only; see --bridge-status)"; exit 2; }
  mkdir -p "$ROOT"; SAVE=$ROOT/bridge-$(date +%Y%m%d-%H%M%S).js
  cp -p "$BRJS" "$SAVE"; echo "current bridge saved: $SAVE"
  cp -p "$SRCB" "$BRJS"; echo "bridge restored from $SRCB"; binfo "$BRJS"
fi
if [ "$MODE" = restore ]; then
  BK=$ROOT/$TS
  [ -f "$BK/index.html" ] || { echo "no backup $BK"; exit 2; }
  IDX=$(cat "$BK/IDX" 2>/dev/null || true); [ -n "$IDX" ] || IDX=$(echo $IDXS | awk '{print $1}')
  JSDIR=$(cat "$BK/JSDIR" 2>/dev/null || echo "$(dirname "$IDX")/githubio/js")
  cp -p "$BK/index.html" "$IDX"
  if [ -f "$BK/js/webosCompatBridge.js" ] && [ -f "$JSDIR/webosCompatBridge.js" ] && ! cmp -s "$BK/js/webosCompatBridge.js" "$JSDIR/webosCompatBridge.js"; then
    mkdir -p "$ROOT"; cp -p "$JSDIR/webosCompatBridge.js" "$ROOT/bridge-$(date +%Y%m%d-%H%M%S).js"
    cp -p "$BK/js/webosCompatBridge.js" "$JSDIR/webosCompatBridge.js"; echo "bridge restored from $BK (the changed one was saved in $ROOT)"
  fi
  for f in sttv-speed.js sttv-v2b.js sttv-hls.min.js; do
    if [ -f "$BK/js/$f" ]; then cp -p "$BK/js/$f" "$JSDIR/$f"; elif [ -f "$BK/$f" ]; then cp -p "$BK/$f" "$JSDIR/$f"; else rm -f "$JSDIR/$f"; fi
  done
  if [ -d "$BK/svc" ]; then
    [ -f "$BK/svc/sttv_media_fetch.js" ] || rm -f "$SVC/sttv_media_fetch.js"      # the only file we add there
    for f in "$BK"/svc/*; do [ -f "$f" ] && cp -p "$f" "$SVC/" || true; done
  else
    # v1.0/v1.1 backup layout
    [ -f "$BK/hls_playlist_client.js" ] && cp -p "$BK/hls_playlist_client.js" "$SVC/hls_playlist_client.js" || true
    [ -f "$BK/sttv_media_fetch.js" ] && cp -p "$BK/sttv_media_fetch.js" "$SVC/sttv_media_fetch.js" || rm -f "$SVC/sttv_media_fetch.js"
  fi
  echo "restored from $BK"
elif [ "$MODE" = remove ]; then
  for IDX in $IDXS; do
    sed -i 's#<script src="[^"]*sttv-speed\.js[^"]*"[^>]*></script>##g' "$IDX"
    D=$(dirname "$IDX"); for j in "$D"/githubio/js "$D"/js; do if [ -d "$j" ]; then rm -f "$j/sttv-speed.js" "$j/sttv-v2b.js" "$j/sttv-hls.min.js"; fi; done
  done
  if [ -d "$SVC" ]; then
    for f in "$SVC"/*.js; do [ "$(basename "$f")" = sttv_media_fetch.js ] && continue; grep -q 'sttv_media_fetch' "$f" && sed -i '/sttv_media_fetch/d' "$f" || true; done
    rm -f "$SVC/sttv_media_fetch.js"
  fi
  echo "removed sttv-speed"
fi
# (no grep inside $(...): with set -e a non-matching grep would end the script here, before the service/app restart)
if [ "$MODE" = remove ]; then
  LEFT=""
  for f in $IDXS "$SVC"/*.js; do if [ -f "$f" ] && grep -qs 'sttv-speed\|sttv_media_fetch' "$f"; then LEFT="$LEFT $f"; fi; done
  if [ -n "$LEFT" ]; then echo "WARNING: traces left in:$LEFT"; else echo "clean: no sttv-speed traces"; fi
fi
for d in /proc/[0-9]*; do
  p=${d#/proc/}; [ "$p" = "$$" ] || [ "$p" = "$PPID" ] && continue
  c=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
  case "$c" in *"services/$APPID.hls"*) kill "$p" 2>/dev/null || true ;; esac
done
luna-send -n 1 luna://com.webos.service.applicationmanager/closeByAppId '{"id":"'"$APPID"'"}' >/dev/null 2>&1 || true
sleep 2
luna-send -n 1 luna://com.webos.service.applicationmanager/launch '{"id":"'"$APPID"'"}' >/dev/null 2>&1 || echo "restart the app manually"
REMOTE
