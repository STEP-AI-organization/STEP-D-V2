/**
 * 도메인 접근 계층 — 미디어 중심 정규 테이블.
 *
 * 설계: docs/plans/active/db-normalization-media-centric.md
 *
 * 지금까지 program·episode·clip·recommendation 은 `entities` 의 JSONB 블롭이었고,
 * 코드는 전부 `getEntity<any>` 로 꺼내 썼다 — **타입도 FK 도 없었다.**
 * 오늘 네이버 워커에서 작업 폴더를 만들 때 `program?.tenantName ?? program?.broadcaster` 로
 * 필드를 **추측해서** 짠 게 그 비용이다. 여기 있는 함수는 전부 타입이 있다.
 *
 * ⚠️ 이 파일은 **entities 를 읽지 않는다.** 이관 기간에는 두 경로가 공존하므로,
 * 호출부를 옮길 때 "새 테이블에 아직 없는 행" 을 만날 수 있다. 0027 마이그레이션이
 * 백필했지만, 그 뒤 구 경로로 쓴 데이터는 여기 안 보인다 — 라우트를 옮기는 순서가 중요하다.
 */
import { getPool } from "../db-pg.ts";

const pool = () => getPool();

// ── 타입 ──────────────────────────────────────────────────────────────────────

/** media.kind — master 는 원본, 나머지는 파생물. 파생물은 media_edit 을 갖는다. */
export type MediaKind = "master" | "clip" | "shorts" | "highlight";

export interface Program {
  id: string;
  title: string;
  section: string | null;
  targetAge: string | null;
  status: string;
  owner: string | null;
  endedDate: string | null;
  rightsUntil: string | null;
  rightsNote: string | null;
  pipelineGenre: string | null;
  createdAt: number;
  /** episode 카운트로 뽑는다 — 컬럼으로 저장하지 않는다(손으로 갱신하면 어긋난다). */
  episodeCount?: number;
}

export interface Episode {
  id: string;
  programId: string | null;
  episodeNumber: number | null;
  broadDate: string | null;
  targetAge: string | null;
  sourceChannelId: string | null;
  sourceVideoId: string | null;
  pipeline: unknown;
  createdAt: number;
  /** 조인으로 얻는다 — episode 에 사본을 두지 않는다(프로그램명 바꿔도 따라온다). */
  programTitle?: string | null;
}

/** 파생물 = media(kind≠master) + media_edit. 두 테이블을 조인한 모습이다. */
export interface Derivative {
  mediaId: string;
  kind: MediaKind;
  episodeId: string | null;
  sourceMediaId: string | null;
  title: string | null;
  synopsis: string | null;
  status: string | null;
  rendered: boolean;
  aspectRatio: string | null;
  startTime: number | null;
  endTime: number | null;
  hookTimeSec: number | null;
  targetChannel: string | null;
  sourceRecommendationId: string | null;
  editorState: unknown;
  /** media 쪽 파일 정보 */
  path: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbPath: string | null;
  createdAt: number;
}

export interface Distribution {
  id: string;
  mediaId: string;
  channel: string;
  accountId: string | null;
  status: string;
  url: string | null;
  error: string | null;
  scheduledAt: number | null;
  publishedAt: number | null;
}

// ── program ───────────────────────────────────────────────────────────────────

const PROGRAM_COLS = `id, title, section, target_age AS "targetAge", status, owner,
  ended_date AS "endedDate", rights_until AS "rightsUntil", rights_note AS "rightsNote",
  pipeline_genre AS "pipelineGenre", created_at AS "createdAt"`;

export async function listPrograms(): Promise<Program[]> {
  // episodeCount 는 조인으로 센다. 컬럼으로 두면 회차를 지웠을 때 어긋난다.
  const { rows } = await pool().query(
    `SELECT p.id, p.title, p.section, p.target_age AS "targetAge", p.status, p.owner,
            p.ended_date AS "endedDate", p.rights_until AS "rightsUntil",
            p.rights_note AS "rightsNote", p.pipeline_genre AS "pipelineGenre",
            p.created_at AS "createdAt",
            (SELECT count(*)::int FROM episode e WHERE e.program_id = p.id) AS "episodeCount"
       FROM program p ORDER BY p.created_at DESC`);
  return rows as Program[];
}

export async function getProgram(id: string): Promise<Program | undefined> {
  const { rows } = await pool().query(`SELECT ${PROGRAM_COLS} FROM program WHERE id = $1`, [id]);
  return rows[0] as Program | undefined;
}

export async function upsertProgram(p: Partial<Program> & { id: string; title: string }): Promise<void> {
  await pool().query(
    `INSERT INTO program (id, title, section, target_age, status, owner, ended_date,
       rights_until, rights_note, pipeline_genre, created_at, updated_at)
     VALUES ($1,$2,$3,$4,COALESCE($5,'airing'),$6,$7,$8,$9,$10,COALESCE($11::bigint,$12::bigint),$12::bigint)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, section = EXCLUDED.section, target_age = EXCLUDED.target_age,
       status = EXCLUDED.status, owner = EXCLUDED.owner, ended_date = EXCLUDED.ended_date,
       rights_until = EXCLUDED.rights_until, rights_note = EXCLUDED.rights_note,
       pipeline_genre = EXCLUDED.pipeline_genre, updated_at = EXCLUDED.updated_at`,
    [p.id, p.title, p.section ?? null, p.targetAge ?? null, p.status ?? null, p.owner ?? null,
     p.endedDate ?? null, p.rightsUntil ?? null, p.rightsNote ?? null, p.pipelineGenre ?? null,
     p.createdAt ?? null, Date.now()]);
}

// ── episode ───────────────────────────────────────────────────────────────────

const EPISODE_SELECT = `e.id, e.program_id AS "programId", e.episode_number AS "episodeNumber",
  e.broad_date AS "broadDate", e.target_age AS "targetAge",
  e.source_channel_id AS "sourceChannelId", e.source_video_id AS "sourceVideoId",
  e.pipeline, e.created_at AS "createdAt", p.title AS "programTitle"`;

export async function listEpisodes(programId?: string): Promise<Episode[]> {
  const where = programId ? "WHERE e.program_id = $1" : "";
  const { rows } = await pool().query(
    `SELECT ${EPISODE_SELECT} FROM episode e LEFT JOIN program p ON p.id = e.program_id
     ${where} ORDER BY e.broad_date DESC NULLS LAST, e.created_at DESC`,
    programId ? [programId] : []);
  return rows as Episode[];
}

export async function getEpisode(id: string): Promise<Episode | undefined> {
  const { rows } = await pool().query(
    `SELECT ${EPISODE_SELECT} FROM episode e LEFT JOIN program p ON p.id = e.program_id
      WHERE e.id = $1`, [id]);
  return rows[0] as Episode | undefined;
}

export async function upsertEpisode(e: Partial<Episode> & { id: string }): Promise<void> {
  await pool().query(
    `INSERT INTO episode (id, program_id, episode_number, broad_date, target_age,
       source_channel_id, source_video_id, pipeline, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::bigint,$10::bigint),$10::bigint)
     ON CONFLICT (id) DO UPDATE SET
       program_id = EXCLUDED.program_id, episode_number = EXCLUDED.episode_number,
       broad_date = EXCLUDED.broad_date, target_age = EXCLUDED.target_age,
       source_channel_id = EXCLUDED.source_channel_id,
       source_video_id = EXCLUDED.source_video_id,
       pipeline = COALESCE(EXCLUDED.pipeline, episode.pipeline),
       updated_at = EXCLUDED.updated_at`,
    [e.id, e.programId ?? null, e.episodeNumber ?? null, e.broadDate ?? null, e.targetAge ?? null,
     e.sourceChannelId ?? null, e.sourceVideoId ?? null,
     e.pipeline ? JSON.stringify(e.pipeline) : null, e.createdAt ?? null, Date.now()]);
}

/** 파이프라인 진행률만 갱신 — 잦은 부분 업데이트라 전체 upsert 를 쓰지 않는다. */
export async function setEpisodePipeline(id: string, pipeline: unknown): Promise<void> {
  await pool().query(
    `UPDATE episode SET pipeline = $2, updated_at = $3 WHERE id = $1`,
    [id, JSON.stringify(pipeline), Date.now()]);
}

// ── 파생물 (clip · shorts · highlight) ─────────────────────────────────────────

const DERIV_SELECT = `me.media_id AS "mediaId", m.kind, me.episode_id AS "episodeId",
  m.source_media_id AS "sourceMediaId", me.title, me.synopsis, me.status, me.rendered,
  me.aspect_ratio AS "aspectRatio", me.start_time AS "startTime", me.end_time AS "endTime",
  me.hook_time_sec AS "hookTimeSec", me.target_channel AS "targetChannel",
  me.source_recommendation_id AS "sourceRecommendationId", me.editor_state AS "editorState",
  m.path, m.durationsec AS "durationSec", m.width, m.height, m.thumbpath AS "thumbPath",
  me.created_at AS "createdAt"`;

/** kind 를 주면 그 종류만. 안 주면 파생물 전부(master 제외). */
export async function listDerivatives(
  opts: { episodeId?: string; kind?: MediaKind } = {},
): Promise<Derivative[]> {
  const w: string[] = [];
  const a: unknown[] = [];
  if (opts.episodeId) { a.push(opts.episodeId); w.push(`me.episode_id = $${a.length}`); }
  if (opts.kind) { a.push(opts.kind); w.push(`m.kind = $${a.length}`); }
  const { rows } = await pool().query(
    `SELECT ${DERIV_SELECT} FROM media_edit me JOIN media m ON m.id = me.media_id
     ${w.length ? "WHERE " + w.join(" AND ") : ""}
     ORDER BY me.created_at DESC`, a);
  return rows as Derivative[];
}

export async function getDerivative(mediaId: string): Promise<Derivative | undefined> {
  const { rows } = await pool().query(
    `SELECT ${DERIV_SELECT} FROM media_edit me JOIN media m ON m.id = me.media_id
      WHERE me.media_id = $1`, [mediaId]);
  return rows[0] as Derivative | undefined;
}

export async function upsertDerivative(
  d: Partial<Derivative> & { mediaId: string },
): Promise<void> {
  await pool().query(
    `INSERT INTO media_edit (media_id, episode_id, title, synopsis, status, rendered,
       aspect_ratio, start_time, end_time, hook_time_sec, target_channel,
       source_recommendation_id, editor_state, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false),$7,$8,$9,$10,$11,$12,$13::jsonb,COALESCE($14::bigint,$15::bigint),$15::bigint)
     ON CONFLICT (media_id) DO UPDATE SET
       episode_id = COALESCE(EXCLUDED.episode_id, media_edit.episode_id),
       title = COALESCE(EXCLUDED.title, media_edit.title),
       synopsis = COALESCE(EXCLUDED.synopsis, media_edit.synopsis),
       status = COALESCE(EXCLUDED.status, media_edit.status),
       rendered = EXCLUDED.rendered,
       aspect_ratio = COALESCE(EXCLUDED.aspect_ratio, media_edit.aspect_ratio),
       start_time = COALESCE(EXCLUDED.start_time, media_edit.start_time),
       end_time = COALESCE(EXCLUDED.end_time, media_edit.end_time),
       hook_time_sec = COALESCE(EXCLUDED.hook_time_sec, media_edit.hook_time_sec),
       target_channel = COALESCE(EXCLUDED.target_channel, media_edit.target_channel),
       editor_state = COALESCE(EXCLUDED.editor_state, media_edit.editor_state),
       updated_at = EXCLUDED.updated_at`,
    [d.mediaId, d.episodeId ?? null, d.title ?? null, d.synopsis ?? null, d.status ?? null,
     d.rendered ?? null, d.aspectRatio ?? null, d.startTime ?? null, d.endTime ?? null,
     d.hookTimeSec ?? null, d.targetChannel ?? null, d.sourceRecommendationId ?? null,
     d.editorState ? JSON.stringify(d.editorState) : null, d.createdAt ?? null, Date.now()]);
}

// ── 배포 ──────────────────────────────────────────────────────────────────────

const DIST_COLS = `id, media_id AS "mediaId", channel, account_id AS "accountId", status,
  url, error, scheduled_at AS "scheduledAt", published_at AS "publishedAt"`;

export async function listDistributions(mediaId: string): Promise<Distribution[]> {
  const { rows } = await pool().query(
    `SELECT ${DIST_COLS} FROM distribution WHERE media_id = $1 ORDER BY channel`, [mediaId]);
  return rows as Distribution[];
}

/**
 * 채널 하나의 배포 상태를 기록한다.
 *
 * JSONB 배열 시절에는 배열을 통째로 읽어 수정해 다시 써야 했고, 두 채널이 동시에 끝나면
 * 한쪽이 덮였다. UNIQUE(media_id, channel) + upsert 라 그 경합이 사라진다.
 */
export async function recordDistribution(
  mediaId: string, channel: string,
  patch: { status?: string; url?: string | null; error?: string | null;
           accountId?: string | null; scheduledAt?: number | null; publishedAt?: number | null },
): Promise<void> {
  await pool().query(
    `INSERT INTO distribution (id, media_id, channel, account_id, status, url, error,
       scheduled_at, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,COALESCE($5,'pending'),$6,$7,$8::bigint,$9::bigint,$10::bigint,$10::bigint)
     ON CONFLICT (media_id, channel) DO UPDATE SET
       account_id   = COALESCE(EXCLUDED.account_id, distribution.account_id),
       status       = COALESCE(EXCLUDED.status, distribution.status),
       url          = COALESCE(EXCLUDED.url, distribution.url),
       -- 성공하면 이전 에러를 지운다. COALESCE 로 두면 옛 에러가 영원히 남는다.
       error        = CASE WHEN EXCLUDED.status = 'published' THEN NULL
                           ELSE COALESCE(EXCLUDED.error, distribution.error) END,
       scheduled_at = COALESCE(EXCLUDED.scheduled_at, distribution.scheduled_at),
       published_at = COALESCE(EXCLUDED.published_at, distribution.published_at),
       updated_at   = EXCLUDED.updated_at`,
    [`${mediaId}:${channel}`, mediaId, channel, patch.accountId ?? null, patch.status ?? null,
     patch.url ?? null, patch.error ?? null, patch.scheduledAt ?? null,
     patch.publishedAt ?? null, Date.now()]);
}

/** 채널별 배포 현황 — JSONB 배열 시절에는 앱에서 펼쳐야 했던 질의. */
export async function distributionStats(): Promise<{ channel: string; status: string; n: number }[]> {
  const { rows } = await pool().query(
    `SELECT channel, status, count(*)::int AS n FROM distribution
      GROUP BY channel, status ORDER BY channel, status`);
  return rows as { channel: string; status: string; n: number }[];
}

// ── entities → 정규 테이블 이중 쓰기 (이관 기간 전용) ──────────────────────────
//
// 호출부가 124곳(index.ts 만 60곳)이고 그 파일은 지금 프론트 개편과 함께 재작성 중이다.
// 거기를 동시에 고치면 충돌이 확정이라, **저장 계층에서 미러링**한다:
//   putEntity() → entities 에 쓰고 → 여기서 정규 테이블에도 반영
//
// 그래서 라우트를 한 줄도 안 고쳐도 새 테이블이 최신을 유지한다. 라우트는 나중에 파일
// 단위로 옮기면 되고, 다 옮긴 뒤 이 함수와 entities 를 함께 지운다.
//
// ⚠️ 미러링 실패가 요청을 깨뜨리지 않게 한다 — 이관 기간에는 entities 가 진실이다.
//    다만 **조용히 넘기지는 않는다.** 어긋난 걸 모르면 나중에 더 비싸다.

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export async function mirrorEntity(kind: string, id: string, data: any): Promise<void> {
  try {
    if (kind === "program") {
      await upsertProgram({
        id, title: String(data?.title ?? "(제목 없음)"),
        section: data?.section ?? null, targetAge: data?.targetAge ?? null,
        status: data?.status ?? "airing", owner: data?.owner ?? null,
        endedDate: data?.endedDate ?? null, rightsUntil: data?.rightsUntil ?? null,
        rightsNote: data?.rightsNote ?? null, pipelineGenre: data?.pipelineGenre ?? null,
        createdAt: num(data?.createdAt) ?? Date.now(),
      });
    } else if (kind === "episode") {
      await upsertEpisode({
        id, programId: data?.programId ?? null,
        episodeNumber: num(data?.episodeNumber), broadDate: data?.broadDate ?? null,
        targetAge: data?.targetAge ?? null, sourceChannelId: data?.sourceChannelId ?? null,
        sourceVideoId: data?.sourceVideoId ?? null, pipeline: data?.pipeline ?? null,
        createdAt: num(data?.createdAt) ?? Date.now(),
      });
    } else if (kind === "clip") {
      // media 행이 없으면 media_edit 을 만들 수 없다(PK 가 media_id 다). 아직 렌더 전이라
      // 파생 미디어가 존재하지 않는 정상 상태이므로 조용히 건너뛴다.
      if (!data?.mediaId) return;
      await upsertDerivative({
        mediaId: String(data.mediaId), episodeId: data?.episodeId ?? null,
        title: data?.title ?? null, synopsis: data?.synopsis ?? null,
        status: data?.status ?? null, rendered: Boolean(data?.rendered),
        aspectRatio: data?.aspectRatio ?? null,
        startTime: num(data?.startTime), endTime: num(data?.endTime),
        hookTimeSec: num(data?.hookTimeSec), targetChannel: data?.targetChannel ?? null,
        sourceRecommendationId: data?.sourceRecommendationId ?? null,
        editorState: data?.editorState ?? null,
        createdAt: num(data?.createdAt) ?? Date.now(),
      });
      // distributions JSONB 배열 → 행. 채널당 한 줄.
      for (const d of Array.isArray(data?.distributions) ? data.distributions : []) {
        if (!d?.channel) continue;
        await recordDistribution(String(data.mediaId), String(d.channel), {
          status: d.status ?? null, url: d.url ?? null, error: d.error ?? null,
          publishedAt: num(d.publishedAt), scheduledAt: num(d.scheduledAt),
        });
      }
    } else if (kind === "recommendation") {
      await pool().query(
        `INSERT INTO recommendation (id, episode_id, kind, title, start_time, end_time,
           hook_time_sec, hook_quote, hook_intro_caption, hook_strength, appeal, payoff,
           edit_note, completeness, score100, status, tags, channel_scores,
           thumbnail_candidates, selected_thumbnail_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20,
                 COALESCE($21::bigint,$22::bigint),$22::bigint)
         ON CONFLICT (id) DO UPDATE SET
           episode_id = EXCLUDED.episode_id, title = EXCLUDED.title,
           start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
           status = EXCLUDED.status, score100 = EXCLUDED.score100,
           selected_thumbnail_id = EXCLUDED.selected_thumbnail_id,
           thumbnail_candidates = COALESCE(EXCLUDED.thumbnail_candidates,
                                           recommendation.thumbnail_candidates),
           updated_at = EXCLUDED.updated_at`,
        [id, data?.episodeId ?? null, data?.kind ?? null, data?.title ?? null,
         num(data?.startTime), num(data?.endTime), num(data?.hookTimeSec),
         data?.hookQuote ?? null, data?.hookIntroCaption ?? null, num(data?.hookStrength),
         data?.appeal ?? null, data?.payoff ?? null, data?.editNote ?? null,
         num(data?.completeness), num(data?.score100), data?.status ?? null,
         data?.tags ? JSON.stringify(data.tags) : null,
         data?.channelScores ? JSON.stringify(data.channelScores) : null,
         data?.thumbnailCandidates ? JSON.stringify(data.thumbnailCandidates) : null,
         data?.selectedThumbnailId ?? null, num(data?.createdAt), Date.now()]);
    }
  } catch (err) {
    // 요청을 깨뜨리지 않되 조용히 넘기지도 않는다 — 어긋난 걸 모르면 나중에 더 비싸다.
    console.error(`[domain] 미러링 실패 ${kind}/${id}:`, err instanceof Error ? err.message : err);
  }
}
