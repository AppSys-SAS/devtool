import { spawn } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const folder = process.env.E2E_FOLDER

if (!folder) {
  throw new Error('E2E_FOLDER names the folder of the instance under test')
}

await rm(folder, { recursive: true, force: true })
await cp(path.join(root, 'fixtures'), folder, { recursive: true })

const server = spawn(
  process.execPath,
  [path.join(root, '..', 'apps', 'cli', 'lib', 'index.js'), '--config-folder', path.join(folder, 'devtool'), 'server'],
  { stdio: 'inherit' }
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal))
}

server.on('exit', code => {
  process.exit(code ?? 0)
})
