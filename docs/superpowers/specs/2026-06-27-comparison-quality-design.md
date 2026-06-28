# Comparison Quality — v0.5.0 Design

Date: 2026-06-27
Status: Approved (in implementation)

## Goal

Improve `compare_design` comparison quality on three fronts that produce
false/noisy diffs today:

1. **Resize distortion** — auto-resize stretches (`fit:"fill"`), ignoring aspect
   ratio, so any size mismatch smears differences across the whole image.
2. **AA / font noise** — raw pixel `%` does not map to perceived difference.
3. **Dynamic content** — timestamps, avatars, ads always differ; no way to
   exclude regions.

Scope is comparison quality only. Capture-from-URL, batch compare, alignment
detection, and pass/fail gating are explicitly out of scope.

## Features

### 1. `resize_fit` (enum `fill | contain | cover`, default `contain`)

Threaded into sharp `resize`. Default changes from the old implicit `fill` to
`contain` (aspect-preserving, letterboxed). This is a behavior change → minor
version bump 0.4.0 → 0.5.0.

- `contain`: scale preserving aspect to fit inside the design box, pad the
  remainder with transparent `{r:0,g:0,b:0,alpha:0}`.
- `fill`: legacy stretch (exact target dims, aspect ignored).
- `cover`: scale to cover, cropping overflow.

Letterbox bands are **not** auto-masked: an aspect mismatch is a real defect, and
`contain` localizes it to bands instead of smearing it everywhere (the reason to
prefer it over `fill`). The padded band reads as honest diff against design
content.

`resized` result gains a `fit` field recording the mode used. (`contentBox`
offset was considered and dropped — YAGNI; no consumer crops the letterbox.)

### 2. SSIM metric

Structural similarity, computed alongside pixelmatch on the
dimension-reconciled, **masked** buffers.

- Library: `ssim.js@3.5.0` (MIT, zero runtime deps, pure JS, no known vulns).
  Repo archived but the package is frozen SSIM math — acceptable, pinned.
- Call `ssim(a, b, { windowSize: Math.min(11, width, height) })`, return
  `.mssim` (0-1, 1 = identical). The dynamic window size keeps SSIM valid on
  images smaller than the default 11×11 window (verified: 6×6 works).
- pngjs `.data` is a `Buffer`; wrap in a zero-copy `Uint8ClampedArray` view to
  satisfy `ssim.js`'s `ImageData.data` type without copying.
- **Advisory only.** No pass/fail gate; `threshold` continues to apply to
  pixelmatch alone. Reported in the result and response text.
- Known limitation: SSIM has no native region-exclude, so masked regions are
  painted identical (locally SSIM 1) but windows straddling a mask edge can still
  sample real content. Effect is small; documented, not engineered around.

### 3. `ignore_regions` (array of `{x, y, width, height}`)

Rectangles masked out before pixelmatch + SSIM so dynamic content does not count.

- Coordinates are in **design space** (the post-resize reference frame).
- Both buffers are painted identical (transparent) inside each rect.
- Out-of-bounds rects are **clamped** to `[0,W]×[0,H]`; rects that clamp to zero
  area are dropped. Malformed input (non-numeric, or negative width/height)
  **throws** a validation error (fail loud).
- Denominator correction: `totalPixels = W*H − maskedCount`, where `maskedCount`
  is counted from the actual mask buffer (overlap- and clamp-safe), so masking
  cannot dilute the percentage. New `maskedPixels` result field reports the count.

## Order of operations

```
load design + implementation
  → reconcile dimensions (resize implementation to design dims using resize_fit)
  → build mask from ignore_regions; paint both buffers identical inside it
  → pixelmatch (threshold) on masked buffers  → differentPixels, diff image
  → ssim on masked buffers                     → mssim
  → totalPixels = W*H − maskedCount; percentage = differentPixels / totalPixels
```

## Result shape

```ts
interface CompareResult {
  totalPixels: number;        // W*H − maskedPixels
  differentPixels: number;
  differencePercentage: number;
  ssim: number;               // 0..1, 1 = identical
  maskedPixels?: number;      // present when ignore_regions masked > 0
  diffImageBase64?: string;
  resized?: {
    fromWidth: number; fromHeight: number;
    toWidth: number; toHeight: number;
    fit: "fill" | "contain" | "cover";
  };
}
```

## Module split

- `src/compare.ts` — image logic: `loadPNG`, `compareScreenshots`, mask building,
  SSIM, plus exported helpers worth testing in isolation.
- `src/index.ts` — re-exports `loadPNG`/`compareScreenshots` from `compare.ts`,
  keeps `handleListToolsRequest`/`handleCallToolRequest` and server bootstrap.

Re-exporting keeps the existing 16 tests' `import { ... } from "./index.js"`
unchanged (surgical; zero test churn).

## MCP schema additions

`compare_design` inputSchema gains:
- `resize_fit`: `{ type: "string", enum: ["fill","contain","cover"], default: "contain" }`
- `ignore_regions`: `{ type: "array", items: { x, y, width, height: number } }`

Response text gains an `SSIM:` line and, when applicable, a masked-pixels note.

## Versioning

0.4.0 → 0.5.0. Update `package.json`, the version string in
`handleListToolsRequest`, the server metadata, and the ListTools version test.

## Testing — 100% coverage target

`node --test --experimental-test-coverage`. Cover:
- `resize_fit`: each of fill/contain/cover; default-is-contain; `fit` in result.
- contain letterbox: non-square aspect mismatch → pad band produces diff.
- SSIM: identical → 1.0; differing → < 1.0; small-image window path.
- `ignore_regions`: masks a differing rect → diff drops; denominator subtracts;
  overlapping rects counted once; out-of-bounds clamp; zero-area drop;
  malformed → throws; `maskedPixels` reported.
- handler: SSIM line in text; ignore_regions + resize_fit passthrough; error path.
- existing behavior (formats, base64/file output, threshold coercion) preserved.

## Risks

- Contain default silently shifts numbers for callers who relied on fill-stretch.
  Mitigated by minor bump + README/AGENTS migration note.
- SSIM window bleed near small masks (above).
- `diffImageBase64` token size on large comparisons — pre-existing, unchanged.
