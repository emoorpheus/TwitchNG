// hygiene.mjs - nothing private in the repo (it is meant to be published): LAN / public IPv4 literals, local absolute
// paths, e-mail addresses, MAC addresses, tokens / keys, "home" + "lab" wording. Scans every file git would commit (tracked + new,
// minus .gitignore) or, outside git, the whole tree minus the same ignores. Text files only; vendored / generated blobs
// are skipped (VENDORED). A line can opt out with the marker  hygiene:allow  (only for docs that explain these rules).
//   node tests/hygiene.mjs            -> one FAIL line per finding + a summary; exit 1 on findings
// Use placeholders instead: $TV_HOST / <TV_IP> (your TV, see tv.env.example), <lan-host>, 192.0.2.x (RFC 5737 examples).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIT } from './_paths.mjs';

const VENDORED = new Set(['sttv-speed/sttv-hls.min.js', 'probe/gate-media.js', 'tests/e2e/hls.min.js', 'tests/e2e/sttv-hls.min.js']);
const IGNORE_DIRS = /^(?:\.git|node_modules|tests\/testdata|tests\/deploy\/(?:tvroot|bin)|tests\/wav)(?:\/|$)/;
const IGNORE_FILES = /^(?:tv\.env|.*\.local\.env)$/;
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|mp4|m4s|ts|aac|wav|ipk|zip|gz|tgz|7z|pdf|woff2?|ttf|otf)$/i;
const ipOk = (ip) => ip === '127.0.0.1' || ip === '0.0.0.0' || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(ip) || /^255\./.test(ip);
const PRIVATE = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const RULES = [
  // IPv4 literal, not part of a longer dotted number and not a version after "/" (Chrome/120.0.0.0)
  { id: 'ipv4', re: /(?<![\w./-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    bad: (ip) => ip.split('.').every((o) => +o <= 255) && !ipOk(ip), why: (ip) => (PRIVATE.test(ip) ? 'LAN' : 'public') + ' address' },
  { id: 'local-path', re: /\/data\/work\/|\/home\/[a-z_][\w-]*\/|\/Users\/[^/\s'"`]+\/|[A-Za-z]:\\Users\\/g, why: () => 'machine-specific path' },
  { id: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g,
    bad: (m) => !/@(?:example\.(?:com|org|net)|users\.noreply\.github\.com)$/i.test(m) && !/^git@github\.com$/i.test(m), why: () => 'e-mail address' },
  { id: 'mac', re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, why: () => 'MAC address' },
  { id: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_\w{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[\w-]{10,}|\b(?:oauth:|OAuth\s+|Bearer\s+)[A-Za-z0-9._~+/-]{20,}/g,
    why: () => 'token / key' },
  { id: 'home-lab', re: /home[l]ab/gi, why: () => 'personal setup wording (say: a server in your LAN)' },
];

function files() {
  const g = spawnSync('git', ['-C', KIT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  const top = spawnSync('git', ['-C', KIT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (g.status === 0 && top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(KIT))
    return g.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(KIT, f)));
  const out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(KIT, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (IGNORE_DIRS.test(r)) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile() && !IGNORE_FILES.test(e.name)) out.push(r);
    }
  })('');
  return out;
}

let n = 0, hits = 0;
for (const f of files()) {
  if (VENDORED.has(f) || BINARY.test(f) || IGNORE_DIRS.test(f) || IGNORE_FILES.test(path.basename(f))) continue;
  const buf = fs.readFileSync(path.join(KIT, f));
  if (buf.subarray(0, 8192).includes(0)) continue;          // binary
  n++;
  buf.toString('utf8').split('\n').forEach((line, i) => {
    if (line.includes('hygiene:allow')) return;
    for (const r of RULES) {
      for (const m of line.matchAll(r.re)) {
        if (r.bad && !r.bad(m[0])) continue;
        hits++;
        console.log(`FAIL ${f}:${i + 1} ${r.id} (${r.why(m[0])}): ${m[0]}`);
      }
    }
  });
}
console.log(hits ? `FAIL hygiene: ${hits} finding(s) in ${n} text files` : `PASS hygiene: ${n} text files, nothing private`);
process.exit(hits ? 1 : 0);
