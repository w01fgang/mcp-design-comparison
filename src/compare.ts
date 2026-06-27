import fs from "fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { ssim } from "ssim.js";

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

export async function loadPNG(
  filePath: string,
  resizeTo?: { width: number; height: number; fit: ResizeFit }
): Promise<PNG> {
  try {
    // Check if file exists
    await fs.access(filePath);

    // Probe metadata first (post-access) to detect unsupported formats robustly.
    // Avoids fragile reliance on sharp raw/decode error message strings.
    try {
      await sharp(filePath).metadata();
    } catch {
      throw new Error(`Unsupported image format: ${filePath}`);
    }

    // Use sharp to convert any image format to PNG buffer
    // This handles PNG, JPEG, WebP, GIF, TIFF, etc.
    let pipeline = sharp(filePath).ensureAlpha(); // Ensure RGBA format
    if (resizeTo) {
      // The implementation is scaled to the design's dimensions so the raw
      // buffer lines up with the reference for pixelmatch. `fit` controls how:
      //   contain — preserve aspect, letterbox the remainder (transparent pad)
      //   fill    — stretch to exact dims, ignoring aspect
      //   cover   — preserve aspect, crop the overflow
      pipeline = pipeline.resize(resizeTo.width, resizeTo.height, {
        fit: resizeTo.fit,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }
    const { data, info } = await pipeline
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Create PNG object from raw pixel data
    const png = new PNG({ width: info.width, height: info.height });
    png.data = data;

    return png;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    // Unsupported-format and any other error propagate unchanged.
    throw error;
  }
}

/**
 * Build a boolean mask (1 = ignored) from ignore_regions in design-space
 * coordinates. Out-of-bounds rects are clamped; rects that clamp to zero area
 * are dropped. Malformed input (non-finite, or negative width/height) throws.
 * Counting masked pixels from the buffer is overlap- and clamp-safe.
 */
export function buildMask(
  width: number,
  height: number,
  regions: IgnoreRegion[]
): { mask: Uint8Array; maskedCount: number } {
  const mask = new Uint8Array(width * height);

  for (const r of regions) {
    if (![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v))) {
      throw new Error(
        "ignore_regions: each region needs numeric x, y, width, height"
      );
    }
    if (r.width < 0 || r.height < 0) {
      throw new Error("ignore_regions: width and height must be non-negative");
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
        mask[row + x] = 1;
      }
    }
  }

  let maskedCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) maskedCount++;
  }
  return { mask, maskedCount };
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
    data: new Uint8ClampedArray(
      png.data.buffer,
      png.data.byteOffset,
      png.data.byteLength
    ),
    width: png.width,
    height: png.height,
  };
}

/**
 * Mean structural similarity (0..1, 1 = identical). The window size shrinks for
 * images smaller than the default 11×11 window so tiny images stay valid.
 */
export function computeSSIM(a: PNG, b: PNG): number {
  // Shrink the window for images smaller than the default 11×11 so tiny images
  // stay valid (loadPNG always yields ≥1×1, so the window is always ≥1).
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
): Promise<CompareResult> {
  const normThreshold = normalizeThreshold(threshold);
  // Load both images
  const design = await loadPNG(designPath);
  let implementation = await loadPNG(implementationPath);

  // Reconcile dimensions: pixelmatch requires identical buffers.
  let resized: CompareResult["resized"];
  if (
    design.width !== implementation.width ||
    design.height !== implementation.height
  ) {
    if (!autoResize) {
      throw new Error(
        `Image dimensions don't match: design (${design.width}x${design.height}) vs implementation (${implementation.width}x${implementation.height})`
      );
    }
    // Re-decode the implementation, scaled to the design's dimensions
    // (the design is the reference) so the comparison can proceed.
    resized = {
      fromWidth: implementation.width,
      fromHeight: implementation.height,
      toWidth: design.width,
      toHeight: design.height,
      fit: resizeFit,
    };
    implementation = await loadPNG(implementationPath, {
      width: design.width,
      height: design.height,
      fit: resizeFit,
    });
  }

  // Mask out ignored regions before any metric so dynamic content (timestamps,
  // avatars) does not count. Both buffers are painted identical inside the mask.
  const { mask, maskedCount } = buildMask(
    design.width,
    design.height,
    ignoreRegions
  );
  if (maskedCount > 0) {
    applyMask(design.data, mask);
    applyMask(implementation.data, mask);
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
    { threshold: normThreshold }
  );

  // Structural similarity on the same (reconciled, masked) buffers.
  const ssimScore = computeSSIM(design, implementation);

  // Masked pixels are identical by construction; exclude them from the
  // denominator so masking cannot dilute the percentage.
  const totalPixels = design.width * design.height - maskedCount;
  const differencePercentage =
    totalPixels > 0 ? (differentPixels / totalPixels) * 100 : 0;

  const result: CompareResult = {
    totalPixels,
    differentPixels,
    differencePercentage,
    ssim: ssimScore,
  };

  if (maskedCount > 0) {
    result.maskedPixels = maskedCount;
  }
  if (resized) {
    result.resized = resized;
  }

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
