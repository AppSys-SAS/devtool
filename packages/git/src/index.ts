import type { GitForge } from './forge.js'
import { github } from './github.js'
import { gitlab } from './gitlab.js'
import type { ForgeRepository } from './repository.js'

export * from './forge.js'
export * from './repository.js'

/** The forges whose pull requests the devtool reads, in the order they are guessed from a host. */
export const FORGES: GitForge[] = [github, gitlab]

/**
 * Finds the forge of a repository.
 * @param name The name the configuration gives, null to guess it from the host.
 * @param repository The repository.
 * @returns The forge, null when the name is unknown or the host matches none.
 */
export function findForge (name: string | null, repository: ForgeRepository): GitForge | null {
  return FORGES.find(forge => (name === null ? forge.matches(repository.host) : forge.name === name)) ?? null
}
