#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  batchEditImages,
  editImage,
  generateImage,
  getServerInfo,
  multiReferenceImage,
  resolveConfig,
} from "./ccgo-images.js";

const server = new McpServer({
  name: "ccgo-imager",
  version: "0.2.8",
});

function resultContent(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

const commonImageArgs = {
  model: z.string().default("gpt-image-2").describe("Public model name. Usually keep gpt-image-2."),
  size: z.string().default("1024x1024").describe("Image size, for example 1024x1024 or 2048x2048."),
  n: z.number().int().min(1).max(6).default(1).describe("Number of images to create. Limited to 1-6."),
  output_dir: z.string().optional().describe("Subdirectory under CCGO_IMAGER_OUTPUT_DIR where images should be saved."),
  filename_prefix: z.string().optional().describe("Filename prefix for saved image files."),
  quality: z.string().optional().describe("Optional OpenAI-compatible quality parameter."),
  background: z.string().optional().describe("Optional background parameter, such as transparent or auto."),
  output_format: z.string().optional().describe("Optional output format, such as png, webp, or jpeg."),
  moderation: z.string().optional().describe("Optional moderation parameter when supported by the upstream."),
  download_urls: z.boolean().default(true).describe("Download URL results to local files when possible."),
};

server.registerTool(
  "server_info",
  {
    title: "CCGO Imager Server Info",
    description:
      "Return sanitized CCGO Imager MCP configuration and limits. Does not reveal the API key.",
    inputSchema: {},
  },
  async () => resultContent(getServerInfo()),
);

server.registerTool(
  "ccgo_image_generate",
  {
    title: "CCGO Image Generate",
    description:
      "Generate raster image assets through the user's CCGO Imager route. Use this instead of native image_generation when a workflow needs generated icons, transparent assets, or slide visual assets.",
    inputSchema: {
      prompt: z.string().min(1).describe("Image generation prompt."),
      ...commonImageArgs,
      style: z.string().optional().describe("Optional style parameter when supported."),
    },
  },
  async (input) => resultContent(await generateImage(input, { config: resolveConfig() })),
);

server.registerTool(
  "ccgo_image_edit",
  {
    title: "CCGO Image Edit",
    description:
      "Edit one or more local image files through the user's CCGO Imager route. Use for reference-image based asset cleanup, background changes, or image edits.",
    inputSchema: {
      prompt: z.string().min(1).describe("Image edit instruction."),
      image_path: z.string().optional().describe("Single local image path to edit."),
      image_paths: z.array(z.string()).optional().describe("Multiple local image paths to edit in one request."),
      mask_path: z.string().optional().describe("Optional local mask image path."),
      input_fidelity: z.string().optional().describe("Optional input fidelity parameter when supported."),
      ...commonImageArgs,
    },
  },
  async (input) => resultContent(await editImage(input, { config: resolveConfig() })),
);

server.registerTool(
  "ccgo_image_batch_edit",
  {
    title: "CCGO Image Batch Edit",
    description:
      "Edit many local image files with the same prompt. Runs separate CCGO edit requests with controlled concurrency; default 4, max 6.",
    inputSchema: {
      prompt: z.string().min(1).describe("Image edit instruction applied to every image."),
      image_paths: z.array(z.string()).min(1).describe("Local image paths to edit one by one."),
      concurrency: z.number().int().min(1).max(6).default(4).describe("Batch concurrency. Default 4, max 6."),
      input_fidelity: z.string().optional().describe("Optional input fidelity parameter when supported."),
      ...commonImageArgs,
    },
  },
  async (input) => resultContent(await batchEditImages(input, { config: resolveConfig() })),
);

server.registerTool(
  "ccgo_image_multi_reference",
  {
    title: "CCGO Image Multi Reference",
    description:
      "Generate or edit one image from multiple local reference images. Use when a Skill needs to combine several references into one final asset.",
    inputSchema: {
      prompt: z.string().min(1).describe("Image instruction using all references."),
      image_paths: z.array(z.string()).min(2).max(10).describe("Two to ten local reference image paths."),
      mask_path: z.string().optional().describe("Optional local mask image path."),
      input_fidelity: z.string().optional().describe("Optional input fidelity parameter when supported."),
      ...commonImageArgs,
    },
  },
  async (input) => resultContent(await multiReferenceImage(input, { config: resolveConfig() })),
);

await server.connect(new StdioServerTransport());
