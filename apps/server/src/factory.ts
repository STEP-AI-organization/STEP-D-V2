/**
 * 콘텐츠 공장 — 소스 영상 하나 → 분석·쇼츠·클립·배포까지 자동 완주.
 *
 * 사용자 결정 (2026-08-10, docs/plans/active/factory-api-plan.md):
 *   소비자 = AENA(사내) · 배포 = YouTube 전용 · 사람 개입 없음(전자동)
 *
 * **새 파이프라인이 아니다.** 기존 잡(youtube.download · content.analyze ·
 * distribution.publish)을 순서대로 엮는 상태기계일 뿐이다. 그래서 분석·배포 로직을
 * 건드리지 않고, 문제가 생기면 이 파일만 되돌리면 된다.
 *
 * ## 왜 상태기계인가
 * content.analyze 는 실측 16분이다. 오케스트레이터가 그동안 워커를 붙잡고 기다리면
 * drain 모드에서 잡 하나가 워커를 통째로 점유한다. 그래서 **한 걸음 전진하고 재큐**한다
 * — 다음 폴링에서 이어서 본다.
 *
 * ## 전자동의 안전장치 (승인 절차가 아니라 '손 뗄 수 있는 장치')
 *   1. FACTORY_ENABLED  명시적 truthy 일 때만 ingest 를 받는다
 *   2. dryRun           클립까지 만들고 업로드는 안 한다
 *   3. 일일 상한        프로그램당 하루 N개 (기본 5) — 같은 영상 20번 올라가는 사고 방지
 *   4. private 업로드   → 유예 후 공개 전환 (factory.publicize). 되돌리기 = 전환 취소
 */
import { creditBalance, getEntity, putEntity, listEntities, listMedia } from "./db-pg.ts";
import { checkCredits } from "./credits.ts";
import { billableMinutes } from "./billing.ts";
import { commitAndInherit } from "./adopt.ts";
import { dispatchPublish } from "./publish-dispatch.ts";
import { newId } from "./pipeline.ts";
import { enqueue } from "./queue.ts";
import { basicReframeState } from "./reframe.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** 킬 스위치. 잘못된 env 의 실패 모드가 "안 돌아감"이지 "실수로 배포됨"이 아니다. */
export function factoryEnabled(): boolean {
  return TRUTHY.has(String(process.env.FACTORY_ENABLED ?? "").trim().toLowerCase());
}

/** 프로그램당 하루 몇 개까지 자동 배포할 것인가. */
export function dailyCap(): number {
  const n = Number(process.env.FACTORY_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * private 업로드 후 공개 전환까지 유예(ms). 이 사이엔 URL 이 있어도 남이 못 본다.
 *
 * ⚠️ 빈 문자열을 그냥 Number() 에 넣으면 0 이 되어 **유예가 사라진다**(즉시 공개).
 * 안전장치가 조용히 없어지는 방향이라, 빈값·공백은 미설정과 같게 기본값으로 되돌린다.
 * 명시적인 "0" 은 그대로 존중한다 — 유예 없음은 의도할 수 있는 선택이다.
 */
export function publicizeDelayMs(): number {
  const raw = String(process.env.FACTORY_PUBLICIZE_DELAY_MIN ?? "").trim();
  if (raw === "") return 10 * 60_000;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60_000;
}

export type FactoryState =
  | "queued" | "ingesting" | "analyzing" | "adopting"
  | "rendering" | "publishing" | "publicizing"
  | "done" | "failed" | "hold";

export interface FactoryPolicy {
  maxShorts?: number;
  minConfidence?: number;
  dryRun?: boolean;
  /** 업로드 직후 공개로 둘 것인가. 기본 false = private 후 유예 공개. */
  publishPublic?: boolean;
  /** 렌더 템플릿 강제 지정 (자동배포 화면에서 선택). 미지정이면 장르 자동 선택. */
  templateId?: string;
}

export interface FactoryJob {
  id: string;
  state: FactoryState;
  programId: string;
  mediaId?: string;
  episodeId?: string;
  sourceUrl: string;
  targets: string[];              // 지금은 "youtube:<channelId>" 만
  policy: FactoryPolicy;
  idempotencyKey?: string;
  clipIds: string[];
  error?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

function now(): number { return Date.now(); }

/** 워커에서 서버 라우트를 부를 때 쓰는 베이스. */
export function apiBase(): string {
  return (process.env.INTERNAL_API_BASE || process.env.PUBLIC_URL || "http://localhost:4100")
    .replace(/\/+$/, "");
}

/**
 * 워커 → 서버 내부 호출 인증. 두 겹이다:
 *  1. Cloud Run IAM — 서비스가 공개가 아니므로(조직 정책) 메타데이터 서버에서 ID 토큰을
 *     받아 Authorization 에 싣는다. 로컬 dev 엔 메타데이터가 없어 조용히 생략된다.
 *  2. 앱 레벨 — `INTERNAL_API_TOKEN` 공유 토큰 + 현재 잡의 테넌트를 헤더로 넘긴다
 *     (index.ts resolveTenant 의 internal 경로). AUTH_REQUIRED 여도 통과해야 렌더가 돈다.
 * 예전엔 "Cloud Run 은 allow-unauthenticated" 전제로 무인증 fetch 였는데, 그 전제가
 * 깨지면서 렌더 요청이 GFE 401 로 조용히 죽었다 (2026-08-12 스모크 f_1bccf059 실측).
 */
export async function internalHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  const token = process.env.INTERNAL_API_TOKEN;
  if (token) {
    h["x-internal-token"] = token;
    const { currentTenantId } = await import("./tenant.ts");
    try { h["x-tenant-id"] = currentTenantId(); } catch { /* 컨텍스트 없으면 기본 테넌트 */ }
  }
  const aud = apiBase();
  const meta = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(aud)}`,
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) },
  ).catch(() => null);
  if (meta?.ok) h["Authorization"] = `Bearer ${await meta.text()}`;
  return h;
}

async function requestExport(clipId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/clips/${clipId}/export`, {
    method: "POST", headers: await internalHeaders(),
  });
  if (!res.ok) throw new Error(`export ${res.status}`);
}

async function save(job: FactoryJob): Promise<FactoryJob> {
  const next = { ...job, updatedAt: now() };
  await putEntity("factoryJob", next.id, next);
  return next;
}

/**
 * 지정된 타깃이 실제로 배포 가능한 채널인지 검증한다.
 *
 * ingest 시점에 걸러야 한다 — 배포 시점에 알면 워커가 잡을 조용히 버리고(loadActiveChannel
 * 이 null 이면 경고만 남기고 drop) 공장은 "배포됨"으로 끝나 버린다. 그게 가장 나쁜 실패다.
 */
export async function validateTargets(targets: string[]): Promise<string[]> {
  const { listYouTubeChannels } = await import("./db-pg.ts");
  const channels = await listYouTubeChannels();
  const problems: string[] = [];

  for (const t of targets) {
    if (!t.startsWith("youtube:")) { problems.push(`${t}: YouTube 만 실송출합니다`); continue; }
    const id = t.slice("youtube:".length).trim();
    const ch = channels.find((c: any) => c.channelId === id);
    if (!ch) { problems.push(`${t}: 연동되지 않은 채널`); continue; }
    // active 가 아니면 전부 막는다 — revoked(구글이 끊음)·disconnected(사람이 연동해제) 포함.
    if ((ch as any).status !== "active" || !(ch as any).refreshToken) {
      problems.push(`${t}: 연결이 끊겼습니다 (재연동 필요)`); continue;
    }
    const { scopeCanPublish } = await import("./youtube.ts");
    if (!scopeCanPublish((ch as any).scope)) {
      problems.push(`${t}: 업로드 권한 없음 (분석 전용으로 연결됨 — 게시 모드로 재연결 필요)`);
    }
  }
  return problems;
}

/** 같은 요청이 두 번 오면 기존 잡을 돌려준다 — 재작업도 이중 배포도 하지 않는다. */
export async function findByIdempotencyKey(key: string): Promise<FactoryJob | undefined> {
  if (!key) return undefined;
  const all = await listEntities<FactoryJob>("factoryJob");
  return all.find((j) => j.idempotencyKey === key);
}

export async function createJob(input: {
  sourceUrl: string;
  programId: string;
  targets: string[];
  policy?: FactoryPolicy;
  idempotencyKey?: string;
}): Promise<FactoryJob> {
  const job: FactoryJob = {
    id: newId("f"),
    state: "queued",
    programId: input.programId,
    sourceUrl: input.sourceUrl,
    targets: input.targets,
    policy: input.policy ?? {},
    idempotencyKey: input.idempotencyKey,
    clipIds: [],
    createdAt: now(),
    updatedAt: now(),
  };
  await save(job);
  await enqueue("factory.orchestrate", { factoryJobId: job.id },
    { dedupeKey: `factory.orchestrate:${job.id}` });
  return job;
}

/** 오늘 이 프로그램으로 자동 배포된 클립 수 — 일일 상한 판정용. */
async function publishedToday(programId: string): Promise<number> {
  const since = now() - 24 * 60 * 60 * 1000;
  const jobs = await listEntities<FactoryJob>("factoryJob");
  return jobs
    .filter((j) => j.programId === programId && j.updatedAt >= since)
    .filter((j) => j.state === "publishing" || j.state === "publicizing" || j.state === "done")
    .reduce((n, j) => n + j.clipIds.length, 0);
}

/**
 * 한 걸음 전진. 반환값은 "다음에 언제 다시 볼지"(ms) — null 이면 종료 상태다.
 * 여기서 절대 오래 기다리지 않는다. 기다림은 재큐로 표현한다.
 */
export async function advance(factoryJobId: string): Promise<{ job: FactoryJob; retryInMs: number | null }> {
  const loaded = await getEntity<FactoryJob>("factoryJob", factoryJobId);
  if (!loaded) throw new Error(`factoryJob ${factoryJobId} 없음`);
  let job = loaded;

  const fail = async (msg: string) => {
    job = await save({ ...job, state: "failed", error: msg });
    return { job, retryInMs: null };
  };

  /**
   * 분석을 태우기 전 크레딧 판정 — 라우트의 `/api/media/:id/analyze` 게이트와 같은 규칙.
   * 공장은 그 라우트를 거치지 않고 content.analyze 를 직접 큐잉하므로, 여기서 안 보면
   * 잔액 없는 테넌트도 분석이 돌아 원가가 그대로 나간다. 러닝타임을 모르면 막지 않고
   * 차감은 끝난 뒤 실제 길이로 한다(recordUsage) — 라우트 쪽과 같은 방향이다.
   */
  const creditBlocked = async (durationSec: number): Promise<string | null> => {
    const need = billableMinutes(durationSec ?? 0);
    if (need <= 0) return null;
    const verdict = checkCredits({ balance: await creditBalance(), needMinutes: need });
    return verdict.allow ? null : verdict.reason;
  };

  switch (job.state) {
    // ── 소스 확보 ────────────────────────────────────────────────────────────
    case "queued": {
      // 이미 우리 미디어면 재사용, YouTube URL 이면 다운로드 잡을 태운다.
      // 고객 스토리지 인증을 위임받지 않는다 — 우리 GCS 로 가져와야 재현이 된다.
      const media = await listMedia();
      // media 행의 저장 경로 필드는 `path` 다 (listMedia). 예전엔 존재하지 않는
      // `storedPath` 를 봐서 이 재사용 분기가 항상 빗나갔다 — 이미 분석된 회차도
      // "미디어를 찾지 못했다"로 죽는 버그 (2026-08-12 프로덕션 스모크에서 발견).
      const existing = media.find((m: any) => m.path === job.sourceUrl
        || m.path === `youtube:${job.sourceUrl}` || m.id === job.sourceUrl);
      if (existing) {
        // 이미 분석이 끝난 미디어면 **다시 태우지 않는다.** content.analyze 는 체크포인트로
        // 연산은 스킵해도 recordUsage 가 전체 분수를 다시 차감한다 — 프로덕션 스모크에서
        // 재분석 없는 관통인데 59크레딧이 재차감됐다 (2026-08-12 실측). 분석이 있으면
        // 바로 analyzing 으로 가서 추천 존재 확인만 한다.
        const { getContentAnalysis } = await import("./db-pg.ts");
        const analysis = await getContentAnalysis((existing as any).id).catch(() => null);
        const analyzed = (analysis as any)?.status === "done";
        if (!analyzed) {
          const blocked = await creditBlocked((existing as any).durationSec ?? 0);
          if (blocked) return await fail(`크레딧 부족 — ${blocked}`);
          await enqueue("content.analyze", { mediaId: (existing as any).id },
            { dedupeKey: `content.analyze:${(existing as any).id}` });
        }
        job = await save({ ...job, state: "analyzing", mediaId: (existing as any).id,
          episodeId: (existing as any).episodeId });
        return { job, retryInMs: analyzed ? 0 : 60_000 };
      }
      if (!job.mediaId) {
        return await fail(
          "sourceUrl 로 미디어를 찾지 못했다 — POST /api/factory/videos 로 먼저 등록할 것");
      }
      job = await save({ ...job, state: "ingesting" });
      return { job, retryInMs: 30_000 };
    }

    // ── 다운로드 완료 대기 ───────────────────────────────────────────────────
    case "ingesting": {
      const media = (await listMedia()).find((m: any) => m.id === job.mediaId) as any;
      if (!media) return await fail("미디어가 사라졌다");
      if (String(media.path ?? "").startsWith("youtube:")) {
        return { job, retryInMs: 60_000 };   // 아직 다운로드 중
      }
      // queued 분기와 같은 이유 — 분석이 이미 있으면 재큐잉(=재차감)하지 않는다.
      const { getContentAnalysis } = await import("./db-pg.ts");
      const analysis = await getContentAnalysis(job.mediaId!).catch(() => null);
      const analyzed = (analysis as any)?.status === "done";
      if (!analyzed) {
        const blocked = await creditBlocked(media.durationSec ?? 0);
        if (blocked) return await fail(`크레딧 부족 — ${blocked}`);
        await enqueue("content.analyze", { mediaId: job.mediaId },
          { dedupeKey: `content.analyze:${job.mediaId}` });
      }
      job = await save({ ...job, state: "analyzing", episodeId: media.episodeId });
      return { job, retryInMs: analyzed ? 0 : 60_000 };
    }

    // ── 분석 완료 대기 ───────────────────────────────────────────────────────
    case "analyzing": {
      const recs = (await listEntities<any>("recommendation"))
        .filter((r) => r.episodeId === job.episodeId);
      if (recs.length === 0) return { job, retryInMs: 60_000 };
      job = await save({ ...job, state: "adopting" });
      return { job, retryInMs: 0 };
    }

    // ── 쇼츠 선별 → 자동 채택 ────────────────────────────────────────────────
    case "adopting": {
      const cap = dailyCap();
      const already = await publishedToday(job.programId);
      if (already >= cap) {
        // 상한은 실패가 아니다 — 사람이 보고 풀 수 있게 hold 로 남긴다.
        job = await save({ ...job, state: "hold",
          note: `일일 상한 ${cap}개 도달 (오늘 ${already}개)` });
        return { job, retryInMs: null };
      }

      const minConf = job.policy.minConfidence ?? 0;
      const maxShorts = Math.min(job.policy.maxShorts ?? 3, cap - already);
      const picks = (await listEntities<any>("recommendation"))
        .filter((r) => r.episodeId === job.episodeId && r.status === "pending")
        .filter((r) => (r.confidence ?? r.score100 ?? 100) / (r.score100 ? 100 : 1) >= minConf)
        .sort((a, b) => (b.score100 ?? 0) - (a.score100 ?? 0))
        .slice(0, Math.max(0, maxShorts));

      if (picks.length === 0) {
        return await fail("채택 가능한 추천이 없다 (minConfidence 확인)");
      }

      const clipIds: string[] = [];
      for (const rec of picks) {
        const clipId = await adoptRecommendation(rec, job);
        if (clipId) clipIds.push(clipId);
      }
      if (clipIds.length === 0) return await fail("자동 채택이 하나도 성공하지 못했다");

      job = await save({ ...job, state: "rendering", clipIds });
      return { job, retryInMs: 10_000 };
    }

    // ── 렌더 ─────────────────────────────────────────────────────────────────
    // 렌더는 서버의 /api/clips/:id/export 가 한다(자막·훅 프리롤·썸네일 오버레이가 전부
    // 거기 있다). 워커에서 그 로직을 복제하면 두 벌이 갈라지므로 HTTP 로 부른다.
    case "rendering": {
      const clips = await Promise.all(job.clipIds.map((id) => getEntity<any>("clip", id)));
      const pending = clips.filter((c) => c && !c.rendered);
      for (const clip of pending) {
        await requestExport((clip as any).id).catch((e) => {
          console.warn(`[factory] export 요청 실패 ${(clip as any).id}: ${String(e).slice(0, 120)}`);
        });
      }
      const after = await Promise.all(job.clipIds.map((id) => getEntity<any>("clip", id)));
      if (after.some((c) => !c?.rendered)) return { job, retryInMs: 30_000 };

      if (job.policy.dryRun) {
        // 드라이런: 여기까지가 전부다. 붙이는 쪽이 이걸로 먼저 관통을 확인한다.
        job = await save({ ...job, state: "done", note: "dryRun — 업로드하지 않음" });
        return { job, retryInMs: null };
      }
      job = await save({ ...job, state: "publishing" });
      return { job, retryInMs: 0 };
    }

    // ── 배포 (YouTube 전용) ──────────────────────────────────────────────────
    case "publishing": {
      // **지정한 채널로만 나간다.** 여기서 채널을 추론하거나 폴백하지 않는다 —
      // "하나뿐이니 거기로" 같은 추측이 잘못된 채널 배포를 만든다.
      const channelIds = job.targets
        .filter((t) => t.startsWith("youtube:"))
        .map((t) => t.slice("youtube:".length).trim())
        .filter(Boolean);
      if (channelIds.length === 0) return await fail("YouTube 타깃이 없다 (현재 YouTube 만 실송출)");

      // **자동 배포도 게이트를 건너뛰지 않는다** (F6 Invariant · FLOWS.md:142).
      // 예전엔 여기서 큐에 직접 넣어서, 라우트에 게이트를 붙여도 이 경로에는 안 걸렸다.
      // 이제 사람이 누르는 배포와 같은 관문(dispatchPublish)을 지난다.
      const gateBlocked: string[] = [];
      for (const channelId of channelIds) {
        const outcome = await dispatchPublish({
          clipIds: job.clipIds,
          channel: "youtube",
          youtubeChannelId: channelId,
          // 기본은 private — 유예 뒤 공개로 바꾼다. 잘못 나갔을 때 되돌릴 시간을 번다.
          privacy: job.policy.publishPublic ? "public" : "private",
          actor: `factory:${job.id}`,
          origin: "factory",
        });
        for (const s of outcome.skipped) gateBlocked.push(`${s.clipId}: ${s.reason}`);
      }

      // 게이트에 막힌 게 있으면 조용히 넘어가지 않는다 — 로그에 사유를 남긴다.
      // (사람이 확정하면 다시 잡히게 하는 보류 큐 재진입은 S4)
      if (gateBlocked.length > 0) {
        console.warn(`[factory] ${job.id}: 게이트 미통과 ${gateBlocked.length}건 — ${gateBlocked.join(" · ")}`);
      }
      job = await save({ ...job, state: job.policy.publishPublic ? "done" : "publicizing" });
      if (job.state === "done") return { job, retryInMs: null };

      await enqueue("factory.publicize", { factoryJobId: job.id },
        { dedupeKey: `factory.publicize:${job.id}`, delayMs: publicizeDelayMs() });
      return { job, retryInMs: null };
    }

    case "publicizing":
    case "done":
    case "failed":
    case "hold":
      return { job, retryInMs: null };
  }
}

/**
 * 자동 렌더용 제목 랩핑 — 무인 렌더에는 에디터의 손질이 없으므로 여기서 줄수·크기를
 * 못박는다. 규칙: 2줄 이하 · 넘치면 말줄임 · 길수록 폰트 축소 (렌더러는 자동 줄바꿈이
 * 없어서(WrapStyle 2) 시드가 안 감싸면 화면 밖으로 나간다 — 2026-08-12 실측).
 */
export function wrapAutoTitle(raw: string): { lines: string[]; size: number } {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { lines: [], size: 32 };
  if (text.length <= 14) return { lines: [text], size: 34 };
  const budget = 16;
  // 중간에 가장 가까운 공백에서 자른다 — 단어 중간 절단 방지.
  const cut = (() => {
    const mid = Math.min(budget, Math.ceil(text.length / 2));
    for (let d = 0; d < 8; d++) {
      if (text[mid - d] === " ") return mid - d;
      if (text[mid + d] === " ") return mid + d;
    }
    return mid;
  })();
  let l1 = text.slice(0, cut).trim();
  let l2 = text.slice(cut).trim();
  if (l2.length > budget + 4) l2 = `${l2.slice(0, budget + 3).trim()}…`;
  return { lines: [l1, l2], size: text.length > 24 ? 28 : 30 };
}

/**
 * 무인 자동배포 기본 렌더 시드 (사용자 확정 2026-08-12 · TVING 쇼츠 스타일):
 *   검정 배경에 16:9 원본을 **가운데 레터박스** — 원본 번인 자막이 그대로 보이므로
 *   AI 자막 오버레이는 끈다(겹침 원천 차단) · 상단 띠에 짧은 훅 한 줄 · 하단 띠에
 *   프로그램명 브랜딩. editorState 가 없으면 렌더가 블러 커버 + 기본 자막 폴백으로
 *   나가 조잡했다(스모크 실측) — 시드가 곧 무인 품질의 하한선이다.
 * 사람이 에디터에서 열어 저장하면 이 시드는 그대로 대체된다.
 */
/**
 * 템플릿별 시드 파라미터 — 템플릿을 바꿔도 이전 것은 버리지 않는다(사용자 지시 2026-08-12:
 * "여러 템플릿 할 때마다 버리지 말고 만들어두자"). 새 표준이 생기면 여기 행을 추가한다.
 */
const TEMPLATE_SEEDS: Record<string, {
  accent: string; titleY: number;
  bottom: "logo-box" | "icon-title";
  channelY: number; iconShape: "circle" | "square"; iconSize: number;
  iconY?: number; boxY?: number;
}> = {
  // 표준 (2026-08-12 확정 · 나는 SOLO 쇼츠 레퍼런스): 청록 훅 + 프로그램 로고 + 방영시간 박스
  "broadcast-standard": {
    accent: "#40E0E0", titleY: 11, bottom: "logo-box",
    channelY: 88, iconShape: "square", iconSize: 50, iconY: 68, boxY: 79.5,
  },
  // 드라마: 번인 자막이 없어 확대 크롭(fit cover)이 산다 — 띠가 좁아 위치가 다르다
  "broadcast-drama": {
    accent: "#40E0E0", titleY: 8, bottom: "logo-box",
    channelY: 88, iconShape: "square", iconSize: 50, iconY: 77, boxY: 87.5,
  },
  // 구 표준 (TVING 풍 · 보존): 빨강 훅 + 원형 아이콘 + 프로그램명 텍스트
  "broadcast-clean": {
    accent: "#FF4040", titleY: 11, bottom: "icon-title",
    channelY: 88, iconShape: "circle", iconSize: 40,
  },
};

/** 프로그램 장르로 템플릿 선택 — 드라마는 확대 크롭, 그 외는 표준. */
export function pickTemplateId(program?: any): string {
  const g = `${program?.pipelineGenre ?? ""} ${program?.section ?? ""}`;
  return /drama|드라마/i.test(g) ? "broadcast-drama" : "broadcast-standard";
}

export function autoEditorState(
  rec: any, programTitle: string, program?: any, forcedTemplateId?: string,
  layoutOverride?: { titleY?: number; channelIconY?: number; channelBoxY?: number; channelIconSize?: number },
): Record<string, unknown> {
  const hook = String(rec.hookQuote ?? "").replace(/^['"'"]|['"'"]$/g, "").trim();
  const headline = hook && hook.length <= 30 ? hook : String(rec.titleLine1 ?? rec.title ?? "");
  const { lines, size } = wrapAutoTitle(headline);
  // 자동배포 화면에서 고른 템플릿(policy) > 프로그램 기본(autoPublish 설정) > 장르 자동.
  const templateId = (forcedTemplateId && TEMPLATE_SEEDS[forcedTemplateId] ? forcedTemplateId : null)
    ?? (TEMPLATE_SEEDS[String(program?.autoPublish?.templateId ?? "")] ? String(program.autoPublish.templateId) : null)
    ?? pickTemplateId(program);
  const seed = TEMPLATE_SEEDS[templateId] ?? TEMPLATE_SEEDS["broadcast-standard"];
  return {
    aspect: "9:16",
    bgType: "solid",
    bg: "#000000",
    templateId,
    // 한 줄이면 통째 강조색, 두 줄이면 둘째 줄만 (표준 강조색 = 청록, 레퍼런스 확정).
    // ⚠️ id 를 반드시 넣는다. 없으면 편집기에서 setLine 이 l.id === undefined 로 **두 줄을 다**
    //    매칭해 한 줄로 붕괴하고, React key 도 undefined 로 겹친다(2026-08-12 발견).
    titleLines: lines.map((text, i) => ({
      id: `t${i}`, text, size, color: lines.length === 1 || i === 1 ? seed.accent : "#FFFFFF",
    })),
    titleX: 50,
    titleY: seed.titleY,
    titleAlign: "center",
    captionsOn: false,
    karaoke: false,
    hookOn: false,
    showChannel: true,
    // logo-box 하단은 로고(프로그램 brandIconDataUrl)가 이름을 대신한다 — 텍스트 이름 생략.
    channelName: seed.bottom === "logo-box" ? "" : programTitle,
    channelY: seed.channelY,
    channelLabelSize: 30,
    channelIconShape: seed.iconShape,
    channelIconSize: seed.iconSize,
    ...(seed.iconY != null ? { channelIconY: seed.iconY } : {}),
    // 방영시간 박스 — 프로그램 설정의 schedule 그대로 (예: "(수) 밤 10시 30분").
    ...(seed.bottom === "logo-box" && String(program?.schedule ?? "").trim()
      ? { channelBoxText: String(program.schedule).trim(), channelBoxY: seed.boxY }
      : {}),
    // 자동배포 규칙의 위치 미세조정 — 시드 기본값 위에 덮인다 (숫자 필드만).
    ...(layoutOverride && typeof layoutOverride === "object"
      ? Object.fromEntries(
          (["titleY", "channelIconY", "channelBoxY", "channelIconSize"] as const)
            .filter((k) => Number.isFinite(layoutOverride[k]))
            .map((k) => [k, layoutOverride[k]]),
        )
      : {}),
  };
}


/**
 * 추천 하나 → 클립. index.ts 의 adopt 라우트와 같은 뼈대다.
 * 라우트를 HTTP 로 부르지 않는 이유: 워커가 별도 프로세스라 인증·네트워크가 더 붙는다.
 */
async function adoptRecommendation(rec: any, job: FactoryJob): Promise<string | null> {
  if (rec.status !== "pending") return rec.adoptedClipId ?? null;
  const episode = await getEntity<any>("episode", rec.episodeId);
  const master = (await listMedia()).find(
    (m: any) => m.episodeId === rec.episodeId && m.role === "master") as any;

  const clipId = newId("c");
  const clip = {
    id: clipId,
    episodeId: rec.episodeId,
    programTitle: episode?.programTitle ?? "",
    title: rec.title,
    titleLine1: rec.titleLine1,
    titleLine2: rec.titleLine2,
    hookQuote: rec.hookQuote,
    hookTimeSec: rec.hookTimeSec,
    hookIntroCaption: rec.hookIntroCaption,
    clipType: rec.kind === "short" ? "T6" : "TZ",
    targetAge: episode?.targetAge ?? 0,
    aspectRatio: rec.kind === "short" ? "9:16-crop-main" : "16:9",
    // 무인 렌더 기본 시드 — 에디터를 안 거쳐도 배포 가능한 모양으로 나가게 한다.
    editorState: autoEditorState(rec, episode?.programTitle ?? "",
      episode?.programId ? await getEntity<any>("program", episode.programId) : undefined,
      job.policy.templateId),
    durationSec: Math.max(1, rec.endTime - rec.startTime),
    synopsis: rec.editNote ?? undefined,
    status: "editing",
    rendered: false,
    startTime: rec.startTime,
    endTime: rec.endTime,
    sourceMediaId: master?.id,
    sourceRecommendationId: rec.id,
    beatIds: Array.isArray(rec.beatIds) ? rec.beatIds : [],
    reframe: basicReframeState(),
    distributions: [],
    // 공장이 만든 클립이라는 표식 — 나중에 사고 추적·롤백 대상 선별에 쓴다.
    factoryJobId: job.id,
  };

  // 채택 커밋 + **이슈 승계**는 adopt.ts 하나로 모았다. 예전엔 이 경로가 승계를 안 해서
  // 공장이 만든 미디어에는 회차 이슈가 안 붙었다(F2 Invariant 위반).
  const ok = await commitAndInherit(clipId, clip, rec.id, rec);
  if (!ok) return null;

  return clipId;
}
