import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/storage/json-store.js";

test("JsonStore persists state and credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-store-"));
  const store = new JsonStore(dir);
  store.update((state) => { state.syncBuf = "next"; });
  store.saveCredentials({ token: "secret", userId: "owner" });
  const reopened = new JsonStore(dir);
  assert.equal(reopened.read().syncBuf, "next");
  assert.deepEqual(reopened.loadCredentials(), { token: "secret", userId: "owner" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(reopened.credentialsPath).mode & 0o777, 0o600);
  }
});
