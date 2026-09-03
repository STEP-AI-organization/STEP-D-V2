/**
 * 도우미가 쓰는 **읽기 전용** 조회 도구.
 *
 * ## 왜 도구가 따로 필요한가
 *
 * 스냅샷(snapshot.ts)은 매 턴 실리는 숫자 몇 개다. 그걸로 "크레딧 얼마 남았나" 는 답하지만
 * "지난주 올린 3화 왜 안 끝났나" 는 못 답한다. 그런 질문은 **묻고 나서** 찾아야 한다.
 *
 * ## 도구가 하지 않는 것
 *
 * 아무것도 바꾸지 않는다. 분석 재시도·배포 재시도 같은 **실행은 이 단계에 없다** —
 * 크레딧이 실제로 소모되므로 오작동이 곧 돈이고, 그건 사람이 버튼을 누르는 자리다.
 * 대신 "어느 화면에서 무엇을 누르면 되는지" 를 링크로 준다.
 *
 * 테넌트 격리는 RLS 가 한다(요청이 `runWithTenant` 안에서 돈다). 여기서 tenant 조건을
 * 또 쓰지 않는다 — 격리가 두 벌이 되면 한 벌은 반드시 샌다.
 */
import { getPool } from "../db-pg.ts";

/** 한 번에 돌려주는 행 수. 모델이 읽고 요약할 만큼만 — 많이 줘도 답이 좋아지지 않는다. */
const LIMIT = 5;
/** 실패 목록의 조회 창(일). */
const FAIL_DAYS = 14;

/** Vertex `functionDeclarations` 형태. 모델이 이 설명만 보고 도구를 고른다. */
export const READ_TOOL_DECLARATIONS = [
  {
    name: "lookup_media",
    description:
      "회차·영상을 제목으로 찾아 지금 상태(분석 중/완료/실패)와 화면 링크를 돌려준다. " +
      "사용자가 특정 회차·영상을 짚어 물을 때 쓴다. 예: '3화 분석 끝났어?', '신병 4화 어디까지 됐어?'",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "찾을 제목의 일부. 예: '3화', '신병'" },
      },
      required: ["query"],
    },
  },
  {
    name: "recent_failures",
    description:
      "최근 실패한 작업과 배포를 사유와 함께 돌려준다. " +
      "사용자가 '왜 안 돼', '실패한 게 뭐야' 처럼 원인을 물을 때 쓴다.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["all", "job", "distribution"],
          description: "job=분석·렌더 등 내부 작업, distribution=채널 배포, all=둘 다(기본)",
        },
      },
    },
  },
] as const;

export interface MediaHit {
  id: string;
  title: string;
  /** 회차에 붙어 있으면 회차 상세로, 아니면 미디어 목록으로 보낸다. */
  link: string;
  durationMin: number;
  analysis: { status: string; error: string | null } | null;
  shorts: number;
  clips: number;
}

/**
 * 제목으로 영상 찾기.
 *
 * 분석 상태는 `job_queue` 의 `content.analyze` 잡에서 읽는다 — 미디어 행에는 "분석했다"는
 * 표시가 없고, 사람이 알고 싶은 건 **지금 도는가·왜 멈췄나** 라서 잡 쪽이 정답이다.
 * 같은 미디어에 잡이 여럿이면(재분석) 가장 최근 것만 본다.
 */
export async function lookupMedia(query: string): Promise<MediaHit[]> {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const { rows } = await getPool().query(
    `SELECT m.id, m.title, m.episodeid AS "episodeId", m.durationsec AS "durationSec"
       FROM media m
      WHERE m.title ILIKE $1
      ORDER BY m.createdat DESC
      LIMIT $2`,
    [`%${q}%`, LIMIT],
  );
  if (!rows.length) return [];

  const ids: string[] = rows.map((r: any) => r.id);

  // 미디어별 최신 분석 잡. DISTINCT ON 으로 한 번에 — 미디어 수만큼 왕복하지 않는다.
  const jobs = await getPool().query(
    `SELECT DISTINCT ON (payload->>'mediaId')
            payload->>'mediaId' AS media_id, status, error
       FROM job_queue
      WHERE type = 'content.analyze' AND payload->>'mediaId' = ANY($1)
      ORDER BY payload->>'mediaId', updatedAt DESC`,
    [ids],
  );
  const jobBy = new Map<string, { status: string; error: string | null }>(
    jobs.rows.map((r: any) => [r.media_id, { status: r.status, error: r.error ?? null }]),
  );

  // 이 원본에서 나온 결과물 수. 사람이 "3화 몇 개 나왔어?" 를 자주 묻는다.
  // 숏폼/클립 구분은 `clipType` 이다 — "T6" 이 숏폼이고 나머지가 가로 클립
  // (index.ts 채택부: `clipType: rec.kind === "short" ? "T6" : "TZ"`).
  const made = await getPool().query(
    `SELECT data->>'sourceMediaId' AS media_id,
            COUNT(*) FILTER (WHERE data->>'clipType' =  'T6')::int AS shorts,
            COUNT(*) FILTER (WHERE data->>'clipType' IS DISTINCT FROM 'T6')::int AS clips
       FROM entities
      WHERE kind = 'clip' AND data->>'sourceMediaId' = ANY($1)
      GROUP BY 1`,
    [ids],
  );
  const madeBy = new Map<string, { shorts: number; clips: number }>(
    made.rows.map((r: any) => [r.media_id, { shorts: r.shorts ?? 0, clips: r.clips ?? 0 }]),
  );

  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    link: r.episodeId ? `/episodes/${r.episodeId}` : "/media",
    durationMin: Math.round(Number(r.durationSec ?? 0) / 60),
    analysis: jobBy.get(r.id) ?? null,
    shorts: madeBy.get(r.id)?.shorts ?? 0,
    clips: madeBy.get(r.id)?.clips ?? 0,
  }));
}

export interface FailureItem {
  kind: "job" | "distribution";
  what: string;
  reason: string;
  link: string;
}

/**
 * 최근 실패 목록.
 *
 * 잡과 배포를 **한 목록으로 합친다.** 사용자에게는 둘 다 "안 된 것" 이고, 어느 쪽 실패인지는
 * 우리 내부 구분이다. 다만 고치는 자리가 달라서(작업=운영 진단, 배포=배포 화면) 링크는 나눈다.
 */
export async function recentFailures(kind: "all" | "job" | "distribution" = "all"): Promise<FailureItem[]> {
  const since = Date.now() - FAIL_DAYS * 24 * 60 * 60 * 1000;
  const out: FailureItem[] = [];

  if (kind !== "distribution") {
    const { rows } = await getPool().query(
      `SELECT type, error FROM job_queue
        WHERE status = 'failed' AND updatedAt > $1
        ORDER BY updatedAt DESC LIMIT $2`,
      [since, LIMIT],
    );
    for (const r of rows) {
      out.push({
        kind: "job",
        what: JOB_LABEL[r.type] ?? r.type,
        reason: shorten(r.error) || "사유가 기록되지 않았습니다",
        link: "/ops",
      });
    }
  }

  if (kind !== "job") {
    const { rows } = await getPool().query(
      `SELECT e.data->>'title' AS title, d->>'channel' AS channel, d->>'error' AS error
         FROM entities e,
              jsonb_array_elements(COALESCE(e.data->'distributions', '[]'::jsonb)) d
        WHERE e.kind = 'clip' AND d->>'status' = 'failed'
        LIMIT $1`,
      [LIMIT],
    );
    for (const r of rows) {
      out.push({
        kind: "distribution",
        what: `${r.title ?? "제목 없음"} → ${CHANNEL_LABEL[r.channel] ?? r.channel}`,
        reason: shorten(r.error) || "사유가 기록되지 않았습니다",
        link: "/distribution",
      });
    }
  }

  return out;
}

/** 내부 잡 이름을 사람 말로. 모르는 타입은 그대로 — 지어내지 않는다. */
const JOB_LABEL: Record<string, string> = {
  "content.analyze": "영상 분석",
  "clip.render": "영상 만들기(렌더)",
  "clip.reframe": "세로 변환",
  "media.transcode": "영상 변환",
  "distribution.publish": "채널 배포",
  "thumbnail.generate": "썸네일 생성",
  "channel.analyze": "채널 지표 수집",
  "naver.publish": "네이버 배포",
};

const CHANNEL_LABEL: Record<string, string> = {
  youtube: "유튜브", instagram: "인스타그램", facebook: "페이스북",
  tiktok: "틱톡", naver: "네이버", smr: "SMR",
};

/** 사유는 한 줄이면 충분하다. 스택트레이스가 답변에 실리면 사용자가 읽지 않는다. */
function shorten(err: unknown): string {
  const s = String(err ?? "").split("\n")[0].trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
