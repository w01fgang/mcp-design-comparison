#!/usr/bin/env node

import { compareScreenshots } from './dist/index.js';

const [, , design, implementation, output] = process.argv;

if (!design || !implementation) {
  console.error('Usage: node test-manual.mjs <design.png> <implementation.png> [output-diff.png]');
  process.exit(1);
}

try {
  console.log('Comparing screenshots...');
  console.log(`Design: ${design}`);
  console.log(`Implementation: ${implementation}`);
  
  const result = await compareScreenshots(design, implementation, output);
  
  console.log('\n✅ Comparison Results:');
  console.log(`Total Pixels: ${result.totalPixels.toLocaleString()}`);
  console.log(`Different Pixels: ${result.differentPixels.toLocaleString()}`);
  console.log(`Difference: ${result.differencePercentage.toFixed(2)}%`);
  
  if (output) {
    console.log(`\nDiff image saved to: ${output}`);
  } else {
    console.log(`\nDiff image size: ${result.diffImageBase64?.length || 0} bytes (base64)`);
  }
  
  process.exit(0);
} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
}
