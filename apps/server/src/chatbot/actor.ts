import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "../app-env.ts";
import { authRequired, type Role } from "../auth/auth.ts";
import { currentTenantId } from "../auth/tenant.ts";
import type { ChatbotError } from "./agent.ts";

/**
 * 챗봇·리포트의 행위자.
 *
 * 세션이 있으면 그 사람이다. **없고 인증이 꺼져 있으면** 로컬 개발 자세이므로 기본
 * 워크스페이스의 공용 행위자로 돈다 — 이 리포의 다른 라우트 전부가 이미 그렇게 동작한다
 * (`resolveTenant` 3번 경로). 여기만 401 을 내면 로컬에서 챗봇만 안 뜨고, 그 이유를
 * 다음 사람이 한참 찾는다.
 *
 * 이 폴백이 안전한 근거는 챗봇에 있지 않다 — **기동 시 `assertAuthPosture()` 가
 * "테넌트 2개 이상 + 인증 꺼짐" 조합을 아예 서빙하지 않는다.** 프로덕션은 AUTH_REQUIRED=1
 * 이라 늘 진짜 세션이다. 그 전제가 깨지면 서버가 통째로 503 이 되지, 여기가 새지 않는다.
 */
export function chatbotActor(c: Context<AppEnv>): { id: string; tenantId: string; role: Role } {
  const user = c.get("user");
  if (user) return { id: user.id, tenantId: user.tenantId, role: user.role };
  if (authRequired()) throw new HTTPException(401, { message: "login required" });
  return { id: "local", tenantId: currentTenantId(), role: "owner" };
}

/** 챗봇 오류 → 상태 코드. 사유를 기계가 읽을 코드로도 준다(위 keyError 와 같은 이유). */
export function chatbotStatus(code: ChatbotError["code"]): 400 | 404 | 409 | 429 {
  if (code === "rate_limited") return 429;
  if (code === "thread_not_found") return 404;
  if (code === "thread_full") return 409;
  return 400;
}
