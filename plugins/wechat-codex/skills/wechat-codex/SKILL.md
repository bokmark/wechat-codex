---
name: wechat-codex
description: Set up, inspect, update, or manage the local WeChat-to-Codex bridge. Use when the user wants to connect WeChat, receive Codex task notifications, add a monitored project, or check/restart the bridge service.
---

# WeChat Codex

Use the bundled `../../scripts/setup.mjs` helper for deterministic setup and service management. The plugin contains its complete runtime and must not ask the user to clone a repository, install npm packages, edit JSON, or run terminal commands themselves. The bridge is local, but WeChat authorization and the host's permission to install a background service are real requirements that cannot be silently bypassed.

## Setup or add projects

1. Determine the requested scope before setup:
   - For the current project, resolve the current task's real project root automatically. Ask only when there is no project context or two plausible roots exist.
   - For all, multiple, or saved Codex projects, use Codex's project-list capability and select only projects on the current host that expose a real local directory. Do not scan the filesystem. If the user explicitly says all, include every eligible saved project. If they did not specify scope and more than one eligible project exists, show their names in plain language and ask whether to add all, only the current one, or selected projects.
   - Never choose this plugin's cache or marketplace checkout.
2. Tell the user, in plain language, how many projects Codex will configure and that it will install or update a local auto-start service. Do not expose filesystem details unless they ask. Obtain any approval required by the host immediately before setup.
3. Run the helper yourself from the user's project directory, with a PTY because a new WeChat login may be needed:

   ```sh
   node <plugin-root>/scripts/setup.mjs install --project <absolute-project-path> [--project <another-absolute-project-path> ...]
   ```

4. When the helper prints a WeChat authorization URL, show it as a clickable link and continue waiting for confirmation. This should be the only interactive onboarding step beyond system approval. Never print credential files or tokens.
5. Report success only after the helper confirms the service is running. Give the user one next action: send `help` to the WeChat robot. If setup fails, preserve its concise error and use `status` or `logs`; retry at most once for a transient service-loading error.

Running `install` again safely updates the stable runtime and adds every selected project without erasing existing projects or credentials. Repeated paths are ignored. Never instruct the user to edit `config.json`; rerun setup once with one or more new projects whenever their saved project list changes.

## Service operations

Use one of:

```sh
node <plugin-root>/scripts/setup.mjs status
node <plugin-root>/scripts/setup.mjs restart
node <plugin-root>/scripts/setup.mjs logs
```

Use `status` before changing a working service. Use `restart` after a runtime update or when the user explicitly asks. Logs may contain task text; summarize only what is necessary and never expose secrets.

The automated service installer currently supports macOS. On another operating system, explain the limitation without presenting manual developer steps as a foolproof installation.
