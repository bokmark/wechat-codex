import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const validSandboxes = new Set(["read-only", "workspace-write"]);
const validApprovalPolicies = new Set(["untrusted", "on-request", "never"]);

export function resolveStateDir() {
  return path.resolve(process.env.WECHAT_CODEX_STATE_DIR || path.join(os.homedir(), ".wechat-codex"));
}

export function loadConfig(configPath = process.env.WECHAT_CODEX_CONFIG || path.resolve("config.json")) {
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const cwd = process.cwd();
  const fallbackKey = path.basename(cwd);
  const projects = raw.projects ?? {
    [fallbackKey]: {
      path: cwd,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    },
  };

  if (!projects || typeof projects !== "object" || Object.keys(projects).length === 0) {
    throw new Error("config.projects must contain at least one project");
  }

  const normalizedProjects = {};
  for (const [key, value] of Object.entries(projects)) {
    if (!value || typeof value.path !== "string") throw new Error(`project ${key} needs an absolute path`);
    if (!path.isAbsolute(value.path)) throw new Error(`project ${key} path must be absolute`);
    const projectPath = path.resolve(value.path);
    const sandbox = value.sandbox ?? "workspace-write";
    const approvalPolicy = value.approvalPolicy ?? "on-request";
    if (!validSandboxes.has(sandbox)) throw new Error(`project ${key} has unsafe/unknown sandbox: ${sandbox}`);
    if (!validApprovalPolicies.has(approvalPolicy)) throw new Error(`project ${key} has unknown approvalPolicy: ${approvalPolicy}`);
    normalizedProjects[key] = { path: projectPath, sandbox, approvalPolicy };
  }

  const defaultProject = raw.defaultProject ?? Object.keys(normalizedProjects)[0];
  if (!normalizedProjects[defaultProject]) throw new Error(`defaultProject ${defaultProject} is not configured`);

  return {
    configPath,
    stateDir: resolveStateDir(),
    codexPath: raw.codexPath || "codex",
    defaultProject,
    projects: normalizedProjects,
    wechat: {
      pollTimeoutMs: Number(raw.wechat?.pollTimeoutMs ?? 35_000),
      sendAcknowledgement: raw.wechat?.sendAcknowledgement !== false,
    },
    externalMonitor: {
      enabled: raw.externalMonitor?.enabled !== false,
      intervalMs: Math.max(5_000, Number(raw.externalMonitor?.intervalMs ?? 15_000)),
      maxThreads: Math.max(1, Math.min(200, Number(raw.externalMonitor?.maxThreads ?? 50))),
      notifyInterrupted: raw.externalMonitor?.notifyInterrupted !== false,
    },
    security: {
      ownerOnly: raw.security?.ownerOnly !== false,
    },
  };
}
