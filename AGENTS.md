# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that exposes a single tool (`compare_design`) for comparing design screenshots with implementation screenshots using pixelmatch. Supports PNG, JPEG, WebP, GIF, and TIFF image formats. The server communicates via stdio and is intended to be used by MCP clients like Claude Desktop.

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Watch mode for development
npm run watch
```

## Architecture

### Module split

The server is split into two files:

- **`src/compare.ts`** — image logic (no MCP concerns). **No-throw**: the fallible
  functions return a discriminated `TryResult<T>` (`{ success: true, value }` or
  `{ success: false, error }`) from `@power-rent/try-catch` instead of throwing.
  - `loadPNG()`: loads images in multiple formats (PNG, JPEG, WebP, GIF, TIFF) using sharp, converts to raw RGBA; optional resize with a `fit` mode (`fill`/`contain`/`cover`). Returns `TryResult<PNG>`. A missing file → "File not found"; any decode failure → "Unsupported image format" with the underlying cause appended (the real error is no longer swallowed).
  - `buildMask()`: turns `ignore_regions` rectangles into a boolean mask (validates element shape, clamps out-of-bounds, drops zero-area, counts masked pixels inline as they are first set). Returns `TryResult<{mask, maskedCount}>`; malformed input is a failure result, not a throw.
  - `computeSSIM()`: mean structural similarity (0–1) via `ssim.js`, window size shrinks for small images. Pure computation over equal-dimension buffers — returns a plain `number` (does not throw for valid input).
  - `compareScreenshots()`: probe implementation dimensions (header only) → load design + implementation (implementation decoded once, at the target size on the resize path) → mask → pixelmatch + SSIM. Returns `TryResult<CompareResult>`; propagates any sub-step failure result.
- **`src/index.ts`** — MCP wiring: re-exports the image logic (so `./index.js` imports stay stable), registers `ListToolsRequestSchema`/`CallToolRequestSchema` handlers, and bootstraps the stdio server. The `compare_design` handler branches on the `TryResult` and returns an `isError` response on failure (no try/catch); only an unknown tool name throws.

### Tool Implementation (`compare_design`)

- Accepts two image paths, optional output path, `threshold` (0–1), `auto_resize` flag, `resize_fit` (`fill`/`contain`/`cover`, default `contain`), and `ignore_regions` (array of `{x,y,width,height}`)
- Order of operations: probe implementation dims → resize-reconcile (using `resize_fit`) → mask `ignore_regions` in both buffers → pixelmatch + SSIM on the masked buffers
- Masked pixels are excluded from both the diff and the percentage denominator (`totalPixels = W*H − maskedCount`); when the whole image is masked (`totalPixels === 0`), the handler notes that SSIM is not meaningful
- Returns text response with statistics + SSIM score + optional base64 image or saves to file

### Key Constraints

- Supports PNG, JPEG, WebP, GIF, and TIFF formats (via sharp library)
- Differing dimensions are auto-resized by default (implementation → design) using `resize_fit` (default `contain`, aspect-preserving); pass `auto_resize: false` to require identical dimensions
- SSIM is advisory — it is reported but not gated by `threshold` (which applies to pixelmatch only). SSIM is computed on the masked buffers, so `ignore_regions` are treated as identical (SSIM does not penalize masked content), matching how pixelmatch excludes them
- `ssim.js` and `@power-rent/try-catch` are pure JS with no native deps; sharp requires native binaries (handled during npm install)
- `@power-rent/try-catch` is imported from its base entry (no Sentry/reporting unless `.report()` is called, which this project never does)
- Server runs on stdio (not HTTP) - designed for local MCP client communication
- Uses ES modules (`"type": "module"` in package.json)
- TypeScript compilation uses `Node16` module resolution

## Testing the Server

### Automated Tests

The project includes comprehensive tests using Node.js's built-in test runner:

```bash
npm test
```

Tests cover:
- File validation (existence, PNG format)
- Image comparison (identical, different, dimension mismatch)
- Output modes (file save, base64)

### Manual Testing

Use the included test script to test with real screenshots:

```bash
node test-manual.mjs design.png implementation.png [output-diff.png]
```

### MCP Client Testing

1. Build the project: `npm run build`
2. Configure an MCP client (e.g., Claude Desktop) to point to `dist/index.js`
3. Use the `compare_design` tool with two PNG screenshots

The server logs to stderr, so startup messages won't interfere with MCP stdio communication.

## Error Handling

The server validates (all as no-throw `TryResult` failures, surfaced by the handler as an `isError` response):
- File existence before attempting to read ("File not found")
- Image format / decodability ("Unsupported image format", with the underlying sharp cause appended rather than swallowed)
- Image dimensions before comparison — reconciled via auto-resize, or rejected when `auto_resize` is `false`
- `ignore_regions` shape — malformed input (non-object element, non-numeric coordinates, or negative width/height) returns a validation failure; out-of-bounds rectangles are clamped

Sharp automatically handles format detection and conversion. JPEG files with .png extensions are handled correctly.
