# CraigZone

**RedZone-inspired switching for your own video tabs.**

[![Checks](https://github.com/unlockdigital/CraigZone/actions/workflows/checks.yml/badge.svg)](https://github.com/unlockdigital/CraigZone/actions/workflows/checks.yml)
[![MIT license](https://img.shields.io/github/license/unlockdigital/CraigZone)](LICENSE)

Inspired by [NFL RedZone](https://www.nfl.com/redzone/), CraigZone brings a personal viewing lineup to your browser. Jump between sports, livestreams, lectures, music videos, and anything else you watch in a video tab.

- **Switch quickly.** Use arrows, numbered slots, or a previous-video shortcut.
- **Keep audio focused.** Remember each video's mute choice and quiet background tabs.
- **Change the lineup live.** Add or remove tabs while your session keeps running.
- **Settle into fullscreen.** Keep prepared players expanded as you switch, with larger controls for a TV.

## Quick start

Development preview for Chromium. Building requires Python 3.10+.

```sh
git clone https://github.com/unlockdigital/CraigZone.git
cd CraigZone
python3 scripts/build.py build/chromium
```

1. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** → `build/chromium`.
2. Open 2–9 video tabs. Select them in CraigZone, choose **Check players and start**, and approve their player sites.
3. Press Play, then press **Enter** in supporting players or use the player's fullscreen control. **Edit games → Apply** changes your lineup during a session.

**← / →** switch · **1–9** choose a slot · **B** previous video · **M** mute · **Enter** fullscreen (supporting players)

Player compatibility varies by site. Diagnostics stay on your computer, and you choose which sites receive access.

[Usage and demo](docs/USAGE.md) · [Privacy](docs/PRIVACY.md) · [Contributing](.github/CONTRIBUTING.md) · [MIT license](LICENSE)
