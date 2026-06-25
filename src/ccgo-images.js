import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://www.ccgoai.com/v1";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "Pictures", "ccgo-imager-output");
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_N = 6;
const DEFAULT_BATCH_CONCURRENCY = 4;
const MAX_BATCH_CONCURRENCY = 6;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;
const MAX_TASK_TIMEOUT_MS = 20 * 60_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_DOWNLOAD_REDIRECTS = 5;

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

export const CCGO_IMAGER_LIMITS = {
  defaultModel: DEFAULT_MODEL,
  defaultSize: DEFAULT_SIZE,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxN: MAX_N,
  defaultBatchConcurrency: DEFAULT_BATCH_CONCURRENCY,
  maxBatchConcurrency: MAX_BATCH_CONCURRENCY,
};

export function resolveConfig(env = process.env) {
  const outputRoot = path.resolve(
    env.CCGO_IMAGER_OUTPUT_DIR || env.CCGO_IMAGER_OUTPUT_ROOT || DEFAULT_OUTPUT_DIR,
  );
  const inputRoot = env.CCGO_IMAGER_INPUT_ROOT
    ? path.resolve(env.CCGO_IMAGER_INPUT_ROOT)
    : "";
  return {
    baseURL: normalizeBaseURL(env.CCGO_BASE_URL || DEFAULT_BASE_URL),
    apiKey: env.CCGO_IMAGE_API_KEY || env.CCGO_API_KEY || "",
    outputRoot,
    outputDir: outputRoot,
    inputRoot,
    retryAttempts: normalizeRetryAttempts(env.CCGO_IMAGER_RETRY_ATTEMPTS),
    timeoutMs: normalizeTimeoutMs(env.CCGO_IMAGER_TIMEOUT_MS),
    taskTimeoutMs: normalizeTaskTimeoutMs(env.CCGO_IMAGER_TASK_TIMEOUT_MS),
  };
}

export function normalizeBaseURL(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  const withoutSlash = raw.replace(/\/+$/, "");
  return withoutSlash.endsWith("/v1") ? withoutSlash : `${withoutSlash}/v1`;
}

export function requireAPIKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(
      "Missing CCGO_IMAGE_API_KEY. Set CCGO_IMAGE_API_KEY to the user's CCGO image MCP key before starting the MCP server.",
    );
  }
  return apiKey.trim();
}

export function normalizeImageCount(n) {
  if (n === undefined || n === null || n === "") return 1;
  const count = Number(n);
  if (!Number.isInteger(count) || count < 1 || count > MAX_N) {
    throw new Error(`n must be an integer between 1 and ${MAX_N}`);
  }
  return count;
}

export function normalizeBatchConcurrency(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BATCH_CONCURRENCY;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${MAX_BATCH_CONCURRENCY}`);
  }
  return count;
}

function normalizeRetryAttempts(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_RETRY_ATTEMPTS;
  const attempts = Number(value);
  if (!Number.isInteger(attempts) || attempts < 1) return DEFAULT_RETRY_ATTEMPTS;
  return Math.min(attempts, 5);
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 5_000) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(ms), 300_000);
}

function normalizeTaskTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TASK_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 10_000) return DEFAULT_TASK_TIMEOUT_MS;
  return Math.min(Math.floor(ms), MAX_TASK_TIMEOUT_MS);
}

export function sanitizeFilenamePart(value) {
  return String(value || "ccgo-image")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ccgo-image";
}

export function detectImageType(buffer, fallback = "png") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return { ext: fallback, mime: `image/${fallback === "jpg" ? "jpeg" : fallback}`, trusted: false };
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png", trusted: true };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { ext: "jpg", mime: "image/jpeg", trusted: true };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp", trusted: true };
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { ext: "gif", mime: "image/gif", trusted: true };
  }
  return { ext: fallback, mime: `image/${fallback === "jpg" ? "jpeg" : fallback}`, trusted: false };
}

export function detectImageExtension(buffer, fallback = "png") {
  return detectImageType(buffer, fallback).ext;
}

export function resolveInsideRoot(root, requested = "") {
  const resolvedRoot = path.resolve(root || DEFAULT_OUTPUT_DIR);
  const target = requested
    ? path.resolve(path.isAbsolute(requested) ? requested : path.join(resolvedRoot, requested))
    : resolvedRoot;
  const relative = path.relative(resolvedRoot, target);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`Path is outside the allowed root: ${target}`);
  }
  return target;
}

async function readImageFile(filePath, config = resolveConfig()) {
  const resolved = path.resolve(filePath);
  if (config.inputRoot) {
    resolveInsideRoot(config.inputRoot, resolved);
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`Image path is not a file: ${resolved}`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image file is too large: ${resolved}`);
  }
  const bytes = await readFile(resolved);
  const imageType = detectImageType(bytes);
  if (!imageType.trusted) {
    throw new Error(`Unsupported or invalid image file: ${resolved}`);
  }
  return { resolved, bytes, mime: imageType.mime };
}

function requestHeaders(apiKey) {
  return {
    Authorization: `Bearer ${requireAPIKey(apiKey)}`,
  };
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return 0;
  return Math.max(0, Math.min(dateMs - Date.now(), MAX_RETRY_AFTER_MS));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const attempts = options.retryAttempts || options.config?.retryAttempts || DEFAULT_RETRY_ATTEMPTS;
  const timeoutMs = options.timeoutMs || options.config?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const sleepImpl = options.sleep || sleep;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: init.signal || controller.signal,
      });
      clearTimeout(timer);
      if (!RETRY_STATUSES.has(response.status) || attempt === attempts) {
        return response;
      }
      const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
      await sleepImpl(retryAfter || Math.min(1000 * attempt, 3000));
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === attempts) break;
      await sleepImpl(Math.min(1000 * attempt, 3000));
    }
  }
  throw lastError || new Error("CCGO image request failed");
}

async function readResponseText(response) {
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("CCGO image response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("CCGO image response is too large");
  }
  return text;
}

async function parseResponse(response) {
  const text = await readResponseText(response);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message =
      body?.error?.message ||
      body?.message ||
      body?.raw ||
      `CCGO image request failed with HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 1000));
  }
  return body;
}

function pickOptionalFields(input, allowed) {
  const out = {};
  for (const key of allowed) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      out[key] = input[key];
    }
  }
  return out;
}

function fetchOptions(options, config) {
  return {
    fetch: options.fetch || fetch,
    retryAttempts: options.retryAttempts || config.retryAttempts,
    timeoutMs: options.timeoutMs || config.timeoutMs,
    sleep: options.sleep,
    config,
  };
}

export async function generateImage(input, options = {}) {
  const config = options.config || resolveConfig();
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");

  const payload = {
    model: input.model || DEFAULT_MODEL,
    prompt,
    size: input.size || DEFAULT_SIZE,
    n: normalizeImageCount(input.n),
    ...pickOptionalFields(input, [
      "quality",
      "background",
      "output_format",
      "moderation",
      "style",
    ]),
  };

  const response = await fetchWithRetry(
    `${config.baseURL}/images/generations`,
    {
      method: "POST",
      headers: {
        ...requestHeaders(config.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    fetchOptions(options, config),
  );
  const body = await parseResponse(response);
  return saveImageResponse(body, {
    outputRoot: config.outputRoot || config.outputDir,
    outputDir: input.output_dir || "",
    filenamePrefix: input.filename_prefix || "ccgo-generated",
    downloadURLs: input.download_urls !== false,
    fetchImpl: options.fetch || fetch,
    retryAttempts: config.retryAttempts,
    timeoutMs: config.timeoutMs,
    taskTimeoutMs: config.taskTimeoutMs,
    taskBaseURL: config.baseURL,
    taskAPIKey: config.apiKey,
    initialPollAfterMs: parseRetryAfter(response.headers?.get?.("retry-after")),
    sleep: options.sleep,
  });
}

export async function editImage(input, options = {}) {
  const config = options.config || resolveConfig();
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");

  const imagePaths = Array.isArray(input.image_paths)
    ? input.image_paths
    : input.image_path
      ? [input.image_path]
      : [];
  if (imagePaths.length === 0) {
    throw new Error("image_path or image_paths is required");
  }

  const form = new FormData();
  form.set("model", input.model || DEFAULT_MODEL);
  form.set("prompt", prompt);
  form.set("size", input.size || DEFAULT_SIZE);
  form.set("n", String(normalizeImageCount(input.n)));
  for (const [key, value] of Object.entries(
    pickOptionalFields(input, [
      "quality",
      "background",
      "output_format",
      "moderation",
      "input_fidelity",
    ]),
  )) {
    form.set(key, String(value));
  }

  for (const imagePath of imagePaths) {
    const image = await readImageFile(imagePath, config);
    form.append("image", new Blob([image.bytes], { type: image.mime }), path.basename(image.resolved));
  }
  if (input.mask_path) {
    const mask = await readImageFile(input.mask_path, config);
    form.set("mask", new Blob([mask.bytes], { type: mask.mime }), path.basename(mask.resolved));
  }

  const response = await fetchWithRetry(
    `${config.baseURL}/images/edits`,
    {
      method: "POST",
      headers: requestHeaders(config.apiKey),
      body: form,
    },
    fetchOptions(options, config),
  );
  const body = await parseResponse(response);
  return saveImageResponse(body, {
    outputRoot: config.outputRoot || config.outputDir,
    outputDir: input.output_dir || "",
    filenamePrefix: input.filename_prefix || "ccgo-edited",
    downloadURLs: input.download_urls !== false,
    fetchImpl: options.fetch || fetch,
    retryAttempts: config.retryAttempts,
    timeoutMs: config.timeoutMs,
    taskTimeoutMs: config.taskTimeoutMs,
    taskBaseURL: config.baseURL,
    taskAPIKey: config.apiKey,
    initialPollAfterMs: parseRetryAfter(response.headers?.get?.("retry-after")),
    sleep: options.sleep,
  });
}

export async function batchEditImages(input, options = {}) {
  const imagePaths = Array.isArray(input.image_paths) ? input.image_paths : [];
  if (imagePaths.length === 0) {
    throw new Error("image_paths is required");
  }
  const concurrency = normalizeBatchConcurrency(input.concurrency);
  const results = new Array(imagePaths.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= imagePaths.length) return;
      try {
        results[index] = {
          index,
          image_path: imagePaths[index],
          ok: true,
          result: await editImage(
            {
              ...input,
              image_path: imagePaths[index],
              image_paths: undefined,
              filename_prefix: input.filename_prefix
                ? `${input.filename_prefix}-${index + 1}`
                : `ccgo-batch-${index + 1}`,
            },
            options,
          ),
        };
      } catch (error) {
        results[index] = {
          index,
          image_path: imagePaths[index],
          ok: false,
          error: String(error?.message || error),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, imagePaths.length) }, () => worker()));
  return {
    concurrency,
    total: imagePaths.length,
    succeeded: results.filter((item) => item?.ok).length,
    failed: results.filter((item) => item && !item.ok).length,
    results,
  };
}

export async function multiReferenceImage(input, options = {}) {
  const imagePaths = Array.isArray(input.image_paths) ? input.image_paths : [];
  if (imagePaths.length < 2) {
    throw new Error("image_paths must contain at least 2 reference images");
  }
  if (imagePaths.length > 10) {
    throw new Error("image_paths supports at most 10 reference images");
  }
  return editImage(input, options);
}

export async function assertSafeDownloadURL(rawURL) {
  const parsed = new URL(rawURL);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported image URL protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error("Image URL is missing a hostname");
  const literalFamily = net.isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: false });
  for (const item of addresses) {
    if (isBlockedIPAddress(item.address)) {
      throw new Error(`Image URL resolves to a blocked address: ${item.address}`);
    }
  }
  return parsed.toString();
}

export function isBlockedIPAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

function isBlockedIPv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isBlockedIPv6(address) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("ff")) return true;
  if (lower.startsWith("::ffff:")) {
    return isBlockedIPv4(lower.replace("::ffff:", ""));
  }
  return false;
}

async function downloadImageURL(rawURL, options, redirectCount = 0) {
  const safeURL = await assertSafeDownloadURL(rawURL);
  const response = await fetchWithRetry(
    safeURL,
    { method: "GET", redirect: "manual" },
    {
      fetch: options.fetchImpl,
      retryAttempts: options.retryAttempts,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
    },
  );
  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
      throw new Error("Image URL download redirected too many times");
    }
    const location = response.headers?.get?.("location");
    if (!location) {
      throw new Error(`Image URL download redirected without a Location header`);
    }
    return downloadImageURL(new URL(location, safeURL).toString(), options, redirectCount + 1);
  }
  if (!response.ok) {
    throw new Error(`Image URL download failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error("Downloaded image is too large");
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Downloaded image is too large");
  }
  return buffer;
}

function isImageTaskBody(body) {
  return body && typeof body === "object" && typeof body.id === "string" && typeof body.status === "string";
}

function taskErrorMessage(body) {
  return (
    body?.error?.message ||
    body?.message ||
    `Image task ${body?.id || ""} ${body?.status || "failed"}`
  );
}

function normalizeTaskPollAfter(body, fallback = 0) {
  const value = Number(body?.poll_after_ms || fallback || 0);
  if (!Number.isFinite(value) || value <= 0) return 1200;
  return Math.max(500, Math.min(value, 10_000));
}

function taskURL(baseURL, suffix) {
  const base = new URL(baseURL);
  if (suffix.startsWith("http://") || suffix.startsWith("https://")) {
    const parsed = new URL(suffix);
    if (parsed.origin !== base.origin) {
      throw new Error("Image task result URL uses a different origin");
    }
    return parsed.toString();
  }
  if (suffix.startsWith("/")) {
    return `${base.origin}${suffix}`;
  }
  return `${baseURL.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function readResponseBuffer(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error("CCGO image response is too large");
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxBytes) {
    throw new Error("CCGO image response is too large");
  }
  return buffer;
}

async function fetchImageTaskStatus(taskID, options) {
  const response = await fetchWithRetry(
    taskURL(options.taskBaseURL, `/v1/images/tasks/${encodeURIComponent(taskID)}`),
    {
      method: "GET",
      headers: requestHeaders(options.taskAPIKey),
    },
    {
      fetch: options.fetchImpl,
      retryAttempts: options.retryAttempts,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
    },
  );
  return parseResponse(response);
}

async function fetchImageTaskResult(task, options) {
  const resultURL = task.result_url || `/v1/images/tasks/${encodeURIComponent(task.id)}/result`;
  const response = await fetchWithRetry(
    taskURL(options.taskBaseURL, resultURL),
    {
      method: "GET",
      headers: requestHeaders(options.taskAPIKey),
    },
    {
      fetch: options.fetchImpl,
      retryAttempts: options.retryAttempts,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
    },
  );
  if (!response.ok) {
    const body = await parseResponse(response);
    throw new Error(taskErrorMessage(body));
  }
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.toLowerCase().includes("application/json")) {
    return saveImageResponse(await parseResponse(response), options);
  }
  const buffer = await readResponseBuffer(response);
  return saveImageBuffer(buffer, {
    ...options,
    filenamePrefix: options.filenamePrefix || `ccgo-task-${task.id}`,
    contentType,
    task,
  });
}

async function waitForImageTask(initialTask, options) {
  if (!options.taskBaseURL || !options.taskAPIKey) {
    throw new Error("CCGO image response returned an async task, but task polling is not configured");
  }
  const sleepImpl = options.sleep || sleep;
  const startedAt = Date.now();
  const timeoutMs = options.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS;
  let task = initialTask;
  let waitMs = normalizeTaskPollAfter(task, options.initialPollAfterMs);

  for (;;) {
    const status = String(task.status || "").toLowerCase();
    if (status === "succeeded") {
      if (task.result_available === false) {
        throw new Error("Image task succeeded but result is not available");
      }
      return fetchImageTaskResult(task, options);
    }
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      throw new Error(taskErrorMessage(task));
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Image task ${task.id} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleepImpl(waitMs);
    task = await fetchImageTaskStatus(task.id, options);
    waitMs = normalizeTaskPollAfter(task);
  }
}

async function saveImageBuffer(buffer, options = {}) {
  const outputRoot = path.resolve(options.outputRoot || options.outputDir || DEFAULT_OUTPUT_DIR);
  const outputDir = resolveInsideRoot(outputRoot, options.outputDir || "");
  await mkdir(outputDir, { recursive: true });
  const prefix = sanitizeFilenamePart(options.filenamePrefix);
  const imageType = detectImageType(buffer, contentTypeExtension(options.contentType));
  if (!imageType.trusted && !String(options.contentType || "").toLowerCase().startsWith("image/")) {
    throw new Error("CCGO image task result is not an image");
  }
  const filePath = await nextImagePath(outputDir, prefix, 1, imageType.ext);
  await writeFile(filePath, buffer);
  return {
    output_dir: outputDir,
    images: [
      {
        index: 0,
        path: filePath,
        mime_type: imageType.mime,
        task_id: options.task?.id || null,
        revised_prompt: "",
      },
    ],
    usage: null,
    task: options.task
      ? {
          id: options.task.id,
          status: options.task.status,
          result_url: options.task.result_url || null,
        }
      : null,
  };
}

function contentTypeExtension(contentType = "") {
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes("image/jpeg") || normalized.includes("image/jpg")) return "jpg";
  if (normalized.includes("image/webp")) return "webp";
  if (normalized.includes("image/gif")) return "gif";
  return "png";
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function nextImagePath(outputDir, prefix, index, ext) {
  const basePath = path.join(outputDir, `${prefix}-${index}.${ext}`);
  if (!(await fileExists(basePath))) return basePath;
  for (let suffix = 2; suffix <= 9999; suffix += 1) {
    const candidate = path.join(outputDir, `${prefix}-${index}-${suffix}.${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free output filename for ${prefix}-${index}.${ext}`);
}

export async function saveImageResponse(body, options = {}) {
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) {
    if (isImageTaskBody(body)) {
      return waitForImageTask(body, options);
    }
    throw new Error("CCGO image response did not contain data[]");
  }

  const outputRoot = path.resolve(options.outputRoot || options.outputDir || DEFAULT_OUTPUT_DIR);
  const outputDir = resolveInsideRoot(outputRoot, options.outputDir || "");
  await mkdir(outputDir, { recursive: true });
  const prefix = sanitizeFilenamePart(options.filenamePrefix);
  const saved = [];

  for (const [index, item] of data.entries()) {
    const revisedPrompt = item.revised_prompt || item.revisedPrompt || "";
    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, "base64");
      const imageType = detectImageType(buffer);
      const filePath = await nextImagePath(outputDir, prefix, index + 1, imageType.ext);
      await writeFile(filePath, buffer);
      saved.push({
        index,
        path: filePath,
        mime_type: imageType.mime,
        revised_prompt: revisedPrompt,
      });
      continue;
    }
    if (item.url) {
      if (options.downloadURLs) {
        try {
          const buffer = await downloadImageURL(item.url, options);
          const imageType = detectImageType(buffer);
          const filePath = await nextImagePath(outputDir, prefix, index + 1, imageType.ext);
          await writeFile(filePath, buffer);
          saved.push({
            index,
            path: filePath,
            source_url: item.url,
            mime_type: imageType.mime,
            revised_prompt: revisedPrompt,
          });
          continue;
        } catch {
          // Return the URL below when downloading fails or is blocked by URL safety checks.
        }
      }
      saved.push({ index, url: item.url, revised_prompt: revisedPrompt });
    }
  }

  if (saved.length === 0) {
    throw new Error("CCGO image response did not contain b64_json or url images");
  }

  return {
    output_dir: outputDir,
    images: saved,
    usage: body.usage || null,
  };
}

export function getServerInfo(env = process.env) {
  const config = resolveConfig(env);
  return {
    name: "ccgo-imager",
    base_url: config.baseURL,
    output_root: config.outputRoot,
    input_root: config.inputRoot || null,
    default_model: DEFAULT_MODEL,
    default_size: DEFAULT_SIZE,
    max_n: MAX_N,
    batch_concurrency: {
      default: DEFAULT_BATCH_CONCURRENCY,
      max: MAX_BATCH_CONCURRENCY,
    },
    async_task_timeout_sec: Math.round(config.taskTimeoutMs / 1000),
    max_input_image_mb: Math.floor(MAX_IMAGE_BYTES / 1024 / 1024),
    tools: [
      "ccgo_image_generate",
      "ccgo_image_edit",
      "ccgo_image_batch_edit",
      "ccgo_image_multi_reference",
      "server_info",
    ],
    auth: {
      api_key_env: config.apiKey ? "configured" : "missing",
      tool_parameter_api_key: "not_supported",
    },
  };
}
