export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ApiResult<T = unknown> extends HttpResult {
  json: T | null;
}

export interface ChunkInput {
  sessionUrl: string;
  filePath: string;
  start: number;
  endInclusive: number;
  total: number;
  signal: AbortSignal;
  onProgress: (bytesInChunk: number) => void;
}

export interface TransferNetwork {
  api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<ApiResult<T>>;
  queryOffset(sessionUrl: string, total: number, signal?: AbortSignal): Promise<HttpResult>;
  putChunk(input: ChunkInput): Promise<HttpResult>;
  cancelSession(sessionUrl: string): Promise<void>;
}

export function parseCommittedOffset(status: number, range: string | undefined, total: number): number | null {
  if (status === 200 || status === 201) return total;
  if (status !== 308) return null;
  if (!range) return 0;
  const match = /bytes=\d+-(\d+)/.exec(range);
  return match ? Number(match[1]) + 1 : 0;
}
