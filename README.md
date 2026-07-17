# MCP Design Comparison Server

An MCP (Model Context Protocol) server that allows LLMs to compare design screenshots with implementation screenshots using [pixelmatch](https://github.com/mapbox/pixelmatch). Supports multiple image formats including PNG, JPEG, WebP, GIF, TIFF, and SVG (rasterized via librsvg). This tool helps identify visual discrepancies between design mockups and actual implementation.

## Features

- **Multi-Format Support**: Works with PNG, JPEG, WebP, GIF, TIFF, and SVG images
- **Screenshot Comparison**: Compare two images pixel-by-pixel
- **SSIM Score**: Structural-similarity metric (0–1) that tracks perceived difference, not just raw pixel deltas
- **Auto-Resize**: Mismatched resolutions are reconciled automatically — the implementation is scaled to the design's dimensions. `resize_fit` controls how (`contain` preserves aspect ratio by default; `fill`/`cover` available); toggle off with `auto_resize`
- **Ignore Regions**: Exclude rectangles (e.g. timestamps, avatars) from the comparison so dynamic content doesn't count
- **Vector (SVG) Input**: Compare a design PNG against an SVG icon (or SVG vs SVG) — SVGs are rasterized at a configurable density (`svg_density`, default 288 dpi) with no pre-render step
- **Diff Localization**: A diff bounding box and a 3x3 heat grid report *where* differences cluster, not just how many pixels differ
- **Assertion Gate**: Optional `max_difference_percentage` flips the result to an error when exceeded — a CI regression gate without parsing text
- **Visual Diff Output**: Generate a highlighted diff image showing differences
- **Detailed Metrics**: Get total pixels, different pixels, and percentage difference
- **Configurable Threshold**: Adjust sensitivity of the comparison
- **Base64 Support**: Return diff images as base64 or save to file

## Installation

### For End Users

Install globally via npm:

```bash
npm install -g mcp-design-comparison
```

Or using npx (no installation required):

```bash
npx mcp-design-comparison
```

### For Development

```bash
git clone https://github.com/w01fgang/mcp-design-comparison.git
cd mcp-design-comparison
npm install
npm run build
```

## Usage

### As an MCP Server

Add this server to your MCP client configuration. The server runs on stdio and provides a single tool:

#### Tool: `compare_design`

Compare a design screenshot with an implementation screenshot.

**Parameters:**
- `design_path` (string, required): Path to the design screenshot (supports PNG, JPEG, WebP, GIF, TIFF, SVG)
- `implementation_path` (string, required): Path to the implementation screenshot (supports PNG, JPEG, WebP, GIF, TIFF, SVG)
- `output_diff_path` (string, optional): Path to save the diff image (always saved as PNG). If not provided, the diff image will be returned as base64
- `threshold` (number, optional): Matching threshold (0-1). Smaller values make the comparison more sensitive. Default is 0.1
- `auto_resize` (boolean, optional): When the two screenshots differ in resolution, scale the implementation to the design's dimensions instead of erroring. Default is `true`. Set `false` to require identical dimensions.
- `resize_fit` (string, optional): How to scale the implementation when dimensions differ — `contain` (default, preserves aspect ratio and letterboxes), `fill` (stretches to exact dimensions), or `cover` (preserves aspect ratio and crops overflow).
- `ignore_regions` (array, optional): Rectangles `{ x, y, width, height }` in design-space coordinates to exclude from the comparison (e.g. dynamic content). Excluded pixels count toward neither the diff nor the percentage denominator.
- `svg_density` (number, optional): Rasterization density (DPI) for SVG inputs. Higher = crisper vector render before comparison. Default 288 (4x the 72dpi baseline). Aimed at small assets (icons/logos); lower it for large vector art.
- `localize` (boolean, optional): If `true` (default), include a diff bounding box and a coarse 3x3 heat grid in the result, showing where differences cluster. Set `false` to skip the extra pass.
- `max_difference_percentage` (number, optional): If set and the difference percentage exceeds it (strictly greater), the call returns an error (`isError: true`) while still producing the diff artifact. Use as a CI gate against a golden image. Omit for report-only.

**Returns:**
- Total number of pixels (excluding any ignored regions)
- Number of different pixels
- Percentage difference
- SSIM score (0–1, where 1.0 means identical)
- Diff bounding box and 3x3 heat grid (when `localize` is on and differences exist)
- Diff image (as file or base64)

### Configuration Example

Add to your MCP settings file:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "design-comparison": {
      "command": "npx",
      "args": ["-y", "mcp-design-comparison"]
    }
  }
}
```

**Cursor** (`~/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` on macOS):

```json
{
  "mcpServers": {
    "design-comparison": {
      "command": "npx",
      "args": ["-y", "mcp-design-comparison"]
    }
  }
}
```

After adding the configuration, restart Claude Desktop or Cursor.

## How It Works

1. Loads both images into memory (any supported format → raw RGBA)
2. If dimensions differ, scales the implementation to the design's dimensions using `resize_fit` (default `contain`, aspect-preserving; unless `auto_resize` is `false`, which errors instead)
3. Masks out any `ignore_regions` in both images so excluded pixels don't count
4. Uses pixelmatch to compare pixel-by-pixel, computes an SSIM score, and (when `localize` is on) locates where differences cluster (bounding box + 3x3 heat grid)
5. Generates a diff image highlighting differences in pink
6. Returns statistics, the SSIM score, and the diff image

## Example Use Cases

- **Design QA**: Verify that implementation matches design mockups
- **Regression Testing**: Compare screenshots before and after changes
- **Cross-browser Testing**: Compare renders across different browsers
- **Responsive Design**: Compare layouts at different breakpoints

## Testing

### Run Automated Tests

```bash
npm test
```

### Manual Testing with Your Screenshots

Use the included test script:

```bash
node test-manual.mjs design.png implementation.png [output-diff.png]
```

## Requirements

- Node.js 18+
- Images in a supported format (PNG, JPEG, WebP, GIF, TIFF, or SVG); differing resolutions are auto-resized unless `auto_resize` is disabled

## License

MIT
