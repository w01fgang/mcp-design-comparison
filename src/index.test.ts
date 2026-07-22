import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import { PNG } from "pngjs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a simple solid-color PNG image for testing
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
    create: { width, height, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(filePath, buffer);
}

// Write a PNG whose header is intact but whose pixel data is truncated:
// sharp's metadata() succeeds (reads dimensions) while a full decode fails.
async function createTruncatedPNG(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 37 + 13) & 255;
  const buf = PNG.sync.write(png);
  await fs.writeFile(filePath, buf.subarray(0, Math.floor(buf.length * 0.5)));
}

// design solid red; impl identical except a blue block at the given rect.
// Deterministic with pixelmatch: solid blocks are never AA-classified, so
// differentPixels equals the block area exactly (same precedent as the
// exact-count assertions in the ignore_regions suite).
async function createQuadrantPair(
  design: string,
  impl: string,
  size: number,
  block: { x: number; y: number; width: number; height: number }
): Promise<void> {
  await fs.mkdir(path.dirname(design), { recursive: true });
  const d = new PNG({ width: size, height: size });
  const i = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      d.data[idx] = 255; d.data[idx + 1] = 0; d.data[idx + 2] = 0; d.data[idx + 3] = 255;
      const blue =
        x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height;
      i.data[idx] = blue ? 0 : 255; i.data[idx + 1] = 0; i.data[idx + 2] = blue ? 255 : 0; i.data[idx + 3] = 255;
    }
  }
  await fs.writeFile(design, PNG.sync.write(d));
  await fs.writeFile(impl, PNG.sync.write(i));
}

// In-test SVG fixtures (no committed golden rasters — librsvg renders vary
// across platforms; all assertions below are relational).
const SVG_RED_36 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="#ff0000"/></svg>';
const SVG_VIEWBOX_ONLY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>';
const SVG_NO_SIZE =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" fill="#ff0000"/></svg>';
const SVG_CIRCLE_36 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="#ffffff"/><circle cx="18" cy="18" r="14" fill="#000000"/></svg>';

async function createTestSVG(svg: string, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, svg);
}

// Assert a TryResult succeeded and return its value (no-throw API helper).
async function expectOk(promise: Promise<any>): Promise<any> {
  const r = await promise;
  if (!r.success) assert.fail(`expected success, got error: ${r.error?.message}`);
  return r.value;
}

describe("PNG loading and validation", () => {
  test("should report not-found for non-existent files", async () => {
    const { loadPNG } = await import("./index.js");
    const r = await loadPNG("/non/existent/file.png");
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /File not found/);
  });

  test("should report unsupported for non-image files (with underlying cause)", async () => {
    const { loadPNG } = await import("./index.js");
    const notAnImage = path.join(__dirname, "../test-fixtures/not-an-image.txt");
    await fs.mkdir(path.dirname(notAnImage), { recursive: true });
    await fs.writeFile(notAnImage, "This is not an image file");

    const r = await loadPNG(notAnImage);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Unsupported image format/);
    // the real cause is preserved, not swallowed
    assert.ok(r.error.message.length > "Unsupported image format: ".length + notAnImage.length);

    await fs.unlink(notAnImage);
  });

  test("should load valid PNG files", async () => {
    const { loadPNG } = await import("./index.js");
    const testPng = path.join(__dirname, "../test-fixtures/test.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, testPng);

    const png = await expectOk(loadPNG(testPng));
    assert.strictEqual(png.width, 10);
    assert.strictEqual(png.height, 10);

    await fs.unlink(testPng);
  });

  test("should load valid JPEG files", async () => {
    const { loadPNG } = await import("./index.js");
    const testJpeg = path.join(__dirname, "../test-fixtures/test.jpg");
    await createTestJPEG(12, 8, { r: 10, g: 20, b: 30 }, testJpeg);

    const image = await expectOk(loadPNG(testJpeg));
    assert.strictEqual(image.width, 12);
    assert.strictEqual(image.height, 8);

    await fs.unlink(testJpeg);
  });

  test("should report failure on invalid resize dimensions", async () => {
    const { loadPNG } = await import("./index.js");
    const img = path.join(__dirname, "../test-fixtures/resize-err.png");
    await createTestPNG(10, 10, { r: 10, g: 10, b: 10, a: 255 }, img);

    const r = await loadPNG(img, { width: 0, height: 0, fit: "fill" });
    assert.strictEqual(r.success, false);

    await fs.unlink(img);
  });
});

describe("Screenshot comparison", () => {
  test("should detect identical images", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/identical1.png");
    const img2 = path.join(__dirname, "../test-fixtures/identical2.png");

    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, img1);
    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, img2);

    const result = await expectOk(compareScreenshots(img1, img2));
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

    const result = await expectOk(compareScreenshots(img1, img2));
    assert.ok(result.differentPixels > 0);
    assert.ok(result.differencePercentage > 0);
    assert.strictEqual(result.totalPixels, 100);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should report failure for mismatched dimensions when auto_resize is disabled", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/size1.png");
    const img2 = path.join(__dirname, "../test-fixtures/size2.png");

    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, img1);
    await createTestPNG(20, 20, { r: 0, g: 0, b: 255, a: 255 }, img2);

    const r = await compareScreenshots(img1, img2, undefined, 0.1, false);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Image dimensions don't match/);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });

  test("should auto-resize the implementation to the design dimensions by default", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/resize-design.png");
    const impl = path.join(__dirname, "../test-fixtures/resize-impl.png");

    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, design);
    await createTestPNG(20, 20, { r: 100, g: 150, b: 200, a: 255 }, impl);

    const result = await expectOk(compareScreenshots(design, impl));
    assert.strictEqual(result.totalPixels, 100);
    assert.deepStrictEqual(result.resized, {
      fromWidth: 20,
      fromHeight: 20,
      toWidth: 10,
      toHeight: 10,
      fit: "contain",
    });
    assert.strictEqual(result.differentPixels, 0);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("should report not-found when the implementation file is missing", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/probe-design.png");
    await createTestPNG(10, 10, { r: 1, g: 2, b: 3, a: 255 }, design);

    const r = await compareScreenshots(design, "/non/existent/impl.png");
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /File not found: \/non\/existent\/impl\.png/);

    await fs.unlink(design);
  });

  test("should report unsupported when the implementation is not an image", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/probe2-design.png");
    const bad = path.join(__dirname, "../test-fixtures/probe2-impl.txt");
    await createTestPNG(10, 10, { r: 1, g: 2, b: 3, a: 255 }, design);
    await fs.writeFile(bad, "not an image");

    const r = await compareScreenshots(design, bad);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Unsupported image format/);

    await fs.unlink(design);
    await fs.unlink(bad);
  });

  test("should report failure when the implementation decodes partially (corrupt body)", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/trunc-design.png");
    const impl = path.join(__dirname, "../test-fixtures/trunc-impl.png");
    // design matches the truncated impl's header dimensions (64x64) so no resize
    // happens and loadPNG decodes the impl at native size — where it fails.
    await createTestPNG(64, 64, { r: 50, g: 60, b: 70, a: 255 }, design);
    await createTruncatedPNG(impl);

    const r = await compareScreenshots(design, impl);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Unsupported image format/);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("should report failure when the diff cannot be written", async () => {
    const { compareScreenshots } = await import("./index.js");
    const img1 = path.join(__dirname, "../test-fixtures/write-fail-1.png");
    const img2 = path.join(__dirname, "../test-fixtures/write-fail-2.png");
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, img1);
    await createTestPNG(8, 8, { r: 9, g: 9, b: 9, a: 255 }, img2);

    const r = await compareScreenshots(img1, img2, "/no/such/dir/diff.png");
    assert.strictEqual(r.success, false);

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

    const result = await expectOk(compareScreenshots(img1, img2, diff));
    assert.strictEqual(result.diffImageBase64, undefined);
    await fs.access(diff);

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

    const result = await expectOk(compareScreenshots(img1, img2));
    assert.ok(result.diffImageBase64);
    assert.ok(result.diffImageBase64.length > 0);

    await fs.unlink(img1);
    await fs.unlink(img2);
  });
});

describe("normalizeThreshold", () => {
  test("coerces and clamps to [0,1]", async () => {
    const { normalizeThreshold } = await import("./index.js");
    assert.strictEqual(normalizeThreshold(0.3), 0.3);
    assert.strictEqual(normalizeThreshold(5), 1);
    assert.strictEqual(normalizeThreshold(-2), 0);
    assert.strictEqual(normalizeThreshold("0.5"), 0.5);
    assert.strictEqual(normalizeThreshold("nope"), 0.1);
    assert.strictEqual(normalizeThreshold(undefined), 0.1);
    assert.strictEqual(normalizeThreshold(NaN), 0.1);
  });
});

describe("resize_fit modes", () => {
  // 20x10 design (2:1) vs 10x10 implementation (1:1) makes the modes diverge.
  async function setup() {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/fit-design.png");
    const impl = path.join(__dirname, "../test-fixtures/fit-impl.png");
    await createTestPNG(20, 10, { r: 220, g: 30, b: 30, a: 255 }, design);
    await createTestPNG(10, 10, { r: 220, g: 30, b: 30, a: 255 }, impl);
    return { compareScreenshots, design, impl };
  }

  test("fill stretches solid color → no diff, records fit", async () => {
    const { compareScreenshots, design, impl } = await setup();
    const r = await expectOk(compareScreenshots(design, impl, undefined, 0.1, true, "fill"));
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.resized.fit, "fill");
    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("contain letterboxes → pad band produces diff", async () => {
    const { compareScreenshots, design, impl } = await setup();
    const r = await expectOk(compareScreenshots(design, impl, undefined, 0.1, true, "contain"));
    assert.ok(r.differentPixels > 0);
    assert.deepStrictEqual(r.resized, {
      fromWidth: 10,
      fromHeight: 10,
      toWidth: 20,
      toHeight: 10,
      fit: "contain",
    });
    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("cover crops solid color → no diff", async () => {
    const { compareScreenshots, design, impl } = await setup();
    const r = await expectOk(compareScreenshots(design, impl, undefined, 0.1, true, "cover"));
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.resized.fit, "cover");
    await fs.unlink(design);
    await fs.unlink(impl);
  });
});

describe("SSIM metric", () => {
  test("identical images score ~1.0", async () => {
    const { compareScreenshots } = await import("./index.js");
    const a = path.join(__dirname, "../test-fixtures/ssim-a.png");
    const b = path.join(__dirname, "../test-fixtures/ssim-b.png");
    await createTestPNG(12, 12, { r: 80, g: 160, b: 240, a: 255 }, a);
    await createTestPNG(12, 12, { r: 80, g: 160, b: 240, a: 255 }, b);

    const r = await expectOk(compareScreenshots(a, b));
    assert.strictEqual(typeof r.ssim, "number");
    assert.ok(r.ssim > 0.99);

    await fs.unlink(a);
    await fs.unlink(b);
  });

  test("differing images score below 1.0", async () => {
    const { compareScreenshots } = await import("./index.js");
    const a = path.join(__dirname, "../test-fixtures/ssim-diff-a.png");
    const b = path.join(__dirname, "../test-fixtures/ssim-diff-b.png");
    await createTestPNG(12, 12, { r: 240, g: 20, b: 20, a: 255 }, a);
    await createTestPNG(12, 12, { r: 20, g: 20, b: 240, a: 255 }, b);

    const r = await expectOk(compareScreenshots(a, b));
    assert.ok(r.ssim < 1);
    assert.ok(r.ssim >= 0);

    await fs.unlink(a);
    await fs.unlink(b);
  });

  test("computeSSIM returns 1 for identical buffers", async () => {
    const { computeSSIM } = await import("./index.js");
    const png1 = new PNG({ width: 9, height: 9 });
    const png2 = new PNG({ width: 9, height: 9 });
    png1.data.fill(120);
    png2.data.fill(120);
    assert.ok(computeSSIM(png1, png2) > 0.999);
  });
});

describe("buildMask", () => {
  test("counts overlapping regions once (union)", async () => {
    const { buildMask } = await import("./index.js");
    const r = buildMask(10, 10, [
      { x: 0, y: 0, width: 5, height: 10 },
      { x: 3, y: 0, width: 5, height: 10 },
    ]);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.value.maskedCount, 80);
  });

  test("clamps out-of-bounds regions", async () => {
    const { buildMask } = await import("./index.js");
    const r = buildMask(10, 10, [{ x: 8, y: 0, width: 100, height: 100 }]);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.value.maskedCount, 20);
  });

  test("drops zero-area, zero-height, and fully-out-of-bounds regions", async () => {
    const { buildMask } = await import("./index.js");
    const r = buildMask(10, 10, [
      { x: 5, y: 5, width: 0, height: 0 }, // zero area (x1<=x0)
      { x: 20, y: 20, width: 5, height: 5 }, // entirely outside
      { x: 0, y: 5, width: 5, height: 0 }, // zero height (y1<=y0)
    ]);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.value.maskedCount, 0);
  });

  test("fails on a non-object region entry (null or primitive)", async () => {
    const { buildMask } = await import("./index.js");
    const r1 = buildMask(10, 10, [null as any]);
    assert.strictEqual(r1.success, false);
    assert.match(r1.error.message, /numeric x, y, width, height/);
    const r2 = buildMask(10, 10, [5 as any]);
    assert.strictEqual(r2.success, false);
    assert.match(r2.error.message, /numeric x, y, width, height/);
  });

  test("fails on non-finite coordinates", async () => {
    const { buildMask } = await import("./index.js");
    const r = buildMask(10, 10, [{ x: NaN, y: 0, width: 1, height: 1 }]);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /numeric x, y, width, height/);
  });

  test("fails on negative width/height", async () => {
    const { buildMask } = await import("./index.js");
    const r = buildMask(10, 10, [{ x: 0, y: 0, width: -1, height: 1 }]);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /non-negative/);
  });
});

describe("ignore_regions in comparison", () => {
  test("masking the whole image yields 0% over zero compared pixels", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/mask-all-design.png");
    const impl = path.join(__dirname, "../test-fixtures/mask-all-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
        { x: 0, y: 0, width: 10, height: 10 },
      ])
    );
    assert.strictEqual(r.maskedPixels, 100);
    assert.strictEqual(r.totalPixels, 0);
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.differencePercentage, 0);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("partial mask subtracts from the denominator", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/mask-part-design.png");
    const impl = path.join(__dirname, "../test-fixtures/mask-part-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
        { x: 0, y: 0, width: 5, height: 10 },
      ])
    );
    assert.strictEqual(r.maskedPixels, 50);
    assert.strictEqual(r.totalPixels, 50);
    assert.strictEqual(r.differentPixels, 50);
    assert.strictEqual(r.differencePercentage, 100);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("masking a differing region raises SSIM and lowers the diff", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/ssim-mask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/ssim-mask-impl.png");

    const W = 12;
    const H = 12;
    const d = new PNG({ width: W, height: H });
    const i = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (W * y + x) << 2;
        d.data[idx] = 255; d.data[idx + 1] = 0; d.data[idx + 2] = 0; d.data[idx + 3] = 255;
        const blue = x < 6 && y < 6;
        i.data[idx] = blue ? 0 : 255; i.data[idx + 1] = 0; i.data[idx + 2] = blue ? 255 : 0; i.data[idx + 3] = 255;
      }
    }
    await fs.mkdir(path.dirname(design), { recursive: true });
    await fs.writeFile(design, PNG.sync.write(d));
    await fs.writeFile(impl, PNG.sync.write(i));

    const unmasked = await expectOk(compareScreenshots(design, impl));
    const masked = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
        { x: 0, y: 0, width: 6, height: 6 },
      ])
    );
    assert.ok(masked.differentPixels < unmasked.differentPixels);
    assert.ok(masked.ssim > unmasked.ssim);

    await fs.unlink(design);
    await fs.unlink(impl);
  });
});

describe("MCP request handling", () => {
  test("should list compare_design tool", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    assert.ok(Array.isArray(result.tools));
    const toolNames = result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("compare_design"));
    assert.strictEqual(result.version, "0.7.0");
  });

  test("exposes resize_fit, ignore_regions, and the v0.7.0 params in the tool schema", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    const schema = result.tools[0].inputSchema.properties as Record<string, unknown>;
    assert.ok(schema.resize_fit);
    assert.ok(schema.ignore_regions);
    assert.ok(schema.svg_density);
    assert.ok(schema.localize);
    assert.ok(schema.max_difference_percentage);
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
        arguments: { design_path: img1, implementation_path: img2 },
      },
    });

    assert.ok(Array.isArray(response.content));
    assert.ok(response.content.some((item: any) => item.type === "image"));
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("SSIM:"));

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
        arguments: { design_path: img1, implementation_path: img2, threshold: 0 },
      },
    });

    assert.strictEqual(response.isError, undefined);
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("Difference:"));

    await fs.unlink(img1);
    await fs.unlink(img2);
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
        arguments: { design_path: img1, implementation_path: img2, threshold: "not-a-number" },
      },
    });

    assert.strictEqual(response.isError, undefined);
    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(/Difference: \d+\.\d+%/.test(textItem.text));

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
        arguments: { design_path: design, implementation_path: impl },
      },
    });

    const textItem = response.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("auto-resized from 16x16 to 8x8"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("honors resize_fit and reports it in the note", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-fit-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-fit-impl.png");
    await createTestPNG(8, 8, { r: 100, g: 100, b: 100, a: 255 }, design);
    await createTestPNG(16, 16, { r: 100, g: 100, b: 100, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, resize_fit: "fill" },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("(fill)"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("falls back to contain on invalid resize_fit", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-fit2-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-fit2-impl.png");
    await createTestPNG(8, 8, { r: 100, g: 100, b: 100, a: 255 }, design);
    await createTestPNG(16, 16, { r: 100, g: 100, b: 100, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, resize_fit: "bogus" },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("(contain)"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("reports masked pixels via ignore_regions", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-mask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-mask-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          ignore_regions: [{ x: 0, y: 0, width: 5, height: 10 }],
        },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("Masked Pixels: 50"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("notes when the entire image is masked (no pixels compared)", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-allmask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-allmask-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          ignore_regions: [{ x: 0, y: 0, width: 10, height: 10 }],
        },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("no pixels compared"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("returns error (isError) when ignore_regions is not an array", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-badmask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-badmask-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    // A single rectangle object (not wrapped in an array) must fail loud
    // rather than be silently treated as "no ignored regions".
    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          ignore_regions: { x: 0, y: 0, width: 5, height: 10 },
        },
      },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.includes("ignore_regions must be an array"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("saves diff to file and omits base64 image when output path given", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-out-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-out-impl.png");
    const diff = path.join(__dirname, "../test-fixtures/h-out-diff.png");
    await createTestPNG(8, 8, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(8, 8, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, output_diff_path: diff },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes(`Diff image saved to: ${diff}`));
    assert.ok(!res.content.some((c: any) => c.type === "image"));
    await fs.access(diff);

    await fs.unlink(design);
    await fs.unlink(impl);
    await fs.unlink(diff);
  });

  test("returns error (isError) when auto_resize is false and dimensions differ", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-noresize-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-noresize-impl.png");
    await createTestPNG(8, 8, { r: 10, g: 10, b: 10, a: 255 }, design);
    await createTestPNG(16, 16, { r: 10, g: 10, b: 10, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, auto_resize: false },
      },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.includes("Image dimensions don't match"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("returns error (isError) on malformed ignore_regions", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-bad-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-bad-impl.png");
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, design);
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          ignore_regions: [{ x: "x", y: 0, width: 1, height: 1 }] as any,
        },
      },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.startsWith("Error comparing screenshots"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("returns isError when required paths are missing (either path)", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const noDesign = await handleCallToolRequest({
      params: { name: "compare_design", arguments: {} },
    });
    assert.strictEqual(noDesign.isError, true);
    assert.ok(noDesign.content[0].text.includes("design_path and implementation_path are required"));

    const noImpl = await handleCallToolRequest({
      params: { name: "compare_design", arguments: { design_path: "/some/path.png" } },
    });
    assert.strictEqual(noImpl.isError, true);
    assert.ok(noImpl.content[0].text.includes("design_path and implementation_path are required"));
  });

  test("returns isError when there is no arguments object", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const res = await handleCallToolRequest({
      params: { name: "compare_design" },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.includes("design_path and implementation_path are required"));
  });

  test("throws on unknown tool names", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    await assert.rejects(
      async () => await handleCallToolRequest({ params: { name: "nope", arguments: {} } }),
      /Unknown tool: nope/
    );
  });
});

describe("max_difference_percentage gate", () => {
  test("passes when the difference is below the gate", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/gate-below-design.png");
    const impl = path.join(__dirname, "../test-fixtures/gate-below-impl.png");
    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, design);
    await createTestPNG(10, 10, { r: 100, g: 150, b: 200, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, max_difference_percentage: 5 },
      },
    });
    assert.strictEqual(res.isError, undefined);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("passes on exact equality (strictly-greater boundary)", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/gate-eq-design.png");
    const impl = path.join(__dirname, "../test-fixtures/gate-eq-impl.png");
    // full red vs full blue → exactly 100.00% different; a gate of 100 must pass
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, max_difference_percentage: 100 },
      },
    });
    assert.strictEqual(res.isError, undefined);
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("Difference: 100.00%"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("trips with a distinct message naming both numbers (artifact kept, base64 mode)", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/gate-trip-design.png");
    const impl = path.join(__dirname, "../test-fixtures/gate-trip-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, max_difference_percentage: 5 },
      },
    });
    assert.strictEqual(res.isError, true);
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(
      textItem.text.startsWith("Difference 100.00% exceeds max_difference_percentage 5%")
    );
    assert.ok(!textItem.text.startsWith("Error comparing screenshots"));
    // full stats survive into the gate-trip error
    assert.ok(textItem.text.includes("Total Pixels:"));
    assert.ok(textItem.text.includes("SSIM:"));
    // localization output survives into the gate-trip error too
    assert.ok(textItem.text.includes("Diff bounds:"));
    assert.ok(textItem.text.includes("Heat (3x3, % diff):"));
    // diff artifact survives (base64 output mode)
    assert.ok(res.content.some((c: any) => c.type === "image"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("gate of 0 with a zero diff passes", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/gate-zero-design.png");
    const impl = path.join(__dirname, "../test-fixtures/gate-zero-impl.png");
    await createTestPNG(8, 8, { r: 20, g: 30, b: 40, a: 255 }, design);
    await createTestPNG(8, 8, { r: 20, g: 30, b: 40, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, max_difference_percentage: 0 },
      },
    });
    assert.strictEqual(res.isError, undefined);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("rejects invalid values (negative, NaN) before any comparison runs", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    // paths deliberately non-existent: validation must fail loud before any decode
    const negative = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: "/non/existent/a.png",
          implementation_path: "/non/existent/b.png",
          max_difference_percentage: -1,
        },
      },
    });
    assert.strictEqual(negative.isError, true);
    assert.ok(
      negative.content[0].text.includes(
        "max_difference_percentage must be a non-negative, finite number"
      )
    );

    const nan = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: "/non/existent/a.png",
          implementation_path: "/non/existent/b.png",
          max_difference_percentage: NaN,
        },
      },
    });
    assert.strictEqual(nan.isError, true);
    assert.ok(
      nan.content[0].text.includes(
        "max_difference_percentage must be a non-negative, finite number"
      )
    );
  });

  test("writes the diff file even when the gate trips (file mode)", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/gate-file-design.png");
    const impl = path.join(__dirname, "../test-fixtures/gate-file-impl.png");
    const diff = path.join(__dirname, "../test-fixtures/gate-file-diff.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          output_diff_path: diff,
          max_difference_percentage: 5,
        },
      },
    });
    assert.strictEqual(res.isError, true);
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes(`Diff image saved to: ${diff}`));
    await fs.access(diff); // artifact written despite the trip

    await fs.unlink(design);
    await fs.unlink(impl);
    await fs.unlink(diff);
  });
});

describe("diff localization", () => {
  test("counts only red-marker pixels (yellow AA and grayscale excluded)", async () => {
    const { localizeDiff } = await import("./index.js");
    const width = 6;
    const height = 6;
    const data = Buffer.alloc(width * height * 4, 255); // white, opaque
    const paint = (x: number, y: number, rgba: number[]) => {
      const idx = (y * width + x) << 2;
      data[idx] = rgba[0]; data[idx + 1] = rgba[1]; data[idx + 2] = rgba[2]; data[idx + 3] = rgba[3];
    };
    paint(1, 1, [255, 0, 0, 255]); // red marker — counted
    paint(2, 2, [255, 0, 0, 255]); // red marker — counted
    paint(3, 3, [255, 255, 0, 255]); // AA yellow — must be excluded

    const { diffBounds, heatGrid } = localizeDiff(
      data, width, height, new Uint8Array(width * height)
    );
    assert.deepStrictEqual(diffBounds, { x: 1, y: 1, width: 2, height: 2 });
    // 6x6 into 3x3 → 2x2 cells of 4 px. Red (1,1)→cell 0, (2,2)→cell 4.
    // Yellow (3,3) also lands in cell 4 and would read 50 if counted.
    assert.deepStrictEqual(heatGrid.cells, [25, 0, 0, 0, 25, 0, 0, 0, 0]);
    assert.strictEqual(heatGrid.rows, 3);
    assert.strictEqual(heatGrid.cols, 3);
  });

  test("floor partition covers every pixel exactly once (10x10 into 3x3)", async () => {
    const { localizeDiff } = await import("./index.js");
    const width = 10;
    const height = 10;
    const data = Buffer.alloc(width * height * 4);
    for (let k = 0; k < width * height; k++) {
      const idx = k << 2;
      data[idx] = 255; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
    }
    const { diffBounds, heatGrid } = localizeDiff(
      data, width, height, new Uint8Array(width * height)
    );
    assert.deepStrictEqual(diffBounds, { x: 0, y: 0, width: 10, height: 10 });
    // all-red: every cell must be exactly 100% — a skipped or double-counted
    // pixel makes some cell diverge from 100.
    assert.deepStrictEqual(heatGrid.cells, [100, 100, 100, 100, 100, 100, 100, 100, 100]);
  });

  test("last row/column absorbs the remainder", async () => {
    const { localizeDiff } = await import("./index.js");
    const width = 10;
    const height = 10;
    const data = Buffer.alloc(width * height * 4, 255); // white
    const idx = (9 * width + 9) << 2;
    data[idx] = 255; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255; // red at (9,9)

    const { diffBounds, heatGrid } = localizeDiff(
      data, width, height, new Uint8Array(width * height)
    );
    assert.deepStrictEqual(diffBounds, { x: 9, y: 9, width: 1, height: 1 });
    // cell boundaries at floor(10/3)=3 → last cell spans x,y ∈ [6,9]: 4x4 = 16 px
    assert.strictEqual(heatGrid.cells[8], 6.25); // 1/16 * 100
    assert.deepStrictEqual(heatGrid.cells.slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("grids larger than the image stay in range (2x2 into 3x3)", async () => {
    const { localizeDiff } = await import("./index.js");
    const width = 2;
    const height = 2;
    const data = Buffer.alloc(width * height * 4, 255);
    const idx = (1 * width + 1) << 2;
    data[idx] = 255; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255; // red at (1,1)

    const { diffBounds, heatGrid } = localizeDiff(
      data, width, height, new Uint8Array(width * height)
    );
    assert.deepStrictEqual(diffBounds, { x: 1, y: 1, width: 1, height: 1 });
    // cellW/cellH clamp to 1: (1,1) → row 1, col 1 → cell 4; empty grid cells report 0
    assert.deepStrictEqual(heatGrid.cells, [0, 0, 0, 0, 100, 0, 0, 0, 0]);
  });

  test("quadrant fixture: bbox, heat distribution, and area-weighted invariant", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-quad-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-quad-impl.png");
    await createQuadrantPair(design, impl, 12, { x: 0, y: 0, width: 6, height: 6 });

    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [], true)
    );
    assert.strictEqual(r.differentPixels, 36);
    assert.deepStrictEqual(r.diffBounds, { x: 0, y: 0, width: 6, height: 6 });
    // 12x12 into 3x3 → 4x4 cells: blue block covers cell0 fully, cells 1 and 3
    // half, cell 4 a quarter
    assert.deepStrictEqual(r.heatGrid.cells, [100, 50, 0, 50, 25, 0, 0, 0, 0]);
    // area-weighted invariant: all cells equal-sized (no mask) → plain mean of
    // the cells equals differencePercentage
    const mean = r.heatGrid.cells.reduce((a: number, b: number) => a + b, 0) / 9;
    assert.ok(Math.abs(mean - r.differencePercentage) < 1e-9);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("red-marker pixels in the real diff equal differentPixels", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-inv-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-inv-impl.png");
    await createQuadrantPair(design, impl, 12, { x: 3, y: 4, width: 5, height: 3 });

    const r = await expectOk(compareScreenshots(design, impl));
    const diffPng = PNG.sync.read(Buffer.from(r.diffImageBase64, "base64"));
    let red = 0;
    for (let k = 0; k < diffPng.width * diffPng.height; k++) {
      const idx = k << 2;
      if (
        diffPng.data[idx] === 255 &&
        diffPng.data[idx + 1] === 0 &&
        diffPng.data[idx + 2] === 0 &&
        diffPng.data[idx + 3] === 255
      ) {
        red++;
      }
    }
    assert.strictEqual(red, r.differentPixels);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("masked region is excluded from bbox and heat", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-mask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-mask-impl.png");
    await createQuadrantPair(design, impl, 12, { x: 0, y: 0, width: 6, height: 6 });

    // mask the top three rows of the blue block → remaining diff is y ∈ [3,5]
    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
        { x: 0, y: 0, width: 6, height: 3 },
      ], true)
    );
    assert.strictEqual(r.maskedPixels, 18);
    assert.strictEqual(r.differentPixels, 18);
    assert.deepStrictEqual(r.diffBounds, { x: 0, y: 3, width: 6, height: 3 });
    // cell0 (x0-3,y0-3): 12 of 16 px masked, remaining 4 all red → 100
    assert.strictEqual(r.heatGrid.cells[0], 100);
    // cell1 (x4-7,y0-3): 6 masked, 10 unmasked, 2 red → 20
    assert.strictEqual(r.heatGrid.cells[1], 20);
    // cell3 (x0-3,y4-7): unmasked, 8 of 16 red → 50
    assert.strictEqual(r.heatGrid.cells[3], 50);
    // cell4 (x4-7,y4-7): 4 of 16 red → 25
    assert.strictEqual(r.heatGrid.cells[4], 25);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("fully-masked frame → diffBounds null, heatGrid all-zero", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-allmask-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-allmask-impl.png");
    await createTestPNG(12, 12, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(12, 12, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
        { x: 0, y: 0, width: 12, height: 12 },
      ], true)
    );
    assert.strictEqual(r.diffBounds, null);
    assert.deepStrictEqual(r.heatGrid.cells, [0, 0, 0, 0, 0, 0, 0, 0, 0]);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("zero-diff run → diffBounds null, heatGrid all-zero", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-zero-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-zero-impl.png");
    await createTestPNG(9, 9, { r: 7, g: 8, b: 9, a: 255 }, design);
    await createTestPNG(9, 9, { r: 7, g: 8, b: 9, a: 255 }, impl);

    const r = await expectOk(compareScreenshots(design, impl));
    assert.strictEqual(r.diffBounds, null);
    assert.deepStrictEqual(r.heatGrid.cells, [0, 0, 0, 0, 0, 0, 0, 0, 0]);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("localize=false omits both fields", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-off-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-off-impl.png");
    await createQuadrantPair(design, impl, 12, { x: 0, y: 0, width: 6, height: 6 });

    const r = await expectOk(
      compareScreenshots(design, impl, undefined, 0.1, true, "contain", [], false)
    );
    assert.strictEqual(r.diffBounds, undefined);
    assert.strictEqual(r.heatGrid, undefined);

    await fs.unlink(design);
    await fs.unlink(impl);
  });
});

describe("diff localization text output", () => {
  test("appends Diff bounds and heat lines when diffs exist", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-text-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-text-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("Diff bounds: x=0 y=0 w=10 h=10 (design space)"));
    assert.ok(textItem.text.includes("Heat (3x3, % diff):"));
    // full 100% diff → every heat row renders as "  100 100 100"
    assert.ok(textItem.text.includes("  100 100 100"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("prints no bounds/heat lines on a zero-diff run", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-text0-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-text0-impl.png");
    await createTestPNG(10, 10, { r: 5, g: 6, b: 7, a: 255 }, design);
    await createTestPNG(10, 10, { r: 5, g: 6, b: 7, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(!textItem.text.includes("Diff bounds:"));
    assert.ok(!textItem.text.includes("Heat ("));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("prints no bounds/heat lines when localize is false", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/loc-textoff-design.png");
    const impl = path.join(__dirname, "../test-fixtures/loc-textoff-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, localize: false },
      },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(!textItem.text.includes("Diff bounds:"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("exposes localize in the tool schema", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    const schema = result.tools[0].inputSchema.properties as Record<string, unknown>;
    assert.ok(schema.localize);
  });
});

describe("normalizeDensity", () => {
  test("defaults undefined to 288 and passes valid numbers through", async () => {
    const { normalizeDensity } = await import("./index.js");
    const def = normalizeDensity(undefined);
    assert.strictEqual(def.success, true);
    assert.strictEqual(def.value, 288);
    const explicit = normalizeDensity(144);
    assert.strictEqual(explicit.success, true);
    assert.strictEqual(explicit.value, 144);
  });

  test("fails loud on non-number, NaN, zero, and negative", async () => {
    const { normalizeDensity } = await import("./index.js");
    for (const bad of ["288", 0, -1, NaN, null, {}]) {
      const r = normalizeDensity(bad);
      assert.strictEqual(r.success, false, `expected failure for ${String(bad)}`);
      assert.match(r.error.message, /svg_density must be a positive, finite number/);
    }
  });
});

describe("SVG loading", () => {
  test("renders an SVG at the given density (intrinsic x density/72)", async () => {
    const { loadPNG } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/load-density.svg");
    await createTestSVG(SVG_RED_36, svgPath);

    const at288 = await expectOk(loadPNG(svgPath, undefined, 288));
    assert.strictEqual(at288.width, 144); // 36 * 288/72
    assert.strictEqual(at288.height, 144);
    // solid full-bleed rect → first pixel is opaque red
    assert.strictEqual(at288.data[0], 255);
    assert.strictEqual(at288.data[3], 255);

    const at72 = await expectOk(loadPNG(svgPath, undefined, 72));
    assert.strictEqual(at72.width, 36);
    assert.strictEqual(at72.height, 36);

    await fs.unlink(svgPath);
  });

  test("resolves intrinsic size from viewBox when width/height are absent", async () => {
    const { loadPNG } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/load-viewbox.svg");
    await createTestSVG(SVG_VIEWBOX_ONLY, svgPath);

    const png = await expectOk(loadPNG(svgPath, undefined, 288));
    assert.strictEqual(png.width, 144);
    assert.strictEqual(png.height, 144);

    await fs.unlink(svgPath);
  });

  test("reports unsupported for .svg files with non-SVG bytes (cause preserved)", async () => {
    const { loadPNG } = await import("./index.js");
    const bogus = path.join(__dirname, "../test-fixtures/bogus.svg");
    await fs.mkdir(path.dirname(bogus), { recursive: true });
    await fs.writeFile(bogus, "this is not an svg");

    const r = await loadPNG(bogus, undefined, 288);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Unsupported image format/);
    // the underlying cause is preserved, not swallowed
    assert.ok(r.error.message.length > "Unsupported image format: ".length + bogus.length);

    await fs.unlink(bogus);
  });
});

describe("SVG comparison", () => {
  test("SVG design + PNG impl: reference dims are intrinsic x density/72", async () => {
    const { compareScreenshots } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-design.svg");
    const impl = path.join(__dirname, "../test-fixtures/svg-design-impl.png");
    await createTestSVG(SVG_RED_36, svgPath);
    await createTestPNG(144, 144, { r: 255, g: 0, b: 0, a: 255 }, impl);

    const r = await expectOk(compareScreenshots(svgPath, impl)); // default density 288
    assert.strictEqual(r.totalPixels, 144 * 144);
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.resized, undefined);

    await fs.unlink(svgPath);
    await fs.unlink(impl);
  });

  test("PNG design + SVG impl with matching intrinsic dims: no resized record, zero diff", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-impl-design.png");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-impl.svg");
    await createTestPNG(36, 36, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestSVG(SVG_RED_36, svgPath);

    const r = await expectOk(compareScreenshots(design, svgPath));
    assert.strictEqual(r.totalPixels, 36 * 36);
    assert.strictEqual(r.differentPixels, 0);
    // intrinsic dims match the design → not reported as a resize, even though
    // the render happened at 288 dpi and was scaled down
    assert.strictEqual(r.resized, undefined);

    await fs.unlink(design);
    await fs.unlink(svgPath);
  });

  test("SVG impl reports resized from its intrinsic (72 dpi) size", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-resized-design.png");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-resized.svg");
    await createTestPNG(72, 72, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestSVG(SVG_RED_36, svgPath);

    const r = await expectOk(compareScreenshots(design, svgPath));
    assert.deepStrictEqual(r.resized, {
      fromWidth: 36,
      fromHeight: 36,
      toWidth: 72,
      toHeight: 72,
      fit: "contain",
    });
    assert.strictEqual(r.differentPixels, 0);

    await fs.unlink(design);
    await fs.unlink(svgPath);
  });

  test("auto_resize=false with an SVG impl errors on intrinsic-vs-design mismatch", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-noresize-design.png");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-noresize.svg");
    await createTestPNG(72, 72, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestSVG(SVG_RED_36, svgPath);

    const r = await compareScreenshots(design, svgPath, undefined, 0.1, false);
    assert.strictEqual(r.success, false);
    assert.match(
      r.error.message,
      /Image dimensions don't match: design \(72x72\) vs implementation \(36x36\)/
    );

    await fs.unlink(design);
    await fs.unlink(svgPath);
  });

  test("identical SVG on both sides → 0 diffs, diffBounds null, exact reference dims", async () => {
    const { compareScreenshots } = await import("./index.js");
    const a = path.join(__dirname, "../test-fixtures/svg-both-a.svg");
    const b = path.join(__dirname, "../test-fixtures/svg-both-b.svg");
    await createTestSVG(SVG_RED_36, a);
    await createTestSVG(SVG_RED_36, b);

    const r = await expectOk(compareScreenshots(a, b));
    assert.strictEqual(r.totalPixels, 144 * 144); // 36x36 @ 288 → 144x144
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.diffBounds, null);

    await fs.unlink(a);
    await fs.unlink(b);
  });

  test("viewBox-only SVG resolves dims from viewBox", async () => {
    const { compareScreenshots } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-viewbox.svg");
    const impl = path.join(__dirname, "../test-fixtures/svg-viewbox-impl.png");
    await createTestSVG(SVG_VIEWBOX_ONLY, svgPath);
    await createTestPNG(144, 144, { r: 255, g: 0, b: 0, a: 255 }, impl);

    const r = await expectOk(compareScreenshots(svgPath, impl));
    assert.strictEqual(r.totalPixels, 144 * 144);
    assert.strictEqual(r.differentPixels, 0);

    await fs.unlink(svgPath);
    await fs.unlink(impl);
  });

  test("SVG with no derivable intrinsic size fails loud as design and as impl", async () => {
    const { compareScreenshots } = await import("./index.js");
    const noSize = path.join(__dirname, "../test-fixtures/svg-nosize.svg");
    const png = path.join(__dirname, "../test-fixtures/svg-nosize-peer.png");
    await createTestSVG(SVG_NO_SIZE, noSize);
    await createTestPNG(36, 36, { r: 1, g: 2, b: 3, a: 255 }, png);

    const asDesign = await compareScreenshots(noSize, png);
    assert.strictEqual(asDesign.success, false);
    assert.match(asDesign.error.message, /no derivable intrinsic size/);

    const asImpl = await compareScreenshots(png, noSize);
    assert.strictEqual(asImpl.success, false);
    assert.match(asImpl.error.message, /no derivable intrinsic size/);

    await fs.unlink(noSize);
    await fs.unlink(png);
  });

  test(".svg extension with non-SVG bytes fails through the format-error path", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-bogus-design.png");
    const bogus = path.join(__dirname, "../test-fixtures/svg-bogus.svg");
    await createTestPNG(36, 36, { r: 1, g: 2, b: 3, a: 255 }, design);
    await fs.writeFile(bogus, "this is not an svg");

    const r = await compareScreenshots(design, bogus);
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /Unsupported image format/);

    await fs.unlink(design);
    await fs.unlink(bogus);
  });

  test("higher svg_density does not increase diff % on an AA-heavy shape", async () => {
    const { compareScreenshots } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/density-circle.svg");
    const design = path.join(__dirname, "../test-fixtures/density-design.png");
    await createTestSVG(SVG_CIRCLE_36, svgPath);
    // Clean 72x72 reference: render the same circle at very high density and
    // downscale — generated in-test on this platform, so no cross-platform
    // golden flakiness; the assertion below is relational.
    const ref = await sharp(Buffer.from(SVG_CIRCLE_36), { density: 1152 })
      .resize(72, 72)
      .png()
      .toBuffer();
    await fs.mkdir(path.dirname(design), { recursive: true });
    await fs.writeFile(design, ref);

    // svg_density 72 floors up to the effective ceil(72 * 72/36) = 144
    const low = await expectOk(
      compareScreenshots(design, svgPath, undefined, 0.1, true, "contain", [], true, 72)
    );
    const high = await expectOk(
      compareScreenshots(design, svgPath, undefined, 0.1, true, "contain", [], true, 576)
    );
    assert.ok(high.differencePercentage <= low.differencePercentage + 0.5);

    await fs.unlink(svgPath);
    await fs.unlink(design);
  });

  test("invalid svg_density fails loud even for raster-only inputs", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-badden-design.png");
    const impl = path.join(__dirname, "../test-fixtures/svg-badden-impl.png");
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, design);
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, impl);

    const r = await compareScreenshots(
      design, impl, undefined, 0.1, true, "contain", [], true, -5
    );
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /svg_density must be a positive, finite number/);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("bounds-checks unbounded render cost (huge density fails loud)", async () => {
    const { compareScreenshots } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-huge.svg");
    const impl = path.join(__dirname, "../test-fixtures/svg-huge-impl.png");
    await createTestSVG(SVG_RED_36, svgPath);
    await createTestPNG(36, 36, { r: 255, g: 0, b: 0, a: 255 }, impl);

    // 36 * 1e7/72 = 5,000,000 px per side — far past the 8192x8192 cap
    const r = await compareScreenshots(
      svgPath, impl, undefined, 0.1, true, "contain", [], true, 1e7
    );
    assert.strictEqual(r.success, false);
    assert.match(r.error.message, /svg_density too high/);

    await fs.unlink(svgPath);
    await fs.unlink(impl);
  });

  test("wide design + square SVG impl under 'contain' is letterboxed, not rejected as too-dense", async () => {
    // An SVG implementation compared against a design with an extreme aspect
    // ratio succeeds under the default 'contain' fit. 'contain' letterboxes
    // the SVG so it fills only the constraining (smaller-scale) axis; the
    // render density is therefore sized from min(scaleW, scaleH). A 36x36 SVG
    // into a 9000x100 design renders a 144x144 intermediate at density 288 and
    // compares cleanly.
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/svg-wide-design.png");
    const svgPath = path.join(__dirname, "../test-fixtures/svg-wide-impl.svg");
    await createTestPNG(9000, 100, { r: 0, g: 0, b: 255, a: 255 }, design);
    await createTestSVG(SVG_RED_36, svgPath); // 36x36 intrinsic

    // Default density 288, contain: the min-axis scale keeps the 36x36
    // intermediate at 144x144, well under the 8192x8192 render cap.
    const r = await expectOk(compareScreenshots(design, svgPath));
    assert.deepStrictEqual(r.resized, {
      fromWidth: 36,
      fromHeight: 36,
      toWidth: 9000,
      toHeight: 100,
      fit: "contain",
    });

    await fs.unlink(design);
    await fs.unlink(svgPath);
  });
});

describe("svg_density in the handler", () => {
  test("exposes svg_density in the tool schema", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    const schema = result.tools[0].inputSchema.properties as Record<string, unknown>;
    assert.ok(schema.svg_density);
  });

  test("passes svg_density through and compares an SVG at the requested density", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const svgPath = path.join(__dirname, "../test-fixtures/h-svg.svg");
    const impl = path.join(__dirname, "../test-fixtures/h-svg-impl.png");
    await createTestSVG(SVG_RED_36, svgPath);
    await createTestPNG(72, 72, { r: 255, g: 0, b: 0, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: svgPath, implementation_path: impl, svg_density: 144 },
      },
    });
    assert.strictEqual(res.isError, undefined);
    const textItem = res.content.find((c: any) => c.type === "text");
    // 36x36 @ 144 dpi → 72x72 reference = 5,184 pixels
    assert.ok(textItem.text.includes("Total Pixels: 5,184"));

    await fs.unlink(svgPath);
    await fs.unlink(impl);
  });

  test("returns isError on invalid svg_density", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-svg-bad-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-svg-bad-impl.png");
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, design);
    await createTestPNG(8, 8, { r: 1, g: 1, b: 1, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: { design_path: design, implementation_path: impl, svg_density: 0 },
      },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(
      res.content[0].text.includes("svg_density must be a positive, finite number")
    );

    await fs.unlink(design);
    await fs.unlink(impl);
  });
});

describe("EXIF orientation auto-rotate", () => {
  // display space: 200 wide x 100 tall, left half red / right half blue.
  // Asymmetric on both axes, so an un-rotated axis-swap reads as a gross diff.
  function buildDisplayPNG(): PNG {
    const W = 200;
    const H = 100;
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (W * y + x) << 2;
        const red = x < W / 2;
        png.data[idx] = red ? 255 : 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = red ? 0 : 255;
        png.data[idx + 3] = 255;
      }
    }
    return png;
  }

  // orientation 6 = viewer rotates the stored image 90° clockwise to display it,
  // so the stored pixels are the display rotated 90° counter-clockwise
  // (sharp rotate 270). TIFF + 90° rotation is lossless, so the twin survives.
  async function writeOrientedTIFF(dispBuf: Buffer, filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const stored = await sharp(dispBuf)
      .rotate(270)
      .tiff()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await fs.writeFile(filePath, stored);
  }

  // WHY: an EXIF-oriented screenshot that is the visual twin of the design must
  // compare as near-zero. Measuring it in stored (un-oriented) pixel space swaps
  // the axes and reports a ~88% false regression.
  test("oriented impl that is the design's visual twin compares as near-zero", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/exif-twin-design.png");
    const impl = path.join(__dirname, "../test-fixtures/exif-twin-impl.tiff");
    const dispBuf = PNG.sync.write(buildDisplayPNG());
    await fs.mkdir(path.dirname(design), { recursive: true });
    await fs.writeFile(design, dispBuf);
    await writeOrientedTIFF(dispBuf, impl);

    const r = await expectOk(compareScreenshots(design, impl));
    // probe reported DISPLAY dims (200x100 == design) → no resize path taken
    assert.strictEqual(r.resized, undefined);
    assert.ok(
      r.differencePercentage < 2,
      `expected near-zero for the visual twin, got ${r.differencePercentage}%`
    );

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  // Direct probe assertion: a different design size forces a resize, exposing the
  // impl's probed dimensions via resized.from{Width,Height} — which must be the
  // display dims (200x100), not the stored dims (100x200).
  test("dimension probe of the oriented file yields display dims (200x100)", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/exif-probe-design.png");
    const impl = path.join(__dirname, "../test-fixtures/exif-probe-impl.tiff");
    await createTestPNG(100, 50, { r: 0, g: 0, b: 0, a: 255 }, design);
    await writeOrientedTIFF(PNG.sync.write(buildDisplayPNG()), impl);

    const r = await expectOk(compareScreenshots(design, impl));
    assert.strictEqual(r.resized.fromWidth, 200);
    assert.strictEqual(r.resized.fromHeight, 100);

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  // Regression guard: the added .rotate() must be a no-op for a file with no
  // orientation tag — a plain TIFF twin still compares as near-zero, no resize.
  test("non-oriented control (plain TIFF twin) still compares as near-zero", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/exif-ctrl-design.png");
    const impl = path.join(__dirname, "../test-fixtures/exif-ctrl-impl.tiff");
    const dispBuf = PNG.sync.write(buildDisplayPNG());
    await fs.mkdir(path.dirname(design), { recursive: true });
    await fs.writeFile(design, dispBuf);
    await fs.mkdir(path.dirname(impl), { recursive: true });
    await fs.writeFile(impl, await sharp(dispBuf).tiff().toBuffer());

    const r = await expectOk(compareScreenshots(design, impl));
    assert.strictEqual(r.resized, undefined);
    assert.ok(
      r.differencePercentage < 2,
      `expected near-zero for the plain twin, got ${r.differencePercentage}%`
    );

    await fs.unlink(design);
    await fs.unlink(impl);
  });
});
