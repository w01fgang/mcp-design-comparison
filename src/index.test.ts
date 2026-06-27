import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import { PNG } from "pngjs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a simple PNG image for testing
async function createTestPNG(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; a: number },
  filePath: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = color.a;
    }
  }

  await fs.writeFile(filePath, PNG.sync.write(png));
}

async function createTestJPEG(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
  filePath: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(filePath, buffer);
}

describe("PNG loading and validation", () => {
  test("should reject non-existent files", async () => {
    const { loadPNG } = await import("./index.js");
    await assert.rejects(
      async () => await loadPNG("/non/existent/file.png"),
      /File not found/
    );
  });

  test("should reject unsupported image files", async () => {
    const { loadPNG } = await import("./index.js");
    const notAnImage = path.join(__dirname, "../test-fixtures/not-an-image.txt");
    await fs.mkdir(path.dirname(notAnImage), { recursive: true });
    await fs.writeFile(notAnImage, "This is not an image file");

    await assert.rejects(
      async () => await loadPNG(notAnImage),
      /Unsupported image format/
    );

    await fs.unlink(notAnImage);
  });

  test("should load valid PNG files", async () => {
    const { loadPNG } = await import("./index.js");
    const testPng = path.join(__dirname, "../test-fixtures/test.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, testPng);

    const png = await loadPNG(testPng);
    assert.strictEqual(png.width, 10);
    assert.strictEqual(png.height, 10);

    await fs.unlink(testPng);
  });

  test("should load valid JPEG files", async () => {
    const { loadPNG } = await import("./index.js");
    const testJpeg = path.join(__dirname, "../test-fixtures/test.jpg");
    await createTestJPEG(12, 8, { r: 10, g: 20, b: 30 }, testJpeg);

    const image = await loadPNG(testJpeg);
    assert.strictEqual(image.width, 12);
    assert.strictEqual(image.height, 8);

    await fs.unlink(testJpeg);
  });
});

describe("Screenshot comparison", () => {
  test("should detect identical images", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/identical1.png");
    const img2 = path.join(__dirname, "../test-fixtures/identical2.png");

    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, img1);
    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, img2);

    const result = await compareScreenshots(img1, img2);

    assert.strictEqual(result.differentPixels, 0);
    assert.strictEqual(result.differencePercentage, 0);
    assert.strictEqual(result.totalPixels, 100);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should detect different images", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/different1.png");
    const img2 = path.join(__dirname, "../test-fixtures/different2.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, img2);

    const result = await compareScreenshots(img1, img2);

    assert.ok(result.differentPixels > 0);
    assert.ok(result.differencePercentage > 0);
    assert.strictEqual(result.totalPixels, 100);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should reject mismatched dimensions when auto_resize is disabled", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/size1.png");
    const img2 = path.join(__dirname, "../test-fixtures/size2.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(20, 20, { r: 0, g: 0, b: 255, a: 255 }, img2);

    await assert.rejects(
      async () =>
        await compareScreenshots(img1, img2, undefined, 0.1, false),
      /Image dimensions don't match/
    );

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should auto-resize the implementation to the design dimensions by default", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/resize-design.png");
    const impl = path.join(__dirname, "../test-fixtures/resize-impl.png");

    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, design);
    await createTestPNG(20, 20, { r: 100, g: 150, b: 200, a: 255 }, impl);

    const result = await compareScreenshots(design, impl);

    // Comparison runs against the design's dimensions, not the implementation's.
    assert.strictEqual(result.totalPixels, 100);
    assert.ok(result.resized);
    assert.deepStrictEqual(result.resized, {
      fromWidth: 20,
      fromHeight: 20,
      toWidth: 10,
      toHeight: 10,
    });
    // A solid-color resize stays a solid color → identical to the design.
    assert.strictEqual(result.differentPixels, 0);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("should save diff image to file when output path provided", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/save1.png");
    const img2 = path.join(__dirname, "../test-fixtures/save2.png");
    const diff = path.join(__dirname, "../test-fixtures/diff.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, img2);

    const result = await compareScreenshots(img1, img2, diff);

    assert.strictEqual(result.diffImageBase64, undefined);
    await fs.access(diff); // Should not throw

    await fs.unlink(img1);
    await fs.unlink(img2);
    await fs.unlink(diff);
  });

  test("should return base64 diff image when no output path provided", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/base64-1.png");
    const img2 = path.join(__dirname, "../test-fixtures/base64-2.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, img2);

    const result = await compareScreenshots(img1, img2);

    assert.ok(result.diffImageBase64);
    assert.ok(result.diffImageBase64.length > 0);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });
});

describe("MCP request handling", () => {
  test("should list compare_design tool", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    assert.ok(Array.isArray(result.tools));
    const toolNames = result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("compare_design"));
    // version reported via ListTools (in addition to server metadata)
    assert.strictEqual(result.version, "0.4.0");
  });

  test("should return image content when no output path provided", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/handler-1.png");
    const img2 = path.join(__dirname, "../test-fixtures/handler-2.png");

    await createTestPNG(8, 8, { r: 120, g: 120, b: 120, a: 255 }, img1);
    await createTestPNG(8, 8, { r: 120, g: 120, b: 120, a: 255 }, img2);

    const response = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: img1,
          implementation_path: img2,
        },
      },
    });

    assert.ok(Array.isArray(response.content));
    const hasImage = response.content.some((item) => item.type === "image");
    assert.ok(hasImage);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should return error content on compare failure", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const response = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: "/non/existent/design.png",
          implementation_path: "/non/existent/implementation.png",
        },
      },
    });

    assert.strictEqual(response.isError, true);
    assert.ok(response.content[0].text.startsWith("Error comparing screenshots"));
  });

  test("should accept numeric threshold and succeed", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/thresh-num-1.png");
    const img2 = path.join(__dirname, "../test-fixtures/thresh-num-2.png");

    await createTestPNG(6, 6, { r: 50, g: 50, b: 50, a: 255 }, img1);
    await createTestPNG(6, 6, { r: 200, g: 50, b: 50, a: 255 }, img2);

    const response = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: img1,
          implementation_path: img2,
          threshold: 0,
        },
      },
    });

    assert.strictEqual(response.isError, undefined);
    assert.ok(Array.isArray(response.content));
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem);
    assert.ok(textItem.text.includes("Difference:"));
    // 0 threshold is sensitive; should report some >0 difference
    assert.ok(/Difference: [1-9]/.test(textItem.text) || textItem.text.includes("100.00%") || textItem.text.includes("Difference: 100"));

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should report auto-resize in the response text", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/handler-resize-design.png");
    const impl = path.join(__dirname, "../test-fixtures/handler-resize-impl.png");

    await createTestPNG(8, 8, { r: 120, g: 120, b: 120, a: 255 }, design);
    await createTestPNG(16, 16, { r: 120, g: 120, b: 120, a: 255 }, impl);

    const response = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
        },
      },
    });

    assert.strictEqual(response.isError, undefined);
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem);
    assert.ok(textItem.text.includes("auto-resized from 16x16 to 8x8"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("should coerce invalid threshold (string) and still succeed using default", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/thresh-bad-1.png");
    const img2 = path.join(__dirname, "../test-fixtures/thresh-bad-2.png");

    await createTestPNG(6, 6, { r: 120, g: 120, b: 120, a: 255 }, img1);
    await createTestPNG(6, 6, { r: 120, g: 121, b: 120, a: 255 }, img2);

    const response = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: img1,
          implementation_path: img2,
          threshold: "not-a-number",
        },
      },
    });

    assert.strictEqual(response.isError, undefined);
    assert.ok(Array.isArray(response.content));
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem);
    assert.ok(textItem.text.includes("Difference:"));
    // invalid falls back to default 0.1; with tiny delta may be 0% or small, but must be finite valid %
    assert.ok(/Difference: \d+\.\d+%/.test(textItem.text));

    await fs.unlink(img1);
    await fs.unlink(img2);
  });
});
