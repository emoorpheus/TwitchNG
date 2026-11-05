#!/bin/sh
# Installer/rollback test against a fake TV filesystem (fake ssh = local sh with /media/developer re-rooted).
#   sh run.sh   -> prints PASS/FAIL per check
set -u
T=$(cd "$(dirname "$0")" && pwd); K=$T/../..; FAKE=$T/tvroot; BIN=$T/bin
rm -rf "$FAKE" "$BIN"; mkdir -p "$BIN"
cat > "$BIN/ssh" <<'SSH'
#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; root@*) shift; break ;; *) break ;; esac; done
RW="s#\([^a-zA-Z0-9_]\)/media/developer#\1$FAKE/media/developer#g; s#^/media/developer#$FAKE/media/developer#"
CMD=$(printf '%s' "$*" | sed "$RW")
case "$CMD" in
  "sh -s"*) sed "$RW" > "$FAKE/.script"; eval "set -- ${CMD#sh -s}"; sh "$FAKE/.script" "$@" ;;
  *) sh -c "$CMD" ;;
esac
SSH
cat > "$BIN/luna-send" <<'LUNA'
#!/bin/sh
case "$*" in *fetchPlaylist*ping*) echo '{"returnValue":true,"sttvMedia":true,"pong":true,"version":"fake"}' ;; *) echo '{"returnValue":true}' ;; esac
LUNA
chmod +x "$BIN/ssh" "$BIN/luna-send"
export FAKE PATH="$BIN:$PATH"
APPID=com.tbsniller.smarttwitchwebostv
VER=$(sed -n "s/.*var VERSION = '\([^']*\)'.*/\1/p" "$K/sttv-speed/sttv-speed.js" | head -1)
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
mkapp() { # $1 = root|release, $2 = inline|module
  rm -rf "$FAKE"; A=$FAKE/media/developer/apps/usr/palm/applications/$APPID; S=$FAKE/media/developer/apps/usr/palm/services/$APPID.hls
  D=$A; [ "$1" = release ] && D=$A/release
  mkdir -p "$D/githubio/js" "$S/node_modules/webos-service"
  printf '<html><head></head><body>\n<script src="githubio/js/webosCompatBridge.js"></script>\n<script src="githubio/js/main.js"></script>\n</body></html>\n' > "$D/index.html"
  echo '// bridge' > "$D/githubio/js/webosCompatBridge.js"; echo '// main' > "$D/githubio/js/main.js"
  cat > "$S/node_modules/webos-service/index.js" <<'WS'
function Service(name) { this.name = name; } Service.prototype.register = function (n, cb) { (global.__regs = global.__regs || {})[n] = cb; return {}; };
module.exports = Service;
WS
  if [ "$2" = inline ]; then
    printf '{ "name": "%s.hls", "main": "hls_service.js" }\n' "$APPID" > "$S/package.json"
    printf "'use strict';\nvar Service = require('webos-service');\nvar service = new Service('%s.hls');\nservice.register('fetchPlaylist', function (message) { message.respond({ returnValue: true, orig: true }); });\n" "$APPID" > "$S/hls_service.js"
    # v1.1 leftover appended by a hacked installer
    printf '\ntry { require("./sttv_media_fetch").install(module.exports); } catch (e) {} // sttv-speed\n' >> "$S/hls_service.js"
    echo '// old v1.1 copy' > "$S/sttv_media_fetch.js"
  else
    printf '{ "name": "%s.hls", "main": "./hls_service.js" }\n' "$APPID" > "$S/package.json"
    printf "var Service = require('webos-service'); var client = require('./hls_playlist_client');\nvar service = new Service('%s.hls');\nservice.register('fetchPlaylist', function (m) { client.fetchPlaylist(m.payload, function (r) { m.respond(r); }); });\n" "$APPID" > "$S/hls_service.js"
    printf "module.exports = { fetchPlaylist: function (p, cb) { cb({ returnValue: true, orig: true }); } };\n" > "$S/hls_playlist_client.js"
  fi
  (cd "$FAKE" && find . -type f ! -name '.script' | sort | xargs md5sum) > "$T/orig.md5"
}
svc_ping() { # load the patched service main with the mock webos-service, call fetchPlaylist twice
  (cd "$S" && node -e "
    require('./' + require('./package.json').main.replace(/^\.\//, ''));
    var out = [], f = global.__regs.fetchPlaylist, msg = function (p) { return { payload: p, respond: function (r) { out.push(r); } }; };
    f(msg({ sttvMedia: true, ping: true })); f(msg({ url: 'x' }));
    setTimeout(function () { console.log(JSON.stringify(out)); }, 20);")
}
for L in "root inline" "release module"; do
  # shellcheck disable=SC2086 # intentional split: "<layout> <service>"
  set -- $L; echo "== layout $1 / service $2"
  mkapp "$1" "$2"
  sh "$K/deploy/install.sh" 192.0.2.10 > "$T/install_$1.log" 2>&1; rc=$?
  check "install rc=0 ($1)" "[ $rc = 0 ]"
  check "tag once after bridge" "grep -c 'webosCompatBridge.js\"></script><script src=\"githubio/js/sttv-speed.js?v=$VER\" data-v2b=\"auto\"></script>' '$D/index.html' | grep -q '^1$'"
  check "3 js files" "[ -s '$D/githubio/js/sttv-speed.js' ] && [ -s '$D/githubio/js/sttv-v2b.js' ] && [ -s '$D/githubio/js/sttv-hls.min.js' ]"
  check "one hook line" "[ \$(grep -c sttv_media_fetch '$S/hls_service.js') = 1 ] && grep -q hookService '$S/hls_service.js'"
  [ "$2" = inline ] && check "hook after use strict (line 2)" "sed -n 2p '$S/hls_service.js' | grep -q hookService"
  check "ping=pong, others untouched" "svc_ping | grep -q '\"pong\":true.*\"orig\":true'"
  if [ "$2" = inline ]; then check "no pristine over a v1.1 leftover" "[ ! -d '$FAKE/media/developer/sttv_speed_backups/pristine' ]"
  else check "backup + pristine" "[ -d '$FAKE/media/developer/sttv_speed_backups/pristine' ]"; fi
  FIRST=$(cd "$FAKE/media/developer/sttv_speed_backups" && set -- 20*; echo "$1")
  sleep 1; sh "$K/deploy/install.sh" 192.0.2.10 > "$T/install2_$1.log" 2>&1
  check "re-install idempotent" "[ \$(grep -o 'sttv-speed.js' '$D/index.html' | wc -l) = 1 ] && [ \$(grep -c sttv_media_fetch '$S/hls_service.js') = 1 ]"
  # v1.3: the bridge is backed up (never modified); foreign edits are visible and revertible
  BRF=$D/githubio/js/webosCompatBridge.js; BKR=$FAKE/media/developer/sttv_speed_backups
  check "bridge backed up, untouched, reported" "cmp -s '$BKR/$FIRST/js/webosCompatBridge.js' '$BRF' && grep -q 'bridge: webosCompatBridge.js md5' '$T/install_$1.log'"
  printf 'if (ms.type === 2 && false) startMainHls(ms.uri); // hand edit\n' >> "$BRF"
  XB=$FAKE/media/developer/backups/tv_customizations_x/apps/$APPID.orig_backup/githubio/js; mkdir -p "$XB"
  printf 'if (ms.type === 2 && Hls.isSupported()) startMainHls(ms.uri);\n' > "$XB/webosCompatBridge.js"
  sh "$K/deploy/rollback.sh" 192.0.2.10 --bridge-status > "$T/bstatus_$1.log" 2>&1
  check "--bridge-status sees the hand edit" "grep -q 'webosCompatBridge.js: md5 .*startMainHls lines: 1' '$T/bstatus_$1.log' && grep -q '$FIRST/js/webosCompatBridge.js: md5 .*startMainHls lines: 0' '$T/bstatus_$1.log'"
  check "--bridge-status lists copies in /media/developer/backups" "grep -q 'orig_backup/githubio/js/webosCompatBridge.js: md5 .*Hls.isSupported lines: 1' '$T/bstatus_$1.log'"
  rm -rf "$FAKE/media/developer/backups"
  sh "$K/deploy/rollback.sh" 192.0.2.10 --bridge "$FIRST" > "$T/bridge_$1.log" 2>&1
  check "--bridge restores only the bridge, saves the edited one" "cmp -s '$BKR/$FIRST/js/webosCompatBridge.js' '$BRF' && grep -q startMainHls \$(ls '$BKR'/bridge-*.js | head -1) && [ -s '$D/githubio/js/sttv-speed.js' ] && grep -q 'sttv-speed.js' '$D/index.html'"
  rm -f "$BKR"/bridge-*.js
  printf '// another hand edit\n' >> "$BRF"
  sh "$K/deploy/rollback.sh" 192.0.2.10 > "$T/rollback_$1.log" 2>&1
  check "rollback clean" "grep -q 'clean: no sttv-speed traces' '$T/rollback_$1.log' && [ ! -f '$D/githubio/js/sttv-hls.min.js' ] && [ ! -f '$S/sttv_media_fetch.js' ]"
  sh "$K/deploy/rollback.sh" 192.0.2.10 --restore "$FIRST" > "$T/restore_$1.log" 2>&1
  (cd "$FAKE" && find . -type f ! -name '.script' ! -path './media/developer/sttv_speed_backups/*' | sort | xargs md5sum) > "$T/now.md5"
  check "restore first backup = original files" "diff '$T/orig.md5' '$T/now.md5' >/dev/null"
done
# no built-in TV address (argument or TV_HOST from tv.env); an address that could be read as an ssh option is refused
env -u TV_HOST sh "$K/deploy/install.sh" > "$T/noaddr_install.log" 2>&1; rc=$?
check "install.sh without a TV address: usage, exit 1" "[ $rc = 1 ] && grep -q 'usage:' '$T/noaddr_install.log'"
env -u TV_HOST sh "$K/deploy/rollback.sh" --list > "$T/noaddr_rollback.log" 2>&1; rc=$?
check "rollback.sh without a TV address: usage, exit 1" "[ $rc = 1 ] && grep -q 'usage:' '$T/noaddr_rollback.log'"
TV_HOST=192.0.2.10 sh "$K/deploy/rollback.sh" --list > "$T/envaddr_rollback.log" 2>&1; rc=$?
check "rollback.sh takes TV_HOST" "[ $rc = 0 ] && ! grep -q 'usage:' '$T/envaddr_rollback.log'"
sh "$K/deploy/rollback.sh" '-oProxyCommand=sh -c id' --list > "$T/badaddr_rollback.log" 2>&1; rc=$?
check "address looking like an ssh option is refused" "[ $rc = 1 ] && grep -q 'bad TV address' '$T/badaddr_rollback.log'"
echo "failures: $fails"
