#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "url";
import {
  compareScreenshots,
  type IgnoreRegion,
  type ResizeFit,
} from "./compare.js";

// Re-export image logic so existing consumers/tests can import from "./index.js".
export {
  loadPNG,
  compareScreenshots,
  computeSSIM,
  buildMask,
  normalizeThreshold,
} from "./compare.js";
export type { CompareResult, ResizeFit, IgnoreRegion } from "./compare.js";

const VERSION = "0.5.0";

const RESIZE_FITS: ResizeFit[] = ["fill", "contain", "cover"];

// Extract a human-readable message from an unknown thrown value.
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Coerce resize_fit to a valid mode, defaulting to "contain" (mirrors the
// lenient coercion used for threshold).
function normalizeResizeFit(value: unknown): ResizeFit {
  return typeof value === "string" && (RESIZE_FITS as string[]).includes(value)
    ? (value as ResizeFit)
    : "contain";
}

// Create server instance
const server = new Server(
  {
    name: "mcp-design-comparison",
    version: VERSION,
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
          "Compare a design screenshot with an implementation screenshot using pixelmatch and SSIM. Supports PNG, JPEG, WebP, GIF, and TIFF formats. Returns the number and percentage of different pixels, a structural-similarity (SSIM) score, and optionally outputs a diff image highlighting the differences.",
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
                "If true (default), the implementation screenshot is scaled to the design's dimensions when they differ, instead of failing. Set false to require identical dimensions.",
              default: true,
            },
            resize_fit: {
              type: "string",
              enum: ["fill", "contain", "cover"],
              description:
                "How to scale the implementation when dimensions differ. 'contain' (default) preserves aspect ratio and letterboxes; 'fill' stretches to the exact dimensions; 'cover' preserves aspect ratio and crops the overflow.",
              default: "contain",
            },
            ignore_regions: {
              type: "array",
              description:
                "Rectangles (design-space coordinates) to exclude from the comparison, e.g. dynamic content like timestamps or avatars. Excluded pixels count toward neither the diff nor the percentage denominator.",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["x", "y", "width", "height"],
              },
            },
          },
          required: ["design_path", "implementation_path"],
        },
      },
    ],
    // version is reported via ListTools response (and server metadata) for direct inspection / MCP handshake
    version: VERSION,
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
      resize_fit?: string;
      ignore_regions?: IgnoreRegion[];
    };
    const {
      design_path,
      implementation_path,
      output_diff_path,
      threshold = 0.1,
      auto_resize = true,
      resize_fit,
      ignore_regions,
    } = args;
    if (typeof design_path !== "string" || typeof implementation_path !== "string") {
      throw new Error("design_path and implementation_path are required");
    }

    const resizeFit = normalizeResizeFit(resize_fit);
    const ignoreRegions = Array.isArray(ignore_regions) ? ignore_regions : [];

    try {
      const result = await compareScreenshots(
        design_path,
        implementation_path,
        output_diff_path,
        threshold,
        auto_resize,
        resizeFit,
        ignoreRegions
      );

      let responseText = `Design Comparison Results:\n\n`;
      responseText += `Total Pixels: ${result.totalPixels.toLocaleString()}\n`;
      responseText += `Different Pixels: ${result.differentPixels.toLocaleString()}\n`;
      responseText += `Difference: ${result.differencePercentage.toFixed(2)}%\n`;
      responseText += `SSIM: ${result.ssim.toFixed(4)} (1.0000 = identical)\n`;

      if (result.maskedPixels) {
        responseText += `Masked Pixels: ${result.maskedPixels.toLocaleString()} (excluded from comparison)\n`;
      }

      if (result.resized) {
        responseText += `\nNote: implementation auto-resized from ${result.resized.fromWidth}x${result.resized.fromHeight} to ${result.resized.toWidth}x${result.resized.toHeight} (${result.resized.fit}) to match the design.\n`;
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
            text: `Error comparing screenshots: ${formatError(error)}`,
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

/* node:coverage disable */
// Server bootstrap: exercised only when run as an executable, not under test.
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
/* node:coverage enable */
