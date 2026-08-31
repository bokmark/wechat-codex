import assert from "node:assert/strict";
import test from "node:test";
import { codexProcessOptions } from "../src/codex/process-options.js";

test("Windows command wrappers are launched through the system shell", () => {
  assert.deepEqual(codexProcessOptions("C:\\Tools\\codex.cmd", "win32"), {
    shell: true,
    windowsHide: true,
  });
  assert.deepEqual(codexProcessOptions("C:\\Tools\\codex.exe", "win32"), {});
});

test("Unix Codex executables do not use a shell", () => {
  assert.deepEqual(codexProcessOptions("/usr/local/bin/codex", "linux"), {});
  assert.deepEqual(codexProcessOptions("/Applications/Codex.app/codex", "darwin"), {});
});
