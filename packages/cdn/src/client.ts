import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { accessToken } from "./auth.js";
import type { CdnOptions } from "./options.js";

/** Raised when the CDN answers with an error. */
export class CdnRequestError extends Error {
  /**
   * @param status - The HTTP status of the answer.
   * @param message - The message of the answer.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CdnRequestError";
  }
}

/**
 * Builds a stream failing at its end when it did not carry an exact length.
 *
 * @param expected - The expected length in bytes, or null to accept any.
 * @returns The transform checking the length.
 */
function lengthCheck(expected: number | null): Transform {
  let received = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      received += chunk.length;
      callback(null, chunk);
    },
    flush(callback: TransformCallback): void {
      callback(expected !== null && received !== expected ? new Error(`incomplete download: ${received} of ${expected} bytes`) : null);
    },
  });
}

/** A file stored on the CDN. */
export interface CdnFile {
  path: string;
  /** Size once decrypted, in bytes. */
  size: number;
  updatedAt: Date;
}

/**
 * Files of the developer tools on the CDN, read and written with the access token of the signed-in
 * developer.
 */
export class CdnClient {
  /**
   * @param _options - The CDN options.
   */
  constructor(private readonly _options: CdnOptions) {}

  /**
   * Lists the stored files, with their size once decrypted and their last upload.
   *
   * @returns The files, or null when the CDN cannot list them.
   */
  async list(): Promise<CdnFile[] | null> {
    const response = await this.request("GET", "");
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }

    await this.assertOk(response);
    const { files } = (await response.json()) as { files: { path: string; size: number; updatedAt: string }[] };
    return files.map((file) => ({ path: file.path, size: file.size, updatedAt: new Date(file.updatedAt) }));
  }

  /**
   * Opens a file for download. The stream fails when the file arrives incomplete, as a damaged file
   * does.
   *
   * @param path - The path of the file, such as `account/db.sql.gz`.
   * @returns The content, or null when the file does not exist.
   */
  async download(path: string): Promise<Readable | null> {
    const response = await this.request("GET", path);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }

    await this.assertOk(response);
    const length = response.headers.get("content-length");

    return pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), lengthCheck(length === null ? null : Number(length)), () => undefined);
  }

  /**
   * Reads a whole text file.
   *
   * @param path - The path of the file.
   * @returns The text, or null when the file does not exist.
   */
  async readText(path: string): Promise<string | null> {
    const content = await this.download(path);
    if (content === null) {
      return null;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf-8");
  }

  /**
   * Uploads a local file, streamed, replacing the stored one.
   *
   * @param path - The path of the file on the CDN.
   * @param filePath - The local file.
   * @param contentType - The media type served with the file.
   */
  async upload(path: string, filePath: string, contentType = "application/octet-stream"): Promise<void> {
    const { size } = await fs.stat(filePath);
    const response = await this.request("PUT", path, {
      headers: { "Content-Type": contentType, "Content-Length": String(size) },
      body: Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
      duplex: "half",
    });
    await this.assertOk(response);
  }

  /**
   * Deletes a file; a missing file counts as deleted.
   *
   * @param path - The path of the file.
   */
  async remove(path: string): Promise<void> {
    await this.assertOk(await this.request("DELETE", path));
  }

  /**
   * Calls the devtool files of the CDN with the access token of the developer.
   *
   * @param method - The HTTP method.
   * @param path - The path of the file, empty for the list of the files.
   * @param init - The other request options.
   * @returns The answer.
   */
  private async request(method: string, path: string, init: RequestInit & { duplex?: "half" } = {}): Promise<Response> {
    const token = await accessToken(this._options);
    const url = path === "" ? `${this._options.url}/devtool` : `${this._options.url}/devtool/${path.split("/").map(encodeURIComponent).join("/")}`;

    return fetch(url, { ...init, method, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  }

  /**
   * Turns an error answer into an exception.
   *
   * @param response - The answer.
   */
  private async assertOk(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }

    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : response.statusText;
    throw new CdnRequestError(response.status, `CDN ${response.status}: ${message}`);
  }
}
