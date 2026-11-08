# Using Craig Zone

Craig Zone builds a viewing lineup from 2–9 video tabs in one browser window. Sports, live events, lectures, music videos, and other browser videos can share the same controls. The current interface uses “game” for each selected video.

## Start a lineup

1. Open your video tabs in one browser window.
2. Open Craig Zone, select the tabs, and choose **Check players and start**.
3. Approve access to the selected pages and their embedded player sites.
4. Click Play yourself. Use each player's fullscreen control to prepare the expanded view as needed.

Craig Zone keeps prepared players expanded as you switch. The active tab follows its remembered mute choice; background tabs in the session window stay muted. Opening Craig Zone's own controls preserves the current video's audio. An unrelated webpage quiets the session window. Other browser windows keep their own behavior.

## Controls

| Key | Action |
| --- | --- |
| Left / Right arrows | Previous / next video |
| 1–9 | Select a stable slot |
| B | Return to the previous video |
| M | Toggle the active video's mute choice |
| Escape | Minimize the player and pause automatic expansion for that tab |

Browser-command fallbacks use **Alt+Shift+Left/Right/B**. Customize them at `chrome://extensions/shortcuts`.

Choose **Edit games**, adjust the selected tabs, then **Check players and apply**. Surviving videos keep their slot numbers and prepared player state. Choose **Watch** to return to a video. **Stop Craig Zone** restores saved mute settings, page styles, and window state. A full browser restart ends the running session.

The toolbar popup provides compact controls. **Open larger controls** opens a page suited to a TV or larger screen.

## Player compatibility

Manual playback and the player's fullscreen control provide the standard viewing flow. Automatic expansion is a best-effort convenience for recognized direct-video and custom Play controls. Ambiguous targets retain manual fullscreen. Reopening fullscreen enables expansion again after an Escape opt-out.

Chromium is the primary tested browser. The shared Firefox source in `src/` supports experimental temporary developer loading. Site layout, frame permissions, and media behavior affect player compatibility.

## Try the local demo

From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/demo
```

Open `http://127.0.0.1:8765/?video=1` and `http://127.0.0.1:8765/?video=2` in separate tabs. Start Craig Zone and click Play. The demo draws its own moving canvas video locally.
