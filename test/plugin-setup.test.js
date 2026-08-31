import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  mergeProjectConfig,
  mergeProjectsConfig,
  parseArgs,
  platformLabel,
  powershellQuote,
  projectKey,
  systemdQuote,
  systemdUnit,
  windowsLauncher,
  windowsTaskScript,
  xmlEscape,
} from "../plugins/wechat-codex/scripts/setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.join(os.tmpdir(), "wechat-codex-plugin-test");
const firstPath = path.join(temporaryRoot, "first");
const secondPath = path.join(temporaryRoot, "second");
const samePath = path.join(temporaryRoot, "same");

test("plugin setup escapes LaunchAgent XML values", () => {
  assert.equal(xmlEscape('a&<b>"c"'), "a&amp;&lt;b&gt;&quot;c&quot;");
});

test("plugin setup adds projects without erasing existing configuration", () => {
  const before = {
    defaultProject: "first",
    projects: { first: { path: firstPath, sandbox: "read-only", approvalPolicy: "never" } },
    wechat: { sendAcknowledgement: false },
  };
  const { config, key } = mergeProjectConfig(before, secondPath);
  assert.equal(key, "second");
  assert.equal(config.defaultProject, "first");
  assert.equal(config.projects.first.sandbox, "read-only");
  assert.equal(config.projects.second.sandbox, "workspace-write");
  assert.equal(config.wechat.sendAcknowledgement, false);
});

test("plugin setup reuses a project key for an existing path", () => {
  const before = { projects: { custom: { path: samePath, sandbox: "read-only" } } };
  const { config, key } = mergeProjectConfig(before, samePath, "ignored");
  assert.equal(key, "custom");
  assert.equal(Object.keys(config.projects).length, 1);
  assert.equal(projectKey(samePath), "same");
});

test("plugin setup accepts multiple projects in one install", () => {
  const { options } = parseArgs([
    "install",
    "--project", firstPath,
    "--project", secondPath,
    "--name", "one",
    "--name", "two",
  ]);
  assert.deepEqual(options.projects, [firstPath, secondPath]);
  assert.deepEqual(options.names, ["one", "two"]);

  const before = { projects: { existing: { path: path.join(temporaryRoot, "existing"), sandbox: "read-only" } } };
  const { config, projects } = mergeProjectsConfig(before, [
    { path: firstPath, name: "one" },
    { path: secondPath, name: "two" },
  ]);
  assert.deepEqual(projects.map((project) => project.key), ["one", "two"]);
  assert.equal(config.projects.existing.sandbox, "read-only");
  assert.equal(config.projects.one.path, firstPath);
  assert.equal(config.projects.two.path, secondPath);
});

test("plugin setup deduplicates repeated project paths", () => {
  const { config, projects } = mergeProjectsConfig({}, [
    { path: samePath },
    { path: samePath, name: "duplicate" },
  ]);
  assert.equal(projects.length, 1);
  assert.deepEqual(Object.keys(config.projects), ["same"]);
});

test("plugin setup generates a safe Linux systemd user service", () => {
  const unit = systemdUnit("/opt/node bin/node", {
    runtimeDir: "/home/demo/WeChat Codex 100%",
    stateDir: "/home/demo/.wechat-codex",
    configPath: "/home/demo/.wechat-codex/config.json",
  });
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStart="\/opt\/node bin\/node"/);
  assert.match(unit, /WeChat Codex 100%%/);
  assert.equal(systemdQuote('a"b%'), '"a\\"b%%"');
});

test("plugin setup generates a quoted Windows launcher and logon task", () => {
  const launcher = windowsLauncher("C:\\Program Files\\node.exe", {
    runtimeDir: "C:\\Users\\O'Brien\\WeChatCodex",
    stateDir: "C:\\Users\\O'Brien\\.wechat-codex",
    configPath: "C:\\Users\\O'Brien\\.wechat-codex\\config.json",
  });
  assert.match(launcher, /O''Brien/);
  assert.match(launcher, /WECHAT_CODEX_CONFIG/);
  assert.match(launcher, /service-error\.log/);
  assert.equal(powershellQuote("O'Brien"), "'O''Brien'");
  const task = windowsTaskScript("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.match(task, /Register-ScheduledTask/);
  assert.match(task, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(task, /Start-ScheduledTask/);
});

test("plugin setup names all supported platforms", () => {
  assert.equal(platformLabel("darwin"), "macOS");
  assert.equal(platformLabel("linux"), "Linux");
  assert.equal(platformLabel("win32"), "Windows");
});

test("plugin contains a self-contained runtime synchronized with the project", () => {
  const files = ["package.json", "src/cli.js", "src/core/task-controller.js", "src/weixin/client.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const bundled = fs.readFileSync(path.join(root, "plugins", "wechat-codex", "runtime", file), "utf8");
    assert.equal(bundled, source, `${file} is stale in the plugin runtime`);
  }
});
