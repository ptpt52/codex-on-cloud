# Project instructions

This is a single-user browser desktop for Codex, based on a persistent container session.

- Keep browser lifetime, panel lifetime and desktop process lifetime separate.
- Never restart the desktop because there are no viewers. Never resubmit prompts or approval decisions after reconnect.
- Do not add Docker socket access to the panel or desktop.
- Desktop helpers accept fixed actions; never interpolate user input into shell commands.
- Authenticate HTTP and WebSocket paths. Preserve Host, Origin and CSRF checks.
- Never put real credentials, auth caches, workspace files or runtime state in Git or build contexts.
- Preserve the separate paste and Enter actions. Terminal paste uses Ctrl+Shift+V.
- New persistent paths, queues, uploads and logs need explicit resource bounds.
- Pin application/image versions. Recovery must not silently upgrade dependencies.
- Run npm run check, npm test and npm run test:desktop for relevant backend changes. Use npm run test:browser for browser behavior changes.
- Distinguish mock-backed tests from an actual Docker/KasmVNC/Codex deployment in reports.
