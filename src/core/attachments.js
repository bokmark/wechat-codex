import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const BLOCKED_DIRECTORIES = new Set([".git", ".codex", ".wechat-codex", "node_modules"]);
const BLOCKED_NAMES = new Set([".git-credentials", ".netrc", ".npmrc", "credentials.json", "id_dsa", "id_ed25519", "id_rsa"]);
const BLOCKED_EXTENSIONS = new Set([".key", ".p12", ".pfx", ".pem"]);

export function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function changeKind(change) {
  return typeof change?.kind === "string" ? change.kind : change?.kind?.type;
}

export function attachmentCandidates(items) {
  const candidates = [];
  for (const item of items || []) {
    if (item?.type === "fileChange" && (!item.status || item.status === "completed")) {
      for (const change of item.changes || []) {
        if (changeKind(change) === "add" && typeof change.path === "string") {
          candidates.push({ path: change.path, source: "fileChange" });
        }
      }
    }
    if (item?.type === "imageGeneration" && item.status === "completed" && typeof item.savedPath === "string") {
      candidates.push({ path: item.savedPath, source: "imageGeneration", kind: "image" });
    }
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeAttachmentCandidates(...groups) {
  const seen = new Set();
  const merged = [];
  for (const candidate of groups.flat()) {
    if (!candidate?.path) continue;
    const key = `${candidate.source || "fileChange"}:${candidate.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sensitive(relativePath) {
  const parts = relativePath.split(path.sep);
  const name = parts.at(-1).toLowerCase();
  if (parts.some((part) => BLOCKED_DIRECTORIES.has(part.toLowerCase()))) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return BLOCKED_NAMES.has(name) || BLOCKED_EXTENSIONS.has(path.extname(name));
}

export async function resolveAttachments(candidates, projectPath, { maxFiles = 5, maxFileBytes = 20 * 1024 * 1024 } = {}) {
  const root = await fs.realpath(projectPath);
  const attachments = [];
  const skipped = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    if (attachments.length >= maxFiles) {
      skipped.push({ path: candidate.path, reason: `每个任务最多发送 ${maxFiles} 个附件` });
      continue;
    }
    const absolute = path.resolve(root, candidate.path);
    const relative = path.relative(root, absolute);
    if (!containedBy(root, absolute)) {
      skipped.push({ path: candidate.path, reason: "不在项目目录内" });
      continue;
    }
    if (sensitive(relative)) {
      skipped.push({ path: candidate.path, reason: "可能包含凭据或密钥" });
      continue;
    }
    try {
      const linkStat = await fs.lstat(absolute);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
        skipped.push({ path: candidate.path, reason: "不是普通文件" });
        continue;
      }
      const real = await fs.realpath(absolute);
      if (!containedBy(root, real)) {
        skipped.push({ path: candidate.path, reason: "文件实际位置不在项目内" });
        continue;
      }
      if (linkStat.size > maxFileBytes) {
        skipped.push({ path: candidate.path, reason: `超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB` });
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      attachments.push({
        path: real,
        name: path.basename(real),
        kind: candidate.kind === "image" || isImagePath(real) ? "image" : "file",
        size: linkStat.size,
      });
    } catch (error) {
      skipped.push({ path: candidate.path, reason: error.code === "ENOENT" ? "文件已不存在" : "文件无法读取" });
    }
  }
  return { attachments, skipped };
}
