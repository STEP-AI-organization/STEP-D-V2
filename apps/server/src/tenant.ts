/**
 * 테넌트 컨텍스트 — "누구의 데이터인가"를 요청·잡 단위로 들고 다닌다.
 *
 * 왜 AsyncLocalStorage 인가
 *   db-pg.ts 에는 tenant 인자를 받지 않는 조회 함수가 100개 가까이 있고, index.ts 는
 *   6300줄에 라우트 118개다. 모든 시그니처에 tenantId 를 손으로 끼워 넣는 변경은
 *   **한 군데만 빠뜨려도 유출**인데, 빠뜨렸다는 사실이 타입으로도 테스트로도 안 드러난다.
 *   컨텍스트로 들고 다니면 스코프 주입이 db-pg.ts 안 한 곳으로 모이고,
 *   컨텍스트가 없을 때 **던지는(fail-closed)** 것으로 누락을 즉시 드러낼 수 있다.
 *
 * 세 가지 스코프
 *   1. 특정 테넌트  — 일반 요청. 그 테넌트 행만 보인다.
 *   2. ALL_TENANTS  — 전 테넌트 순회가 **본래 목적**인 시스템 작업(스케줄러·큐 워커 디스패치·
 *                     관리자 통계). 반드시 `runAsSystem()` 으로 명시해야 한다.
 *   3. 없음         — 프로그래밍 실수. 조회 시 throw 한다.
 *
 * 3번을 "기본 테넌트로 폴백"으로 만들지 않은 게 이 파일의 핵심이다. 폴백이 있으면
 * 배선을 빼먹어도 화면이 멀쩡히 뜨고, 그 상태로 외부 방송사를 받는 순간 유출된다.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** 기존 데이터 전부의 귀속처 (migrations/0013_tenants.cjs). */
export const DEFAULT_TENANT_ID = "t_default";

/** 전 테넌트 횡단 스코프. 시스템 작업만 쓴다. */
export const ALL_TENANTS = Symbol("ALL_TENANTS");
export type TenantScope = string | typeof ALL_TENANTS;

export interface TenantContext {
  scope: TenantScope;
  /** 어디서 정해진 스코프인지 — 로그·감사용. */
  via: "web" | "api-key" | "internal" | "job" | "system";
  /** 외부 API 키로 들어온 경우의 키 id (ak_xxx). 미터링에 쓴다. */
  apiKeyId?: string;
}

const als = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 전 테넌트 횡단 작업. 목적이 그것인 코드만 쓴다 — 편의로 쓰면 격리가 무의미해진다. */
export function runAsSystem<T>(fn: () => T): T {
  return als.run({ scope: ALL_TENANTS, via: "system" }, fn);
}

export function currentContext(): TenantContext | undefined {
  return als.getStore();
}

/**
 * 현재 스코프. 컨텍스트가 없으면 던진다 — 배선 누락을 조용히 넘기지 않는다.
 * 전 테넌트 조회가 필요하면 `runAsSystem()` 으로 **의도를 적어야** 한다.
 */
export function currentScope(): TenantScope {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      "tenant scope missing — 이 코드 경로가 테넌트 컨텍스트 밖에서 DB를 읽고 있다. " +
        "요청이면 미들웨어(resolveTenant)를, 잡이면 runWithTenant/runAsSystem 을 확인할 것.",
    );
  }
  return ctx.scope;
}

/** 쓰기용. 횡단 스코프에서는 어느 테넌트로 쓸지 결정할 수 없으므로 던진다. */
export function currentTenantId(): string {
  const scope = currentScope();
  if (scope === ALL_TENANTS) {
    throw new Error("tenant scope is ALL_TENANTS — 쓰기에는 구체적인 테넌트가 필요하다.");
  }
  return scope;
}

/**
 * WHERE 절 조각. 파라미터 번호가 이미 n개 쓰인 쿼리에 이어 붙일 수 있게
 * 다음 인덱스를 받아 `{ sql, params }` 를 돌려준다.
 *
 *   const t = tenantWhere(2);                 // $1, $2 를 이미 쓴 쿼리
 *   `SELECT ... WHERE kind = $1 AND id = $2${t.sql}`   // → " AND tenant_id = $3"
 *   [kind, id, ...t.params]
 *
 * 횡단 스코프면 sql 이 빈 문자열이라 필터가 붙지 않는다.
 */
export function tenantWhere(paramOffset: number, column = "tenant_id"): { sql: string; params: string[] } {
  const scope = currentScope();
  if (scope === ALL_TENANTS) return { sql: "", params: [] };
  return { sql: ` AND ${column} = $${paramOffset + 1}`, params: [scope] };
}
