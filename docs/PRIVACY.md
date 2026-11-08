# Privacy and permissions

Craig Zone runs its bundled extension code locally. You approve access to the video pages and embedded player sites in your selected lineup.

The tab picker reads open-tab titles and sites. Running-session labels, approved origins, mute choices, and restoration state use browser session storage. A full browser restart ends that session.

## Local diagnostics

Diagnostics remain in browser storage for seven UTC daily buckets. They contain bounded counts of completed operations and categorized failures, build/browser labels, session-size buckets, and permission outcomes. Earlier untagged activity keeps an `unknown` build marker.

Diagnostic data excludes URLs, tab titles, media, cookies, credentials, raw errors, and key histories. The controls show coverage dates and freshness. **Save local summary** creates a deliberate JSON download; **Clear diagnostics** removes the retained counts.

The standalone build uses browser storage. Integration maintainers can explicitly enable native messaging for a separately installed compatible local adapter.

## Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | Identify selected tabs, display the picker, and manage tab audio |
| `scripting` | Prepare approved players and restore their page styles |
| `webNavigation` | Inspect the frame chain of selected players |
| `storage` | Save local diagnostics and session state |
| `activeTab` | Support interactions with the active tab |
| Optional host access | Reach the page/player sites you choose |

The optional native integration adds `nativeMessaging` only when explicitly enabled at build time.
