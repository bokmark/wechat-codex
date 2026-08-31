#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { JsonStore } from "./storage/json-store.js";
import { loginWithQr } from "./weixin/login.js";
import { BridgeService } from "./service.js";

const command = process.argv[2] || "start";
const logger = createLogger();

async function main() {
  const config = loadConfig();
  const store = new JsonStore(config.stateDir);

  if (command === "login") {
    const credentials = await loginWithQr({ store, logger });
    logger.info(`登录成功，凭据已保存在 ${store.credentialsPath}`);
    logger.info(`微信用户：${credentials.userId}`);
    return;
  }

  if (command === "doctor") {
    let healthy = true;
    const version = spawnSync(config.codexPath, ["--version"], { encoding: "utf8" });
    if (version.status === 0) logger.info(`Codex：${version.stdout.trim()}`);
    else { logger.error(`找不到 Codex：${version.stderr?.trim() || config.codexPath}`); healthy = false; }
    for (const [key, project] of Object.entries(config.projects)) {
      if (fs.existsSync(project.path)) logger.info(`项目 ${key}：${project.path}`);
      else { logger.error(`项目路径不存在 ${key}：${project.path}`); healthy = false; }
    }
    const credentials = store.loadCredentials();
    if (credentials?.token && credentials?.userId) logger.info(`微信登录：已配置（${credentials.userId}）`);
    else { logger.warn("微信登录：尚未配置，请运行 npm run login"); healthy = false; }
    if (!healthy) process.exitCode = 1;
    return;
  }

  if (command !== "start") throw new Error(`未知命令：${command}`);
  const credentials = store.loadCredentials();
  if (!credentials?.token || !credentials?.userId) throw new Error("尚未登录微信，请先运行 npm run login");
  const controller = new AbortController();
  const service = new BridgeService({ config, credentials, store, logger });
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try { await service.start(controller.signal); } finally { await service.stop(); }
}

main().catch((error) => {
  logger.error(error.stack || error.message);
  process.exitCode = 1;
});
