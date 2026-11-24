import type { Server } from 'node:http'

/** Settings of the devtool files server. */
export interface ServerConfig {
  /** Port to listen on, 0 for any free port. */
  port: number
  /** Folder storing the files. */
  dataDir: string
  /** Issuer of the access tokens. */
  issuer: string
  /** Address of the keys of the issuer. */
  jwksUrl: string
  /** Audience the access tokens must carry. */
  audience: string
  /** Client the access tokens must be issued to, null to accept any. */
  clientId: string | null
  /** Groups allowed to list and download. */
  readGroups: string[]
  /** Groups allowed to list, download, upload and delete. */
  writeGroups: string[]
  /** Largest file accepted, in bytes. */
  maxBytes: number
}

/**
 * Reads the configuration from environment variables.
 * @param env The environment variables.
 * @returns The configuration.
 */
export function configFromEnv (env: NodeJS.ProcessEnv): ServerConfig

/**
 * Creates the server of the devtool files API, not listening yet.
 * @param config The configuration.
 * @returns The server.
 */
export function createServer (config: ServerConfig): Server
