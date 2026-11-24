import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync, type Zippable } from 'fflate'

const SKIPPED = new Set(['node_modules', 'data', '.DS_Store'])

/**
 * Packs a folder into a zip archive, its files under a folder of the same name and their permissions kept.
 * @param folder The folder.
 * @returns The bytes of the archive.
 */
export async function zipFolder (folder: string): Promise<Uint8Array> {
  const name = path.basename(folder)
  const entries: Zippable = {}
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    const relative = path.relative(folder, file)
    if (!entry.isFile() || relative.split(path.sep).some(segment => SKIPPED.has(segment))) {
      continue
    }
    const { mode } = await stat(file)
    entries[`${name}/${relative.split(path.sep).join('/')}`] = [await readFile(file), { os: 3, attrs: (mode & 0o777) << 16 }]
  }
  return zipSync(entries)
}

/**
 * Writes a zip archive of every folder of the examples, `<target>/<folder>.zip`.
 * @param examples The folder holding the examples.
 * @param target The folder receiving the archives.
 * @returns The names of the archives written.
 */
export async function zipExamples (examples: string, target: string): Promise<string[]> {
  const folders = (await readdir(examples, { withFileTypes: true })).filter(entry => entry.isDirectory())
  await mkdir(target, { recursive: true })
  const written: string[] = []
  for (const folder of folders) {
    await writeFile(path.join(target, `${folder.name}.zip`), await zipFolder(path.join(examples, folder.name)))
    written.push(`${folder.name}.zip`)
  }
  return written
}
