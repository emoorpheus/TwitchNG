// Loads sttv-speed.js into a VM context (no auto-install) and returns its internals.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function loadAddon(extra = {}) {
  const code = fs.readFileSync(path.join(here, '../sttv-speed/sttv-speed.js'), 'utf8');
  const ctx = {
    console, performance, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { language: 'en' }, location: { href: 'https://localhost/' },
    __sttvSpeedNoAutoInstall: true, ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'sttv-speed.js' });
  return ctx.STTVSpeed;
}
