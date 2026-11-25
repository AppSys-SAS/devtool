import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist/lib',
  fixedExtension: false,
  clean: true,
  dts: false,
  define: {
    'process.env.DEVTOOL_UI_FOLDER': JSON.stringify('../ui')
  },
  deps: {
    onlyBundle: []
  }
})
