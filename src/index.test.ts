import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import { PNG } from "pngjs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a simple PNG image for testing
async function createTestPNG(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; a: number },
  filePath: string
): Promise<void> {
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

  test("should reject images with different dimensions", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/size1.png");
    const img2 = path.join(__dirname, "../test-fixtures/size2.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(20, 20, { r: 0, g: 0, b: 255, a: 255 }, img2);

    await assert.rejects(
      async () => await compareScreenshots(img1, img2),
      /Image dimensions don't match/
    );

    await fs.unlink(img1);
    await fs.unlink(img2);
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
