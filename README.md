# Twitch NG

**Twitch NG (Next-Gen)** is a community-maintained Twitch app for LG webOS TVs. It is distributed as a separate application, so it can be installed alongside the stock Twitch app.

[Русская версия](README.ru.md) · [Releases](https://github.com/emoorpheus/TwitchNG/releases) · [Report a problem](https://github.com/emoorpheus/TwitchNG/issues)

> Twitch NG is an independent community project. It is not affiliated with or endorsed by Twitch Interactive, Inc.

## Features

- Browse Twitch and watch streams, VODs, and clips using the TV interface.
- Optional **Next-Gen UI** with redesigned typography, focus states, badges, and playback details. It can be disabled with `TWITCHNG_UI='0'`.
- Optional VOD and clip speed control from **0.25× to 2×**, with pitch-preserving audio processing. Speed controls are not shown for live streams.
- An OLED-oriented visual preset and a dedicated About screen.
- Separate app data and sign-in from the stock Twitch app.

Playback speed uses the bundled **STTV Speed** engine. The app and engine have independent version numbers.

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
