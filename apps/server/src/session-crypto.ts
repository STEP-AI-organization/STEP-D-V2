/**
 * 로그인 세션(storageState) 봉인 — 제공자 공용 암호화 계층.
 *
 * 네이버(`naver-session-store.ts`)가 먼저 쓰던 것을 쿠팡파트너스가 같이 쓰게 되면서 뽑아냈다.
 * **복사하지 않고 공유하는 이유**는 명확하다 — 암호 코드가 두 벌이 되면 한쪽만 고쳐지는 날이
 * 오고, 그게 세션 유출로 이어진다.
 *
 * ## 왜 암호화가 필수인가
 *
 * **세션 쿠키는 그 계정의 전체 권한이다.** 아이디·비번보다 오히려 위험하다 — 2차인증까지
 * 통과된 상태라 그대로 쓰면 바로 그 계정이 된다(2026-08-27 실측: 빈 브라우저에 쿠키 37개를
 * 주입하니 로그인 상태가 그대로 재현됐다). B2B 로 가면 고객사 법인 계정의 쿠키를 우리가
 * 들고 있는 셈이라, DB 유출 = 고객사 계정 탈취다.
 *
 * 그래서 방향은 셋 다 "안전한 쪽으로 실패":
 *   - 키가 없으면 **저장도 조회도 거부**한다. 평문 폴백은 만들지 않는다 —
 *     "키 설정을 깜빡했는데 조용히 평문으로 저장됐다" 가 제일 나쁜 실패 모드다.
 *   - 복호화 실패(키 교체·손상)는 **null 로 돌려준다.** 잡은 "세션 없음" 으로 끝나고
 *     사람이 다시 올리면 된다 — 예외로 워커를 죽이지 않는다.
 *   - 값은 로그·API 응답에 싣지 않는다. 바깥에는 "있다/없다 + 갱신 시각" 만 나간다.
 *
 * 키 만들기(32바이트 base64):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";

/** 환경변수에서 32바이트 키. 없거나 길이가 다르면 null(조용히 보정하지 않는다). */
function keyOf(envName: string): Buffer | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  // 32바이트가 아니면 자르거나 늘리지 않는다 — 잘못된 키로 암호화하면 나중에 못 푼다는
  // 사실이 그때는 안 보인다.
  if (buf.length !== 32) {
    console.error(`[session-crypto] ${envName} 는 base64 32바이트여야 한다 (현재 ${buf.length})`);
    return null;
  }
  return buf;
}

export function keyReady(envName: string): boolean {
  return keyOf(envName) !== null;
}

/** 평문 storageState(JSON) → 저장 문자열. 키가 없으면 던진다(조용히 평문 저장 금지). */
export function sealWith(envName: string, state: unknown): string {
  const k = keyOf(envName);
  if (!k) throw new Error(`${envName} 미설정 — 세션을 저장할 수 없습니다`);
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, k, iv);
  const body = Buffer.concat([c.update(JSON.stringify(state), "utf-8"), c.final()]);
  const tag = c.getAuthTag();
  // v1:<iv>:<tag>:<ciphertext> — 앞에 버전을 둬야 나중에 알고리즘을 바꿔도 옛 값을 읽는다.
  return ["v1", iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/** 저장 문자열 → 평문 storageState. 키가 없거나 못 풀면 null(예외 대신). */
export function openWith(envName: string, blob: string | null | undefined): unknown | null {
  if (!blob) return null;
  const k = keyOf(envName);
  if (!k) {
    console.error(`[session-crypto] ${envName} 미설정 — 저장된 세션을 읽을 수 없습니다`);
    return null;
  }
  try {
    const [ver, ivB, tagB, bodyB] = blob.split(":");
    if (ver !== "v1") throw new Error(`알 수 없는 세션 형식: ${ver}`);
    const d = createDecipheriv(ALG, k, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    const out = Buffer.concat([d.update(Buffer.from(bodyB, "base64")), d.final()]);
    return JSON.parse(out.toString("utf-8"));
  } catch (err) {
    // 키를 바꿨거나 값이 손상됐다. 워커를 죽이지 말고 "세션 없음" 으로 흘려보낸다.
    console.error(`[session-crypto] ${envName} 복호화 실패 — 세션을 다시 올려야 합니다:`,
      err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 올라온 값이 Playwright storageState 모양인지 최소 확인.
 * 아무 JSON 이나 받으면 나중에 브라우저가 열릴 때야 깨진다 — 받을 때 걸러야 한다.
 */
export function looksLikeStorageState(v: unknown): v is { cookies: unknown[] } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.cookies);
}
