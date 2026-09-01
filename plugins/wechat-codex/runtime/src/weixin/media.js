import crypto from "node:crypto";
import fs from "node:fs/promises";

export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const WEIXIN_MEDIA_TYPE = Object.freeze({ image: 1, file: 3 });

export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function cdnUploadUrl(response, cdnBaseUrl, fileKey) {
  const fullUrl = response.upload_full_url?.trim();
  if (fullUrl) return fullUrl;
  if (!response.upload_param) throw new Error("微信没有返回媒体上传地址");
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(fileKey)}`;
}

async function uploadEncrypted(fetchFn, url, ciphertext) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`微信 CDN 拒绝上传（HTTP ${response.status}）`);
      }
      if (response.status !== 200) throw new Error(`微信 CDN 上传失败（HTTP ${response.status}）`);
      const downloadParam = response.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("微信 CDN 响应缺少媒体下载参数");
      return downloadParam;
    } catch (error) {
      lastError = error;
      if (/拒绝上传/.test(error.message) || attempt === 3) throw error;
    }
  }
  throw lastError;
}

export async function uploadMedia({ filePath, toUserId, kind, requestUploadUrl, fetchFn, cdnBaseUrl = WEIXIN_CDN_BASE_URL }) {
  const plaintext = await fs.readFile(filePath);
  const rawMd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const fileKey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const response = await requestUploadUrl({
    filekey: fileKey,
    media_type: WEIXIN_MEDIA_TYPE[kind] || WEIXIN_MEDIA_TYPE.file,
    to_user_id: toUserId,
    rawsize: plaintext.length,
    rawfilemd5: rawMd5,
    filesize: aesEcbPaddedSize(plaintext.length),
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
  });
  const uploadUrl = cdnUploadUrl(response, cdnBaseUrl.replace(/\/$/, ""), fileKey);
  const downloadParam = await uploadEncrypted(fetchFn, uploadUrl, ciphertext);
  return {
    aesKeyHex: aesKey.toString("hex"),
    downloadParam,
    fileSize: plaintext.length,
    ciphertextSize: ciphertext.length,
    rawMd5,
  };
}
