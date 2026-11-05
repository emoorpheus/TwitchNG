// Node-side helpers (fs); the box code itself is browser-safe in mp4box.mjs.
import fs from 'node:fs';
import { boxes } from './mp4box.mjs';
export * from './mp4box.mjs';
// { init: Uint8Array(ftyp+moov), frags: [Uint8Array(moof+mdat)] }
export function split(file) {
  const u8 = new Uint8Array(fs.readFileSync(file)), bs = boxes(u8);
  const moovEnd = bs.find((b) => b.type === 'moov').end, frags = [];
  for (let i = 0; i < bs.length; i++) if (bs[i].type === 'moof' && bs[i + 1] && bs[i + 1].type === 'mdat') frags.push(u8.slice(bs[i].start, bs[i + 1].end));
  return { init: u8.slice(0, moovEnd), frags };
}
