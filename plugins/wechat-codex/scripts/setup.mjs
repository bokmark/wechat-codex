#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LABEL = "com.bokmark.wechat-codex";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME_DIR = os.homedir();
const RUNTIME_DIR = path.join(HOME_DIR, ".local", "share", "wechat-codex");
const STATE_DIR = path.join(HOME_DIR, ".wechat-codex");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const PLIST_PATH = path.join(HOME_DIR, "Library", "LaunchAgents", `${LABEL}.plist`);

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function projectKey(projectPath) {
  return path.basename(projectPath).trim() || "project";
}

export function mergeProjectConfig(raw, selectedPath, requestedKey) {
  const resolved = path.resolve(selectedPath);
  const config = raw && typeof raw === "object" ? structuredClone(raw) : {};
  config.projects ||= {};
  const existing = Object.entries(config.projects).find(([, project]) => path.resolve(project.path) === resolved);
  let key = existing?.[0] || requestedKey || projectKey(resolved);
  if (!existing) {
    const base = key;
    let suffix = 2;
    while (config.projects[key] && path.resolve(config.projects[key].path) !== resolved) key = `${base}-${suffix++}`;
  }
  config.projects[key] = {
    ...config.projects[key],
    path: resolved,
    sandbox: config.projects[key]?.sandbox || "workspace-write",
    approvalPolicy: config.projects[key]?.approvalPolicy || "on-request",
  };
  config.defaultProject ||= key;
  config.wechat ||= { pollTimeoutMs: 35_000, sendAcknowledgement: true };
  config.externalMonitor ||= { enabled: true, intervalMs: 15_000, maxThreads: 50, notifyInterrupted: true };
  config.security ||= { ownerOnly: true };
  return { config, key };
}

function parseArgs(argv) {
  const command = argv[0] || "status";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--relogin") options.relogin = true;
    else if (value === "--project" || value === "--name") {
      if (!argv[index + 1]) throw new Error(`${value} 缺少参数`);
      options[value.slice(2)] = argv[++index];
    } else throw new Error(`未知参数：${value}`);
  }
  return { command, options };
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (options.allowFailure || result.status === 0) return result;
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(`${program} ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
}

function sourceRoot() {
  const bundled = path.join(PLUGIN_ROOT, "runtime");
  if (fs.existsSync(path.join(bundled, "src", "cli.js"))) return bundled;
  const candidate = path.resolve(PLUGIN_ROOT, "..", "..");
  if (fs.existsSync(path.join(candidate, "src", "cli.js"))) return candidate;
  throw new Error("插件安装包不完整，请在 Codex 插件页更新或重新安装 WeChat Codex");
}

function deployRuntime(source) {
  const staging = `${RUNTIME_DIR}.new-${process.pid}`;
  const previous = `${RUNTIME_DIR}.previous`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const item of ["src", "package.json", "README.md", "LICENSE", "THIRD_PARTY.md"]) {
    const from = path.join(source, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, item), { recursive: true });
  }
  if (!fs.existsSync(path.join(staging, "src", "cli.js"))) throw new Error("运行文件部署失败");
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, previous);
  fs.renameSync(staging, RUNTIME_DIR);
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`已有配置无法读取，请让 Codex 帮你检查：${CONFIG_PATH}`);
  }
}

function saveConfig(config) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIG_PATH);
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function resolveCodexExecutable(configured) {
  const candidates = [
    configured,
    executableOnPath("codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function plist(nodePath, codexPath) {
  const launchPath = [...new Set([
    path.dirname(nodePath), path.dirname(codexPath), "/opt/homebrew/bin", "/usr/local/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ])].join(":");
  const values = {
    label: LABEL,
    node: nodePath,
    cli: path.join(RUNTIME_DIR, "src", "cli.js"),
    cwd: RUNTIME_DIR,
    config: CONFIG_PATH,
    state: STATE_DIR,
    stdout: path.join(STATE_DIR, "service.log"),
    stderr: path.join(STATE_DIR, "service-error.log"),
    launchPath,
  };
  for (const [key, value] of Object.entries(values)) values[key] = xmlEscape(value);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${values.label}</string>
  <key>ProgramArguments</key><array><string>${values.node}</string><string>${values.cli}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${values.cwd}</string>
  <key>EnvironmentVariables</key><dict>
    <key>WECHAT_CODEX_CONFIG</key><string>${values.config}</string>
    <key>WECHAT_CODEX_STATE_DIR</key><string>${values.state}</string>
    <key>PATH</key><string>${values.launchPath}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${values.stdout}</string>
  <key>StandardErrorPath</key><string>${values.stderr}</string>
</dict></plist>
`;
}

function serviceTarget() { return `gui/${process.getuid()}/${LABEL}`; }

function writeLaunchAgent(codexPath) {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist(process.execPath, codexPath), { mode: 0o600 });
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function bootService() {
  if (serviceStatus().loaded) {
    const restarted = run("launchctl", ["kickstart", "-k", serviceTarget()], { allowFailure: true });
    if (restarted.status === 0 || serviceStatus().running) return;
    const detail = String(restarted.stderr || restarted.stdout || "").trim();
    throw new Error(`后台服务重启失败${detail ? `：${detail}` : ""}`);
  }
  let loaded;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt) pause(1_000);
    loaded = run("launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST_PATH], { allowFailure: true });
    if (serviceStatus().loaded) return;
  }
  const detail = String(loaded?.stderr || loaded?.stdout || "").trim();
  throw new Error(`launchctl bootstrap 失败${detail ? `：${detail}` : ""}`);
}

function requireMac() {
  if (process.platform !== "darwin") throw new Error("自动后台服务目前只支持 macOS");
}

function serviceStatus() {
  const result = run("launchctl", ["print", serviceTarget()], { allowFailure: true });
  if (result.status !== 0) return { loaded: false, running: false, state: "未载入" };
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || "已载入";
  return { loaded: true, running: state === "running", state };
}

function showStatus() {
  requireMac();
  const status = serviceStatus();
  if (!status.loaded) {
    console.log("WeChat Codex 后台服务尚未运行。");
    return false;
  }
  console.log(`WeChat Codex 后台服务：${status.state}${status.running ? "" : "（未正常运行）"}`);
  console.log(`配置：${CONFIG_PATH}`);
  return status.running;
}

function waitForService(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceStatus().running) return true;
    pause(250);
  }
  return false;
}

function showLogs() {
  const files = [path.join(STATE_DIR, "service.log"), path.join(STATE_DIR, "service-error.log")];
  for (const file of files) {
    console.log(`\n${file}`);
    if (!fs.existsSync(file)) { console.log("（暂无日志）"); continue; }
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    console.log(lines.slice(-80).join("\n"));
  }
}

function loginIfNeeded(relogin) {
  const credentials = path.join(STATE_DIR, "credentials.json");
  if (!relogin && fs.existsSync(credentials)) {
    console.log("[3/5] 已找到微信授权，将直接复用。");
    return;
  }
  console.log("[3/5] 需要完成一次微信授权。请打开稍后显示的链接并在微信中确认。");
  const result = run(process.execPath, [path.join(RUNTIME_DIR, "src", "cli.js"), "login"], {
    cwd: RUNTIME_DIR,
    env: { ...process.env, WECHAT_CODEX_CONFIG: CONFIG_PATH, WECHAT_CODEX_STATE_DIR: STATE_DIR },
    stdio: "inherit",
    allowFailure: true,
  });
  if (result.status !== 0) throw new Error("微信授权未完成，可以稍后重新运行安装命令");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "status") { showStatus(); return; }
  if (command === "logs") { showLogs(); return; }
  if (command === "restart") {
    requireMac();
    if (!fs.existsSync(PLIST_PATH)) throw new Error("服务尚未安装，请先运行 install");
    bootService();
    if (!waitForService() || !showStatus()) throw new Error("后台服务未能启动，请查看 logs");
    return;
  }
  if (command !== "install") throw new Error(`未知操作：${command}`);

  requireMac();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) throw new Error("当前运行环境过旧，请先更新 Codex 后重试");
  const selected = path.resolve(options.project || process.cwd());
  if (!fs.statSync(selected, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`项目目录不存在：${selected}`);
  if (selected === PLUGIN_ROOT || selected.startsWith(`${PLUGIN_ROOT}${path.sep}`)) {
    throw new Error("不能把插件缓存目录当作项目；请通过 --project 指定真实项目目录");
  }

  console.log("[1/5] 正在检查插件和当前项目……");
  const source = sourceRoot();
  console.log("[2/5] 正在部署本地桥接服务并自动生成配置……");
  deployRuntime(source);
  const { config, key } = mergeProjectConfig(loadConfig(), selected, options.name);
  const codexPath = resolveCodexExecutable(config.codexPath);
  if (!codexPath) throw new Error("找不到本机 Codex。请先安装或更新 Codex，再重新发送“连接我的微信”");
  config.codexPath = codexPath;
  saveConfig(config);
  loginIfNeeded(options.relogin);
  console.log("[4/5] 正在设置登录 macOS 后自动启动……");
  writeLaunchAgent(codexPath);
  bootService();
  if (!waitForService() || !showStatus()) throw new Error("后台服务未能启动，请查看 logs");
  console.log("[5/5] 正在完成健康检查……");
  console.log(`项目已加入监控：${key} (${selected})`);
  console.log("安装完成。现在可以直接在微信发送 help；以后无需运行命令或编辑配置文件。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`安装失败：${error.message}`);
    process.exitCode = 1;
  });
}
