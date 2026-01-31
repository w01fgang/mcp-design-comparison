# MCP Design Comparison Server

An MCP (Model Context Protocol) server that allows LLMs to compare design screenshots with implementation screenshots using [pixelmatch](https://github.com/mapbox/pixelmatch). This tool helps identify visual discrepancies between design mockups and actual implementation.

## Features

- **Screenshot Comparison**: Compare two PNG images pixel-by-pixel
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
- `design_path` (string, required): Path to the design screenshot (PNG format)
- `implementation_path` (string, required): Path to the implementation screenshot (PNG format)
- `output_diff_path` (string, optional): Path to save the diff image. If not provided, the diff image will be returned as base64
- `threshold` (number, optional): Matching threshold (0-1). Smaller values make the comparison more sensitive. Default is 0.1

**Returns:**
- Total number of pixels
- Number of different pixels
- Percentage difference
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

1. Loads both PNG images into memory
2. Validates that dimensions match
3. Uses pixelmatch to compare pixel-by-pixel
4. Generates a diff image highlighting differences in pink
5. Returns statistics and the diff image

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
- PNG images with matching dimensions

## License

MIT
