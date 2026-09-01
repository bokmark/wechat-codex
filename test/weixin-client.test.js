import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("WeixinClient encrypts and sends an image through the WeChat CDN", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-media-"));
  const filePath = path.join(dir, "preview.png");
  const plaintext = Buffer.from("not-a-real-png");
  fs.writeFileSync(filePath, plaintext);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/ilink/bot/getuploadurl")) {
      return new Response(JSON.stringify({ ret: 0, upload_full_url: "https://cdn.test/upload" }), { status: 200 });
    }
    if (url === "https://cdn.test/upload") {
      assert.equal(options.method, "POST");
      assert.equal(options.body.byteLength % 16, 0);
      assert.notDeepEqual(Buffer.from(options.body).subarray(0, plaintext.length), plaintext);
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", token: "token", fetchFn });

  await client.sendMedia("user", filePath, "ctx", "image");

  const uploadRequest = JSON.parse(calls[0].options.body);
  assert.equal(uploadRequest.media_type, 1);
  assert.equal(uploadRequest.to_user_id, "user");
  assert.equal(uploadRequest.rawsize, plaintext.length);
  assert.equal(uploadRequest.filesize, 16);
  const message = JSON.parse(calls[2].options.body).msg;
  assert.equal(message.item_list[0].type, 2);
  assert.equal(message.item_list[0].image_item.media.encrypt_query_param, "download-param");
  assert.equal(message.item_list[0].image_item.mid_size, 16);
  assert.equal(message.context_token, "ctx");
});

test("WeixinClient sends a new non-image as a file message", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-media-"));
  const filePath = path.join(dir, "report.txt");
  fs.writeFileSync(filePath, "hello");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let message;
  const fetchFn = async (url, options) => {
    if (url.endsWith("/ilink/bot/getuploadurl")) {
      const body = JSON.parse(options.body);
      assert.equal(body.media_type, 3);
      return new Response(JSON.stringify({ ret: 0, upload_full_url: "https://cdn.test/upload" }), { status: 200 });
    }
    if (url === "https://cdn.test/upload") {
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
    }
    message = JSON.parse(options.body).msg;
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  const client = new WeixinClient({ baseUrl: "https://example.test", token: "token", fetchFn });

  await client.sendMedia("user", filePath, "ctx", "file");

  assert.equal(message.item_list[0].type, 4);
  assert.equal(message.item_list[0].file_item.file_name, "report.txt");
  assert.equal(message.item_list[0].file_item.len, "5");
  assert.match(message.item_list[0].file_item.md5, /^[a-f0-9]{32}$/);
});
