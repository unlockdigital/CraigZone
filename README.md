# Craig Zone

Craig Zone brings keyboard switching, predictable audio and reversible theater mode to a lineup of live video tabs. Choose 2–9 games, click Play yourself, and move between games with the keyboard.

Version 0.3.0 is a development preview. Chromium is the primary tested browser. The shared Firefox source is experimental and supports temporary developer loading.

## Install for development

Use Python 3.10 or newer. From this repository:

```sh
python3 chromium/build.py build/chromium
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `build/chromium`. Pin Craig Zone to the toolbar. After a source update, build into a fresh directory and reload the extension.

The standalone build uses browser storage for local diagnostics. Optional native-messaging adapters can be enabled explicitly by an integration maintainer.

## Watch games

1. Open the game tabs in one browser window.
2. Open Craig Zone, select 2–9 tabs, and choose **Check players and start**.
3. Approve access to the selected pages and any discovered player sites.
4. Click the game's Play control. Recognized direct-video and custom Play controls expand the player once playback begins. Other players can use their own fullscreen control.

| Control | Action |
| --- | --- |
| Left / Right arrows | Previous / next game |
| 1–9 | Select a stable game slot |
| B | Return to the previous game |
| M | Toggle the current game's mute choice |
| Escape | Minimize the player and pause automatic expansion for that game |

The active game's audio follows its remembered mute choice. Other tabs in that session window remain muted. Opening Craig Zone's controls preserves the current game's audio. Selecting an unrelated webpage quiets the session window. Other browser windows retain their own behavior.

Choose **Edit games**, change the lineup, then **Check players and apply** to add or remove games during a running session. Surviving games keep their slot numbers. **Watch** returns to a game. **Stop Craig Zone** restores saved mute settings, page styles and window state.

The toolbar popup provides compact controls. **Open larger controls** opens a roomy controls page for a TV or larger screen. Browser-command fallbacks use Alt+Shift+Left/Right/B; shortcut settings are available at `chrome://extensions/shortcuts`.

## Try the synthetic demo

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory demo
```

Open `http://127.0.0.1:8765/?game=1` and `http://127.0.0.1:8765/?game=2` in separate tabs, start Craig Zone, and click Play. The demo draws its own moving canvas video and uses a deliberate Play button.

## Privacy and permissions

All extension code is bundled locally. Diagnostics stay in browser storage for seven UTC daily buckets. They contain completed-operation counts, categorized failures, build/browser labels, session-size buckets and permission outcomes. Earlier untagged counts retain an `unknown` build marker. The controls show coverage dates and freshness and offer **Save local summary** and **Clear diagnostics**.

Diagnostic data excludes URLs, tab titles, media, cookies, credentials and key histories. The controls read open-tab titles and sites to display the picker; running-session labels, granted origins and restoration state use browser session storage. A full browser restart ends that session.

`tabs` identifies selected games and controls tab audio. `scripting` and `webNavigation` prepare approved players and inspect the selected frame chain. Host access is requested for the chosen page/player sites. `storage` holds local state. `activeTab` supports interactions with the active tab. Native messaging is an explicit integration option.

## Development checks

Use Node.js 22 or newer and Python 3.10 or newer:

```sh
python3 tools/check.py
python3 tools/browser_check.py /absolute/path/to/chrome-for-testing
```

The first command runs dependency-free controller, player, diagnostics, adapter and build checks. The second uses OpenSSL to create a temporary test identity and runs synthetic direct/embedded video checks in a fresh browser profile. Test pages and debugging endpoints use loopback. Existing browser profiles remain separate.

Player compatibility varies with site layout, frame permissions and media behavior. Ambiguous Play targets retain manual fullscreen. This preview's public support scope is the standalone developer installation and its documented controls. Firefox and additional platforms benefit from dedicated testing.

Contributions should include a synthetic reproduction for player-specific behavior. See [CONTRIBUTING.md](CONTRIBUTING.md). Craig Zone is available under the [MIT license](LICENSE).
