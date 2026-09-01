/**
 * 네이버 자격증명(아이디/비번) 봉인 — **세션과 다른 키**를 쓴다.
 *
 * 암호화 본체는 `session-crypto.ts` 공용. 여기는 커머스·네이버세션과 같은 얇은 층이지만,
 * 담는 것이 다르므로 키를 갈라 둔다(`NAVER_CRED_KEY`).
 *
 * ## 왜 키를 가르나 — 세션보다 위험한 자산이다
 *
 * 세션 쿠키는 그 서비스에만 통하고, 사용자가 로그아웃하면 죽는다. **비밀번호는 다르다**:
 * 사람들이 다른 서비스에도 같은 걸 쓰고, 본인이 바꾸기 전에는 무효화되지 않는다. 유출 피해가
 * 우리 서비스 밖으로 나간다는 뜻이다. 그래서 세션 키가 새도 자격증명은 안 열리게 분리한다.
 *
 * ## 취급 규칙
 *  - 값을 **로그·API 응답·에러 메시지에 절대 싣지 않는다.** 바깥에는 있다/없다·상태만.
 *  - **검증된 것만 보관한다.** 로그인에 실패하면 지운다 — 틀린 비번을 들고 반복 시도하면
 *    계정이 잠긴다(세션 만료보다 훨씬 나쁜 상태).
 *  - 키가 없으면 저장을 거부한다(평문 폴백 없음).
 *
 * 키 만들기(32바이트 base64):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { keyReady, openWith, sealWith } from "../auth/session-crypto.ts";

const KEY_ENV = "NAVER_CRED_KEY";

export interface NaverCredential {
  id: string;
  pw: string;
}

export function credStoreReady(): boolean {
  return keyReady(KEY_ENV);
}

/** 평문 자격증명 → 저장 문자열. 키가 없으면 던진다. */
export function sealCredential(c: NaverCredential): string {
  if (!c?.id?.trim() || !c?.pw) throw new Error("아이디·비밀번호가 모두 필요합니다");
  return sealWith(KEY_ENV, { id: c.id.trim(), pw: c.pw });
}

/** 저장 문자열 → 평문. 키가 없거나 못 풀면 null(예외 대신 — 워커를 죽이지 않는다). */
export function openCredential(blob: string | null | undefined): NaverCredential | null {
  const v = openWith(KEY_ENV, blob) as Partial<NaverCredential> | null;
  if (!v || typeof v.id !== "string" || typeof v.pw !== "string" || !v.id || !v.pw) return null;
  return { id: v.id, pw: v.pw };
}

/**
 * 화면에 보여줄 아이디 가리기 — `ha983885` → `ha9***85`.
 * 아이디 자체는 비밀이 아니지만, 전부 노출하면 어깨너머·스크린샷으로 새고 무차별 대입의
 * 절반이 된다. "내가 넣은 그 계정이 맞나" 를 확인할 만큼만 보여준다.
 */
export function maskNaverId(id: string): string {
  const s = String(id ?? "");
  if (s.length <= 4) return s ? `${s[0]}***` : "";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}
