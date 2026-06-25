#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_ENTRY = path.join(PACKAGE_ROOT, "src", "index.js");
const DEFAULT_BASE_URL = "https://www.ccgoai.com/v1";
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "Pictures", "ccgo-imager-output");
const SERVER_NAME = "ccgo-imager";
const VERSION = "0.2.8";
const REQUIRED_TOOLS = [
  "ccgo_image_generate",
  "ccgo_image_edit",
  "ccgo_image_batch_edit",
  "ccgo_image_multi_reference",
  "server_info",
];

function info(message) {
  console.log(`[..] ${message}`);
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function warn(message) {
  console.warn(`[!!] ${message}`);
}

function step(message) {
  console.log(`\n>>> ${message}`);
}

function parseArgs(argv) {
  const args = {
    claude: true,
    codex: true,
    reset: false,
    yes: false,
    baseURL: DEFAULT_BASE_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
    inputRoot: "",
    skipModelsCheck: false,
    strictModelsCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    switch (item) {
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--no-claude":
        args.claude = false;
        break;
      case "--no-codex":
        args.codex = false;
        break;
      case "--reset":
        args.reset = true;
        break;
      case "--base-url":
        args.baseURL = argv[++i] || args.baseURL;
        break;
      case "--output-dir":
        args.outputDir = path.resolve(argv[++i] || args.outputDir);
        break;
      case "--input-root":
        args.inputRoot = path.resolve(argv[++i] || "");
        break;
      case "--skip-models-check":
        args.skipModelsCheck = true;
        break;
      case "--strict-model-check":
        args.strictModelsCheck = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`CCGO Imager MCP installer

Usage:
  npm run install:local
  npm run install:local -- --reset
  CCGO_IMAGE_API_KEY=sk-... npm run install:local -- --yes

Options:
  --yes                 Non-interactive mode. Read key from CCGO_IMAGE_API_KEY or CCGO_API_KEY.
  --no-claude           Do not update ~/.claude.json.
  --no-codex            Do not update ~/.codex/config.toml.
  --reset               Remove ccgo-imager config from selected clients.
  --base-url URL        CCGO OpenAI-compatible base URL. Default ${DEFAULT_BASE_URL}
  --output-dir PATH     Output root. Default ~/Pictures/ccgo-imager-output
  --input-root PATH     Optional local input root restriction.
  --skip-models-check   Skip optional /v1/models validation.
  --strict-model-check  Treat /v1/models validation failure as fatal.`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function maskKey(key) {
  const value = String(key || "").trim();
  if (value.length <= 9) return "***";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

async function chmodSafe(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch {
    // Windows and some mounted filesystems may ignore POSIX modes.
  }
}

function backupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.bak-${stamp}`;
}

async function backupIfExists(filePath) {
  if (!(await exists(filePath))) return "";
  const target = backupPath(filePath);
  await copyFile(filePath, target);
  await chmodSafe(target, 0o600);
  info(`Backup: ${target}`);
  return target;
}

async function writeTextAtomicSecure(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, filePath);
  await chmodSafe(filePath, 0o600);
}

async function writeJSONAtomic(filePath, value) {
  await writeTextAtomicSecure(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function askText(prompt, defaultValue = "") {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`${prompt}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt, defaultValue = true) {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  for (;;) {
    const answer = (await askText(`${prompt} ${hint}`)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

async function askSecret(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive key input requires a TTY. Use CCGO_IMAGE_API_KEY=sk-... npm run install:local -- --yes instead.");
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";

    output.write(`${prompt}: `);
    stdin.setEncoding("utf8");
    stdin.setRawMode?.(true);
    stdin.resume();

    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode?.(Boolean(wasRaw));
      output.write("\n");
    }

    function onData(chunk) {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    }

    stdin.on("data", onData);
  });
}

async function promptForKey(args) {
  const currentKey = (process.env.CCGO_IMAGE_API_KEY || process.env.CCGO_API_KEY || "").trim();
  if (args.yes) {
    if (!currentKey) {
      throw new Error("--yes mode requires CCGO_IMAGE_API_KEY=sk-... or CCGO_API_KEY=sk-...");
    }
    return currentKey;
  }
  step("配置 CCGO 生图 MCP Key");
  info("请使用 CCGO 后台提供的生图 MCP Key。Key 只会写入你本机的 Codex/Claude 配置，不会发送到聊天窗口。");
  for (;;) {
    const key = currentKey || await askSecret("请粘贴 CCGO 生图 MCP Key");
    if (!key) {
      warn("Key 不能为空。");
      if (currentKey) throw new Error("Environment key is empty.");
      continue;
    }
    info(`输入的 Key: ${maskKey(key)}`);
    if (key.startsWith("sk-") || await askYesNo("Key 不是 sk- 开头，仍然继续?", false)) {
      if (currentKey || await askYesNo("确认使用这个 Key?", true)) {
        return key;
      }
    }
    if (currentKey) {
      throw new Error("Environment key was rejected.");
    }
  }
}

async function confirmReset(args) {
  if (args.yes) return;
  if (!(await askYesNo(`Remove ${SERVER_NAME} from selected client configs?`, false))) {
    throw new Error("Cancelled.");
  }
}

function buildEnv(args, apiKey) {
  const env = {
    CCGO_IMAGE_API_KEY: apiKey,
    CCGO_BASE_URL: args.baseURL,
    CCGO_IMAGER_OUTPUT_DIR: args.outputDir,
  };
  if (args.inputRoot) {
    env.CCGO_IMAGER_INPUT_ROOT = args.inputRoot;
  }
  return env;
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Node.js >= 20 is required. Current version: ${process.version}`);
  }
  ok(`Node.js ${process.version}`);
}

function warnRunningClients() {
  if (process.platform === "win32") return;
  for (const pattern of ["Claude", "codex"]) {
    const result = spawnSync("pgrep", ["-l", "-i", pattern], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => !/(node|npm|npx|python|install\.mjs)/i.test(line));
    if (lines.length > 0) {
      warn(`检测到 ${pattern} 相关进程，安装完成后请重启客户端使 MCP 生效。`);
    }
  }
}

async function updateClaudeConfig(args, env) {
  const filePath = path.join(os.homedir(), ".claude.json");
  const backup = await backupIfExists(filePath);
  let config = {};
  if (await exists(filePath)) {
    try {
      config = JSON.parse(await readFile(filePath, "utf8") || "{}");
    } catch (error) {
      throw new Error(`~/.claude.json is not valid JSON. Backup was created. ${error.message}`);
    }
  }
  config.mcpServers ||= {};
  if (args.reset) {
    delete config.mcpServers[SERVER_NAME];
  } else {
    config.mcpServers[SERVER_NAME] = {
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
    };
  }
  await writeJSONAtomic(filePath, config);
  return backup;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function removeCodexServerBlock(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const kept = [];
  let skip = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (header) {
      const name = header[1];
      skip = name === `mcp_servers.${SERVER_NAME}` || name === `mcp_servers.${SERVER_NAME}.env`;
    }
    if (!skip) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function updateCodexConfig(args, env) {
  const configDir = path.join(os.homedir(), ".codex");
  const filePath = path.join(configDir, "config.toml");
  await mkdir(configDir, { recursive: true });
  await chmodSafe(configDir, 0o700);
  const backup = await backupIfExists(filePath);
  const current = (await exists(filePath)) ? await readFile(filePath, "utf8") : "";
  let next = removeCodexServerBlock(current);
  if (!args.reset) {
    const envLines = Object.entries(env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join("\n");
    const block = `[mcp_servers.${SERVER_NAME}]
command = ${tomlString(process.execPath)}
args = [${tomlString(SERVER_ENTRY)}]

[mcp_servers.${SERVER_NAME}.env]
${envLines}`;
    next = `${next ? `${next}\n\n` : ""}${block}`;
  }
  await writeTextAtomicSecure(filePath, `${next.trimEnd()}\n`);
  return backup;
}

async function validateHandshake(env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let nextId = 1;
    const responses = new Map();
    let stdout = "";
    let stderr = "";
    let poll;
    const timer = setTimeout(() => {
      if (poll) clearInterval(poll);
      child.kill();
      reject(new Error(`MCP tools/list handshake timed out. ${stderr}`.trim()));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id) {
            responses.set(message.id, message);
          }
        } catch {
          // Ignore non-JSON process output.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      reject(error);
    });

    function send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return id;
    }

    const initId = send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ccgo-imager-installer", version: VERSION },
    });

    poll = setInterval(() => {
      if (responses.has(initId) && !responses.has("initialized-sent")) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
        responses.set("initialized-sent", true);
        send("tools/list");
      }
      for (const [id, message] of responses.entries()) {
        if (typeof id === "number" && id !== initId && message?.result?.tools) {
          clearTimeout(timer);
          clearInterval(poll);
          child.kill();
          const toolNames = message.result.tools.map((tool) => tool.name);
          for (const required of REQUIRED_TOOLS) {
            if (!toolNames.includes(required)) {
              reject(new Error(`MCP handshake missing tool: ${required}`));
              return;
            }
          }
          ok(`MCP tools/list OK: ${toolNames.sort().join(", ")}`);
          resolve();
          return;
        }
      }
    }, 100);
  });
}

function assertSafeBaseURLForKeyProbe(rawURL) {
  const parsed = new URL(rawURL);
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("Refusing to send key to a non-HTTPS, non-local base URL.");
  }
}

async function validateModels(args, apiKey) {
  if (args.skipModelsCheck || !apiKey) return;
  try {
    assertSafeBaseURLForKeyProbe(args.baseURL);
    const response = await fetch(`${args.baseURL.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error("models response missing data[]");
    ok("Optional /v1/models check passed.");
  } catch (error) {
    const message = `Optional /v1/models check failed: ${error?.message || error}`;
    if (args.strictModelsCheck) throw new Error(message);
    warn(message);
  }
}

const args = parseArgs(process.argv.slice(2));

checkNodeVersion();
warnRunningClients();

if (args.reset) {
  await confirmReset(args);
} else {
  step("安装 CCGO Imager MCP");
  info(`Base URL: ${args.baseURL}`);
  info(`输出目录: ${args.outputDir}`);
}

const apiKey = args.reset ? "" : await promptForKey(args);
const env = args.reset ? {} : buildEnv(args, apiKey);

if (!args.reset) {
  await mkdir(args.outputDir, { recursive: true });
  await chmodSafe(args.outputDir, 0o700);
  await validateHandshake(env);
  await validateModels(args, apiKey);
}

const backups = [];
if (args.claude) backups.push(["Claude", await updateClaudeConfig(args, env)]);
if (args.codex) backups.push(["Codex", await updateCodexConfig(args, env)]);

ok(args.reset ? "CCGO Imager MCP config removed." : "CCGO Imager MCP installed.");
for (const [name, backup] of backups) {
  if (backup) info(`${name} backup: ${backup}`);
}
if (!args.reset) {
  console.log("\n安装完成。请重启 Codex / Claude Desktop / Claude Code。");
  console.log(`图片会保存到: ${args.outputDir}`);
  console.log("\n重启后直接描述你想要的图片即可，例如：");
  console.log("  帮我生成一张蓝色对勾图标，透明背景。");
  console.log("  根据这张参考图，帮我生成一张同风格头像。");
}
