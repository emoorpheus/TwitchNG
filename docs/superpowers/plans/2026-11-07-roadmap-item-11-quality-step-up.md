# Roadmap Item 11: Quality Step-Up (Auto-Recovery after DownCap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement auto-recovery of video quality (step-up) after an earlier bandwidth downCap when network conditions have sustainably improved.

**Architecture:** Extend `v2bNetWatch` and add `v2bStepUp` in `sttv-speed/sttv-speed.js` to monitor channel bandwidth headroom (>= 1.5× required bitrate) for at least 2 minutes with a healthy buffer (>= 10s wall-clock ahead), rate-limited to once every 5 minutes.

**Tech Stack:** JavaScript (strictly ES5 for TV engine compatibility), Node.js VM test harness, Playwright CDP.

**Spec:** `ROADMAP.md` (Item 11).

## Global Constraints
- Strictly ES5 syntax in `sttv-speed/sttv-speed.js`.
- No LAN IP addresses in committed files (use `$TV_HOST`).
- Safe fallback: if network is unstable, downCap remains protected.
- Verification on physical LG OLED TV (`$TV_HOST`).

## Review Focus
1. Buffer fullness requirement: Never attempt step-up if buffer ahead is below 10s wall-clock time.
2. 1.5× Headroom: Measured bandwidth (`bwEst`) must exceed target variant bandwidth × speed × 1.5.
3. 2-minute sustained condition: A transient spike in bandwidth must not trigger premature step-up.
4. 5-minute cooldown: Prevent oscillation between two adjacent quality levels.
5. Reaching highest variant: Clears `v2b.downCap` so future play is uncapped.

---

### Task 1: Create Dedicated Unit Test for Quality Step-Up
**Files:**
- Create: `tests/app/stepup-unit.mjs`
- Test: `tests/app/stepup-unit.mjs`

- [ ] Write unit tests verifying:
  1. Low buffer suppresses step-up even with huge bandwidth.
  2. Insufficient bandwidth (< 1.5× margin) suppresses step-up.
  3. Bandwidth sustained for < 120s does not trigger step-up.
  4. Bandwidth sustained >= 120s with full buffer triggers `v2b_step_up` and updates/clears `downCap`.
  5. 5-minute cooldown between quality adjustments is enforced.
- [ ] Run `node tests/app/stepup-unit.mjs` to observe failure on current code.

### Task 2: Implement Quality Step-Up in `sttv-speed/sttv-speed.js`
**Files:**
- Modify: `sttv-speed/sttv-speed.js:160-170, 1980-1995, 2670-2720`

- [ ] Add toast string `v2b_up` in `MSG`.
- [ ] Add state variables `highSince`, `stepUps`, `lastStepAt` in `v2b`.
- [ ] Implement `v2bStepUp(why)`:
  - Find eligible higher variants from `v2b.master` below `cfg.v2bMaxH`.
  - Destroy old HLS instance and start new variant via `v2bStartHls`.
  - Update or clear `v2b.downCap`.
  - Emit `v2b_step_up` and show toast.
- [ ] Extend `v2bNetWatch(v)` to track `highSince` and trigger `v2bStepUp` when conditions are met.
- [ ] Run `node tests/app/stepup-unit.mjs` to confirm all tests pass.

### Task 3: Hygiene & All Existing Test Verification
**Files:**
- Test: `tests/hygiene.mjs`
- Test: `tests/app/restore-unit.mjs`
- Modify: `ROADMAP.md`

- [ ] Run `node tests/hygiene.mjs` to ensure no ES6 syntax and no private data leaks.
- [ ] Run `node tests/app/restore-unit.mjs` to ensure restore functionality remains intact.
- [ ] Mark Item 11 as completed in `ROADMAP.md`.

### Task 4: Build, Validate IPK and Deploy to LG OLED TV
**Files:**
- Build: `com.twitchng.tv_1.0.0_all.ipk`

- [ ] Run `build/build-app.mjs` to build updated IPK.
- [ ] Run `tests/app/twitchng.mjs` and `tests/probe/cdp-cli.mjs` on the built package.
- [ ] Deploy IPK to LG OLED TV (`$TV_HOST`) via `luna-send`.
- [ ] Verify live state via `probe/sttv-cdp.mjs check --host $TV_HOST`.
- [ ] Commit and push changes to GitHub `main`.
