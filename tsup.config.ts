import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  dts: true,
  clean: false,
  outDir: 'dist',
  target: 'es2022',
  splitting: false,
  sourcemap: true,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
  },
  {
    ...shared,
    entry: { 'tracking/index': 'src/tracking/index.ts' },
  },
]);
