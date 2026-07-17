# Vector Input & Diff Localization (v0.7.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `.svg` inputs on either side of `compare_design` (rendered at an explicit density), report *where* diffs cluster (bounding box + 3×3 heat grid), and add an optional CI assertion gate (`max_difference_percentage`).

**Architecture:** All image logic stays in `src/compare.ts` (SVG rasterization is a constructor-options branch inside `loadPNG`; `localizeDiff` is a single O(W·H) pass over the pixelmatch diff buffer keyed on the red marker). `src/index.ts` grows three `inputSchema` params, the bounds/heat text lines, and the gate — applied after `compareScreenshots` returns so the diff artifact survives a gate trip. Everything keeps the no-throw `TryResult` convention.

**Tech Stack:** TypeScript (ES2022/Node16, strict), sharp (librsvg for SVG decode — already a dep), pixelmatch, pngjs, ssim.js, `node:test` + `node:assert`, MCP SDK, `@power-rent/try-catch`.

## Global Constraints

- Version bump **0.6.0 → 0.7.0**: `package.json:3`, `VERSION` at `src/index.ts:26`, and the existing assertion at `src/index.test.ts:531`.
- **sharp is the only image dependency** — no new deps; SVG decode rides sharp's bundled librsvg.
- **No-throw convention**: every new fallible helper returns a `TryResult` via `@power-rent/try-catch`'s pattern (the local `fail()` factory at `src/compare.ts:39-41`); nothing throws.
- `svg_density` default **288**; `normalizeDensity` fails loud on non-number/NaN/≤ 0; render cost bounds-checked at **8192 × 8192 output pixels** (`MAX_SVG_OUTPUT_PIXELS`).
- `localize` default **true**; heat grid is **3×3**, floor partition (`floor(W/cols)` / `floor(H/rows)`), last column/row absorbs the remainder; per-cell denominator = unmasked pixels in that cell; fully-masked cell → 0%.
- `max_difference_percentage`: **strictly greater-than** trips (equality passes); non-finite/negative fails loud (`isError`); gate lives in `src/index.ts` **after** `compareScreenshots` returns; the diff artifact (file or base64 image content) survives a trip; gate message has **no** `Error comparing screenshots:` prefix.
- `diffBounds`, `heatGrid`, and `ignore_regions` coordinates are in **rendered-pixel (design-space) coordinates** — for an SVG design that is intrinsic × (density / 72).
- Test command: **`npm run build && npm test`** (`test` = `node --test dist/index.test.js`; tests are compiled by `tsc`, so a test referencing a not-yet-existing export FAILS at build with TS2339/TS2554 — that build error *is* the RED signal for new-export cycles).

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `/Users/wolf/sources/mcp-design-comparison/src/compare.ts` | Modify | `localizeDiff` + `DiffBounds`/`HeatGrid` types; `normalizeDensity`, `checkSvgRenderCost`, `checkSvgIntrinsicSize`, `isSvgPath`; SVG branch in `loadPNG`; intrinsic-size guard in `probeDimensions`; `localize` + `svgDensity` params and wiring in `compareScreenshots`; guarding comment at the pixelmatch call. |
| `/Users/wolf/sources/mcp-design-comparison/src/index.ts` | Modify | `VERSION` 0.7.0; three new `inputSchema` params; handler arg plumbing; `max_difference_percentage` validation + gate; `Diff bounds:`/heat text lines; re-export `localizeDiff`, `normalizeDensity` and the new types. |
| `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts` | Modify | New fixture helpers (`createQuadrantPair`, `createTestSVG` + inline SVG constants), new `describe` blocks per feature, version assertion updated to 0.7.0. |
| `/Users/wolf/sources/mcp-design-comparison/package.json` | Modify | `version: "0.7.0"`. |
| `/Users/wolf/sources/mcp-design-comparison/README.md` | Modify | Document SVG support and the three new params (README documents every param at lines 52-59, so it must be updated). |
| `/Users/wolf/sources/mcp-design-comparison/test-fixtures/` | No committed additions | All fixtures generated in-test and unlinked (only `not-a-png.txt` stays committed). No golden rasters. |

---

## Task 1 — Assertion gate (`max_difference_percentage`, Feature 3)

**Files:**
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.ts` (schema at lines 66-118; handler args at lines 138-155; result assembly at lines 210-226)
- Test: `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts`

**Interfaces:**
- Consumes: `compareScreenshots` (unchanged in this task, `src/compare.ts:210`), `errorResponse(text)` (`src/index.ts:39-44`), the existing `content` array assembly (`src/index.ts:210-226`).
- Produces: handler behavior only — `max_difference_percentage?: unknown` arg, fail-loud validation message `max_difference_percentage must be a non-negative, finite number`, gate-trip text `Difference <pct>% exceeds max_difference_percentage <max>%` prepended to the full stats text. No new exports.

### Steps

- [ ] **1.1 Write failing tests.** Append to `src/index.test.ts` (after the `MCP request handling` describe, before EOF):

```ts
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
```

- [ ] **1.2 Run — expect RED.** `npm run build && npm test`. Build succeeds (`arguments` is `Record<string, unknown>`, so the extra key compiles). Expected: `# fail 3` — `trips with a distinct message naming both numbers (artifact kept, base64 mode)` (isError is `undefined`), `rejects invalid values (negative, NaN) before any comparison runs` (message is `Error comparing screenshots: File not found...`), `writes the diff file even when the gate trips (file mode)` (isError is `undefined`). The other three new tests are green-on-arrival regression guards; all pre-existing tests pass.

- [ ] **1.3 Implement — schema param.** In `src/index.ts`, inside `inputSchema.properties` (after the `ignore_regions` entry ending at line 115, before `},` closing `properties`):

```ts
            max_difference_percentage: {
              type: "number",
              description:
                "If set and the difference percentage exceeds it, the call returns an error (isError: true). Use as a CI gate against a golden image. Omit for report-only.",
            },
```

- [ ] **1.4 Implement — handler validation + gate.** In `src/index.ts` `handleCallToolRequest`:

Add to the `args` cast (after `ignore_regions?: unknown;`, line 145):

```ts
      max_difference_percentage?: unknown;
```

Add to the destructure (after `ignore_regions,`, line 154):

```ts
      max_difference_percentage,
```

Immediately after the required-paths check (after line 158's closing `}`), add fail-loud validation — before any decode:

```ts
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
```

Replace the final `return { content };` (line 226) with the gate. It runs after `compareScreenshots` returned (diff already written in file mode) and after `content` is assembled (base64 image item already present), so the artifact survives the trip:

```ts
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
```

- [ ] **1.5 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0`, all tests pass including the 6 new ones.

- [ ] **1.6 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/index.ts src/index.test.ts && git commit -m "feat: max_difference_percentage assertion gate (CI companion)"
```

---

## Task 2 — Diff localization (`localizeDiff` + `localize`, Feature 2)

**Files:**
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/compare.ts` (`CompareResult` at lines 19-35; pixelmatch call at lines 282-289; `compareScreenshots` signature at lines 210-218; value assembly at lines 300-311)
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.ts` (re-exports at lines 17-24; schema; handler; text builder at lines 187-208)
- Test: `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts`

**Interfaces:**
- Consumes: pixelmatch diff buffer (`diff.data`), the `mask` from `buildMask` (`src/compare.ts:266-270`), `CompareResult`.
- Produces (later tasks and index.ts rely on these exact shapes):

```ts
export interface DiffBounds { x: number; y: number; width: number; height: number }
export interface HeatGrid { rows: number; cols: number; cells: number[] }
export function localizeDiff(
  diffData: Buffer,
  width: number,
  height: number,
  mask: Uint8Array,
  rows?: number, // default 3
  cols?: number  // default 3
): { diffBounds: DiffBounds | null; heatGrid: HeatGrid };
// CompareResult gains: diffBounds?: DiffBounds | null; heatGrid?: HeatGrid;
// compareScreenshots gains 8th param: localize: boolean = true
```

### Cycle 1 — `localizeDiff` in compare.ts

- [ ] **2.1 Write failing tests.** Append to `src/index.test.ts`. First add the shared fixture helper next to `createTruncatedPNG` (after line 58):

```ts
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
```

Then append the describe block at EOF:

```ts
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
```

- [ ] **2.2 Run — expect RED (build error).** `npm run build`. Expected: `error TS2339: Property 'localizeDiff' does not exist on type ...` (the `./index.js` module type) and `error TS2554: Expected 2-7 arguments, but got 8` for the `compareScreenshots(..., [], true)` calls. That build failure is the RED signal — do not run `npm test` yet.

- [ ] **2.3 Implement — `localizeDiff` in `src/compare.ts`.** Insert after `computeSSIM` (after line 208), before `compareScreenshots`:

```ts
export interface DiffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeatGrid {
  rows: number;
  cols: number;
  /** Row-major, per-cell % of that cell's unmasked pixels (0–100). */
  cells: number[];
}

/**
 * Locate pixelmatch differences: bounding box + coarse heat grid, in one
 * O(W·H) pass over the diff buffer. A pixel counts as changed ⇔ its diff pixel
 * equals pixelmatch's red marker (255, 0, 0, 255) — anti-aliased pixels
 * (yellow) and unchanged pixels (grayscale) are excluded, so the population is
 * exactly `differentPixels`. Masked pixels are skipped from each cell's
 * denominator (and are painted grayscale, never red, so they cannot enter the
 * numerator). Cell boundaries sit at floor(W/cols) / floor(H/rows); the last
 * column/row absorbs the remainder, so every pixel is counted exactly once.
 * Pure — does not throw for valid inputs, so it returns a plain value rather
 * than a TryResult (mirrors computeSSIM).
 */
export function localizeDiff(
  diffData: Buffer,
  width: number,
  height: number,
  mask: Uint8Array,
  rows: number = 3,
  cols: number = 3
): { diffBounds: DiffBounds | null; heatGrid: HeatGrid } {
  // Math.max(1, ...) keeps the index math valid when the image is smaller than
  // the grid (floor would yield 0 and divide by zero).
  const cellW = Math.max(1, Math.floor(width / cols));
  const cellH = Math.max(1, Math.floor(height / rows));

  const diffCounts = new Array<number>(rows * cols).fill(0);
  const unmaskedCounts = new Array<number>(rows * cols).fill(0);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const gridRow = Math.min(rows - 1, Math.floor(y / cellH));
    for (let x = 0; x < width; x++) {
      const k = rowBase + x;
      if (mask[k]) {
        continue; // masked: excluded from both numerator and denominator
      }
      const cell = gridRow * cols + Math.min(cols - 1, Math.floor(x / cellW));
      unmaskedCounts[cell]++;
      const idx = k << 2;
      if (
        diffData[idx] === 255 &&
        diffData[idx + 1] === 0 &&
        diffData[idx + 2] === 0 &&
        diffData[idx + 3] === 255
      ) {
        diffCounts[cell]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const diffBounds: DiffBounds | null =
    maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const cells = diffCounts.map((count, i) =>
    unmaskedCounts[i] > 0 ? (count / unmaskedCounts[i]) * 100 : 0
  );
  return { diffBounds, heatGrid: { rows, cols, cells } };
}
```

- [ ] **2.4 Implement — wire into `CompareResult` and `compareScreenshots`.** In `src/compare.ts`:

Add to `CompareResult` (after the `resized` field, before the closing `}` at line 35):

```ts
  /** Bounding box of differing pixels in design space; null = zero differing pixels. Omitted when localize=false. */
  diffBounds?: DiffBounds | null;
  /** Coarse per-cell diff heat grid. Zero diffs → all-zero cells. Omitted when localize=false. */
  heatGrid?: HeatGrid;
```

Add the 8th parameter to `compareScreenshots` (after `ignoreRegions: IgnoreRegion[] = []` at line 217):

```ts
  ignoreRegions: IgnoreRegion[] = [],
  localize: boolean = true
```

Add the guarding comment directly above the pixelmatch call (line 282):

```ts
    // localizeDiff keys on pixelmatch's default red marker (255, 0, 0, 255).
    // That invariant holds only while this call never passes diffColor,
    // diffColorAlt, or diffMask — do not add those options without updating
    // localizeDiff.
    const differentPixels = pixelmatch(
```

Wire the pass into the value assembly, after the `if (resized) { ... }` block (line 309-311), before the `if (outputDiffPath)` block:

```ts
    if (localize) {
      const localization = localizeDiff(diff.data, design.width, design.height, mask);
      value.diffBounds = localization.diffBounds;
      value.heatGrid = localization.heatGrid;
    }
```

- [ ] **2.5 Implement — re-export from `src/index.ts`.** Extend the re-export block (lines 17-24):

```ts
export {
  loadPNG,
  compareScreenshots,
  computeSSIM,
  buildMask,
  normalizeThreshold,
  localizeDiff,
} from "./compare.js";
export type {
  CompareResult,
  ResizeFit,
  IgnoreRegion,
  TryResult,
  DiffBounds,
  HeatGrid,
} from "./compare.js";
```

- [ ] **2.6 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0` — all 10 new localization tests pass, no existing test regresses (existing tests never `deepStrictEqual` a whole `CompareResult`, so the additive fields are safe).

- [ ] **2.7 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/compare.ts src/index.ts src/index.test.ts && git commit -m "feat: localizeDiff — diff bounding box + 3x3 heat grid keyed on the red marker"
```

### Cycle 2 — `localize` param + text lines in index.ts

- [ ] **2.8 Write failing tests.** Append inside the `diff localization` describe (or as a new sibling describe `diff localization text output`):

```ts
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
```

- [ ] **2.9 Run — expect RED.** `npm run build && npm test`. Build succeeds. Expected: `# fail 2` — `appends Diff bounds and heat lines when diffs exist` (no such text yet) and `exposes localize in the tool schema` (`schema.localize` undefined). The two negative-assertion tests are green-on-arrival guards.

- [ ] **2.10 Implement — index.ts.** Schema (after the `max_difference_percentage` entry from Task 1):

```ts
            localize: {
              type: "boolean",
              description:
                "If true (default), include a diff bounding box and a coarse per-cell heat grid in the result, showing where differences cluster. Set false to skip the extra pass.",
              default: true,
            },
```

Args cast: add `localize?: boolean;`. Destructure: add `localize = true,`. Pass as the 8th argument to `compareScreenshots`:

```ts
    const result = await compareScreenshots(
      design_path,
      implementation_path,
      output_diff_path,
      threshold,
      auto_resize,
      resizeFit,
      ignoreRegions,
      localize
    );
```

Text lines — insert after the `if (value.maskedPixels) { ... }` block (line 198-200), before the `if (value.resized)` note:

```ts
    // Bounds/heat lines only when localize is on AND diffs exist (diffBounds
    // non-null); zero-diff runs and localize=false print nothing extra.
    if (value.diffBounds && value.heatGrid) {
      responseText += `\nDiff bounds: x=${value.diffBounds.x} y=${value.diffBounds.y} w=${value.diffBounds.width} h=${value.diffBounds.height} (design space)\n`;
      responseText += `Heat (${value.heatGrid.rows}x${value.heatGrid.cols}, % diff):\n`;
      for (let row = 0; row < value.heatGrid.rows; row++) {
        const cells = value.heatGrid.cells.slice(
          row * value.heatGrid.cols,
          (row + 1) * value.heatGrid.cols
        );
        responseText += `  ${cells.map((v) => Math.round(v).toString().padStart(3, " ")).join(" ")}\n`;
      }
    }
```

- [ ] **2.11 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0`.

- [ ] **2.12 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/index.ts src/index.test.ts && git commit -m "feat: expose localize param and Diff bounds/heat text lines in handler"
```

---

## Task 3a — SVG rasterization primitives (`normalizeDensity` + `loadPNG` density branch)

**Files:**
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/compare.ts` (`loadPNG` at lines 75-109; `probeDimensions` at lines 114-126)
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.ts` (re-exports)
- Test: `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts`

**Interfaces:**
- Consumes: `fail()` factory (`src/compare.ts:39-41`), `Try` from `@power-rent/try-catch`, sharp.
- Produces (Task 3b depends on these exact signatures):

```ts
export function normalizeDensity(d: unknown): TryResult<number>; // undefined → 288
export async function loadPNG(
  filePath: string,
  resizeTo?: { width: number; height: number; fit: ResizeFit },
  svgDensity?: number // applied only when filePath ends with .svg
): Promise<TryResult<PNG>>;
// module-private, used by Task 3b:
// isSvgPath(filePath: string): boolean
// checkSvgRenderCost(intrinsicWidth, intrinsicHeight, density, filePath): TryResult<void>
// probeDimensions: now fails loud when metadata yields no width/height
```

### Steps

- [ ] **3a.1 Write failing tests.** Add SVG fixture constants + helper to `src/index.test.ts` (after `createQuadrantPair`):

```ts
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
```

Append the describe block at EOF:

```ts
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
```

- [ ] **3a.2 Run — expect RED (build error).** `npm run build`. Expected: `error TS2339: Property 'normalizeDensity' does not exist ...` and `error TS2554: Expected 1-2 arguments, but got 3` on the `loadPNG(..., 288)` calls.

- [ ] **3a.3 Implement — compare.ts.** Insert after `normalizeThreshold` (after line 57):

```ts
// SVG rendering cost ceiling: refuse renders past 8192x8192 output pixels so a
// huge viewBox x density combination fails loud instead of attempting the
// render (and hitting sharp's opaque limitInputPixels failure).
const MAX_SVG_OUTPUT_PIXELS = 8192 * 8192;

// SVG inputs are detected by file extension only; content errors surface from
// sharp as "Unsupported image format" with the underlying cause.
function isSvgPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".svg");
}

/**
 * Validate svg_density: undefined → default 288 (renders a 36x36 icon at
 * 144x144); anything else must be a positive, finite number. Fail-loud
 * (TryResult), matching the ignore_regions convention — never let sharp throw
 * an opaque error over a bad density.
 */
export function normalizeDensity(d: unknown): TryResult<number> {
  if (d === undefined) {
    return { success: true, value: 288 };
  }
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
    return fail("svg_density must be a positive, finite number");
  }
  return { success: true, value: d };
}

// Bounds-check the raster a density would produce for an SVG's intrinsic size,
// so unbounded-cost renders fail loud before sharp attempts them.
function checkSvgRenderCost(
  intrinsicWidth: number,
  intrinsicHeight: number,
  density: number,
  filePath: string
): TryResult<void> {
  const outWidth = Math.ceil((intrinsicWidth * density) / 72);
  const outHeight = Math.ceil((intrinsicHeight * density) / 72);
  if (outWidth * outHeight > MAX_SVG_OUTPUT_PIXELS) {
    return fail(
      `svg_density too high: rendering ${filePath} at ${density} dpi would produce ${outWidth}x${outHeight} pixels (limit ${MAX_SVG_OUTPUT_PIXELS})`
    );
  }
  return { success: true, value: undefined };
}
```

Change `loadPNG`'s signature and pipeline construction (lines 75-99):

```ts
export async function loadPNG(
  filePath: string,
  resizeTo?: { width: number; height: number; fit: ResizeFit },
  svgDensity?: number
): Promise<TryResult<PNG>> {
  const exists = await checkExists(filePath);
  if (!exists.success) {
    return exists;
  }

  // Decode (and optional resize) in one pass; capturing the real error here is
  // what distinguishes a genuine format problem from a swallowed cause.
  const decoded = await new Try(() => {
    // SVG branch: density is a sharp *constructor* option (not chainable) that
    // sets the librsvg rasterization DPI — output pixels = intrinsic size x
    // (density / 72). The rest of the pipeline is shared with rasters.
    const density = isSvgPath(filePath) ? svgDensity : undefined;
    let pipeline = (
      density !== undefined ? sharp(filePath, { density }) : sharp(filePath)
    ).ensureAlpha(); // RGBA
    if (resizeTo) {
      // `fit` controls scaling when reconciling dimensions:
      //   contain — preserve aspect, letterbox the remainder (transparent pad)
      //   fill    — stretch to exact dims, ignoring aspect
      //   cover   — preserve aspect, crop the overflow
      pipeline = pipeline.resize(resizeTo.width, resizeTo.height, {
        fit: resizeTo.fit,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }
    return pipeline.raw().toBuffer({ resolveWithObject: true });
  }).result();
```

(the rest of `loadPNG` is unchanged).

Harden `probeDimensions`' return (replace line 125's non-null assertions):

```ts
  const { width, height } = meta.value;
  if (!width || !height) {
    return fail(`Unsupported image format: ${filePath} (no derivable intrinsic size)`);
  }
  return { success: true, value: { width, height } };
```

- [ ] **3a.4 Implement — re-export.** In `src/index.ts`, add `normalizeDensity,` to the value re-export block from step 2.5.

- [ ] **3a.5 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0` — 5 new tests pass, no regressions (`loadPNG` with no `svgDensity` behaves exactly as before, including for `.svg` paths).

- [ ] **3a.6 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/compare.ts src/index.ts src/index.test.ts && git commit -m "feat: SVG rasterization primitives — normalizeDensity + loadPNG density branch"
```

---

## Task 3b — SVG wiring in `compareScreenshots` + handler/schema

**Files:**
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/compare.ts` (`compareScreenshots` at lines 210-321)
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.ts` (schema, handler)
- Test: `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts`

**Interfaces:**
- Consumes: `normalizeDensity`, `isSvgPath`, `checkSvgRenderCost`, `loadPNG(filePath, resizeTo?, svgDensity?)`, hardened `probeDimensions` (all from Task 3a); `localizeDiff` wiring (Task 2).
- Produces (final signature; Task 4 and callers rely on it):

```ts
export async function compareScreenshots(
  designPath: string,
  implementationPath: string,
  outputDiffPath?: string,
  threshold: unknown = 0.1,
  autoResize: boolean = true,
  resizeFit: ResizeFit = "contain",
  ignoreRegions: IgnoreRegion[] = [],
  localize: boolean = true,
  svgDensity: unknown = undefined
): Promise<TryResult<CompareResult>>;
// module-private: checkSvgIntrinsicSize(filePath): Promise<TryResult<void>>
```

### Cycle 1 — compareScreenshots SVG semantics

- [ ] **3b.1 Write failing tests.** Append at EOF of `src/index.test.ts`:

```ts
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
});
```

- [ ] **3b.2 Run — expect RED (build error).** `npm run build`. Expected: `error TS2554: Expected 2-8 arguments, but got 9` on the `compareScreenshots(..., true, 72)`-style calls; the 2-8-arg SVG tests compile but would fail at runtime (e.g. `totalPixels` 36·36 instead of 144·144 because sharp decodes the SVG at librsvg's 72 dpi default with no density plumbing). The build error is the RED gate.

- [ ] **3b.3 Implement — `checkSvgIntrinsicSize` in `src/compare.ts`.** Insert after `checkSvgRenderCost`:

```ts
// Intrinsic-size pre-check for SVG inputs. librsvg's behaviour for a root
// <svg> with neither width/height nor viewBox varies across versions (some
// throw in metadata(), some invent a default viewport), so the
// no-derivable-size case is detected deterministically here — and this check
// must run BEFORE probeDimensions on every SVG path, so the clear
// "no derivable intrinsic size" cause wins regardless of librsvg behaviour.
// Presence-only check: value interpretation (px/pt/mm/%) defers to librsvg.
// Non-SVG bytes pass through so sharp reports the real decode error with its
// cause; a missing file keeps the "File not found" convention via checkExists.
async function checkSvgIntrinsicSize(filePath: string): Promise<TryResult<void>> {
  const exists = await checkExists(filePath);
  if (!exists.success) {
    return exists;
  }
  const read = await new Try(() => fs.readFile(filePath, "utf8")).result();
  if (!read.success) {
    return fail(`Unsupported image format: ${filePath} (${read.error.message})`);
  }
  const rootTag = /<svg\b[^>]*>/i.exec(read.value);
  if (!rootTag) {
    return { success: true, value: undefined }; // not an SVG root — let sharp report it
  }
  const hasWidthHeight =
    /\bwidth\s*=/i.test(rootTag[0]) && /\bheight\s*=/i.test(rootTag[0]);
  const hasViewBox = /\bviewBox\s*=/i.test(rootTag[0]);
  if (!hasWidthHeight && !hasViewBox) {
    return fail(
      `Unsupported image format: ${filePath} (SVG has no derivable intrinsic size: no width/height attributes and no viewBox)`
    );
  }
  return { success: true, value: undefined };
}
```

- [ ] **3b.4 Implement — `compareScreenshots` wiring.** In `src/compare.ts`, change the signature (append the 9th param after `localize: boolean = true`):

```ts
  localize: boolean = true,
  svgDensity: unknown = undefined
```

At the top of the body, after `const normThreshold = normalizeThreshold(threshold);` (line 219):

```ts
  // Density is validated up front (even for raster-only calls) so a malformed
  // svg_density always fails loud instead of depending on the input mix.
  const densityR = normalizeDensity(svgDensity);
  if (!densityR.success) {
    return densityR;
  }
  const density = densityR.value;
```

Replace the design load (lines 221-227) with:

```ts
  // The design is the reference — always decoded in full at its native size.
  // For an SVG design, "native size" is intrinsic x (density / 72): the render
  // density defines the reference (design-space) dimensions, in which
  // diffBounds, heatGrid, and ignore_regions are all expressed.
  const designIsSvg = isSvgPath(designPath);
  if (designIsSvg) {
    // Intrinsic-size pre-check runs FIRST: on some librsvg builds metadata()
    // throws for a dimensionless SVG, and the probe would then emit a generic
    // format error instead of the "no derivable intrinsic size" cause.
    const intrinsic = await checkSvgIntrinsicSize(designPath);
    if (!intrinsic.success) {
      return intrinsic;
    }
    const designProbe = await probeDimensions(designPath); // intrinsic, 72 dpi metadata
    if (!designProbe.success) {
      return designProbe;
    }
    const cost = checkSvgRenderCost(
      designProbe.value.width,
      designProbe.value.height,
      density,
      designPath
    );
    if (!cost.success) {
      return cost;
    }
  }
  const designR = await loadPNG(designPath, undefined, designIsSvg ? density : undefined);
  if (!designR.success) {
    return designR;
  }
  const design = designR.value;
```

Before the implementation probe (lines 231-235), add the impl-side intrinsic check — like the design path, it must precede `probeDimensions` so the "no derivable intrinsic size" cause wins even on librsvg builds whose `metadata()` throws for dimensionless SVGs:

```ts
  const implIsSvg = isSvgPath(implementationPath);
  if (implIsSvg) {
    const intrinsic = await checkSvgIntrinsicSize(implementationPath);
    if (!intrinsic.success) {
      return intrinsic;
    }
  }
```

(The probe itself is unchanged — an SVG impl probes at its intrinsic size, 72 dpi plain metadata; the `auto_resize: false` mismatch check and `resized.fromWidth/fromHeight` therefore stay intrinsic-based, exactly like rasters.)

Replace the `resizeTo` derivation (lines 254-256) with:

```ts
  // Derive the resize target from the (single) resized record so the two never
  // drift apart. An SVG impl always renders to the design dims — even when its
  // intrinsic dims already match — by rendering at an effective density >= the
  // target and letting the existing resize path scale DOWN (never render small
  // then upscale).
  const resizeTo = resized
    ? { width: resized.toWidth, height: resized.toHeight, fit: resized.fit }
    : implIsSvg
      ? { width: design.width, height: design.height, fit: resizeFit }
      : undefined;

  let implDensity: number | undefined;
  if (implIsSvg && resizeTo) {
    // svg_density is a floor/override, not the sole knob: the ceil() term
    // guarantees the vector render is never smaller than the target.
    const effectiveDensity = Math.max(
      density,
      Math.ceil(
        72 * Math.max(resizeTo.width / implWidth, resizeTo.height / implHeight)
      )
    );
    const cost = checkSvgRenderCost(implWidth, implHeight, effectiveDensity, implementationPath);
    if (!cost.success) {
      return cost;
    }
    implDensity = effectiveDensity;
  }

  const implR = await loadPNG(implementationPath, resizeTo, implDensity);
```

- [ ] **3b.5 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0` — all 11 new SVG tests pass, no regressions.

- [ ] **3b.6 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/compare.ts src/index.test.ts && git commit -m "feat: SVG inputs in compareScreenshots — density floor, intrinsic probe, cost bounds"
```

### Cycle 2 — `svg_density` in schema/handler

- [ ] **3b.7 Write failing tests.** Append at EOF:

```ts
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
```

- [ ] **3b.8 Run — expect RED.** `npm run build && npm test`. Build succeeds (`arguments` keys are untyped). Expected: `# fail 3` — schema key missing, `Total Pixels: 20,736` instead of `5,184` (density not passed → default 288), and success instead of isError for `svg_density: 0` (param ignored).

- [ ] **3b.9 Implement — index.ts.** Schema (after the `localize` entry):

```ts
            svg_density: {
              type: "number",
              description:
                "Rasterization density (DPI) for SVG inputs. Higher = crisper vector render before comparison. Default 288 (4x the 72dpi baseline). Aimed at small assets (icons/logos); lower it for large vector art.",
              default: 288,
            },
```

Args cast: add `svg_density?: unknown;`. Destructure: add `svg_density,`. Pass as the 9th argument:

```ts
    const result = await compareScreenshots(
      design_path,
      implementation_path,
      output_diff_path,
      threshold,
      auto_resize,
      resizeFit,
      ignoreRegions,
      localize,
      svg_density
    );
```

(Invalid density flows out of `compareScreenshots` as a failure → the existing `Error comparing screenshots: ${message}` `errorResponse` — the ignore_regions convention.)

- [ ] **3b.10 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0`.

- [ ] **3b.11 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add src/index.ts src/index.test.ts && git commit -m "feat: expose svg_density param in tool schema and handler"
```

---

## Task 4 — Integration, version bump, docs

**Files:**
- Modify: `/Users/wolf/sources/mcp-design-comparison/package.json` (line 3)
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.ts` (line 26; tool + path-param descriptions at lines 64-76)
- Modify: `/Users/wolf/sources/mcp-design-comparison/src/index.test.ts` (line 531; schema test at lines 534-540)
- Modify: `/Users/wolf/sources/mcp-design-comparison/README.md` (lines 3, 7, 52-59, 105, 135)

**Interfaces:**
- Consumes: everything from Tasks 1-3b.
- Produces: `VERSION = "0.7.0"` surfaced via `handleListToolsRequest().version` and the MCP `serverInfo`; complete `inputSchema`; updated docs.

### Steps

- [ ] **4.1 Write failing tests.** In `src/index.test.ts`, change line 531 from

```ts
    assert.strictEqual(result.version, "0.6.0");
```

to

```ts
    assert.strictEqual(result.version, "0.7.0");
```

and extend the existing schema test (`exposes resize_fit and ignore_regions in the tool schema`, lines 534-540) with the three new params:

```ts
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
```

- [ ] **4.2 Run — expect RED.** `npm run build && npm test`. Expected: `# fail 1` — `should list compare_design tool` (`'0.6.0' !== '0.7.0'`). The extended schema test passes (params already added in Tasks 1-3b) — it is the integration guard.

- [ ] **4.3 Implement — version bump.** `package.json` line 3: `"version": "0.7.0",`. `src/index.ts` line 26: `const VERSION = "0.7.0";`.

- [ ] **4.4 Implement — schema descriptions mention SVG.** In `src/index.ts`, update the tool description (line 64-65) to:

```ts
        description:
          "Compare a design screenshot with an implementation screenshot using pixelmatch and SSIM. Supports PNG, JPEG, WebP, GIF, TIFF, and SVG inputs (SVGs are rasterized at svg_density). Returns the number and percentage of different pixels, a structural-similarity (SSIM) score, a diff bounding box and heat grid showing where differences cluster, and optionally outputs a diff image highlighting the differences.",
```

and the two path params (lines 69-76):

```ts
            design_path: {
              type: "string",
              description: "Path to the design screenshot (supports PNG, JPEG, WebP, GIF, TIFF, SVG)",
            },
            implementation_path: {
              type: "string",
              description: "Path to the implementation screenshot (supports PNG, JPEG, WebP, GIF, TIFF, SVG)",
            },
```

- [ ] **4.5 Run — expect GREEN.** `npm run build && npm test`. Expected: `# fail 0` — full suite green.

- [ ] **4.6 Update README.** The README documents every param (lines 52-59), so it must cover the new surface:

Line 3 (intro): change `Supports multiple image formats including PNG, JPEG, WebP, GIF, and TIFF.` to `Supports multiple image formats including PNG, JPEG, WebP, GIF, TIFF, and SVG (rasterized via librsvg).`

Features list (after the `Ignore Regions` bullet at line 11), add:

```markdown
- **Vector (SVG) Input**: Compare a design PNG against an SVG icon (or SVG vs SVG) — SVGs are rasterized at a configurable density (`svg_density`, default 288 dpi) with no pre-render step
- **Diff Localization**: A diff bounding box and a 3x3 heat grid report *where* differences cluster, not just how many pixels differ
- **Assertion Gate**: Optional `max_difference_percentage` flips the result to an error when exceeded — a CI regression gate without parsing text
```

Parameters section (after the `ignore_regions` bullet at line 59), add:

```markdown
- `svg_density` (number, optional): Rasterization density (DPI) for SVG inputs. Higher = crisper vector render before comparison. Default 288 (4x the 72dpi baseline). Aimed at small assets (icons/logos); lower it for large vector art.
- `localize` (boolean, optional): If `true` (default), include a diff bounding box and a coarse 3x3 heat grid in the result, showing where differences cluster. Set `false` to skip the extra pass.
- `max_difference_percentage` (number, optional): If set and the difference percentage exceeds it (strictly greater), the call returns an error (`isError: true`) while still producing the diff artifact. Use as a CI gate against a golden image. Omit for report-only.
```

Returns section (line 61-66), add after the SSIM bullet:

```markdown
- Diff bounding box and 3x3 heat grid (when `localize` is on and differences exist)
```

Requirements (line 135): change `(PNG, JPEG, WebP, GIF, or TIFF)` to `(PNG, JPEG, WebP, GIF, TIFF, or SVG)`.

- [ ] **4.7 Final verification.** `npm run build && npm test` (expect `# fail 0`), then `npm run test:coverage` for a sanity look at coverage of the new branches. Confirm `test-fixtures/` contains only `not-a-png.txt` afterwards (`ls test-fixtures/`).

- [ ] **4.8 Commit.**

```bash
cd /Users/wolf/sources/mcp-design-comparison && git add package.json src/index.ts src/index.test.ts README.md && git commit -m "chore: v0.7.0 — version, schema descriptions, and docs for vector input & diff localization"
```

---

## Self-review (spec coverage / placeholder scan / type consistency)

- **Spec coverage:** Feature 1 (SVG input) → Tasks 3a+3b, including density default/floor formula, intrinsic probe at 72 dpi, `auto_resize:false` intrinsic mismatch, resized reporting, no-intrinsic-size fail-loud, viewBox resolution, non-SVG bytes, cost bounds, monotonicity, coordinate-space note. Feature 2 (localization) → Task 2, including red-marker rule + guarding comment, mask-aware denominators, floor partition/remainder, null-vs-omitted semantics, text lines, all listed invariants. Feature 3 (gate) → Task 1, including boundary, distinct message, validation, artifact survival in both output modes. Versioning/schema/docs → Task 4. Transparency semantics (spec "Semantics & edge cases") have no dedicated test in the spec's own Testing list, so none is added — behaviour falls out of the unchanged pixelmatch alpha handling.
- **Placeholder scan:** none — every test and implementation step carries full code; every run step names `npm run build && npm test` with its expected outcome.
- **Type consistency:** `localizeDiff(diffData: Buffer, width, height, mask: Uint8Array, rows?=3, cols?=3)` is defined in Task 2 and consumed unchanged in 3b/4; `normalizeDensity(d: unknown): TryResult<number>` and `loadPNG(filePath, resizeTo?, svgDensity?)` defined in 3a, consumed in 3b; final `compareScreenshots` param order is `(designPath, implementationPath, outputDiffPath?, threshold, autoResize, resizeFit, ignoreRegions, localize, svgDensity)` — Task 2 adds `localize` as the 8th parameter and Task 3b appends `svgDensity` as the 9th, so no earlier call site is rewritten.
