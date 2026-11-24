import { fileURLToPath } from 'node:url'

/** The folder of the agent skills shipped with the devtool, one skill per folder. */
export const SKILLS_FOLDER = fileURLToPath(new URL('../skills', import.meta.url))
