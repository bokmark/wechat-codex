import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WEIXIN_LOGIN_BASE_URL, WeixinClient } from "./client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function field(value, ...names) {
  for (const name of names) if (value?.[name] !== undefined) return value[name];
  return undefined;
}

export async function loginWithQr({ store, logger, fetchFn = globalThis.fetch }) {
  const previous = store.loadCredentials();
  let client = new WeixinClient({ baseUrl: WEIXIN_LOGIN_BASE_URL, fetchFn });
  const fetchQrCode = async () => {
    const loginClient = new WeixinClient({ baseUrl: WEIXIN_LOGIN_BASE_URL, fetchFn });
    const started = await loginClient.request("ilink/bot/get_bot_qrcode?bot_type=3", {
      body: { local_token_list: previous?.token ? [previous.token] : [] }, timeoutMs: 20_000,
    });
    const code = field(started, "qrcode", "qr_code");
    const url = field(started, "qrcode_img_content", "qrcode_url", "qr_url") || code;
    if (!code) throw new Error("WeChat login response did not include qrcode");
    client = loginClient;
    output.write(`\n请用微信打开并确认登录：\n${url}\n\n`);
    return code;
  };
  let qrCode = await fetchQrCode();

  const terminal = readline.createInterface({ input, output });
  let verifyCode = "";
  try {
    for (;;) {
      const query = new URLSearchParams({ qrcode: qrCode });
      if (verifyCode) query.set("verify_code", verifyCode);
      let status;
      try {
        status = await client.request(`ilink/bot/get_qrcode_status?${query}`, {
          method: "GET", timeoutMs: 40_000,
        });
      } catch (error) {
        logger.debug("QR status poll will retry", error.message);
        await sleep(1000);
        continue;
      }
      const state = field(status, "status", "qrcode_status");
      logger.debug("QR status", state);
      if (state === "confirmed") {
        const credentials = {
          token: field(status, "bot_token", "token"),
          accountId: field(status, "ilink_bot_id", "bot_id"),
          userId: field(status, "ilink_user_id", "user_id"),
          baseUrl: field(status, "baseurl", "base_url") || WEIXIN_LOGIN_BASE_URL,
          savedAt: new Date().toISOString(),
        };
        if (!credentials.token || !credentials.userId) throw new Error("WeChat confirmed login but omitted credentials");
        store.saveCredentials(credentials);
        return credentials;
      }
      if (state === "expired") {
        output.write("登录地址已过期，正在自动刷新……\n");
        qrCode = await fetchQrCode();
        verifyCode = "";
        continue;
      }
      if (state === "binded_redirect") {
        if (previous?.token && previous?.userId) return previous;
        throw new Error("该机器人已绑定，但本机没有原凭据；请在原设备解绑后重试");
      }
      if (state === "scaned_but_redirect") {
        const redirected = field(status, "redirect_host", "baseurl", "base_url");
        if (redirected) client = new WeixinClient({ baseUrl: redirected, fetchFn });
      } else if (state === "need_verifycode") {
        verifyCode = (await terminal.question("请输入微信显示的验证码：")).trim();
      } else if (state === "verify_code_blocked") {
        throw new Error("验证码尝试次数过多，请稍后重试");
      } else {
        await sleep(800);
      }
    }
  } finally {
    terminal.close();
  }
}
