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

// ⚠️ **오디언스별로** 캐시한다. Cloud Run ID 토큰은 audience = 받는 서비스 URL 이라야 통과한다
// (오디언스 불일치 = 403). 메인 서버(stepd-server)와 렌더 서비스(stepd-render)는 URL 이 달라
// 토큰도 달라야 한다 — 하나로 캐시하면 렌더 프록시가 서버 오디언스 토큰을 보내 403 이 난다.
const clients = new Map<string, IdTokenClient>();
const inflightByAud = new Map<string, Promise<IdTokenClient>>();

function audienceOf(explicit?: string): string {
  const a = (explicit || process.env.CLOUD_RUN_URL || "").replace(/\/$/, "");
  if (!a) throw new Error("ID token audience 미지정 (CLOUD_RUN_URL 또는 인자 없음)");
  return a;
}

async function createIdTokenClient(audience: string): Promise<IdTokenClient> {
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GCP_SERVICE_ACCOUNT_KEY not set");
  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({ credentials });
  return auth.getIdTokenClient(audience);
}

async function client(audience: string): Promise<IdTokenClient> {
  const c = clients.get(audience);
  if (c) return c;
  // 동시 요청이 각자 클라이언트를 만들지 않게 오디언스당 한 번만 만든다.
  let p = inflightByAud.get(audience);
  if (!p) {
    p = createIdTokenClient(audience)
      .then((cl) => { clients.set(audience, cl); return cl; })
      .catch((e) => { inflightByAud.delete(audience); throw e; });  // ← 실패는 캐시하지 않는다
    inflightByAud.set(audience, p);
  }
  return p;
}

/** Cloud Run 호출용 ID 토큰. audience 를 주면 그 서비스(예: stepd-render)용, 없으면 CLOUD_RUN_URL. */
export async function getIdToken(audience?: string): Promise<string> {
  const aud = audienceOf(audience);
  try {
    const c = await client(aud);
    // getRequestHeaders() 는 fetch Headers 를 돌려준다 — 인덱싱하면 undefined 라
    // 빈 Authorization 이 나가고 403 을 받는다.
    const headers = await c.getRequestHeaders();
    const authorization = headers.get("authorization");
    if (!authorization) {
      throw new Error("google-auth-library 가 Authorization 헤더를 주지 않았다 — CLOUD_RUN_URL(오디언스)과 서비스 계정 키를 확인할 것");
    }
    return authorization;
  } catch (e) {
    // 토큰 발급이 깨지면 그 오디언스 클라이언트를 버린다. 만료·회전 같은 일시적 원인이면
    // 다음 요청이 새로 만들어 회복한다 — 인스턴스가 영구히 죽지 않게.
    clients.delete(aud);
    inflightByAud.delete(aud);
    throw e;
  }
}
