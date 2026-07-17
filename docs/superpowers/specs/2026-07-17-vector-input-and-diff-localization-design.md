# Vector Input & Diff Localization — v0.7.0 Design

Date: 2026-07-17
Status: Proposed

## Goal

Make `compare_design` useful for **iterative asset matching**, not just
pass/fail regression of two same-basis rasters. Two concrete gaps block that
workflow today:

1. **No vector input.** Comparing a design PNG against an SVG icon requires the
   caller to pre-rasterize the SVG (`rsvg-convert`/`sips`) at the right size and
   background before calling the tool. Every icon/logo comparison starts with an
   out-of-band render step.
2. **"How much", never "where".** The tool returns Different Pixels, Difference
   %, and SSIM. To learn *what* is wrong (handset mispositioned top-left, colour
   ring around the badge, envelope flap differs) the agent must open the diff
   image and read it by eye. The number alone can't drive a fix.

Motivating case: replacing three 36×36 header contact PNGs (WhatsApp/mail/phone)
with hand-authored SVGs. The SVGs rendered but didn't match — wrong green,
mispositioned glyph, line-art vs solid. `compare_design` was the natural tool,
but raster-vs-vector isn't comparable without a manual render, and a bare
"34% different" wouldn't have said the handset was in the wrong corner. The fix
came from rendering both sides and eyeballing. This proposal folds both of those
manual steps into the tool.

## Non-goals

- Perceptual/semantic "same icon, different style" judgement — pixelmatch + SSIM
  stay the engine; this is about *inputs* and *reporting the existing diff*.
- Custom diff highlight colours, animation, or side-by-side compositing.

## Features

### 1. Vector (SVG) input on either side

Accept `.svg` for `design_path` and/or `implementation_path`. `sharp` already
decodes SVG via librsvg (it is a current dependency), so no new dep — in fact,
because `loadPNG` does no format gating, sharp already decodes `.svg` today, at
librsvg's 72 dpi default. This feature makes the render density explicit and
correct for icon-scale work (see Versioning for the behavioural consequence).

Rasterization rule — **render at the comparison target dimensions, not at the
SVG's intrinsic size then upscale**, to avoid blur:

- If the SVG is the *design* (reference, native-size side): render at
  `svg_density` dpi, and that raster becomes the reference dimensions.
  Reference dims = intrinsic size × (`svg_density` / 72); e.g. a 36×36 SVG at
  the default 288 renders — and is compared — at 144×144.
- If the SVG is the *implementation* (resized to design dims): render at an
  effective density of
  `max(svg_density, ceil(72 × max(targetW / intrinsicW, targetH / intrinsicH)))`,
  then let the existing resize path (`resize_fit`) scale **down** to the
  design's `width × height`. `svg_density` is a floor/override, not the sole
  knob: the formula guarantees the vector render is never smaller than the
  target and then upscaled.

New optional param to control raster fidelity:

```
svg_density: {
  type: "number",
  description:
    "Rasterization density (DPI) for SVG inputs. Higher = crisper vector render before comparison. Default 288 (4x the 72dpi baseline).",
  default: 288,
}
```

Rationale: 288 dpi renders a 36×36 SVG at 144×144 natively — matches the
inspection scale used when matching small icons, and avoids the
render-small-then-upscale blur that would inflate the diff against a clean PNG.

`resize_fit` and `auto_resize` semantics are unchanged; SVG simply feeds the
same resize path with a vector source. Validation: `svg_density` passes through
a `normalizeDensity` step that fails loud (`isError`) on non-number, `NaN`, or
≤ 0 — matching the v0.6.0 `ignore_regions` convention — rather than letting
sharp throw an opaque "Unsupported image format". It is also bounds-checked
against unbounded cost: a density (or resulting output pixel count) past a sane
limit fails loud instead of attempting a huge-viewBox × 288 dpi render (see
Risks).

Semantics & edge cases:

- **Coordinate space.** For an SVG design, "design-space" is the rendered
  raster: intrinsic size × (`svg_density` / 72). `diffBounds` and `heatGrid`
  coordinates are reported in this rendered-pixel space, and `ignore_regions`
  are interpreted in it too — a caller masking a 36×36 SVG design at density
  288 expresses regions in 144-space. For a raster design, design-space is its
  native pixel dims, unchanged.
- **Raster impl smaller than SVG reference.** When the design is an SVG and the
  implementation is a smaller raster, the raster is upscaled to the reference
  dims. That upscale blur can inflate the diff; callers should match sizes or
  lower `svg_density` if it does.
- **Intrinsic size resolution.** Intrinsic dims come from, in order: px
  `width`/`height` attributes → `viewBox` dimensions → fail loud through the
  existing "Unsupported image format"-style error path with a clear cause (no
  derivable intrinsic size). Percent and non-px units (pt/mm) defer to
  librsvg's interpretation.
- **Transparency / background.** SVGs render on a transparent RGBA canvas; no
  flatten is applied. pixelmatch's alpha handling governs the comparison, so a
  transparent SVG pixel against an opaque design pixel counts as a difference —
  transparent-vs-opaque backgrounds can dominate diff % and the heat grid;
  callers comparing an unflattened icon against an opaque mock should expect
  this. The `resize_fit: "contain"` letterbox background for an SVG impl
  matches whatever the existing raster resize path produces (defer to current
  behaviour). A configurable flatten/background is future work (see Out of
  scope).

### 2. Diff localization summary

After `pixelmatch` fills the diff buffer, do one extra pass over `diff.data` to
report **where** the differences are, so the agent gets structure without
reading the image:

- **Bounding box** of changed pixels: `{ x, y, width, height }` in design-space
  (rendered-pixel space when the design is an SVG), or `null` when there are
  zero differing pixels.
- **Coarse heat grid**: divide the frame into an `N×N` grid (default 3×3) and
  report the per-cell difference %, so "concentrated top-left" is a number, not
  an eyeball call.

Detection rule — what counts as "changed". pixelmatch paints the diff buffer
with three pixel classes: unchanged pixels as grayscale, counted differences as
the red marker `(255, 0, 0, 255)`, and anti-aliased pixels as yellow
`(255, 255, 0)`. A naive "non-zero/changed pixel" scan would count the AA
yellow pixels and inflate the bbox and heat grid relative to `differentPixels`.
The rule is therefore explicit: **a pixel is changed ⇔ its `diff.data` pixel
equals the red marker `(255, 0, 0, 255)`**. Consequences:

- The localization pass is 1:1 with `differentPixels`, so bbox and heat use the
  same population as the existing `differencePercentage` numerator.
- Masked (`ignore_regions`) pixels are auto-excluded: they are painted
  grayscale, never red — consistent with the percentage denominator.
- The rule depends on the repo never passing pixelmatch's `diffColor` /
  `diffColorAlt` / `diffMask` options. A guarding comment at the pixelmatch
  call plus a test asserting red-pixel count === `differentPixels` pin this
  invariant.

New optional param:

```
localize: {
  type: "boolean",
  description:
    "If true (default), include a diff bounding box and a coarse per-cell heat grid in the result, showing where differences cluster. Set false to skip the extra pass.",
  default: true,
}
```

Both are computed from the diff buffer already in hand — single O(W·H) pass, no
new decode.

Heat grid semantics:

- Per-cell difference % denominator = the count of **unmasked** pixels in that
  cell, accumulated in the same single pass using the mask array. A
  fully-masked cell (denominator 0) reports 0%, matching the existing
  `totalPixels === 0 → 0` convention. Cell values are in [0, 100].
- Partitioning for non-divisible dimensions: cell boundaries at
  `floor(W / cols)` / `floor(H / rows)`, with the last column/row absorbing the
  remainder, so every pixel is counted exactly once.

### 3. Assertion gate (CI companion)

Optional hard threshold that flips the result to an error, so the same tool
works as a regression gate in a script/CI without the caller parsing text:

```
max_difference_percentage: {
  type: "number",
  description:
    "If set and the difference percentage exceeds it, the call returns an error (isError: true). Use as a CI gate against a golden image. Omit for report-only.",
}
```

Report-only remains the default (param omitted → today's behaviour unchanged).

Semantics:

- The gate lives in `src/index.ts`, applied **after** `compareScreenshots`
  returns and after the diff image has been written to `output_diff_path`; in
  base64 output mode, `diffImageBase64` is likewise included in the gate-trip
  error result — the diff artifact survives a gate trip regardless of output
  mode.
- Boundary: strictly greater-than trips the gate; equality passes.
- On trip: `isError: true` with a distinct message format — no generic
  "Error comparing screenshots:" prefix — e.g.
  `Difference 12.34% exceeds max_difference_percentage 5%`, followed by the
  full stats and the bounds/heat localization lines, so a failing CI log
  carries the same diagnostics as a passing run.
- Validation: a non-finite or negative `max_difference_percentage` fails loud
  (`isError`), matching the v0.6.0 `ignore_regions` convention.

## Order of operations (delta from v0.6.0)

```
normalizeThreshold / normalizeDensity / validate max_difference_percentage
  ↓
load design  ──► if *.svg: rasterize at svg_density dpi (intrinsic × density/72 px)
  ↓
probe impl dims (header) ── svg impl: probe at intrinsic size (plain metadata)
  ↓
load impl  ──► if *.svg: render at effective density (≥ target size), then the
               existing resize path scales down to design W×H (resize_fit)
             else: existing raster resize path
  ↓
buildMask / applyMask                         (unchanged)
  ↓
pixelmatch → differentPixels                  (unchanged)
  ↓
computeSSIM                                    (unchanged)
  ↓
localize (if true): bbox + N×N heat grid from red diff pixels   ← new
  ↓
diff output (file or base64)                  (unchanged; precedes the gate)
  ↓
max_difference_percentage (if set): gate → isError on exceed    ← new, in index.ts
```

The probe is **not** skipped for an SVG implementation. In the current code the
probe is the single source of both the `auto_resize: false` mismatch error and
the `resized.fromWidth`/`fromHeight` record from which the resize target
derives, so an SVG impl is probed at its intrinsic size (72 dpi, plain
metadata); `svg_density` applies only in the render step. `auto_resize: false`
with an SVG impl compares the SVG's intrinsic dims against the design dims and
errors on mismatch, consistent with rasters.

## Result shape additions

Extend the success result; existing fields untouched.

```ts
interface CompareResult {
  // ...existing: totalPixels, differentPixels, differencePercentage,
  //    ssim, maskedPixels, resized, diffImageBase64
  /** Omitted when localize=false. null means zero differing pixels — nothing else. */
  diffBounds?: { x: number; y: number; width: number; height: number } | null;
  /** Omitted when localize=false. Zero diffs → all-zero cells, never null. */
  heatGrid?: {
    rows: number;
    cols: number;
    cells: number[]; // row-major, per-cell % of that cell's unmasked pixels (0–100)
  };
}
```

`diffBounds === null` carries exactly one meaning: zero differing pixels. With
`localize: false`, both `diffBounds` and `heatGrid` are omitted (not computed),
never null. With `localize: true` and zero diffs, `diffBounds` is `null` and
`heatGrid` is populated with all-zero cells.

Text response gains, when `localize` is on and diffs exist (`diffBounds`
non-null; a zero-diff run prints no bounds/heat lines):

```
Diff bounds: x=0 y=0 w=48 h=44 (design space)
Heat (3x3, % diff):
  31  4  0
   6  1  0
   0  0  0
```

That grid is what would have said "handset is top-left" for the phone icon
without opening the image.

## Module split impact

- `src/compare.ts`: branch `loadPNG` on the `.svg` file extension only. The SVG
  branch passes density to the `sharp` **constructor** —
  `sharp(path, { density })`; density is a constructor option, not chainable
  onto the existing pipeline — and then shares the existing
  resize/`ensureAlpha`/`raw` pipeline. Rasterization is thus a
  constructor-options branch inside `loadPNG`, not a standalone helper;
  `svg_density` threads `compareScreenshots` → `loadPNG` as an input option
  applied only on the SVG branch. Add `normalizeDensity` (fail-loud validation
  + cost bounds-check) and `localizeDiff(diffData, width, height, mask, grid)` →
  `{ diffBounds, heatGrid }` keyed on the red marker, with a guarding comment
  at the pixelmatch call. Keep the no-throw `TryResult` convention.
- `src/index.ts`: add the three params to `inputSchema`; append bounds/heat
  lines to the text builder; apply the `max_difference_percentage` gate after
  `compareScreenshots` returns and after the diff image is written, emitting
  the gate's distinct message format rather than the generic
  "Error comparing screenshots:"-prefixed `errorResponse`.

## MCP schema additions

`svg_density` (number, default 288 — `normalizeDensity` fails loud on invalid
values and bounds-checks unbounded cost), `localize` (boolean, default true),
`max_difference_percentage` (number, optional — fails loud on
non-finite/negative). No required-field changes. Raster-input calls with no
diffs are unchanged; raster calls with diffs gain the bounds/heat text lines;
SVG-input calls change behaviour (see Versioning). The `diffBounds`/`heatGrid`
result fields are added for all `localize: true` calls.

## Versioning

Minor bump **0.6.0 → 0.7.0**.

`loadPNG` does no format gating today, so sharp/librsvg already decodes `.svg`
inputs — at the 72 dpi default. With `svg_density` defaulting to 288, existing
SVG-input calls now render at higher density: their reference dimensions,
`differencePercentage`, and diff-image size change. This is a behaviour change,
scoped to SVG inputs only; raster-input calls are unaffected. Result fields are
additive and present for all `localize: true` calls (default); the text output
gains `Diff bounds:`/heat lines only for existing calls that have diffs —
zero-diff calls are unchanged in text.

The minor bump still fits: the release adds new capability, report-only
semantics are unchanged, and no API params are removed or repurposed — nothing
breaks a caller consuming the existing result.

## Testing

Target parity with existing coverage; `node --test`.

Fixture strategy: generate SVG fixtures in-test from inline string constants
and unlink them afterwards, mirroring the existing `createTestPNG` pattern
(only `not-a-png.txt` is committed). No committed golden raster — a PNG
rendered by local librsvg/vips is CI-flaky across platforms/versions.
Assertions are relational, not golden.

- SVG design + PNG impl; PNG design + SVG impl; SVG + SVG.
- Identical SVG on both sides → 0 differing pixels, `diffBounds: null` (zero
  red-marker pixels); exact reference dims = intrinsic × (density / 72)
  (e.g. 36×36 @ 288 → 144×144).
- `svg_density` monotonicity on an AA-heavy shape (circle/diagonal): higher
  density does not increase diff % against a clean reference, with tolerance.
- `localize`: known-offset glyph → bbox in the expected quadrant; heat mass
  concentrates in the expected cell; masked region excluded from bbox/heat.
- AA-edge localize: diagonal edge where `differentPixels` excludes anti-aliased
  pixels → bbox/heat exclude them too (red-marker rule).
- Invariants: red-pixel count === `differentPixels`; area-weighted `heatGrid`
  sum ≈ `differencePercentage`.
- Gate boundary: actual == max → success; actual > max → `isError` naming both
  numbers; `max_difference_percentage: 0` with zero diff → success.
- Invalid gate value (negative/NaN) → `isError`.
- Invalid `svg_density` (0, negative, huge past the bounds check) → `isError`.
- SVG with no derivable intrinsic size (no width/height, no viewBox) as design
  and as impl → error with clear cause; viewBox-only SVG resolves dims from
  viewBox.
- `.svg` extension with non-SVG bytes → error with the underlying cause.
- Fully-masked frame with `localize: true` → `diffBounds: null`, `heatGrid`
  all-zero.
- Heat partitioning on non-divisible dims (e.g. 10×10 into 3×3) → every pixel
  counted exactly once.
- `localize: false` → `diffBounds`/`heatGrid` omitted, no extra pass.
- Handler/schema: new params exposed in `inputSchema`; text lines
  (`Diff bounds:` + heat rows) present when diffs exist, absent on zero-diff
  runs and when `localize: false`.
- Update the existing version assertion from `0.6.0` to `0.7.0`.

## Risks

- **librsvg feature coverage.** sharp/librsvg doesn't render every SVG feature
  (some filters, external refs). Mitigation: surface decode failures through the
  existing "Unsupported image format" path with the underlying cause; document
  the limitation.
- **librsvg render nondeterminism.** Anti-aliasing and the font stack differ
  across platforms/versions; `<text>` SVGs decode successfully but render with
  system-fallback glyphs, so the "surface decode failure" mitigation never
  fires — decode succeeds and the output is silently wrong. Mitigation: no
  golden-raster fixtures, relational assertions only; document that
  text-bearing SVGs depend on system fonts.
- **Density vs cost / unbounded memory.** High `svg_density` on a large SVG is
  slower and heavier; a large viewBox × 288 dpi produces a very large RGBA
  buffer, and sharp's `limitInputPixels` surfaces as an opaque decode failure.
  Mitigation: `normalizeDensity` bounds-checks density/output pixel count and
  fails loud past the limit; the 288 default is aimed at small assets (icons/logos),
  and callers comparing large vector art can lower it (note in the param
  description).
- **Heat grid granularity.** 3×3 is coarse by design (cheap, readable). If finer
  localization is wanted later, expose grid size — deferred to keep this minimal.

## Out of scope / future

- Configurable heat-grid dimensions (`grid_size`).
- Multiple diff clusters (connected-component bounding boxes) instead of one
  global bbox.
- Custom diff highlight colour.
- Configurable flatten/background colour for SVG rasterization (v0.7.0 renders
  on a transparent canvas, no flatten).
