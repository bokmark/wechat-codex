import assert from "node:assert/strict";
import test from "node:test";
import { WeixinClient } from "../src/weixin/client.js";

test("WeixinClient sends the iLink text message shape", async () => {
  let captured;
  const fetchFn = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", token: "token", fetchFn });
  await client.sendText("user", "hello", "ctx");
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://example.test/ilink/bot/sendmessage");
  assert.equal(captured.options.headers.Authorization, "Bearer token");
  assert.equal(captured.options.headers["iLink-App-ClientVersion"], "256");
  assert.equal(body.msg.to_user_id, "user");
  assert.equal(body.msg.item_list[0].text_item.text, "hello");
  assert.equal(body.msg.context_token, "ctx");
  assert.equal(body.base_info.bot_agent, "wechat-codex/0.1.0");
});
