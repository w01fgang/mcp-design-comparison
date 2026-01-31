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

interface CompareResult {
  totalPixels: number;
  differentPixels: number;
  differencePercentage: number;
  diffImageBase64?: string;
}

async function loadPNG(filePath: string): Promise<PNG> {
  const data = await fs.readFile(filePath);
  return PNG.sync.read(data);
}

async function compareScreenshots(
  designPath: string,
  implementationPath: string,
  outputDiffPath?: string,
  threshold = 0.1
): Promise<CompareResult> {
  // Load both images
  const design = await loadPNG(designPath);
  const implementation = await loadPNG(implementationPath);

  // Check if dimensions match
  if (
    design.width !== implementation.width ||
    design.height !== implementation.height
  ) {
    throw new Error(
      `Image dimensions don't match: design (${design.width}x${design.height}) vs implementation (${implementation.width}x${implementation.height})`
    );
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
    { threshold }
  );

  const totalPixels = design.width * design.height;
  const differencePercentage = (differentPixels / totalPixels) * 100;

  const result: CompareResult = {
    totalPixels,
    differentPixels,
    differencePercentage,
  };

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
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "compare_design",
        description:
          "Compare a design screenshot with an implementation screenshot using pixelmatch. Returns the number and percentage of different pixels, and optionally outputs a diff image highlighting the differences.",
        inputSchema: {
          type: "object",
          properties: {
            design_path: {
              type: "string",
              description: "Path to the design screenshot (PNG format)",
            },
            implementation_path: {
              type: "string",
              description: "Path to the implementation screenshot (PNG format)",
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
          },
          required: ["design_path", "implementation_path"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "compare_design") {
    const {
      design_path,
      implementation_path,
      output_diff_path,
      threshold = 0.1,
    } = request.params.arguments as {
      design_path: string;
      implementation_path: string;
      output_diff_path?: string;
      threshold?: number;
    };

    try {
      const result = await compareScreenshots(
        design_path,
        implementation_path,
        output_diff_path,
        threshold
      );

      let responseText = `Design Comparison Results:\n\n`;
      responseText += `Total Pixels: ${result.totalPixels.toLocaleString()}\n`;
      responseText += `Different Pixels: ${result.differentPixels.toLocaleString()}\n`;
      responseText += `Difference: ${result.differencePercentage.toFixed(2)}%\n`;

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
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Design Comparison Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
