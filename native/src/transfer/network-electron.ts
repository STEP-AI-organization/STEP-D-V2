import { createReadStream } from "node:fs";

import { net, type ClientRequest, type Session } from "electron";

import { TransferAbortedError } from "./errors.js";
import type { ApiResult, ChunkInput, HttpResult, TransferNetwork } from "./network.js";

function headersToRecord(headers: Record<string, string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

export class ElectronTransferNetwork implements TransferNetwork {
  constructor(
    private readonly browserSession: Session,
    private readonly apiBase: string,
  ) {}

  async api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await this.browserSession.fetch(`${this.apiBase}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stepd-app": "native",
        },
        body: JSON.stringify(body),
        credentials: "include",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new TransferAbortedError();
      throw error;
    }
    const text = await response.text();
    let parsed: T | null = null;
    if (text) {
      try { parsed = JSON.parse(text) as T; } catch { /* keep the diagnostic text */ }
    }
    return {
      status: response.status,
      headers: (() => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
        return headers;
      })(),
      body: text,
      json: parsed,
    };
  }

  queryOffset(sessionUrl: string, total: number, signal?: AbortSignal): Promise<HttpResult> {
    return this.request({
      method: "PUT",
      url: sessionUrl,
      headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
      signal,
    });
  }

  putChunk(input: ChunkInput): Promise<HttpResult> {
    return this.request({
      method: "PUT",
      url: input.sessionUrl,
      headers: {
        "Content-Length": String(input.endInclusive - input.start + 1),
        "Content-Range": `bytes ${input.start}-${input.endInclusive}/${input.total}`,
      },
      file: { path: input.filePath, start: input.start, end: input.endInclusive },
      signal: input.signal,
      onProgress: input.onProgress,
    });
  }

  async cancelSession(sessionUrl: string): Promise<void> {
    await this.request({
      method: "DELETE",
      url: sessionUrl,
      headers: { "Content-Length": "0" },
    }).catch(() => {});
  }

  private request(options: {
    method: "PUT" | "DELETE";
    url: string;
    headers: Record<string, string>;
    file?: { path: string; start: number; end: number };
    signal?: AbortSignal;
    onProgress?: (bytes: number) => void;
  }): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest;
      try {
        request = net.request({ method: options.method, url: options.url, session: this.browserSession });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(options.signal?.aborted ? new TransferAbortedError() : error);
      };
      const abort = () => {
        request.abort();
        finishReject(new TransferAbortedError());
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      for (const [key, value] of Object.entries(options.headers)) request.setHeader(key, value);
      request.on("error", finishReject);
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("error", finishReject);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", abort);
          resolve({
            status: response.statusCode,
            headers: headersToRecord(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      if (!options.file) {
        request.end();
        return;
      }

      const source = createReadStream(options.file.path, {
        start: options.file.start,
        end: options.file.end,
      });
      let sent = 0;
      source.on("error", (error) => {
        request.abort();
        finishReject(error);
      });
      source.on("data", (raw: string | Buffer) => {
        source.pause();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        sent += chunk.length;
        options.onProgress?.(sent);
        request.write(chunk);
        source.resume();
      });
      source.on("end", () => request.end());
      options.signal?.addEventListener("abort", () => source.destroy(), { once: true });
    });
  }
}
