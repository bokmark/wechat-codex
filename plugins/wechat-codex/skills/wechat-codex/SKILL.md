---
name: wechat-codex
description: Set up, inspect, update, or manage the local WeChat-to-Codex bridge. Use when the user wants to connect WeChat, receive Codex task notifications, add a monitored project, or check/restart the bridge service.
---

# WeChat Codex

Use the bundled `../../scripts/setup.mjs` helper for deterministic setup and service management. The bridge is local, but WeChat authorization and a persistent background process are real requirements that a plugin cannot silently bypass.

## Setup or add a project

1. Resolve the project directory the user wants controlled. Prefer the current task's project root. Do not accidentally use this plugin's cache directory or its marketplace checkout.
2. Explain that setup writes only to `~/.local/share/wechat-codex`, `~/.wechat-codex`, and `~/Library/LaunchAgents/com.bokmark.wechat-codex.plist`, then obtain any approval required by the host.
3. Run this from the user's project directory, with a PTY when a new WeChat login may be needed:

   ```sh
   node <plugin-root>/scripts/setup.mjs install --project <absolute-project-path>
   ```

4. When the helper prints a WeChat authorization URL, show it as a clickable link and continue waiting for confirmation. Never print credential files or tokens.
5. Report success only after the helper confirms the LaunchAgent is running. If it fails, preserve its concise error and use `status` or `logs`; do not repeatedly reinstall.

Running `install` again safely updates the stable runtime and adds the selected project without erasing existing projects or credentials.

## Service operations

Use one of:

```sh
node <plugin-root>/scripts/setup.mjs status
node <plugin-root>/scripts/setup.mjs restart
node <plugin-root>/scripts/setup.mjs logs
```

Use `status` before changing a working service. Use `restart` after a runtime update or when the user explicitly asks. Logs may contain task text; summarize only what is necessary and never expose secrets.

The automated service installer currently supports macOS. On another operating system, explain the limitation and use the repository's foreground `npm start` workflow unless the user asks for a native service implementation.
