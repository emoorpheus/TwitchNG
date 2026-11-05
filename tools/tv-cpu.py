#!/usr/bin/env python3
"""tv-cpu.py [seconds=10] [regex] - per-thread CPU (100 % = one full core) of processes whose cmdline matches regex.
Runs ON the TV (read-only, /proc only). busybox/procps `top` show a share of ALL cores: one saturated core of three
looks like ~33 %, so a JS thread that is the bottleneck (hls.js transmux, WSOLA) is only visible per thread.
Last line: JSON for scripts."""
import json, os, re, sys, time
D = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
PAT = re.compile(sys.argv[2] if len(sys.argv) > 2 else r'WebAppMgr|type=renderer|type=gpu|flutter|surface-manager|wam')
HZ = os.sysconf('SC_CLK_TCK')
def snap():
    out = {}
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            cmd = open('/proc/%s/cmdline' % pid, 'rb').read().replace(b'\0', b' ').decode('utf8', 'replace').strip()
        except OSError:
            continue
        if not cmd or not PAT.search(cmd):
            continue
        try:
            tids = os.listdir('/proc/%s/task' % pid)
        except OSError:
            continue
        for tid in tids:
            try:
                st = open('/proc/%s/task/%s/stat' % (pid, tid)).read()
                comm = open('/proc/%s/task/%s/comm' % (pid, tid)).read().strip()
            except OSError:
                continue
            f = st[st.rfind(')') + 2:].split()
            out[(pid, tid)] = (int(f[11]) + int(f[12]), comm, cmd[:90])
    return out
a = snap(); t0 = time.time(); time.sleep(D); b = snap(); dt = time.time() - t0
rows = sorted(((v[0] - a[k][0]) / HZ / dt * 100, k[0], k[1], v[1], v[2]) for k, v in b.items() if k in a)[::-1]
procs = {}
for r in rows:
    procs.setdefault(r[1], [0.0, r[4]])[0] += r[0]
P = sorted(procs.items(), key=lambda x: -x[1][0])[:6]
print('cores=%d window=%.1fs' % (os.cpu_count() or 0, dt))
for pid, (pct, cmd) in P:
    print('proc   %6.1f%%  pid=%s  %s' % (pct, pid, cmd))
for r in rows[:12]:
    print('thread %6.1f%%  pid=%s tid=%s  %s' % r[:4])
print('JSON ' + json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'windowS': round(dt, 1), 'cores': os.cpu_count(),
                            'procs': [{'pid': p, 'pct': round(v[0], 1), 'cmd': v[1][:60]} for p, v in P],
                            'threads': [{'pct': round(r[0], 1), 'pid': r[1], 'tid': r[2], 'name': r[3]} for r in rows[:12]]}))
