# Twitch NG

**Twitch NG (Next-Gen)** is a community-maintained Twitch app for LG webOS TVs. It is distributed as a separate application, so it can be installed alongside the stock Twitch app.

[Русская версия](README.ru.md) · [Releases](https://github.com/emoorpheus/TwitchNG/releases) · [Report a problem](https://github.com/emoorpheus/TwitchNG/issues)

Project history and implementation notes are available in the [engineering notes](docs/engineering-notes.ru.md).

## Screenshots

Screenshots show the pre-release 06 interface. They document the shipped design; individual Twitch cards and stream listings are live content supplied by Twitch and may differ from what you see.

| Home and live streams | Video library | Categories |
|---|---|---|
| ![Twitch NG home screen with live stream cards](docs/screenshots/pre06/home.jpg) | ![Twitch NG video grid](docs/screenshots/pre06/videos.jpg) | ![Twitch NG games and categories](docs/screenshots/pre06/games.jpg) |

| Game streams | Channel search | Clips |
|---|---|---|
| ![Streams in a selected game category](docs/screenshots/pre06/game-streams.jpg) | ![Channel search screen](docs/screenshots/pre06/search-channels.jpg) | ![Clip grid](docs/screenshots/pre06/clips.jpg) |

| Side navigation | Settings | What's New |
|---|---|---|
| ![Twitch NG side navigation](docs/screenshots/pre06/side.jpg) | ![Twitch NG settings screen](docs/screenshots/pre06/settings.jpg) | ![Twitch NG What's New screen](docs/screenshots/pre06/news.jpg) |

## Why use Twitch NG on a TV?

- **Built around a remote control.** Large cards, clear focus indication, a persistent side rail, and readable labels make browsing possible without a mouse or keyboard.
- **More context before opening a stream.** Viewer count, language, category, title, and live duration appear together on the live card; video cards surface length, views, date, and watched progress.
- **A faster way to find the right content.** Browse recommended rows, follow live channels, search channels, open a game category, and switch between streams and highlights from the TV interface.
- **Choose a VOD pace that suits you.** Speeds from 0.25× to 2× are available for supported VOD and clip playback paths, with pitch-preserving processing where supported.
- **Keep your existing app.** Twitch NG has its own app identity and data, so it installs alongside the stock Twitch app instead of replacing it.
- **Make the screen comfortable in a dark room.** The default black canvas and restrained purple focus accents are designed for OLED viewing; the Next-Gen UI can be disabled if you prefer the classic interface.

> Twitch NG is an independent community project. It is not affiliated with or endorsed by Twitch Interactive, Inc.

## Features

- Browse Twitch and watch streams, VODs, and clips using the TV interface.
- Optional **Next-Gen UI** with redesigned typography, focus states, badges, and playback details. It can be disabled with `TWITCHNG_UI='0'`.
- Optional VOD and clip speed control from **0.25× to 2×**, with pitch-preserving audio processing. Speed controls are not shown for live streams.
- An OLED-oriented visual preset and a dedicated About screen.
- Separate app data and sign-in from the stock Twitch app.

Playback speed uses the bundled **STTV Speed** engine. The app and engine have independent version numbers.

## Interface guide

The app keeps the familiar Twitch navigation model and adds a TV-focused presentation. Names below describe the current English UI; exact sections shown depend on the account and the data returned by Twitch.

### Home, recommendations, and live streams

- **Recommended / Home** is the starting point for discovery. It brings available Twitch rows into one TV-friendly screen, with large artwork and a persistent side rail for navigation.
- **Live** presents stream cards. Each card combines the preview with a prominent live-viewer badge, channel name, stream title, game/category, language, and elapsed stream time. This makes it easier to compare streams without opening each one.
- **Focus feedback** raises and outlines the selected card so remote-control navigation is easy to track at a distance. The Next-Gen visual system uses Onest typography, sharp Lucide-style icons, a black OLED canvas, and purple focus accents.
- **Following and search results** reuse the same card hierarchy, keeping channel identity and stream context in the same place throughout the app.
- Row controls, such as the time period, **Streams / Highlights**, and **Play all**, are presented as selectable buttons. Their availability depends on the current screen.

### Categories and channels

- **Categories** use portrait artwork, with current viewer totals on the artwork and channel counts below the category name. This surfaces both the game's popularity and how many creators are live before opening it.
- **Channel search** uses circular channel portraits and centered names to distinguish people from game artwork. Opening a channel leads to its available live stream, videos, or clips.
- **Channel pages** and account-specific areas require a Twitch sign-in. Their contents are provided by Twitch and can change independently of this app.

### Videos and clips

- **Videos (VODs)** show the preview, duration, view count, category, and date. A progress strip marks previously watched portions when Twitch provides that data. Duration and view count sit directly on the thumbnail, leaving the title and channel details readable below it.
- **Clips** have their own preview and playback page. Speed control is available only when the TV's player applies the selected rate; a clip may remain at normal speed.
- A playback speed selector is available on VODs and clips, not on live streams. Supported choices are **0.25×, 0.5×, 0.75×, 1×, 1.25×, 1.5×, and 2×**. The engine aims to preserve pitch on supported playback paths. On some TV/player paths Twitch or webOS may ignore a rate or need time to restore normal playback.
- Playback quality remains controlled by the player. Changing quality should preserve the VOD position, though the current pre-release has a known recovery delay described above.

### Navigation, settings, and app information

- **Side menu and header** provide navigation, the focused section title, a clock, and a relative “updated” time where available. The menu's current item is highlighted for remote-control navigation.
- **Settings** use the same Next-Gen typography and focus treatment. The stock SmartTwitchTV settings and controls remain available; descriptive text is styled as secondary information.
- **About** identifies Twitch NG, the app pre-release, the speed-engine version, and the webOS version reported by the TV. It also contains the project's license and trademark notice.
- **What's New** summarizes changes in the installed pre-release. A welcome panel may appear on first launch; press OK or Back to close it.

The same typography, icon style, focus states, and spacing carry through navigation, content grids, dialogs, settings, About, and What's New, so the app feels consistent rather than like a collection of unrelated screens.

### Appearance controls

The OLED-oriented preset and Next-Gen UI are enabled by default. These are diagnostic overrides for advanced users, not regular in-app settings:

| Override | Effect | Restore default |
|---|---|---|
| `localStorage.TWITCHNG_OLED = '0'` | Turns off the OLED preset; the Next-Gen UI is also disabled. | Remove the key or set it to `null`. |
| `localStorage.TWITCHNG_UI = '0'` | Turns off the Next-Gen interface while keeping the OLED preset. Restart the app after changing it. | Remove the key or set it to `null`, then restart. |

These values can be changed from the app's web inspector. They are not entered in Twitch search or in the TV's ordinary settings screens.

## Compatibility and current status

The current pre-release line is **Twitch NG 1.0.0 pre-release 06**, with **STTV Speed 1.3.8**. The packaged app was installed and inspected on an LG webOS 25 TV. VOD speed changes to 1.5× and 2× were observed; audio quality was not evaluated in that test.

Known limitations from that test:

- The Next-Gen UI reduced measured focus-navigation performance from about 55–56 to 35–40 frames per second. Disabling the UI restored the baseline.
- Returning from 1.5× to 1× sometimes took 19–35 seconds while the player recovered. Network buffering may contribute.
- Sign-in flows and several audio, router, and long-session checks remain unverified.

This is a pre-release. Results can vary by webOS version, network conditions, and Twitch playback changes. See [Releases](https://github.com/emoorpheus/TwitchNG/releases) for current builds and notes.

## Install

1. Open the [Releases](https://github.com/emoorpheus/TwitchNG/releases) page and download the Twitch NG `.ipk` installer.
2. Install the package using your preferred webOS development or sideloading method.
3. Launch **Twitch NG** from the TV home screen and sign in. Its account session is separate from the stock app.

The package is built for LG webOS TVs. Installation may require Developer Mode or another sideloading tool. The repository's `deploy/` scripts modify the stock SmartTwitchTV installation and are intended for advanced users; they are not required to install the standalone Twitch NG app.

## Report an issue

Before filing an issue, check the [existing reports](https://github.com/emoorpheus/TwitchNG/issues). Include the app version, STTV Speed version, webOS major version, reproduction steps, and relevant error messages. Do not post account credentials, cookies, tokens, IP addresses, or unredacted diagnostic dumps.

## Privacy and security

Twitch NG uses Twitch services to provide Twitch content and sign-in. The speed engine may use the project's configured media-fetch path when its MSE mode is active. Review [SECURITY.md](SECURITY.md) for the data-flow and security details. Report security concerns privately as described there.

## Credits and license

Twitch NG builds on the open-source SmartTwitchTV project and its webOS port. The playback-speed engine is maintained in this project. See the source headers and [SECURITY.md](SECURITY.md) for component details and license notices. The project is distributed under GPL-3.0; third-party components retain their respective licenses.
