/**
 * 네이버 세션(storageState)의 서버 보관.
 *
 * 암호화 본체는 `session-crypto.ts` 에 있다 — 쿠팡파트너스도 같은 봉투를 쓰면서 뽑아냈다.
 * 여기는 **네이버의 키(`NAVER_SESSION_KEY`)를 고정하는 얇은 층**이다. 공개 API 는 예전 그대로라
 * 부르는 쪽(`worker.ts`·`index.ts`)은 바뀌지 않는다.
 *
 * 키는 제공자마다 따로 둔다 — 하나가 새도 다른 쪽 세션까지 열리지 않게.
 *
 * 키 만들기(32바이트 base64):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { keyReady, openWith, sealWith } from "./session-crypto.ts";

export { looksLikeStorageState } from "./session-crypto.ts";

const KEY_ENV = "NAVER_SESSION_KEY";

export function sessionStoreReady(): boolean {
  return keyReady(KEY_ENV);
}

/** 평문 storageState(JSON) → 저장 문자열. 키가 없으면 던진다(조용히 평문 저장 금지). */
export function sealSession(state: unknown): string {
  return sealWith(KEY_ENV, state);
}

/** 저장 문자열 → 평문 storageState. 키가 없거나 못 풀면 null(예외 대신). */
export function openSession(blob: string | null | undefined): unknown | null {
  return openWith(KEY_ENV, blob);
}
