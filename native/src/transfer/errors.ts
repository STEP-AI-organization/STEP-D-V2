import type { NativeUploadErrorCode } from "../contract.js";

export class TransferError extends Error {
  constructor(
    readonly code: NativeUploadErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

export class TransferAbortedError extends Error {
  constructor() {
    super("transfer aborted");
    this.name = "TransferAbortedError";
  }
}

export class SessionExpiredError extends TransferError {
  constructor() {
    super("SESSION_EXPIRED", "업로드 재개 세션이 만료됐습니다.", true);
    this.name = "SessionExpiredError";
  }
}

/**
 * OS 보안 저장소(Windows DPAPI)를 못 쓰는 상태.
 *
 * GCS 세션 URI 는 **업로드 권한 그 자체**라 평문으로 남기지 않는다. 스펙은 이 경우
 * "평문 저장하지 말고 네이티브 업로드를 차단" 이다 — 그래서 **재시도 대상이 아니다**.
 * 예전엔 일반 Error 로 새어나가 NETWORK(재시도 가능)로 오분류돼, 고쳐지지 않는 상태를
 * 영원히 재시도하는 루프가 됐다.
 */
export class EncryptionUnavailableError extends TransferError {
  constructor(message: string) {
    super("ENCRYPTION_UNAVAILABLE", message, false);
    this.name = "EncryptionUnavailableError";
  }
}
