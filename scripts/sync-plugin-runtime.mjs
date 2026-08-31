#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "plugins", "wechat-codex", "runtime");
const items = ["src", "package.json", "LICENSE", "THIRD_PARTY.md"];

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of items) {
  fs.cpSync(path.join(root, item), path.join(target, item), { recursive: true });
}

console.log(`插件运行时已同步：${target}`);
