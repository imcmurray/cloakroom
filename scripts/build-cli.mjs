// Bundle the CLI into a single self-contained ESM file with a Node shebang.
// Zero runtime dependencies, so the output has no node_modules requirement.

import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

const outfile = 'dist-cli/cloak.mjs';

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

await chmod(outfile, 0o755);
console.log(`Built ${outfile}`);
