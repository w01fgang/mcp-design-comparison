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
export type { CompareResult, ResizeFit, IgnoreRegion, TryResult } from "./compare.js";

const VERSION = "0.6.0";

const RESIZE_FITS: ResizeFit[] = ["fill", "contain", "cover"];

// Coerce resize_fit to a valid mode, defaulting to "contain" (mirrors the
// lenient coercion used for threshold).
function normalizeResizeFit(value: unknown): ResizeFit {
  return typeof value === "string" && (RESIZE_FITS as string[]).includes(value)
    ? (value as ResizeFit)
    : "contain";
}

// Standard MCP error response (no-throw: returned, not thrown).
function errorResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
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
            max_difference_percentage: {
              type: "number",
              description:
                "If set and the difference percentage exceeds it, the call returns an error (isError: true). Use as a CI gate against a golden image. Omit for report-only.",
            },
          },
          required: ["design_path", "implementation_path"],
        },
      },
    ],
    // version surfaced in the ListTools result for direct inspection/tests; the
    // MCP handshake version comes from serverInfo (Server config above), not this field.
    version: VERSION,
  };
}

interface CallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

export async function handleCallToolRequest(
  request: CallToolRequest
): Promise<{ content: any[]; isError?: boolean }> {
  if (request.params.name === "compare_design") {
    const args = (request.params.arguments ?? {}) as {
      design_path?: string;
      implementation_path?: string;
      output_diff_path?: string;
      threshold?: unknown;
      auto_resize?: boolean;
      resize_fit?: string;
      ignore_regions?: unknown;
      max_difference_percentage?: unknown;
    };
    const {
      design_path,
      implementation_path,
      output_diff_path,
      threshold,
      auto_resize = true,
      resize_fit,
      ignore_regions,
      max_difference_percentage,
    } = args;
    if (typeof design_path !== "string" || typeof implementation_path !== "string") {
      return errorResponse("design_path and implementation_path are required");
    }

    // Validate the gate before any decode: a malformed gate must fail loud, not
    // silently degrade into a report-only run (mirrors the ignore_regions rule).
    if (
      max_difference_percentage !== undefined &&
      (typeof max_difference_percentage !== "number" ||
        !Number.isFinite(max_difference_percentage) ||
        max_difference_percentage < 0)
    ) {
      return errorResponse(
        "max_difference_percentage must be a non-negative, finite number"
      );
    }

    const resizeFit = normalizeResizeFit(resize_fit);
    // Distinguish "not provided" (default to no mask) from "provided but
    // malformed". Coercing a non-array value to [] would silently drop a
    // caller's mask request and run a noisy comparison; region errors must
    // fail loud, so reject non-array input here before buildMask sees it.
    if (ignore_regions !== undefined && !Array.isArray(ignore_regions)) {
      return errorResponse(
        "ignore_regions must be an array of {x, y, width, height} regions"
      );
    }
    const ignoreRegions = (ignore_regions ?? []) as IgnoreRegion[];

    const result = await compareScreenshots(
      design_path,
      implementation_path,
      output_diff_path,
      threshold,
      auto_resize,
      resizeFit,
      ignoreRegions
    );

    if (!result.success) {
      return errorResponse(`Error comparing screenshots: ${result.error.message}`);
    }

    const value = result.value;
    let responseText = `Design Comparison Results:\n\n`;
    responseText += `Total Pixels: ${value.totalPixels.toLocaleString()}\n`;
    responseText += `Different Pixels: ${value.differentPixels.toLocaleString()}\n`;
    responseText += `Difference: ${value.differencePercentage.toFixed(2)}%\n`;
    responseText += `SSIM: ${value.ssim.toFixed(4)} (1.0000 = identical)\n`;

    if (value.totalPixels === 0) {
      // Whole image masked → nothing actually compared; SSIM over two
      // all-transparent buffers is 1.0 and would otherwise read as "identical".
      responseText += `Note: no pixels compared (entire image masked); the SSIM score is not meaningful.\n`;
    }
    if (value.maskedPixels) {
      responseText += `Masked Pixels: ${value.maskedPixels.toLocaleString()} (excluded from comparison)\n`;
    }

    if (value.resized) {
      responseText += `\nNote: implementation auto-resized from ${value.resized.fromWidth}x${value.resized.fromHeight} to ${value.resized.toWidth}x${value.resized.toHeight} (${value.resized.fit}) to match the design.\n`;
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
    if (value.diffImageBase64) {
      content.push({
        type: "image",
        data: value.diffImageBase64,
        mimeType: "image/png",
      });
    }

    // Assertion gate: strictly greater-than trips; equality passes. Applied
    // after the diff artifact exists (file already written / base64 already in
    // content) so a failing CI log keeps the same diagnostics as a passing run.
    if (
      typeof max_difference_percentage === "number" &&
      value.differencePercentage > max_difference_percentage
    ) {
      content[0] = {
        type: "text",
        text: `Difference ${value.differencePercentage.toFixed(2)}% exceeds max_difference_percentage ${max_difference_percentage}%\n\n${responseText}`,
      };
      return { content, isError: true };
    }

    return { content };
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
