/**
 * OAuth `state` 발급·검증.
 *
 * 예전엔 state 가 그냥 base64(JSON) 이었다 — **서버가 발급한 값인지 아무도 확인하지 않았다.**
 * 그러면 공격자가 자기 code 를 담은 콜백 URL 을 만들어 로그인된 운영자에게 한 번만 열게 하면,
 * 공격자의 채널·페이지·계정이 그 워크스페이스에 "연결됨" 으로 저장된다(세션 쿠키가
 * SameSite=Lax 라 최상위 GET 리다이렉트에 그대로 실린다). 그 뒤 배포 채널이 하나뿐이면
 * 자동 선택까지 되므로, 방송사 클립이 남의 채널로 나갈 수 있는 경로였다.
 *
 * 그래서 state 는 **서버가 만든 난수**이고, 발급 시점의 워크스페이스와 함께 저장한다.
 * 콜백은 (1) 그 난수가 우리가 낸 것인지 (2) 아직 안 쓴 것인지 (3) 지금 세션의 워크스페이스와
 * 같은지 를 확인한다. 셋 중 하나라도 아니면 계정을 붙이지 않는다.
 *
 * 같은 문제를 canva.ts 는 이미 `canva_pkce` 테이블로 풀어 뒀다 — 여기는 그 패턴을 나머지
 * 4종(YouTube·Meta·Instagram·TikTok)에 맞게 일반화한 것이다.
 */
import { randomBytes } from "node:crypto";
import { getPool } from "./db-pg.ts";
import { currentScope } from "./tenant.ts";

const pool = () => getPool();

/** 발급 후 이 시간이 지나면 못 쓴다. 동의 화면에서 머무는 시간을 넉넉히 잡은 값. */
const TTL_MS = 30 * 60_000;

let ready: Promise<void> | undefined;
function ensureTable(): Promise<void> {
  ready ??= pool().query(`
    CREATE TABLE IF NOT EXISTS oauth_state (
      state     TEXT PRIMARY KEY,
      tenant    TEXT NOT NULL,
      payload   JSONB NOT NULL,
      createdAt BIGINT NOT NULL
    )`).then(() => undefined);
  return ready;
}

/** 지금 요청의 워크스페이스 — 세션이 없으면 빈 문자열(그 경우 콜백도 빈 문자열이어야 통과). */
function scopeNow(): string {
  try { return String(currentScope() ?? ""); } catch { return ""; }
}

/**
 * state 발급. payload 는 콜백에서 되돌려받을 값(복귀 경로·모드 등)이고,
 * **브라우저를 거치지만 브라우저가 못 고친다** — 서버가 들고 있기 때문이다.
 */
export async function issueOAuthState(payload: Record<string, unknown>): Promise<string> {
  await ensureTable();
  const state = randomBytes(24).toString("base64url");
  await pool().query(
    "INSERT INTO oauth_state (state, tenant, payload, createdAt) VALUES ($1, $2, $3, $4)",
    [state, scopeNow(), JSON.stringify(payload ?? {}), Date.now()],
  );
  // 만료분은 여기서 같이 치운다 — 따로 sweep 잡을 만들 양이 아니다.
  await pool().query("DELETE FROM oauth_state WHERE createdAt < $1", [Date.now() - TTL_MS])
    .catch(() => undefined);
  return state;
}

/**
 * state 사용(1회용). 우리가 낸 것이 아니거나 만료됐으면 null — 그때는 **계정을 붙이지 말 것.**
 *
 * 워크스페이스는 여기서 비교하지 않고 **돌려준다.** 콜백은 남의 브라우저에서 열릴 수 있어서
 * (외부 채널 연결 링크는 채널 주인이 연다) 쿠키로 판정하면 안 되고, 링크를 발급한
 * 워크스페이스에 붙여야 한다. 호출부가 이 tenant 로 컨텍스트를 고정한다.
 */
export type ConsumedState = { tenant: string; data: Record<string, any> };
export async function consumeOAuthState(raw: string | undefined | null): Promise<ConsumedState | null> {
  const state = String(raw ?? "").trim();
  if (!state) return null;
  await ensureTable();
  const { rows } = await pool().query(
    "DELETE FROM oauth_state WHERE state = $1 RETURNING tenant, payload, createdAt", [state],
  );
  const row = rows[0];
  if (!row) return null;
  if (Number(row.createdat ?? row.createdAt) < Date.now() - TTL_MS) return null;
  const payload = row.payload;
  return {
    tenant: String(row.tenant ?? ""),
    data: (typeof payload === "string" ? JSON.parse(payload) : payload) ?? {},
  };
}
