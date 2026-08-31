import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  mergeProjectConfig,
  mergeProjectsConfig,
  parseArgs,
  projectKey,
  xmlEscape,
} from "../plugins/wechat-codex/scripts/setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin setup escapes LaunchAgent XML values", () => {
  assert.equal(xmlEscape('a&<b>"c"'), "a&amp;&lt;b&gt;&quot;c&quot;");
});

test("plugin setup adds projects without erasing existing configuration", () => {
  const before = {
    defaultProject: "first",
    projects: { first: { path: "/tmp/first", sandbox: "read-only", approvalPolicy: "never" } },
    wechat: { sendAcknowledgement: false },
  };
  const { config, key } = mergeProjectConfig(before, "/tmp/second");
  assert.equal(key, "second");
  assert.equal(config.defaultProject, "first");
  assert.equal(config.projects.first.sandbox, "read-only");
  assert.equal(config.projects.second.sandbox, "workspace-write");
  assert.equal(config.wechat.sendAcknowledgement, false);
});

test("plugin setup reuses a project key for an existing path", () => {
  const before = { projects: { custom: { path: "/tmp/same", sandbox: "read-only" } } };
  const { config, key } = mergeProjectConfig(before, "/tmp/same", "ignored");
  assert.equal(key, "custom");
  assert.equal(Object.keys(config.projects).length, 1);
  assert.equal(projectKey("/tmp/same"), "same");
});

test("plugin setup accepts multiple projects in one install", () => {
  const { options } = parseArgs([
    "install",
    "--project", "/tmp/first",
    "--project", "/tmp/second",
    "--name", "one",
    "--name", "two",
  ]);
  assert.deepEqual(options.projects, ["/tmp/first", "/tmp/second"]);
  assert.deepEqual(options.names, ["one", "two"]);

  const before = { projects: { existing: { path: "/tmp/existing", sandbox: "read-only" } } };
  const { config, projects } = mergeProjectsConfig(before, [
    { path: "/tmp/first", name: "one" },
    { path: "/tmp/second", name: "two" },
  ]);
  assert.deepEqual(projects.map((project) => project.key), ["one", "two"]);
  assert.equal(config.projects.existing.sandbox, "read-only");
  assert.equal(config.projects.one.path, "/tmp/first");
  assert.equal(config.projects.two.path, "/tmp/second");
});

test("plugin setup deduplicates repeated project paths", () => {
  const { config, projects } = mergeProjectsConfig({}, [
    { path: "/tmp/same" },
    { path: "/tmp/same", name: "duplicate" },
  ]);
  assert.equal(projects.length, 1);
  assert.deepEqual(Object.keys(config.projects), ["same"]);
});

test("plugin contains a self-contained runtime synchronized with the project", () => {
  const files = ["package.json", "src/cli.js", "src/core/task-controller.js", "src/weixin/client.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const bundled = fs.readFileSync(path.join(root, "plugins", "wechat-codex", "runtime", file), "utf8");
    assert.equal(bundled, source, `${file} is stale in the plugin runtime`);
  }
});
