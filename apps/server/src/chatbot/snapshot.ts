/**
 * 워크스페이스 현황 한 줌 — **매 턴 프롬프트에 실린다.**
 *
 * ## 왜 `getState()` 를 안 쓰나
 *
 * 이미 "워크스페이스 전체"를 주는 함수가 있다(`db-pg.ts` `getState`). 하지만 그건 프로그램·
 * 회차·추천·클립·미디어를 통째로 싣는 화면용 덤프고, 전 라우트 중 가장 느리다(실측 0.4s).
 * 도우미가 매 턴 그걸 부르면 대화가 느려지고, 프롬프트에 넣을 수도 없다(수 MB).
 *
 * 여기서는 **숫자 몇 개만** 읽는다. 사람이 도우미에게 묻는 것의 대부분은
 * "지금 어떻게 돼 있나" 이지 "전부 보여 달라" 가 아니다. 더 필요하면 도구(tools.ts)가
 * 그때 좁게 조회한다.
 *
 * 테넌트 격리는 여기서 하지 않는다 — 모든 표에 RLS 가 걸려 있고 요청은
 * `runWithTenant` 안에서 돈다. 조건을 하나 더 쓰면 격리가 두 벌이 되고 한 벌은 샌다.
 */
import { getPool, creditBalance } from "../db-pg.ts";
import { getWorkspace } from "../auth/auth.ts";
import type { Role } from "../auth/auth.ts";
import { knownScreen } from "./catalog.ts";

export interface WorkspaceSnapshot {
  workspace: string;
  role: Role;
  /** 크레딧 잔액(개). 1개 = 분석 1분. */
  credits: number;
  channels: { youtube: number; facebook: number; instagram: number; tiktok: number; naver: number };
  /** 지금 대기·진행 중인 분석 건수. */
  analyzing: number;
  /** 최근 7일 안에 실패한 작업 수 — "왜 안 되지" 의 첫 단서. */
  failedJobs7d: number;
  /** 아직 사람이 안 본 실패 배포 건수(영상×채널). */
  failedDistributions: number;
  programs: number;
  /** 사용자가 지금 보고 있는 화면. 모르면 null. */
  screen: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "소유자", admin: "관리자", member: "멤버", superadmin: "운영자",
};

/** 7일. 실패를 "최근" 으로 볼 창 — 이보다 오래된 실패는 이미 지나간 일이다. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadSnapshot(
  user: { tenantId: string; role: Role },
  screen?: string | null,
): Promise<WorkspaceSnapshot> {
  const since = Date.now() - RECENT_MS;

  // 카운트만 여러 개라 **한 번의 왕복**으로 끝낸다. 서브쿼리마다 표가 달라도
  // 플래너가 각각 인덱스를 쓴다 — 라운드트립 다섯 번보다 싸다.
  const counts = getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM job_queue
         WHERE type = 'content.analyze' AND status IN ('pending','running'))::int   AS analyzing,
       (SELECT COUNT(*) FROM job_queue
         WHERE status = 'failed' AND updatedAt > $1)::int                            AS failed_jobs,
       (SELECT COUNT(*) FROM entities WHERE kind = 'program')::int                   AS programs,
       (SELECT COUNT(*) FROM youtube_channels   WHERE status <> 'disconnected')::int AS youtube,
       (SELECT COUNT(*) FROM meta_accounts      WHERE status <> 'disconnected')::int AS facebook,
       (SELECT COUNT(*) FROM instagram_accounts WHERE status <> 'disconnected')::int AS instagram,
       (SELECT COUNT(*) FROM tiktok_accounts    WHERE status <> 'disconnected')::int AS tiktok,
       (SELECT COUNT(*) FROM naver_account)::int                                     AS naver`,
    [since],
  );

  // 배포는 클립 엔티티의 JSONB 배열 안에 있다. 표가 따로 없으므로 펼쳐서 센다.
  const failedDist = getPool().query(
    `SELECT COUNT(*)::int AS n
       FROM entities e,
            jsonb_array_elements(COALESCE(e.data->'distributions', '[]'::jsonb)) d
      WHERE e.kind = 'clip' AND d->>'status' = 'failed'`,
  );

  const [c, fd, ws, credits] = await Promise.all([
    counts, failedDist, getWorkspace(user.tenantId).catch(() => null), creditBalance().catch(() => 0),
  ]);

  const row = c.rows[0] ?? {};
  return {
    workspace: ws?.name || "워크스페이스",
    role: user.role,
    credits,
    channels: {
      youtube: row.youtube ?? 0, facebook: row.facebook ?? 0,
      instagram: row.instagram ?? 0, tiktok: row.tiktok ?? 0, naver: row.naver ?? 0,
    },
    analyzing: row.analyzing ?? 0,
    failedJobs7d: row.failed_jobs ?? 0,
    failedDistributions: fd.rows[0]?.n ?? 0,
    programs: row.programs ?? 0,
    screen: screen ? (knownScreen(screen)?.href ?? null) : null,
  };
}

/**
 * 프롬프트에 싣는 형태. **JSON 이 아니라 문장**으로 준다 — 모델이 그대로 인용하기 쉽고,
 * 같은 정보를 JSON 으로 주는 것보다 토큰이 적다.
 */
export function snapshotText(s: WorkspaceSnapshot): string {
  const ch = Object.entries(s.channels)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}개`)
    .join(", ") || "없음";
  const lines = [
    `워크스페이스: ${s.workspace} · 이 사용자 권한: ${ROLE_LABEL[s.role] ?? s.role}`,
    `크레딧 잔액: ${s.credits}개 (1개 = 분석 1분)`,
    `연결된 채널: ${ch}`,
    `등록 프로그램: ${s.programs}개`,
    `진행 중인 분석: ${s.analyzing}건`,
    `최근 7일 실패한 작업: ${s.failedJobs7d}건`,
    `실패한 배포: ${s.failedDistributions}건`,
  ];
  if (s.screen) lines.push(`지금 보고 있는 화면: ${s.screen}`);
  return lines.join("\n");
}
