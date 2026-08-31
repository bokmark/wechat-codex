import crypto from "node:crypto";

export const WEIXIN_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";

function packedVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}

export class WeixinClient {
  constructor({ baseUrl = WEIXIN_LOGIN_BASE_URL, token = "", version = "0.1.0", fetchFn = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.version = version;
    this.fetch = fetchFn;
  }

  headers() {
    const headers = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": packedVersion(this.version),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  baseInfo() {
    return { channel_version: this.version, bot_agent: `wechat-codex/${this.version}` };
  }

  async request(endpoint, { method = "POST", body, timeoutMs = 45_000, signal } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("WeChat request timed out")), timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetch(`${this.baseUrl}/${endpoint.replace(/^\//, "")}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify({ ...body, base_info: this.baseInfo() }),
        signal: controller.signal,
      });
      const text = await response.text();
      let result = {};
      if (text) {
        try { result = JSON.parse(text); } catch { throw new Error(`WeChat returned invalid JSON (${response.status})`); }
      }
      if (!response.ok) throw new Error(`WeChat HTTP ${response.status}: ${result.errmsg || result.message || text}`);
      if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
        throw new Error(`WeChat API ${result.errcode ?? result.ret}: ${result.errmsg || result.message || "request failed"}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  getUpdates(getUpdatesBuf = "", { timeoutMs = 45_000, signal } = {}) {
    return this.request("ilink/bot/getupdates", {
      body: { get_updates_buf: getUpdatesBuf || "" }, timeoutMs, signal,
    });
  }

  sendText(toUserId, text, contextToken, runId) {
    return this.request("ilink/bot/sendmessage", {
      body: {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: crypto.randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken || "",
          ...(runId ? { run_id: runId } : {}),
        },
      },
    });
  }

  notifyStart(toUserId, contextToken) {
    return this.request("ilink/bot/msg/notifystart", { body: { to_user_id: toUserId, context_token: contextToken || "" } });
  }

  notifyStop(toUserId, contextToken) {
    return this.request("ilink/bot/msg/notifystop", { body: { to_user_id: toUserId, context_token: contextToken || "" } });
  }
}
