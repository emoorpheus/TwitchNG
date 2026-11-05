// SVG sources -> PNG assets of the Twitch NG brand layer (Chromium via Playwright, like the kit tests).
//   node brand/twitchng/src/render.mjs
//   -> brand/twitchng/variants/{L3,L4,A,B,C}/{icon.png 512, icon-130.png, icon-80.png, splash.png 1920x1080, empty.png 512}
//   -> brand/twitchng/{icon.png, icon-130.png, icon-80.png, splash.png} = variant L3 (the build default, --icon L3)
//   -> brand/twitchng/preview.png: all variants at launcher sizes 130 / 80 + splash + in-app logo
// splash.png: 8-bit palette PNG via src/pngpal.py (python3 + Pillow + numpy; backdrop exact, ~0.21 MB), else 24-bit (~0.54 MB)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const SRC = path.dirname(fileURLToPath(import.meta.url)), OUT = path.dirname(SRC);
const exe = process.env.CHROMIUM || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(svgFile, w, h, out) {
  const svg = fs.readFileSync(path.join(SRC, svgFile), 'utf8').replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:#000">${svg}</body></html>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
  console.log(path.relative(OUT, out), w + 'x' + h, fs.statSync(out).size + ' B');
}
const V = ['L3', 'L4', 'A', 'B', 'C'], DEF = 'L3';
for (const v of V) {
  const d = path.join(OUT, 'variants', v);
  await render(`icon-${v}.svg`, 512, 512, path.join(d, 'icon.png'));
  await render(`icon-${v}.svg`, 130, 130, path.join(d, 'icon-130.png'));
  await render(`icon-${v}.svg`, 80, 80, path.join(d, 'icon-80.png'));
  await render(`splash-${v}.svg`, 1920, 1080, path.join(d, 'splash.png'));
  const pal = spawnSync('python3', [path.join(SRC, 'pngpal.py'), path.join(d, 'splash.png')], { stdio: 'inherit' });
  if (pal.status !== 0) console.log(`  splash ${v}: palette step skipped (needs python3 + Pillow + numpy), kept 24-bit`);
  fs.copyFileSync(path.join(d, 'icon.png'), path.join(d, 'empty.png'));      // empty-screen banner image in the app
}
for (const f of ['icon.png', 'icon-130.png', 'icon-80.png', 'splash.png']) fs.copyFileSync(path.join(OUT, 'variants', DEF, f), path.join(OUT, f));
// review sheet
const b64 = (v, f) => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'variants', v, f)).toString('base64');
const src = (f) => fs.existsSync(path.join(SRC, f)) ? fs.readFileSync(path.join(SRC, f), 'utf8').trim() : '';
const LOGO = Object.fromEntries(V.map((v) => [v, src(`logo-${v}.svg`)])), MARK = Object.fromEntries(V.map((v) => [v, src(`mark-${v}.svg`)]));
const TV = 'свой рисунок в стиле Twitch: для себя / GitHub; для магазина — B или C';
const label = { L3: ['L3 · телевизор (по умолчанию)', TV, '#c9a4ff'], L4: ['L4 · телевизор + play', TV, '#c9a4ff'],
  A: ['A · Glitch + NG', 'личное использование: Glitch = товарный знак Twitch', '#ff9f43'],
  B: ['B · свой знак + NG', 'можно публиковать (с названием без «Twitch»)', '#2ecc71'],
  C: ['C · текст «NG»', 'можно публиковать (с названием без «Twitch»)', '#2ecc71'] };
const tile = (v, s) => `<div style="display:inline-block;margin-right:${s === 130 ? 22 : 16}px;vertical-align:bottom;text-align:center">
  <img src="${b64(v, s === 130 ? 'icon-130.png' : 'icon-80.png')}" width="${s}" height="${s}" style="display:block;border-radius:${s === 130 ? 14 : 9}px;box-shadow:0 6px 18px rgba(0,0,0,.55)">
  <div style="margin-top:8px;font:13px Arial,sans-serif;color:#8a8a8a">${s} px</div></div>`;
const dummy = (s, c) => `<div style="display:inline-block;width:${s}px;height:${s}px;margin-right:${s === 130 ? 22 : 16}px;border-radius:${s === 130 ? 14 : 9}px;background:${c};opacity:.55;vertical-align:bottom;margin-bottom:23px"></div>`;
const inapp = (v) => LOGO[v] ? `<div style="width:300px">${LOGO[v].replace('class="ng-logo"', 'style="width:300px;height:auto;display:block"')}</div>`
  : `<div style="display:flex;align-items:center;gap:14px"><div style="width:64px;height:64px">${MARK[v].replace('class="ng-mark"', 'style="width:64px;height:64px;display:block"')}</div><span style="font:bold 40px Roboto,Arial,sans-serif;color:#fff">NG Player</span></div>`;
const col = (v) => `<div style="width:560px;padding:26px 28px;background:#0b0b0b;border-radius:16px;border:1px solid #222">
  <div style="font:bold 26px Arial,sans-serif;color:#fff">${label[v][0]}</div><div style="margin:6px 0 20px;font:15px Arial,sans-serif;color:${label[v][2]}">${label[v][1]}</div>
  <div style="background:#1c1d22;border-radius:12px;padding:18px 18px 6px;white-space:nowrap">${dummy(130, '#3a3d46')}${tile(v, 130)}${dummy(130, '#555a66')}</div>
  <div style="background:#1c1d22;border-radius:12px;padding:14px 18px 4px;margin-top:12px;white-space:nowrap">${dummy(80, '#3a3d46')}${tile(v, 80)}${dummy(80, '#555a66')}${dummy(80, '#3a3d46')}</div>
  <div style="margin-top:16px;font:13px Arial,sans-serif;color:#8a8a8a">заставка 1920×1080</div>
  <img src="${b64(v, 'splash.png')}" width="504" height="283" style="display:block;margin-top:6px;outline:1px solid #2a2a2a">
  <div style="margin-top:16px;font:13px Arial,sans-serif;color:#8a8a8a">логотип в приложении${LOGO[v] ? '' : ' (пример названия)'}</div>
  <div style="margin-top:10px;height:80px;background:#000;display:flex;align-items:center;justify-content:center">${inapp(v)}</div></div>`;
await page.setViewportSize({ width: 1990, height: 900 });
await page.setContent(`<html><body style="margin:0;background:#141414;padding:28px 30px">
<div style="font:bold 30px Arial,sans-serif;color:#fff;margin-bottom:6px">Twitch NG — варианты значка (лаунчер LG: 130 / 80 px)</div>
<div style="font:15px Arial,sans-serif;color:#9a9a9a;margin-bottom:22px">сборка: node build/build-app.mjs --brand twitchng --icon L3|L4|A|B|C (по умолчанию L3) [--title "Название"] · соседние плитки — серые заглушки</div>
<div style="display:flex;flex-wrap:wrap;gap:26px;width:1920px">${V.map(col).join('')}</div></body></html>`);
await page.screenshot({ path: path.join(OUT, 'preview.png'), fullPage: true });
console.log('preview.png');
await page.close(); await browser.close();
process.exit(0);
