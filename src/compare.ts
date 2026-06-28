import fs from "fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { ssim } from "ssim.js";
import { Try, type TryResult } from "@power-rent/try-catch";

export type { TryResult };

export type ResizeFit = "fill" | "contain" | "cover";

export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareResult {
  totalPixels: number;
  differentPixels: number;
  differencePercentage: number;
  /** Structural similarity, 0..1 (1 = identical). Advisory; not gated by threshold. */
  ssim: number;
  /** Number of pixels excluded via ignore_regions; present only when > 0. */
  maskedPixels?: number;
  diffImageBase64?: string;
  resized?: {
    fromWidth: number;
    fromHeight: number;
    toWidth: number;
    toHeight: number;
    fit: ResizeFit;
  };
}

// Single failure-result factory for the no-throw API (the failure variant is
// independent of the success value type, so it fits any TryResult<T>).
function fail(message: string): { success: false; error: Error } {
  return { success: false, error: new Error(message) };
}

// Pure normalization for threshold: accepts number | string | other, coerces, clamps to [0,1], defaults to 0.1
export function normalizeThreshold(t: unknown): number {
  let n: number;
  if (typeof t === "number") {
    n = t;
  } else if (typeof t === "string") {
    n = parseFloat(t);
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n)) {
    return 0.1;
  }
  return Math.max(0, Math.min(1, n));
}

// Existence check shared by loadPNG and probeDimensions: maps a missing file to
// a "File not found" failure (no-throw).
async function checkExists(filePath: string): Promise<TryResult<void>> {
  const access = await new Try(() => fs.access(filePath)).result();
  if (!access.success) {
    return fail(`File not found: ${filePath}`);
  }
  return { success: true, value: undefined };
}

/**
 * Decode an image of any supported format to a raw-RGBA pngjs PNG. No-throw:
 * returns a discriminated TryResult instead of throwing. A missing file maps to
 * "File not found"; any decode failure maps to "Unsupported image format" and
 * carries the underlying cause (no longer swallowed).
 */
export async function loadPNG(
  filePath: string,
  resizeTo?: { width: number; height: number; fit: ResizeFit }
): Promise<TryResult<PNG>> {
  const exists = await checkExists(filePath);
  if (!exists.success) {
    return exists;
  }

  // Decode (and optional resize) in one pass; capturing the real error here is
  // what distinguishes a genuine format problem from a swallowed cause.
  const decoded = await new Try(() => {
    let pipeline = sharp(filePath).ensureAlpha(); // RGBA
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

  if (!decoded.success) {
    return fail(`Unsupported image format: ${filePath} (${decoded.error.message})`);
  }

  const { data, info } = decoded.value;
  const png = new PNG({ width: info.width, height: info.height });
  png.data = data;
  return { success: true, value: png };
}

// Read just the header dimensions (cheap — no full decode) while preserving
// loadPNG's error semantics, so the implementation can be decoded exactly once
// at the right size instead of decoded at native size and then re-decoded.
async function probeDimensions(
  filePath: string
): Promise<TryResult<{ width: number; height: number }>> {
  const exists = await checkExists(filePath);
  if (!exists.success) {
    return exists;
  }
  const meta = await new Try(() => sharp(filePath).metadata()).result();
  if (!meta.success) {
    return fail(`Unsupported image format: ${filePath} (${meta.error.message})`);
  }
  return { success: true, value: { width: meta.value.width!, height: meta.value.height! } };
}

/**
 * Build a boolean mask (1 = ignored) from ignore_regions in design-space
 * coordinates. No-throw: malformed input (non-object element, non-finite, or
 * negative width/height) returns a failure TryResult. Out-of-bounds rects are
 * clamped; rects that clamp to zero area are dropped. The masked count is
 * accumulated as pixels are first set, so it is overlap- and clamp-safe.
 */
export function buildMask(
  width: number,
  height: number,
  regions: IgnoreRegion[]
): TryResult<{ mask: Uint8Array; maskedCount: number }> {
  const mask = new Uint8Array(width * height);
  let maskedCount = 0;

  for (const r of regions) {
    if (r === null || typeof r !== "object") {
      return fail("ignore_regions: each region needs numeric x, y, width, height");
    }
    if (![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v))) {
      return fail("ignore_regions: each region needs numeric x, y, width, height");
    }
    if (r.width < 0 || r.height < 0) {
      return fail("ignore_regions: width and height must be non-negative");
    }

    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.floor(r.x + r.width));
    const y1 = Math.min(height, Math.floor(r.y + r.height));
    if (x1 <= x0 || y1 <= y0) {
      continue; // fully out of bounds or zero area after clamping → drop
    }

    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = x0; x < x1; x++) {
        const k = row + x;
        if (!mask[k]) {
          mask[k] = 1;
          maskedCount++; // count on first set → overlap-safe, single pass
        }
      }
    }
  }

  return { success: true, value: { mask, maskedCount } };
}

// Paint masked pixels transparent so both buffers read identical there.
function applyMask(data: Buffer, mask: Uint8Array): void {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const idx = i << 2;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = 0;
    }
  }
}

// Zero-copy view over pngjs Buffer to satisfy ssim.js's Uint8ClampedArray input.
function toImageData(png: PNG) {
  return {
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
}

/**
 * Mean structural similarity (0..1, 1 = identical). Pure computation over two
 * equal-dimension buffers — does not throw for valid inputs, so it returns a
 * plain number rather than a TryResult. The window shrinks for images smaller
 * than the default 11×11 so tiny images stay valid.
 */
export function computeSSIM(a: PNG, b: PNG): number {
  const windowSize = Math.min(11, a.width, a.height);
  return ssim(toImageData(a), toImageData(b), { windowSize }).mssim;
}

export async function compareScreenshots(
  designPath: string,
  implementationPath: string,
  outputDiffPath?: string,
  threshold: unknown = 0.1,
  autoResize: boolean = true,
  resizeFit: ResizeFit = "contain",
  ignoreRegions: IgnoreRegion[] = []
): Promise<TryResult<CompareResult>> {
  const normThreshold = normalizeThreshold(threshold);

  // The design is the reference — always decoded in full at its native size.
  const designR = await loadPNG(designPath);
  if (!designR.success) {
    return designR;
  }
  const design = designR.value;

  // Probe the implementation's dimensions (header only) before decoding, so a
  // resize decodes it once at the target size rather than decoding at native
  // size and discarding that buffer.
  const probe = await probeDimensions(implementationPath);
  if (!probe.success) {
    return probe;
  }
  const { width: implWidth, height: implHeight } = probe.value;

  let resized: CompareResult["resized"];
  if (design.width !== implWidth || design.height !== implHeight) {
    if (!autoResize) {
      return fail(
        `Image dimensions don't match: design (${design.width}x${design.height}) vs implementation (${implWidth}x${implHeight})`
      );
    }
    resized = {
      fromWidth: implWidth,
      fromHeight: implHeight,
      toWidth: design.width,
      toHeight: design.height,
      fit: resizeFit,
    };
  }
  // Derive the resize target from the (single) resized record so the two never
  // drift apart.
  const resizeTo = resized
    ? { width: resized.toWidth, height: resized.toHeight, fit: resized.fit }
    : undefined;

  const implR = await loadPNG(implementationPath, resizeTo);
  if (!implR.success) {
    return implR;
  }
  const implementation = implR.value;

  // Mask out ignored regions before any metric so dynamic content (timestamps,
  // avatars) does not count. Both buffers are painted identical inside the mask.
  const maskR = buildMask(design.width, design.height, ignoreRegions);
  if (!maskR.success) {
    return maskR;
  }
  const { mask, maskedCount } = maskR.value;
  if (maskedCount > 0) {
    applyMask(design.data, mask);
    applyMask(implementation.data, mask);
  }

  // Compute metrics and encode the diff inside a no-throw boundary so the whole
  // function honors its TryResult contract: pixelmatch, ssim.js, PNG allocation,
  // and PNG encoding all throw synchronously on pathological input.
  return new Try(async () => {
    const diff = new PNG({ width: design.width, height: design.height });

    const differentPixels = pixelmatch(
      design.data,
      implementation.data,
      diff.data,
      design.width,
      design.height,
      { threshold: normThreshold }
    );

    // Structural similarity on the same (reconciled, masked) buffers.
    const ssimScore = computeSSIM(design, implementation);

    // Masked pixels are identical by construction; exclude them from the
    // denominator so masking cannot dilute the percentage. totalPixels === 0
    // means the whole image was masked (the handler notes SSIM is meaningless).
    const totalPixels = design.width * design.height - maskedCount;
    const differencePercentage = totalPixels > 0 ? (differentPixels / totalPixels) * 100 : 0;

    const value: CompareResult = {
      totalPixels,
      differentPixels,
      differencePercentage,
      ssim: ssimScore,
    };
    if (maskedCount > 0) {
      value.maskedPixels = maskedCount;
    }
    if (resized) {
      value.resized = resized;
    }

    if (outputDiffPath) {
      await fs.writeFile(outputDiffPath, PNG.sync.write(diff));
    } else {
      value.diffImageBase64 = PNG.sync.write(diff).toString("base64");
    }

    return value;
  }).result();
}
