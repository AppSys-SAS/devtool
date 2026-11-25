import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ASSETS = {
  ui: '../ui/dist',
  assets: '../server/assets',
  bin: '../server/bin',
  skills: '../../packages/skills/skills',
  schema: '../../packages/config/schema'
}

/**
 * Copies a folder of the workspace next to the bundle of the published package, replacing the previous copy.
 * @param {string} target - The folder in `dist`, beside the `lib` folder of the bundle.
 * @param {string} source - The folder of the workspace, relative to the package.
 * @returns {Promise<void>} Resolves once the folder is copied.
 */
async function collect (target, source) {
  const destination = fileURLToPath(new URL(`../dist/${target}`, import.meta.url))
  await rm(destination, { recursive: true, force: true })
  await cp(fileURLToPath(new URL(`../${source}`, import.meta.url)), destination, { recursive: true })
}

await Promise.all(Object.entries(ASSETS).map(([target, source]) => collect(target, source)))
