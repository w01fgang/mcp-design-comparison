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

### Single-file MCP Server (`src/index.ts`)

The entire server is implemented in one file with three main components:

1. **Image Processing Functions**:
   - `loadPNG()`: Loads images in multiple formats (PNG, JPEG, WebP, GIF, TIFF) using sharp, converts to raw pixel data
   - `compareScreenshots()`: Core comparison logic using pixelmatch, returns metrics and diff image

2. **MCP Server Setup**: 
   - Uses `@modelcontextprotocol/sdk` with stdio transport
   - Registers handlers for `ListToolsRequestSchema` and `CallToolRequestSchema`

3. **Tool Implementation** (`compare_design`):
   - Accepts two PNG paths, optional output path, and threshold (0-1)
   - Returns text response with statistics + optional base64 image or saves to file
   - Validates matching image dimensions before comparison

### Key Constraints

- Supports PNG, JPEG, WebP, GIF, and TIFF formats (via sharp library)
- Images must have identical dimensions
- Server runs on stdio (not HTTP) - designed for local MCP client communication
- Uses ES modules (`"type": "module"` in package.json)
- TypeScript compilation uses `Node16` module resolution
- Sharp library requires native binaries (automatically handled during npm install)

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

The server validates:
- File existence before attempting to read
- Image format support (PNG, JPEG, WebP, GIF, TIFF)
- Image dimensions match before comparison

Sharp automatically handles format detection and conversion, preventing format-related errors. JPEG files with .png extensions are automatically handled correctly.
