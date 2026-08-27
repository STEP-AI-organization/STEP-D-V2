/**
 * 쿠팡파트너스 세션(storageState)의 서버 보관.
 *
 * 암호화 본체는 `session-crypto.ts` 공용 — 네이버와 같은 봉투를 쓴다. 여기는 **커머스의
 * 키(`COMMERCE_SESSION_KEY`)를 고정하는 얇은 층**이다.
 *
 * 키를 제공자마다 따로 두는 이유: 하나가 새도 다른 쪽 세션까지 열리지 않게.
 *
 * ⚠️ 이 세션은 **고객사 법인 계정의 전체 권한**이다(실측: 쿠키만 주입해도 그 계정으로
 *    로그인된다 · 2차인증까지 통과된 상태). 값을 로그·API 응답에 절대 싣지 않는다.
 *
 * 키 만들기(32바이트 base64):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { keyReady, openWith, sealWith } from "./session-crypto.ts";

export { looksLikeStorageState } from "./session-crypto.ts";

const KEY_ENV = "COMMERCE_SESSION_KEY";

export function commerceSessionStoreReady(): boolean {
  return keyReady(KEY_ENV);
}

/** 평문 storageState → 저장 문자열. 키가 없으면 던진다(평문 저장 금지). */
export function sealCommerceSession(state: unknown): string {
  return sealWith(KEY_ENV, state);
}

/** 저장 문자열 → 평문 storageState. 키가 없거나 못 풀면 null. */
export function openCommerceSession(blob: string | null | undefined): unknown | null {
  return openWith(KEY_ENV, blob);
}
