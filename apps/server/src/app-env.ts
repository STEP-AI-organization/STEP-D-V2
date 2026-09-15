import type { Hono } from "hono";

import type { User } from "./auth/auth.ts";

/**
 * Hono 앱의 타입 환경 — 미들웨어가 `c.set("user", …)` 로 심는 것.
 *
 * ## 왜 `index.ts` 밖으로 뺐나 (2026-09-14)
 *
 * 라우트를 도메인 폴더(`<도메인>/routes.ts`)로 옮기는 중인데, 그 파일들이 `Context<AppEnv>`
 * 를 쓴다. `AppEnv` 가 `index.ts` 에 있으면 **`index.ts` → 라우트 파일 → `index.ts`** 로
 * 순환 import 가 된다. ESM 이 돌리기는 하지만, 초기화 순서가 얽히면 "왜 이 상수만 undefined
 * 인가" 같은 방식으로 터진다 — 타입 한 줄 때문에 감수할 위험이 아니다.
 *
 * 그래서 **아무것도 import 하지 않는 쪽**(여기)에 두고 양쪽이 가져다 쓴다.
 */
export type AppEnv = { Variables: { user?: User } };

/**
 * 라우트 등록 함수가 받는 앱 타입.
 *
 * 도메인 파일은 `app.route()` 서브앱이 아니라 **이 앱에 직접 등록**한다
 * (`export function registerXRoutes(app: AppHono) { app.get("/api/x/…", …) }`).
 *
 * ⚠️ 서브앱으로 바꾸지 말 것. 서브앱은 경로가 마운트 지점 기준 **상대경로**가 되는데,
 *    이 리포의 소스 스캔 테스트 **59곳**이 `app.post("/api/superadmin/tenants/:id/api-keys"`
 *    같은 **전체 경로 문자열**을 grep 한다. 상대경로로 바뀌면 그것들이 전부 아무것도 못 찾고
 *    **조용히 초록**이 된다(`tests/sources.ts` 주석의 실패 모드). 함수 등록 방식이면 경로
 *    문자열은 그대로고 들여쓰기만 바뀐다.
 */
export type AppHono = Hono<AppEnv>;
