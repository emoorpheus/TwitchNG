# Twitch NG

**Twitch NG (Next-Gen)** is a community-maintained Twitch app for LG webOS TVs. It is distributed as a separate application, so it can be installed alongside the stock Twitch app.

[Русская версия](README.ru.md) · [Releases](https://github.com/emoorpheus/TwitchNG/releases) · [Report a problem](https://github.com/emoorpheus/TwitchNG/issues)

Project history and technical notes are available in the [engineering notes](docs/engineering-notes.ru.md).

## Screenshots

Screenshots demonstrate the Twitch NG 1.0.0 release interface captured on 1080p TV layout. Individual stream cards, channels, and thumbnails are live content supplied by Twitch and reflect real-time browsing.

| Home and live streams | Video library | Categories |
|---|---|---|
| ![Twitch NG home screen with live stream cards](docs/screenshots/en/home.jpg) | ![Twitch NG video grid](docs/screenshots/en/videos.jpg) | ![Twitch NG games and categories](docs/screenshots/en/games.jpg) |

| Game streams | Channel search | Clips |
|---|---|---|
| ![Streams in a selected game category](docs/screenshots/en/game-streams.jpg) | ![Channel search screen](docs/screenshots/en/search-channels.jpg) | ![Clip grid](docs/screenshots/en/clips.jpg) |

| Side navigation | Settings | Player & Controls (Stage 3) |
|---|---|---|
| ![Twitch NG side navigation](docs/screenshots/en/side.jpg) | ![Twitch NG settings screen](docs/screenshots/en/settings.jpg) | ![Twitch NG modern player interface](docs/screenshots/en/player.jpg) |

## Why use Twitch NG on a TV?

- **Built around a remote control.** Large cards, clear focus indication, a persistent side rail, and readable labels make browsing possible without a mouse or keyboard. Focus navigation runs smoothly at **52.4 FPS** on live TV.
- **More context before opening a stream.** Viewer count, language, category, title, and live duration appear together on the live card; video cards surface length, views, date, and watched progress.
- **Modern player interface (Stage 3).** Centered Play/Pause button with subtle focus glow, sleek gradient timeline with unclipped 100% position marker, asymmetric boundary preventing rewind leaks, and glass controls elevated above the chat overlay.
- **A faster way to find the right content.** Browse recommended rows, follow live channels, search channels, open a game category, and switch between streams and highlights from the TV interface.
- **Choose a VOD pace that suits you.** Speeds from 0.25× to 2× are available for supported VODs with pitch-preserving audio processing (WSOLA algorithm) and instant, smooth return to 1×.
- **Keep your existing app.** Twitch NG has its own app identity and data, so it installs alongside the stock Twitch app instead of replacing it.
- **Make the screen comfortable in a dark room.** The default black canvas (`#000`) and restrained purple focus accents are designed for OLED viewing; the Next-Gen UI can be disabled if you prefer the classic interface.

> Twitch NG is an independent community project. It is not affiliated with or endorsed by Twitch Interactive, Inc.

## Features

- Browse Twitch and watch streams, VODs, and clips using the TV interface.
- **Next-Gen UI** with redesigned typography (**Onest** / NG Sans), sharp **Lucide** vector icons, focus states, badges, and playback details. Can be toggled with `TWITCHNG_UI='0'`.
- Pitch-preserving VOD speed control from **0.25× to 2×** powered by the bundled **STTV Speed 1.3.9** engine. Speed controls are not shown for live streams.
- **Smooth 1× Restore:** instantaneous return from speed back to 1× without 10–24s decoder stalls or black frames.
- **Automatic Quality Step-Up:** dynamically recovers back to higher quality variants after temporary bandwidth drops once the connection stabilizes.
- Pure black OLED visual preset (`#000`) by default.
- Separate app data and sign-in from the stock Twitch app.

## Interface guide

The app keeps the familiar Twitch navigation model and adds a TV-focused presentation.

### Home, recommendations, and live streams

- **Recommended / Home** is the starting point for discovery. It brings available Twitch rows into one TV-friendly screen, with large artwork and a persistent side rail for navigation.
- **Live** presents stream cards. Each card combines the preview with a prominent live-viewer badge, channel name, stream title, game/category, language, and elapsed stream time.
- **Focus feedback** raises and outlines the selected card so remote-control navigation is easy to track at a distance. The Next-Gen visual system uses Onest typography, sharp Lucide-style icons, a black OLED canvas, and purple focus accents with 52.4 FPS smooth remote response.
- **Following and search results** reuse the same card hierarchy, keeping channel identity and stream context in the same place throughout the app.

### Categories and channels

- **Categories** use portrait artwork, with current viewer totals on the artwork and channel counts below the category name.
- **Channel search** uses circular channel portraits and centered names to distinguish people from game artwork. Opening a channel leads to its available live stream, videos, or clips.
- **Channel pages** and account-specific areas require a Twitch sign-in.

### Videos, clips, and player interface

- **Videos (VODs)** show the preview, duration, view count, category, and date. A progress strip marks previously watched portions when Twitch provides that data.
- **Player Redesign (Stage 3):**
  - Minimalist centered circular Play/Pause button with focus glow.
  - Smooth gradient progress bar with accurate 100% boundary marker.
  - Asymmetric clip-path preventing progress timeline leakage to the left during rewind.
  - Multi-layer drop shadows on timecodes for crisp legibility over bright video and live chat messages.
  - Lower OSD controls elevated to `z-index: 10` above semi-transparent chat.
- **Speed Control (STTV Speed 1.3.9):** Supported choices are **0.25×, 0.5×, 0.75×, 1×, 1.25×, 1.5×, and 2×**. The engine preserves pitch via WSOLA. Restoring 1× playback is instantaneous.
- **Automatic Quality Recovery:** If network congestion triggers a temporary downCap, the engine restores higher quality automatically after 2 minutes of sustained bandwidth headroom.

### Navigation, settings, and app information

- **Side menu and header** provide navigation, section title, clock, and relative “updated” time.
- **Settings** use the same Next-Gen typography and focus treatment with descriptive secondary labels.
- **About** displays Twitch NG 1.0.0, speed-engine 1.3.9, and the webOS platform details reported by the TV.
- **What's New** summarizes features and updates in the release.

### Appearance controls

The OLED preset and Next-Gen UI are enabled by default:

| Override | Effect | Restore default |
|---|---|---|
| `localStorage.TWITCHNG_OLED = '0'` | Turns off the OLED preset; the Next-Gen UI is also disabled. | Remove the key or set it to `null`. |
| `localStorage.TWITCHNG_UI = '0'` | Turns off the Next-Gen interface while keeping the OLED preset. Restart the app after changing it. | Remove the key or set it to `null`, then restart. |

## Compatibility and verified TV testing

Twitch NG 1.0.0 is verified on **LG OLED TV (webOS 24 / webOS 10.3.0, Chromium 120)**:
- Navigation runs at **52.4 FPS** with instant remote response.
- Pitch-preserving VOD speed (0.25×–2×) and smooth return to 1× without freeze.
- WebAudio WSOLA graph with lip-sync consistency verified.
- Account authorization, personal subscriptions, and watch history verified.
- App package size is compact (**1.2 MB**, 53 files).

## Install

1. Open the [Releases](https://github.com/emoorpheus/TwitchNG/releases) page and download `com.twitchng.tv_1.0.0_all.ipk`.
2. Install via webOS Dev Mode / Homebrew Channel:
   ```bash
   ares-install -d <device> com.twitchng.tv_1.0.0_all.ipk
   ```
   Or via root SSH:
   ```bash
   scp com.twitchng.tv_1.0.0_all.ipk root@TV:/tmp/
   ssh root@TV "luna-send -i -f luna://com.webos.appInstallService/dev/install '{\"id\":\"com.twitchng.tv\",\"ipkUrl\":\"/tmp/com.twitchng.tv_1.0.0_all.ipk\",\"subscribe\":true}'"
   ```
3. Launch **Twitch NG** from the TV launcher and sign in.

## Report an issue

Before filing an issue, check the [existing reports](https://github.com/emoorpheus/TwitchNG/issues). Include the app version (1.0.0), webOS version, reproduction steps, and relevant log messages. Do not post account credentials, tokens, or private IP addresses.

## Privacy and security

Twitch NG runs locally inside webOS without external hosting, telemetry, or analytics. Review [SECURITY.md](SECURITY.md) for data-flow details.

## Credits and license

Twitch NG builds on the open-source SmartTwitchTV project and its webOS port. Distributed under GPL-3.0; third-party components retain their respective licenses.

Development and AI pairing: built and refined with AI assistance (opus 5.5 + gemini 3.8 flash + luna 6).
