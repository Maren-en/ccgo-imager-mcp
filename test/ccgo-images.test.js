import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeDownloadURL,
  batchEditImages,
  detectImageExtension,
  editImage,
  generateImage,
  getServerInfo,
  isBlockedIPAddress,
  normalizeBaseURL,
  normalizeBatchConcurrency,
  normalizeImageCount,
  resolveConfig,
  resolveInsideRoot,
  sanitizeFilenamePart,
  saveImageResponse,
} from "../src/ccgo-images.js";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tinyPng = Buffer.from(tinyPngBase64, "base64");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
  };
}

function binaryResponse(buffer, contentType = "image/png", status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType, "content-length": String(buffer.length) }),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => buffer.toString("utf8"),
  };
}

test("normalizes base URL", () => {
  assert.equal(normalizeBaseURL("https://www.ccgoai.com"), "https://www.ccgoai.com/v1");
  assert.equal(normalizeBaseURL("https://www.ccgoai.com/v1/"), "https://www.ccgoai.com/v1");
});

test("does not fall back to OPENAI environment variables", () => {
  const config = resolveConfig({
    [`OPENAI_${"API_KEY"}`]: "openai-key-should-not-be-used",
    [`OPENAI_${"BASE_URL"}`]: "https://api.openai.example/v1",
  });
  assert.equal(config.apiKey, "");
  assert.equal(config.baseURL, "https://www.ccgoai.com/v1");
});

test("validates image count", () => {
  assert.equal(normalizeImageCount(undefined), 1);
  assert.equal(normalizeImageCount(6), 6);
  assert.throws(() => normalizeImageCount(7), /between 1 and 6/);
});

test("validates batch concurrency", () => {
  assert.equal(normalizeBatchConcurrency(undefined), 4);
  assert.equal(normalizeBatchConcurrency(6), 6);
  assert.throws(() => normalizeBatchConcurrency(7), /between 1 and 6/);
});

test("sanitizes filename prefix", () => {
  assert.equal(sanitizeFilenamePart("图标 asset 01"), "图标-asset-01");
  assert.equal(sanitizeFilenamePart(""), "ccgo-image");
});

test("detects png", () => {
  assert.equal(detectImageExtension(tinyPng), "png");
});

test("resolves output path inside root only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-root-"));
  try {
    assert.equal(resolveInsideRoot(dir, "child"), path.join(dir, "child"));
    assert.throws(() => resolveInsideRoot(dir, "../escape"), /outside the allowed root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saves b64 image response to output dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-test-"));
  try {
    const result = await saveImageResponse(
      { data: [{ b64_json: tinyPngBase64, revised_prompt: "tiny" }] },
      { outputRoot: dir, outputDir: "assets", filenamePrefix: "asset" },
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.output_dir, path.join(dir, "assets"));
    assert.equal(result.images[0].mime_type, "image/png");
    const bytes = await readFile(result.images[0].path);
    assert.equal(bytes[0], 0x89);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polls async image task and saves binary result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-task-"));
  try {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).endsWith("/images/generations")) {
        return jsonResponse({ id: "task_123", status: "running", poll_after_ms: 1 }, 202);
      }
      if (String(url).endsWith("/v1/images/tasks/task_123")) {
        return jsonResponse({
          id: "task_123",
          status: "succeeded",
          result_available: true,
          result_url: "/v1/images/tasks/task_123/result",
        });
      }
      if (String(url).endsWith("/v1/images/tasks/task_123/result")) {
        return binaryResponse(tinyPng);
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const result = await generateImage(
      { prompt: "async image", size: "3840x2160", filename_prefix: "async" },
      {
        config: {
          baseURL: "https://www.ccgoai.com/v1",
          apiKey: "sk-test",
          outputRoot: dir,
          inputRoot: "",
          retryAttempts: 1,
          timeoutMs: 5000,
          taskTimeoutMs: 5000,
        },
        fetch: fetchImpl,
        sleep: async () => {},
      },
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].task_id, "task_123");
    assert.equal(result.images[0].mime_type, "image/png");
    assert.equal(calls.map((call) => call.method).join(","), "POST,GET,GET");
    const bytes = await readFile(result.images[0].path);
    assert.equal(bytes[0], 0x89);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks private URL downloads", async () => {
  assert.equal(isBlockedIPAddress("127.0.0.1"), true);
  await assert.rejects(() => assertSafeDownloadURL("http://127.0.0.1/image.png"), /blocked address/);
});

test("does not follow image URL redirects to private addresses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-redirect-block-"));
  try {
    const calls = [];
    const result = await saveImageResponse(
      { data: [{ url: "http://93.184.216.34/image.png" }] },
      {
        outputRoot: dir,
        filenamePrefix: "redirect",
        downloadURLs: true,
        retryAttempts: 1,
        timeoutMs: 5000,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url: String(url), redirect: init.redirect });
          return {
            ok: false,
            status: 302,
            headers: new Headers({ location: "http://127.0.0.1/private.png" }),
            text: async () => "",
          };
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(result.images[0].url, "http://93.184.216.34/image.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("follows safe image URL redirects manually", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-redirect-safe-"));
  try {
    const calls = [];
    const result = await saveImageResponse(
      { data: [{ url: "http://93.184.216.34/image.png" }] },
      {
        outputRoot: dir,
        filenamePrefix: "redirect",
        downloadURLs: true,
        retryAttempts: 1,
        timeoutMs: 5000,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url: String(url), redirect: init.redirect });
          if (calls.length === 1) {
            return {
              ok: false,
              status: 302,
              headers: new Headers({ location: "/next.png" }),
              text: async () => "",
            };
          }
          return binaryResponse(tinyPng);
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[1].url, "http://93.184.216.34/next.png");
    assert.equal(result.images[0].mime_type, "image/png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server info is sanitized", () => {
  const info = getServerInfo({
    CCGO_API_KEY: "test-api-key-redacted",
    CCGO_BASE_URL: "https://www.ccgoai.com/v1",
    CCGO_IMAGER_OUTPUT_DIR: "/tmp/ccgo-images",
  });
  assert.equal(info.max_n, 6);
  assert.equal(info.batch_concurrency.default, 4);
  assert.equal(info.async_task_timeout_sec, 900);
  assert.equal(info.auth.api_key_env, "configured");
  assert.equal(JSON.stringify(info).includes("test-api-key-redacted"), false);
});

test("does not overwrite existing output files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-no-overwrite-"));
  try {
    const first = await saveImageResponse(
      { data: [{ b64_json: tinyPngBase64 }] },
      { outputRoot: dir, filenamePrefix: "asset" },
    );
    const second = await saveImageResponse(
      { data: [{ b64_json: tinyPngBase64 }] },
      { outputRoot: dir, filenamePrefix: "asset" },
    );
    assert.notEqual(first.images[0].path, second.images[0].path);
    assert.match(first.images[0].path, /asset-1\.png$/);
    assert.match(second.images[0].path, /asset-1-2\.png$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit image enforces input root and magic bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-input-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-outside-"));
  try {
    const imagePath = path.join(root, "ok.png");
    const badPath = path.join(root, "bad.png");
    const outsidePath = path.join(outside, "outside.png");
    await writeFile(imagePath, tinyPng);
    await writeFile(badPath, "not an image");
    await writeFile(outsidePath, tinyPng);

    const config = {
      baseURL: "https://www.ccgoai.com/v1",
      apiKey: "sk-test",
      outputRoot: root,
      inputRoot: root,
      retryAttempts: 1,
      timeoutMs: 5000,
    };

    await assert.rejects(
      () => editImage({ prompt: "test", image_path: outsidePath }, { config, fetch: async () => jsonResponse({ data: [{ b64_json: tinyPngBase64 }] }) }),
      /outside the allowed root/,
    );
    await assert.rejects(
      () => editImage({ prompt: "test", image_path: badPath }, { config, fetch: async () => jsonResponse({ data: [{ b64_json: tinyPngBase64 }] }) }),
      /Unsupported or invalid image file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("batch edit uses default concurrency 4 and allows max 6", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccgo-imager-batch-"));
  try {
    const imagePaths = [];
    for (let i = 0; i < 6; i += 1) {
      const filePath = path.join(dir, `input-${i}.png`);
      await writeFile(filePath, tinyPng);
      imagePaths.push(filePath);
    }

    let active = 0;
    let maxActive = 0;
    const fetchImpl = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
    };
    const config = {
      baseURL: "https://www.ccgoai.com/v1",
      apiKey: "sk-test",
      outputRoot: dir,
      inputRoot: dir,
      retryAttempts: 1,
      timeoutMs: 5000,
    };

    const result = await batchEditImages(
      { prompt: "batch", image_paths: imagePaths },
      { config, fetch: fetchImpl },
    );
    assert.equal(result.concurrency, 4);
    assert.equal(result.succeeded, 6);
    assert.equal(maxActive, 4);

    const resultMax = await batchEditImages(
      { prompt: "batch", image_paths: imagePaths, concurrency: 6 },
      { config, fetch: fetchImpl },
    );
    assert.equal(resultMax.concurrency, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
