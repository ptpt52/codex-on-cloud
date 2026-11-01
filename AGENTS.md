# Project instructions

This is a single-user browser desktop for Codex, running natively as the host user.

- Keep browser lifetime, panel lifetime and desktop process lifetime separate.
- Never restart the desktop because there are no viewers. Never resubmit prompts or approval decisions after reconnect.
- Bind the panel and helper to loopback. VNC uses a private Unix socket, never a public TCP listener.
- Keep the virtual display, Xauthority, XFCE settings and tmux socket separate from the physical desktop.
- Desktop helpers accept fixed actions; never interpolate user input into shell commands.
- Authenticate HTTP and WebSocket paths. Preserve Host, Origin and CSRF checks.
- Never put real credentials, auth caches, workspace files or runtime state in Git.
- Preserve the separate paste and Enter actions. Terminal paste uses Ctrl+Shift+V.
- New persistent paths, queues, uploads and logs need explicit resource bounds.
- Pin application versions. Recovery must not silently upgrade dependencies or modify the user's Codex configuration.
- Run npm run check, npm test and npm run test:desktop for relevant backend changes. Use npm run test:browser for browser behavior changes.
- Distinguish mock-backed tests from actual Xvfb/x11vnc/noVNC/Codex/Cloudflare deployment checks.
