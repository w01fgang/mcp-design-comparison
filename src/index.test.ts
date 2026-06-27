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
      fit: "contain",
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
    assert.strictEqual(result.version, "0.5.0");
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

describe("normalizeThreshold", () => {
  test("coerces and clamps to [0,1]", async () => {
    const { normalizeThreshold } = await import("./index.js");
    assert.strictEqual(normalizeThreshold(0.3), 0.3);
    assert.strictEqual(normalizeThreshold(5), 1); // clamp high
    assert.strictEqual(normalizeThreshold(-2), 0); // clamp low
    assert.strictEqual(normalizeThreshold("0.5"), 0.5); // string parse
    assert.strictEqual(normalizeThreshold("nope"), 0.1); // unparsable → default
    assert.strictEqual(normalizeThreshold(undefined), 0.1); // non-number/string → default
    assert.strictEqual(normalizeThreshold(NaN), 0.1); // non-finite → default
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
    const r = await compareScreenshots(design, impl, undefined, 0.1, true, "fill");
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.resized?.fit, "fill");
    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("contain letterboxes → pad band produces diff", async () => {
    const { compareScreenshots, design, impl } = await setup();
    const r = await compareScreenshots(design, impl, undefined, 0.1, true, "contain");
    // Transparent pad columns differ from the solid design → honest diff.
    assert.ok(r.differentPixels > 0);
    assert.strictEqual(r.resized?.fit, "contain");
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
    const r = await compareScreenshots(design, impl, undefined, 0.1, true, "cover");
    assert.strictEqual(r.differentPixels, 0);
    assert.strictEqual(r.resized?.fit, "cover");
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

    const r = await compareScreenshots(a, b);
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

    const r = await compareScreenshots(a, b);
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
    // Two 5x10 columns overlapping on cols 3-4 → union is cols 0-7 = 80 px.
    const { maskedCount } = buildMask(10, 10, [
      { x: 0, y: 0, width: 5, height: 10 },
      { x: 3, y: 0, width: 5, height: 10 },
    ]);
    assert.strictEqual(maskedCount, 80);
  });

  test("clamps out-of-bounds regions", async () => {
    const { buildMask } = await import("./index.js");
    // x=8 width=100 on a width-10 image → only cols 8-9 (×10 rows) = 20 px.
    const { maskedCount } = buildMask(10, 10, [
      { x: 8, y: 0, width: 100, height: 100 },
    ]);
    assert.strictEqual(maskedCount, 20);
  });

  test("drops zero-area and fully-out-of-bounds regions", async () => {
    const { buildMask } = await import("./index.js");
    const { maskedCount } = buildMask(10, 10, [
      { x: 5, y: 5, width: 0, height: 0 }, // zero area
      { x: 20, y: 20, width: 5, height: 5 }, // entirely outside
    ]);
    assert.strictEqual(maskedCount, 0);
  });

  test("throws on non-finite coordinates", async () => {
    const { buildMask } = await import("./index.js");
    assert.throws(
      () => buildMask(10, 10, [{ x: NaN, y: 0, width: 1, height: 1 }]),
      /numeric x, y, width, height/
    );
  });

  test("throws on negative width/height", async () => {
    const { buildMask } = await import("./index.js");
    assert.throws(
      () => buildMask(10, 10, [{ x: 0, y: 0, width: -1, height: 1 }]),
      /non-negative/
    );
  });
});

describe("ignore_regions in comparison", () => {
  test("masking the whole image yields 0% and excludes all pixels", async () => {
    const { compareScreenshots } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/mask-all-design.png");
    const impl = path.join(__dirname, "../test-fixtures/mask-all-impl.png");
    await createTestPNG(10, 10, { r: 255, g: 0, b: 0, a: 255 }, design);
    await createTestPNG(10, 10, { r: 0, g: 0, b: 255, a: 255 }, impl);

    const r = await compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
      { x: 0, y: 0, width: 10, height: 10 },
    ]);
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

    // Mask left half (50 px). Remaining 50 px all differ → 50/50 = 100%, not 50%.
    const r = await compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
      { x: 0, y: 0, width: 5, height: 10 },
    ]);
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

    // design: solid red. impl: red except a blue 6x6 block in the top-left.
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

    const unmasked = await compareScreenshots(design, impl);
    const masked = await compareScreenshots(design, impl, undefined, 0.1, true, "contain", [
      { x: 0, y: 0, width: 6, height: 6 },
    ]);
    // The mask removes the differing block from BOTH the pixel diff and SSIM.
    assert.ok(masked.differentPixels < unmasked.differentPixels);
    assert.ok(masked.ssim > unmasked.ssim);

    await fs.unlink(design);
    await fs.unlink(impl);
  });
});

describe("loadPNG resize errors", () => {
  test("rejects on invalid resize dimensions", async () => {
    const { loadPNG } = await import("./index.js");
    const img = path.join(__dirname, "../test-fixtures/resize-err.png");
    await createTestPNG(10, 10, { r: 10, g: 10, b: 10, a: 255 }, img);

    await assert.rejects(
      async () => await loadPNG(img, { width: 0, height: 0, fit: "fill" })
    );

    await fs.unlink(img);
  });
});

describe("handler: new parameters and output", () => {
  test("reports SSIM in the response text", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const a = path.join(__dirname, "../test-fixtures/h-ssim-1.png");
    const b = path.join(__dirname, "../test-fixtures/h-ssim-2.png");
    await createTestPNG(8, 8, { r: 90, g: 90, b: 90, a: 255 }, a);
    await createTestPNG(8, 8, { r: 90, g: 90, b: 90, a: 255 }, b);

    const res = await handleCallToolRequest({
      params: { name: "compare_design", arguments: { design_path: a, implementation_path: b } },
    });
    const textItem = res.content.find((c: any) => c.type === "text");
    assert.ok(textItem.text.includes("SSIM:"));

    await fs.unlink(a);
    await fs.unlink(b);
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

  test("reports masked pixels and excludes them via ignore_regions", async () => {
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

  test("returns error on malformed ignore_regions", async () => {
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

  test("throws when required paths are missing", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    await assert.rejects(
      async () =>
        await handleCallToolRequest({
          params: { name: "compare_design", arguments: {} },
        }),
      /design_path and implementation_path are required/
    );
  });

  test("rejects unknown tool names", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    await assert.rejects(
      async () =>
        await handleCallToolRequest({ params: { name: "nope", arguments: {} } }),
      /Unknown tool: nope/
    );
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
    await fs.access(diff); // file written

    await fs.unlink(design);
    await fs.unlink(impl);
    await fs.unlink(diff);
  });

  test("handles a request with no arguments object", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    await assert.rejects(
      async () => await handleCallToolRequest({ params: { name: "compare_design" } }),
      /design_path and implementation_path are required/
    );
  });

  test("surfaces a dimension-mismatch error when auto_resize is false", async () => {
    const { handleCallToolRequest } = await import("./index.js");
    const design = path.join(__dirname, "../test-fixtures/h-noresize-design.png");
    const impl = path.join(__dirname, "../test-fixtures/h-noresize-impl.png");
    await createTestPNG(8, 8, { r: 10, g: 10, b: 10, a: 255 }, design);
    await createTestPNG(16, 16, { r: 10, g: 10, b: 10, a: 255 }, impl);

    const res = await handleCallToolRequest({
      params: {
        name: "compare_design",
        arguments: {
          design_path: design,
          implementation_path: impl,
          auto_resize: false,
        },
      },
    });
    assert.strictEqual(res.isError, true);
    assert.ok(res.content[0].text.includes("Image dimensions don't match"));

    await fs.unlink(design);
    await fs.unlink(impl);
  });

  test("exposes resize_fit and ignore_regions in the tool schema", async () => {
    const { handleListToolsRequest } = await import("./index.js");
    const result = await handleListToolsRequest();
    const schema = result.tools[0].inputSchema.properties as Record<string, unknown>;
    assert.ok(schema.resize_fit);
    assert.ok(schema.ignore_regions);
  });

  test("formatError handles Error and non-Error values", async () => {
    const { formatError } = await import("./index.js");
    assert.strictEqual(formatError(new Error("boom")), "boom");
    assert.strictEqual(formatError("plain string"), "plain string");
    assert.strictEqual(formatError(42), "42");
  });
});
