import { CodexAppServerClient } from "./codex/app-server-client.js";
import { TaskController } from "./core/task-controller.js";
import { ExternalTaskMonitor } from "./core/external-task-monitor.js";
import { WeixinClient } from "./weixin/client.js";

const sleep = (ms, signal) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

export class BridgeService {
  constructor({ config, credentials, store, logger, codex, weixin } = {}) {
    this.config = config;
    this.credentials = credentials;
    this.store = store;
    this.logger = logger;
    this.codex = codex || new CodexAppServerClient({ codexPath: config.codexPath, logger });
    this.weixin = weixin || new WeixinClient({
      baseUrl: credentials.baseUrl,
      cdnBaseUrl: credentials.cdnBaseUrl,
      token: credentials.token,
    });
    this.controller = new TaskController({
      config, credentials, store, codex: this.codex, logger,
      sendText: (...args) => this.weixin.sendText(...args),
      sendMedia: (...args) => this.weixin.sendMedia(...args),
    });
    this.externalMonitor = new ExternalTaskMonitor({
      config, credentials, store, codex: this.codex, logger,
      sendText: (...args) => this.weixin.sendText(...args),
      sendMedia: (...args) => this.weixin.sendMedia(...args),
    });
  }

  async start(signal) {
    await this.codex.start();
    this.controller.start();
    await this.controller.reconcileRunningJobs();
    this.logger?.info("微信 Codex 已连接，正在等待微信消息");
    const monitorPromise = this.externalMonitor.run(signal);
    let failures = 0;
    while (!signal?.aborted) {
      try {
        const state = this.store.read();
        const update = await this.weixin.getUpdates(state.syncBuf, {
          timeoutMs: this.config.wechat.pollTimeoutMs + 10_000, signal,
        });
        failures = 0;
        for (const message of update.msgs || update.messages || []) {
          if (signal?.aborted) break;
          await this.controller.handleIncoming(message);
        }
        // Advance the cursor only after every message has been handed off. If the
        // process dies earlier, iLink will redeliver and the persisted message-id
        // dedupe prevents a task from being created twice.
        if (!signal?.aborted && update.get_updates_buf !== undefined) {
          this.store.update((draft) => { draft.syncBuf = update.get_updates_buf || ""; });
        }
      } catch (error) {
        if (signal?.aborted) break;
        failures += 1;
        const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
        this.logger?.warn(`微信轮询失败，${Math.round(waitMs / 1000)} 秒后重试`, error.message);
        await sleep(waitMs, signal);
      }
    }
    await monitorPromise;
  }

  async stop() {
    this.controller.stop();
    await this.codex.stop();
  }
}
