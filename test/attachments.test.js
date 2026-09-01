import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentCandidates, resolveAttachments } from "../src/core/attachments.js";

test("attachmentCandidates only selects added files and completed generated images", () => {
  const candidates = attachmentCandidates([
    {
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "new.txt", kind: { type: "add" } },
        { path: "changed.txt", kind: { type: "update" } },
        { path: "removed.txt", kind: { type: "delete" } },
      ],
    },
    { type: "imageGeneration", status: "completed", savedPath: "preview.png" },
    { type: "imageGeneration", status: "failed", savedPath: "failed.png" },
  ]);

  assert.deepEqual(candidates, [
    { path: "new.txt", source: "fileChange" },
    { path: "preview.png", source: "imageGeneration", kind: "image" },
  ]);
});

test("resolveAttachments classifies images and rejects unsafe paths", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-attachments-"));
  const outside = path.join(os.tmpdir(), `wechat-codex-outside-${process.pid}.txt`);
  fs.writeFileSync(path.join(project, "report.txt"), "report");
  fs.writeFileSync(path.join(project, "preview.PNG"), "image");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=secret");
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));

  const resolved = await resolveAttachments([
    { path: "report.txt" },
    { path: "preview.PNG" },
    { path: ".env" },
    { path: outside },
    { path: "missing.txt" },
  ], project);

  assert.deepEqual(resolved.attachments.map(({ name, kind }) => ({ name, kind })), [
    { name: "report.txt", kind: "file" },
    { name: "preview.PNG", kind: "image" },
  ]);
  assert.match(resolved.skipped.find((item) => item.path === ".env").reason, /凭据|密钥/);
  assert.match(resolved.skipped.find((item) => item.path === outside).reason, /不在项目目录/);
  assert.match(resolved.skipped.find((item) => item.path === "missing.txt").reason, /不存在/);
});

test("resolveAttachments enforces count and size limits", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-attachments-limit-"));
  fs.writeFileSync(path.join(project, "large.bin"), "12345");
  fs.writeFileSync(path.join(project, "small.txt"), "1");
  fs.writeFileSync(path.join(project, "extra.txt"), "2");

  const resolved = await resolveAttachments([
    { path: "large.bin" },
    { path: "small.txt" },
    { path: "extra.txt" },
  ], project, { maxFiles: 1, maxFileBytes: 4 });

  assert.deepEqual(resolved.attachments.map((item) => item.name), ["small.txt"]);
  assert.equal(resolved.skipped.length, 2);
  assert.match(resolved.skipped[0].reason, /超过/);
  assert.match(resolved.skipped[1].reason, /最多发送/);
});
