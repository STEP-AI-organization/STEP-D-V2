import path from "node:path";

import { isNativeUploadRequest, type NativeUploadRequest } from "../contract.js";
import { isSupportedVideoPath } from "./mime.js";

export function validateJobId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{8,80}$/.test(value)) throw new Error("invalid job id");
  return value;
}

export function validateUploadInput(filePath: unknown, request: unknown): {
  filePath: string;
  request: NativeUploadRequest;
} {
  const validatedPath = validateVideoPath(filePath);
  if (!isNativeUploadRequest(request)) throw new Error("업로드 정보가 올바르지 않습니다.");
  return { filePath: validatedPath, request };
}

export function validateVideoPath(filePath: unknown): string {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("실제 로컬 영상 파일을 선택해 주세요.");
  }
  if (!isSupportedVideoPath(filePath)) throw new Error("지원하지 않는 영상 형식입니다.");
  return path.normalize(filePath);
}
