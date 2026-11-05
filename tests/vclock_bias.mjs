// VClock observation bias with a coarse, asynchronously updated currentTime (webOS-like 200 ms steps, 40 ms JS tick).
import fs from 'node:fs';
import vm from 'node:vm';
import { KIT } from './_paths.mjs';
function load(file) {
  const ctx = { console, performance, URL, setTimeout, clearTimeout, setInterval, clearInterval, navigator: { language: 'en' }, location: { href: 'https://localhost/' }, __sttvSpeedNoAutoInstall: true };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(file, 'utf8'), ctx); return ctx.STTVSpeed._internals;
}
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
function run(I, speed, step, tick) {
  const errs = [];
  for (let trial = 0; trial < 40; trial++) {
    const vc = new I.VClock(), phase = rnd() * step; let tw = 10 + rnd();
    for (let k = 0; k < 400; k++) {
      tw += tick * (0.8 + 0.4 * rnd());                       // jittery setInterval
      const tu = Math.floor((tw - phase) / step) * step + phase; // last pipeline update <= tw
      const ct = 100 + tu * speed;
      vc.sample(ct, tw, speed);
      if (k > 60 && vc.ready()) errs.push(vc.estimate(tw, speed) - (100 + tw * speed));
    }
  }
  const m = errs.reduce((a, b) => a + b, 0) / errs.length, sd = Math.sqrt(errs.reduce((a, b) => a + (b - m) ** 2, 0) / errs.length);
  return { meanMs: +(m * 1000).toFixed(1), sdMs: +(sd * 1000).toFixed(1) };
}
const v10 = load(process.env.STTV_OLD_ENGINE || KIT + 'sttv-speed/sttv-speed.js'), v11 = load(KIT + 'sttv-speed/sttv-speed.js');
const rows = [];
for (const [speed, step, tick] of [[1.5, 0.2, 0.04], [2, 0.2, 0.04], [1.5, 0.25, 0.04], [1.5, 0.1, 0.04], [1.5, 0.04, 0.04], [1.5, 0.016, 0.04]])
  rows.push({ speed, stepMs: step * 1000, tickMs: tick * 1000, v10: JSON.stringify(run(v10, speed, step, tick)), v11: JSON.stringify(run(v11, speed, step, tick)) });
console.table(rows);
