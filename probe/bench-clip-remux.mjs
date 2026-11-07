#!/usr/bin/env node
// probe/bench-clip-remux.mjs - Run MP4 -> fMP4 remuxing benchmark on TV hardware via CDP
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchJsCode = fs.readFileSync(path.join(here, 'bench-clip-remux.js'), 'utf8');

const tvHost = process.argv[2] || process.env.TV_HOST || '127.0.0.1';
const port = 9998;

async function cdpRequest(endpoint) {
  const res = await fetch(`http://${tvHost}:${port}${endpoint}`);
  return res.json();
}

async function runBenchmarkOnTV() {
  console.log(`Connecting to TV at ${tvHost}:${port}...`);
  const targets = await cdpRequest('/json/list');
  const target = targets.find((t) => (t.title && t.title.includes('Twitch NG')) || (t.url && t.url.includes('com.twitchng.tv')));
  if (!target) {
    throw new Error('Twitch NG app target not found on TV! Is the app running?');
  }
  console.log(`Found target: ${target.title} (${target.id})`);

  const wsUrl = target.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let idCounter = 1;
  function sendCdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      const handler = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  console.log('Injecting bench-clip-remux.js into TV runtime...');
  await sendCdp('Runtime.evaluate', { expression: benchJsCode, returnByValue: false });

  console.log('Running 30-second 1080p60 clip remux benchmark on TV...');
  const res30 = await sendCdp('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__STTV_BENCH_CLIP_REMUX.run(30))',
    returnByValue: true
  });
  const data30 = JSON.parse(res30.result.value);

  console.log('Running 60-second 1080p60 clip remux benchmark on TV...');
  const res60 = await sendCdp('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__STTV_BENCH_CLIP_REMUX.run(60))',
    returnByValue: true
  });
  const data60 = JSON.parse(res60.result.value);

  // Get heap memory
  const memRes = await sendCdp('Runtime.evaluate', {
    expression: 'JSON.stringify({ usedJSHeap: performance.memory ? performance.memory.usedJSHeapSize : null, totalJSHeap: performance.memory ? performance.memory.totalJSHeapSize : null })',
    returnByValue: true
  });
  const memData = JSON.parse(memRes.result.value);

  ws.close();

  const report = {
    tvHost: '$TV_HOST',
    timestamp: new Date().toISOString(),
    memory: memData,
    bench30s: data30,
    bench60s: data60
  };

  console.log('\n=== LG OLED TV 1080p60 Clip Remux Benchmark Results ===');
  console.log(`30s Clip (1800 frames 1080p60, ${data30.totalDataMB} MB):`);
  console.log(`  - moov Parse Time:     ${data30.moovParseMs} ms`);
  console.log(`  - init Generation:     ${data30.initGenMs} ms`);
  console.log(`  - Total Remux Time:    ${data30.totalRemuxMs} ms (for 30s of 1080p60!)`);
  console.log(`  - Avg Time per 1s GOP: ${data30.avgPerGopMs} ms (min ${data30.minPerGopMs} ms, max ${data30.maxPerGopMs} ms)`);
  console.log(`  - Throughput:          ${data30.throughputMBs} MB/s`);
  console.log(`  - Realtime Overhead:   ${data30.overheadPct}% of realtime playback`);
  console.log(`  - Verdict:             ${data30.verdict}`);

  console.log(`\n60s Clip (3600 frames 1080p60, ${data60.totalDataMB} MB):`);
  console.log(`  - moov Parse Time:     ${data60.moovParseMs} ms`);
  console.log(`  - init Generation:     ${data60.initGenMs} ms`);
  console.log(`  - Total Remux Time:    ${data60.totalRemuxMs} ms (for 60s of 1080p60!)`);
  console.log(`  - Avg Time per 1s GOP: ${data60.avgPerGopMs} ms (min ${data60.minPerGopMs} ms, max ${data60.maxPerGopMs} ms)`);
  console.log(`  - Throughput:          ${data60.throughputMBs} MB/s`);
  console.log(`  - Realtime Overhead:   ${data60.overheadPct}% of realtime playback`);
  console.log(`  - Verdict:             ${data60.verdict}`);

  const outDir = path.join(here, '../docs/benchmarks');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, '2026-11-07-tv-clip-remux-cost.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport saved to: ${outPath}`);
  return report;
}

runBenchmarkOnTV().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
