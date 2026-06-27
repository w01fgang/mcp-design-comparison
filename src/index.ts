#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { pathToFileURL } from "url";

// Pure normalization for threshold: accepts number | string | other, coerces, clamps to [0,1], defaults to 0.1
function normalizeThreshold(t: unknown): number {
  let n: number;
  if (typeof t === "number") {
    n = t;
  } else if (typeof t === "string") {
    n = parseFloat(t);
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n)) {
    return 0.1;
  }
  return Math.max(0, Math.min(1, n));
}

interface CompareResult {
  totalPixels: number;
  differentPixels: number;
  differencePercentage: number;
  diffImageBase64?: string;
  resized?: {
    fromWidth: number;
    fromHeight: number;
    toWidth: number;
    toHeight: number;
  };
}

export async function loadPNG(
  filePath: string,
  resizeTo?: { width: number; height: number }
): Promise<PNG> {
  try {
    // Check if file exists
    await fs.access(filePath);

    // Probe metadata first (post-access) to detect unsupported formats robustly.
    // Avoids fragile reliance on sharp raw/decode error message strings.
    try {
      await sharp(filePath).metadata();
    } catch {
      throw new Error(`Unsupported image format: ${filePath}`);
    }

    // Use sharp to convert any image format to PNG buffer
    // This handles PNG, JPEG, WebP, GIF, TIFF, etc.
    let pipeline = sharp(filePath).ensureAlpha(); // Ensure RGBA format
    if (resizeTo) {
      // fit: "fill" stretches to the exact target dimensions (ignoring aspect
      // ratio) so the raw buffer lines up with the reference for pixelmatch.
      pipeline = pipeline.resize(resizeTo.width, resizeTo.height, { fit: "fill" });
    }
    const { data, info } = await pipeline
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Create PNG object from raw pixel data
    const png = new PNG({ width: info.width, height: info.height });
    png.data = data;
    
    return png;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (error instanceof Error && error.message.startsWith('Unsupported image format:')) {
      throw error;
    }
    throw error;
  }
}

export async function compareScreenshots(
  designPath: string,
  implementationPath: string,
  outputDiffPath?: string,
  threshold: unknown = 0.1,
  autoResize: boolean = true
): Promise<CompareResult> {
  const normThreshold = normalizeThreshold(threshold);
  // Load both images
  const design = await loadPNG(designPath);
  let implementation = await loadPNG(implementationPath);

  // Reconcile dimensions: pixelmatch requires identical buffers.
  let resized: CompareResult["resized"];
  if (
    design.width !== implementation.width ||
    design.height !== implementation.height
  ) {
    if (!autoResize) {
      throw new Error(
        `Image dimensions don't match: design (${design.width}x${design.height}) vs implementation (${implementation.width}x${implementation.height})`
      );
    }
    // Re-decode the implementation, stretched to the design's dimensions
    // (the design is the reference) so the comparison can proceed.
    resized = {
      fromWidth: implementation.width,
      fromHeight: implementation.height,
      toWidth: design.width,
      toHeight: design.height,
    };
    implementation = await loadPNG(implementationPath, {
      width: design.width,
      height: design.height,
    });
  }

  // Create a diff image
  const diff = new PNG({ width: design.width, height: design.height });

  // Compare images using pixelmatch
  const differentPixels = pixelmatch(
    design.data,
    implementation.data,
    diff.data,
    design.width,
    design.height,
    { threshold: normThreshold }
  );

  const totalPixels = design.width * design.height;
  const differencePercentage = (differentPixels / totalPixels) * 100;

  const result: CompareResult = {
    totalPixels,
    differentPixels,
    differencePercentage,
  };

  if (resized) {
    result.resized = resized;
  }

  // Save or encode diff image
  if (outputDiffPath) {
    await fs.writeFile(outputDiffPath, PNG.sync.write(diff));
  } else {
    // Return base64 encoded diff image
    const buffer = PNG.sync.write(diff);
    result.diffImageBase64 = buffer.toString("base64");
  }

  return result;
}

// Create server instance
const server = new Server(
  {
    name: "mcp-design-comparison",
    version: "0.4.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export async function handleListToolsRequest() {
  return {
    tools: [
      {
        name: "compare_design",
        description:
          "Compare a design screenshot with an implementation screenshot using pixelmatch. Supports PNG, JPEG, WebP, GIF, and TIFF formats. Returns the number and percentage of different pixels, and optionally outputs a diff image highlighting the differences.",
        inputSchema: {
          type: "object",
          properties: {
            design_path: {
              type: "string",
              description: "Path to the design screenshot (supports PNG, JPEG, WebP, GIF, TIFF)",
            },
            implementation_path: {
              type: "string",
              description: "Path to the implementation screenshot (supports PNG, JPEG, WebP, GIF, TIFF)",
            },
            output_diff_path: {
              type: "string",
              description:
                "Optional path to save the diff image. If not provided, the diff image will be returned as base64.",
            },
            threshold: {
              type: "number",
              description:
                "Matching threshold (0-1). Smaller values make the comparison more sensitive. Default is 0.1.",
              default: 0.1,
            },
            auto_resize: {
              type: "boolean",
              description:
                "If true (default), the implementation screenshot is stretched to the design's dimensions when they differ, instead of failing. Set false to require identical dimensions.",
              default: true,
            },
          },
          required: ["design_path", "implementation_path"],
        },
      },
    ],
    // version is reported via ListTools response (and server metadata) for direct inspection / MCP handshake
    version: "0.4.0",
  };
}

interface CallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

export async function handleCallToolRequest(request: CallToolRequest) {
  if (request.params.name === "compare_design") {
    const args = (request.params.arguments ?? {}) as {
      design_path?: string;
      implementation_path?: string;
      output_diff_path?: string;
      threshold?: number;
      auto_resize?: boolean;
    };
    const {
      design_path,
      implementation_path,
      output_diff_path,
      threshold = 0.1,
      auto_resize = true,
    } = args;
    if (typeof design_path !== "string" || typeof implementation_path !== "string") {
      throw new Error("design_path and implementation_path are required");
    }

    const normThreshold = normalizeThreshold(threshold);

    try {
      const result = await compareScreenshots(
        design_path,
        implementation_path,
        output_diff_path,
        normThreshold,
        auto_resize
      );

      let responseText = `Design Comparison Results:\n\n`;
      responseText += `Total Pixels: ${result.totalPixels.toLocaleString()}\n`;
      responseText += `Different Pixels: ${result.differentPixels.toLocaleString()}\n`;
      responseText += `Difference: ${result.differencePercentage.toFixed(2)}%\n`;

      if (result.resized) {
        responseText += `\nNote: implementation auto-resized from ${result.resized.fromWidth}x${result.resized.fromHeight} to ${result.resized.toWidth}x${result.resized.toHeight} to match the design.\n`;
      }

      if (output_diff_path) {
        responseText += `\nDiff image saved to: ${output_diff_path}`;
      }

      const content: any[] = [
        {
          type: "text",
          text: responseText,
        },
      ];

      // If we have base64 image data, include it
      if (result.diffImageBase64) {
        content.push({
          type: "image",
          data: result.diffImageBase64,
          mimeType: "image/png",
        });
      }

      return {
        content,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error comparing screenshots: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, handleListToolsRequest);

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, handleCallToolRequest);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Design Comparison Server running on stdio");
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
