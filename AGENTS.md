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

## Deployment tasks

- Read [the deployment checklist](docs/deployment-checklist.md), then the guide for the selected entry. It applies to human and AI deployments alike.
- Identify the role (workstation node or self-hosted center), workspace mode, final entry, and whether forwarding helpers are required. Reuse an existing deployment's configuration; ask only for missing choices or external credentials. Never print credentials into chat or logs.
- A successful `npm run deploy` does not imply helper packages exist. If TCP/serial helpers are requested, finalize node registration and its full entry path before building. Use `--build-forward` for an already-finalized entry, or `npm run build:forward` after joining a gateway/center. Verify all four downloadable artifacts belong to that entry and the intended build; preserve existing v2 keys and rules.
- Environment checks, active services, and a center homepage are not deployment acceptance. Verify the actual node's `/readyz`, expected node identity, login, and every selected feature. Report missing or untested steps explicitly instead of declaring full success.
- Keep deployment instructions and acceptance criteria in the shared checklist and linked guides. New browser modules also need the UI asset registry and offline shell list; changing the backend asset registry requires a panel update, not just a UI reload.
