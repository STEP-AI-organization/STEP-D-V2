import path from "node:path";

const BY_EXTENSION: Record<string, string> = {
  ".mxf": "application/mxf",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".mp4": "video/mp4",
};

export const VIDEO_EXTENSIONS = new Set(Object.keys(BY_EXTENSION));

export function uploadContentType(filePath: string): string {
  return BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isSupportedVideoPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
