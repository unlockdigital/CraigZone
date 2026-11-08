# Craig Zone contributor instructions

- Write direct affirmative prose.
- Preserve manual playback control and reversible fullscreen/audio behavior.
- Limit page access to selected, approved origins and validate extension message senders.
- Keep diagnostics local, bounded, aggregate and free of browsing/media payloads.
- Run `python3 tools/check.py`; run `tools/browser_check.py` with a fresh Chrome for Testing binary for changes to player/session behavior.
- Keep generated builds, signing keys and browser profiles outside Git history.
- Use synthetic player fixtures and regression checks for consequential changes.
