# Roadmap Item 13: Smooth VOD Restore (Engine 1.3.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 10–24s stall when restoring native 1× playback from VOD speedup (1.5×/2×) by tracking advancing playback without in-segment seeks and nudging frozen decoders early.

**Architecture:** Update `v2bRestoreWatch` in `sttv-speed/sttv-speed.js` to detect forward playback progression (`ct > lastCt + 0.1`) within 15s of `p0`, eliminate harmful `currentTime = p0 + 0.05` seeking that flushes decoder pipelines, and add a 1.5s nudge for stalled decoders with `readyState >= 3`. Bump Engine version to `1.3.9`.

**Tech Stack:** JavaScript (ES5 for TV engine compatibility), Node.js test runners, Playwright CDP, webOS Luna API.

**Spec:** `ROADMAP.md` (Item 13) and `docs/engineering-notes.ru.md` (§17.4 D3 observation).

## Global Constraints
- Target platform: LG webOS 24 / webOS 10.3.0 (Chromium 120), backward compatible down to webOS 3.x.
- Engine code in `sttv-speed/sttv-speed.js` must remain strictly valid ES5 (no `const`, `let`, arrow functions, `async/await` in engine code).
- UI and OLED themes must remain untouched; True Black (`#000`) and lavender accents preserved.
- All test gates in `tests/app/twitchng.mjs`, `tests/probe/cdp-cli.mjs`, and `tests/hygiene.mjs` must pass.
- Verification on physical LG OLED TV (`$TV_HOST`) before completion.

## Review Focus
1. Backward playback start: webOS native HLS resumes at segment keyframe (e.g. `p0 - 0.8s`). The watchdog must mark `v2b_restore_ok` once `ct` advances, even if `ct <= p0 + 0.3`.
2. Stalled decoder with `readyState >= 3`: Video paused or decoder pipeline stopped without playback advance for >1.5s must be nudged via `applyNative(v, 1)` + `v.play()` without seeking.
3. Severe seek drift: If `ct` is more than 4s away from `p0`, only then attempt a seek to `p0`.
4. User pause during restore: If the user pauses the video while restore is pending (`ctl.userPauseAt > r.at`), watchdog must stop cleanly without marking stuck.
5. Engine version propagation: `VERSION = '1.3.9'` must be correctly reflected in `STTVSpeed.status()`, `TwitchNG.state()`, About dialog, and test assertions.

---

### Task 1: Create Dedicated Unit Test for Smooth VOD Restore
**Files:**
- Create: `tests/app/restore-unit.mjs`
- Test: `tests/app/restore-unit.mjs`

- [ ] Write `tests/app/restore-unit.mjs` testing:
  1. Restore with keyframe start (`ct = p0 - 0.5s`) advancing forward -> fires `v2b_restore_ok` within 1s without nudges.
  2. Restore with frozen decoder (`ct` motionless, `readyState = 3`) -> fires early nudge at ~1.6s without mutating `currentTime` if within segment.
  3. Severe drift (`ct = p0 - 10s`) -> applies seek to `p0` on nudge.
  4. User pause during restore -> aborts watchdog without `v2b_restore_stuck`.
- [ ] Run `node tests/app/restore-unit.mjs` and confirm it fails on existing 1.3.8 engine.

### Task 2: Implement Engine 1.3.9 in `sttv-speed/sttv-speed.js`
**Files:**
- Modify: `sttv-speed/sttv-speed.js:12-25, 2308-2345`

- [ ] Bump `VERSION = '1.3.9'` in `sttv-speed/sttv-speed.js`.
- [ ] Refactor `v2bRestoreWatch(v, r)`:
  - Track `lastCt` and `lastCtAt`.
  - Check forward progression: `(lastCt >= 0 && ct > lastCt + 0.1 && Math.abs(ct - p0) < 15)`.
  - Remove `v.currentTime = p0 + 0.05` seek within same segment.
  - Add early nudge at `t > 1500 && v.readyState >= 3 && (tn - lastCtAt > 1400)`.
- [ ] Re-run `node tests/app/restore-unit.mjs` and confirm all cases pass.

### Task 3: Update Test Assertions & Engine References
**Files:**
- Modify: `tests/probe/cdp-cli.mjs`
- Modify: `tests/app/twitchng.mjs`
- Modify: `ROADMAP.md`

- [ ] Verify `tests/probe/cdp-cli.mjs` and `tests/app/twitchng.mjs` accept engine `1.3.9`.
- [ ] Run `node tests/hygiene.mjs` to ensure no ES6 syntax leaks into `sttv-speed.js`.
- [ ] Mark Roadmap Item 13 as completed in `ROADMAP.md`.

### Task 4: Build, Validate IPK and Deploy to LG OLED TV
**Files:**
- Build: `com.twitchng.tv_1.0.0_all.ipk`

- [ ] Run `build/build-app.mjs` to create updated IPK with engine 1.3.9.
- [ ] Run `tests/app/twitchng.mjs` on the built IPK to verify all checks pass.
- [ ] Run `tests/probe/cdp-cli.mjs` to verify probe and CDP integration.
- [ ] Deploy IPK to LG OLED TV (`$TV_HOST`) via `luna-send`.
- [ ] Run `probe/sttv-cdp.mjs check --host $TV_HOST` to verify live TV reports engine 1.3.9.
- [ ] Commit changes to git and push to GitHub `main`.
