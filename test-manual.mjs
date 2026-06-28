#!/usr/bin/env node

import { compareScreenshots } from './dist/index.js';

const [, , design, implementation, output] = process.argv;

if (!design || !implementation) {
  console.error('Usage: node test-manual.mjs <design.png> <implementation.png> [output-diff.png]');
  process.exit(1);
}

console.log('Comparing screenshots...');
console.log(`Design: ${design}`);
console.log(`Implementation: ${implementation}`);

// compareScreenshots is no-throw: it returns a TryResult discriminated union.
const r = await compareScreenshots(design, implementation, output);

if (!r.success) {
  console.error('\n❌ Error:', r.error.message);
  process.exit(1);
}

const result = r.value;

console.log('\n✅ Comparison Results:');
console.log(`Total Pixels: ${result.totalPixels.toLocaleString()}`);
console.log(`Different Pixels: ${result.differentPixels.toLocaleString()}`);
console.log(`Difference: ${result.differencePercentage.toFixed(2)}%`);
console.log(`SSIM: ${result.ssim.toFixed(4)} (1.0000 = identical)`);

if (output) {
  console.log(`\nDiff image saved to: ${output}`);
} else {
  console.log(`\nDiff image size: ${result.diffImageBase64?.length || 0} bytes (base64)`);
}

process.exit(0);
