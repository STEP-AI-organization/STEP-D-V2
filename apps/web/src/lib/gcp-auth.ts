import { GoogleAuth } from "google-auth-library";

/**
 * Cloud Run 호출용 ID 토큰.
 *
 * ⚠️ **거부된 Promise 를 캐시하지 않는다.** 예전에는 `authClient = createIdTokenClient()` 로
 * Promise 를 그대로 담아 뒀는데, 그 Promise 가 한 번 거부되면 그 인스턴스는 **영원히**
 * 같은 거부를 돌려준다. Vercel 은 람다 인스턴스가 여러 개라, 일부만 오염되면
 * "어떤 요청은 200, 어떤 요청은 500"이 되는 간헐 장애로 나타난다(2026-08-11 실제로 겪음).
 * 실패하면 캐시를 비워 다음 요청이 다시 시도하게 한다.
 */
type IdTokenClient = Awaited<ReturnType<GoogleAuth["getIdTokenClient"]>>;

let cached: IdTokenClient | null = null;
let inflight: Promise<IdTokenClient> | null = null;

async function createIdTokenClient(): Promise<IdTokenClient> {
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const targetAudience = process.env.CLOUD_RUN_URL || "";
  if (!keyJson) throw new Error("GCP_SERVICE_ACCOUNT_KEY not set");
  if (!targetAudience) throw new Error("CLOUD_RUN_URL not set (ID token audience)");
  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({ credentials });
  return auth.getIdTokenClient(targetAudience);
}

async function client(): Promise<IdTokenClient> {
  if (cached) return cached;
  // 동시 요청이 각자 클라이언트를 만들지 않게 한 번만 만든다.
  if (!inflight) {
    inflight = createIdTokenClient()
      .then((c) => { cached = c; return c; })
      .catch((e) => { inflight = null; throw e; });  // ← 실패는 캐시하지 않는다
  }
  return inflight;
}

export async function getIdToken(): Promise<string> {
  try {
    const c = await client();
    // getRequestHeaders() 는 fetch Headers 를 돌려준다 — 인덱싱하면 undefined 라
    // 빈 Authorization 이 나가고 403 을 받는다.
    const headers = await c.getRequestHeaders();
    const authorization = headers.get("authorization");
    if (!authorization) {
      throw new Error("google-auth-library 가 Authorization 헤더를 주지 않았다 — CLOUD_RUN_URL(오디언스)과 서비스 계정 키를 확인할 것");
    }
    return authorization;
  } catch (e) {
    // 토큰 발급이 깨지면 클라이언트를 버린다. 만료·회전 같은 일시적 원인이면
    // 다음 요청이 새로 만들어 회복한다 — 인스턴스가 영구히 죽지 않게.
    cached = null;
    inflight = null;
    throw e;
  }
}
