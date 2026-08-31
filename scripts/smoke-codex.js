import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";

const config = loadConfig();
const logger = createLogger();
const client = new CodexAppServerClient({ codexPath: config.codexPath, logger });
const timeout = setTimeout(() => {
  logger.error("Codex App Server smoke test timed out");
  process.exitCode = 1;
  client.stop();
}, 20_000);

try {
  await client.start();
  logger.info("Codex App Server 初始化成功");
  const threads = await client.listAllThreads({
    limit: 20,
    sortKey: "recency_at",
    sortDirection: "desc",
    archived: false,
    cwd: [config.projects[config.defaultProject].path],
    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
  }, 20);
  logger.info(`任务发现成功：找到 ${threads.length} 个当前项目任务`);
  if (threads[0]) {
    const turns = await client.listThreadTurns(threads[0].id, { limit: 1, sortDirection: "desc", itemsView: "summary" });
    logger.info(`持久化回合读取成功：最新状态 ${turns.data?.[0]?.status || "无回合"}`);
  }
} finally {
  clearTimeout(timeout);
  await client.stop();
}
