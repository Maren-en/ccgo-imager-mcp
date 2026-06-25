#!/usr/bin/env node
import {
  getServerInfo,
  normalizeBaseURL,
  normalizeBatchConcurrency,
  normalizeImageCount,
  sanitizeFilenamePart,
} from "../src/ccgo-images.js";

const checks = [
  normalizeBaseURL("https://www.ccgoai.com") === "https://www.ccgoai.com/v1",
  normalizeBaseURL("https://www.ccgoai.com/v1/") === "https://www.ccgoai.com/v1",
  normalizeImageCount(undefined) === 1,
  normalizeImageCount(6) === 6,
  normalizeBatchConcurrency(undefined) === 4,
  normalizeBatchConcurrency(6) === 6,
  sanitizeFilenamePart("图标 asset 01") === "图标-asset-01",
  getServerInfo({ CCGO_API_KEY: "test" }).max_n === 6,
];

if (checks.some((ok) => !ok)) {
  throw new Error("ccgo-imager-mcp smoke checks failed");
}

console.log("ccgo-imager-mcp smoke checks passed");
