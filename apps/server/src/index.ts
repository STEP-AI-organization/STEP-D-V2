/**
 * STEP-D backend — Hono on Node + PostgreSQL + Cloud Storage (GCS).
 *
 * Production: DATABASE_URL + GCS_BUCKET env vars.
 * Development: local SQLite fallback not used — see db-pg.ts for local PG.
 * Video processing: real ffmpeg (system-installed, baked into Docker image).
 */
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  runWithTenant, runAsSystem, currentTenantId, DEFAULT_TENANT_ID, type TenantContext,
} from "./tenant.ts";
import {
  SESSION_COOKIE,
  authRequired,
  acceptInvite,
  canManageWorkspace,
  countActiveOwners,
  createInvite,
  getMember,
  getWorkspace,
  isWorkspaceOwner,
  listMembers,
  listPendingInvites,
  renameWorkspace,
  revokeInvite,
  updateMember,
  createSession,
  destroyAllSessions,
  destroySession,
  destroyTenantSessions,
  findUserByEmail,
  passwordProblem,
  resolveSession,
  setPassword,
  verifyPassword,
  workspaceBlockReason,
  type User,
} from "./auth.ts";
import { audit, clientIp, requireReason, requireSuperadmin } from "./admin.ts";
import { grantDedupeKey, inviteLink, planOnboarding } from "./onboarding.ts";
import {
  API_SCOPES, bearerKey, checkRoute, generateKey, hashKey, keyBlockReason, keyPrefix,
  normalizeScopes, shouldTouchLastUsed,
} from "./api-keys.ts";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  initDb,
  getState,
  getEntity,
  putEntity,
  prependEntity,
  commitAdoption,
  markRecommendationRejected,
  // 게이트 (migrations/0012 · FLOWS F3)
  listRightsIssues,
  listRightsIssuesFor,
  getRightsIssue,
  insertRightsIssue,
  updateRightsIssueResolution,
  deleteRightsIssue,
  putRightsJudgement,
  isJudged,
  judgedSet,
  appendGateAudit,
  listGateAudit,
  type GateSubjectType,
  listAssetFolders,
  insertAssetFolder,
  assetFolderExists,
  listAssetSubtree,
  moveAssetFolder,
  deleteAssetFolderTree,
  listAssetFiles,
  getAssetFile,
  insertAssetFile,
  moveAssetFiles,
  deleteAssetFiles,
  updateMediaThumb,
  listAutomationRules,
  upsertAutomationRule,
  deleteAutomationRule,
  appendRuleRun,
  listRuleRuns,
  releaseHold,
  openHolds,
  getAutomationSetting,
  setAutomationSetting,
  creditBalance,
  addCreditEntry,
  listCreditLedger,
  createTopup,
  getTopup,
  markTopupPaid,
  listChannelRules,
  getChannelRule,
  upsertChannelRule,
  deleteChannelRule,
  type ChannelRuleRow,
  listMedia,
  getMedia,
  insertMedia,
  mediaPublic,
  listYouTubeChannels,
  getYouTubeChannelByChannelId,
  upsertYouTubeChannel,
  updateYouTubeTokens,
  markYouTubeChannelRevoked,
  deleteYouTubeChannel,
  listMetaAccounts,
  upsertMetaAccount,
  deleteMetaAccount,
  type MetaAccount,
  listTikTokAccounts,
  upsertTikTokAccount,
  deleteTikTokAccount,
  type TikTokAccount,
  listChannelVideos,
  upsertChannelVideo,
  getChannelVideoByVideoId,
  deleteChannelVideo,
  deleteChannelVideosForChannel,
  getUncheckedShortVideoIds,
  setChannelVideoShort,
  countUncheckedShortVideos,
  insertVideoStat,
  getVideoStats,
  getLatestVideoStat,
  getChannelViewTrend,
  getChannelTrendSummary,
  getChannelAnalytics,
  markContentAnalysisPending,
  getContentAnalysis,
  listContentAnalysisSummary,
  listEntities,
  getTranscript,
  deleteMediaData,
  deleteEntityRow,
  deleteEntitiesByEpisode,
  listProgramCast,
  getCastMember,
  upsertCastMember,
  deleteCastMember,
  listEpisodeCast,
  setEpisodeCastStatus,
  getVideoAnalytics,
  getVideoRetention,
  listVideoComments,
  upsertShortSourceMap,
  listShortSourceMaps,
  listSourceMapsMissingSegment,
  deleteShortSourceMap,
  getChannelPointProfile,
  getPool,
  asSystem,
  getRawPool,
  lookupApiKey,
  touchApiKey,
  withRawTransaction,
  searchSegments,
  listKnownCharacters,
  logSearchEvent,
  listSearchEvents,
  newQueryId,
  type MediaRow,
  type YouTubeChannel,
  type ChannelVideo,
  type SearchHit,
  type SearchQuery,
  type SearchEventKind,
} from "./db-pg.ts";
import { hasFfmpeg, probe, captureThumbnail, trimEncode, remuxFaststart, renderShort } from "./ffmpeg.ts";
import { embedQuery } from "./search-embed.ts";
import { parseQuery } from "./search-parse.ts";
import { newId } from "./pipeline.ts";
import {
  normalizeProfile,
  promptForMode,
  PROFILE_RESPONSE_SCHEMA,
  type GenerateMode,
} from "./profile.ts";
import { normalizeCastInput } from "./cast.ts";
import { youtubeUploadEnabled, UPLOAD_DISABLED_CODE, UPLOAD_DISABLED_MESSAGE } from "./upload-gate.ts";
import { geminiGenerate, parseJsonLoose } from "./gemini.ts";
import { syncProgramFromFacesForMedia, CORE_PYTHON, CORE_DIR, REPO_ROOT } from "./content-pipeline.ts";
import {
  syncChannelVideos,
  classifyShorts,
  fetchChannelAnalytics,
  fetchPopularVideos,
  fetchVideoCategories,
  withAccessToken,
  refreshChannelToken,
  TokenRevokedError,
  type PersistTokens,
  type YouTubeAuth,
  scopeCanPublish,
  YT_PUBLISH_SCOPE,
} from "./youtube.ts";
import { SHORTS_PROBE_MAX_PER_SYNC, SHORTS_PROBE_CONCURRENCY } from "./config.ts";
import { runChannelPipeline, runDueChannels } from "./channel-pipeline.ts";
import { initQueue, enqueue, queueStats, listJobs } from "./queue.ts";
import {
  uploadPath,
  thumbPath,
  clipPath,
  writeFile,
  uploadFile,
  fileSize,
  fileExists,
  readFile,
  createReadStream,
  parseObjectPath,
  useGcs,
  createResumableSession,
  signedReadUrl,
  deleteFile,
  deletePrefix,
  listPrefix,
} from "./storage-gcs.ts";
import { castPrefix, stylePrefix, thumbnailPrefix } from "./thumbnail-assets.ts";
import { isClipRendered, upsertDistribution } from "./publish-guard.ts";
import {
  initialPipeline,
  isoDateOrToday,
  readEpisodeNumber,
  readTrack,
} from "./episode-intake.ts";
import { dispatchPublish } from "./publish-dispatch.ts";
import { opsCapabilityOf } from "./ops-role.ts";
import {
  CREDIT_UNIT_LABEL, buildTopup, checkCredits, creditPriceKrw, settleTopup,
  topupDedupeKey, topupPaymentId,
} from "./credits.ts";
import { billableMinutes, portoneConfigured } from "./billing.ts";
import { getPayment, verifyWebhook } from "./portone.ts";
import { commitAndInherit } from "./adopt.ts";
import { runAutomationCycle } from "./automation-cycle.ts";
import {
  ROOT as ASSET_ROOT,
  canMoveFolder,
  childPath,
  kindOf,
  normalizeFolderPath,
  parentOf,
  validateName,
} from "./asset-path.ts";
import {
  RULE_CRITERIA,
  RULE_MEDIA_KINDS,
  GATE_POLICIES,
  RULE_DELETED_NOTICE,
  initialRuleState,
  isGatePolicy,
  isRuleCriterion,
  isRuleMediaKind,
  planCycle,
  ruleCreatedNotice,
} from "./automation.ts";
import {
  CHANNEL_ROLES,
  defaultRuleFor,
  eligibility,
  isChannelRole,
  type ChannelRule,
} from "./channel-rules.ts";
import {
  ISSUE_KINDS,
  canResolve,
  evaluateGate,
  inheritedIssues,
  isIssueKind,
  isResolution,
  type GateResult,
  type Issue,
} from "./gate.ts";
import { listShortsTemplates, getShortsTemplate, toPercent } from "./shorts-template.ts";
import { listNaverAccounts, getNaverAccount, upsertNaverAccount, markNaverAccount } from "./db-pg.ts";
import { naverSessionPath } from "./naver-session.ts";
import {
  CANVA_CALLBACK_PATH, canvaConfigured, canvaConnected, canvaAuthUrl,
  canvaExchangeCode, disconnectCanva, listCanvaDesigns,
} from "./canva.ts";
import {
  createJob as createFactoryJob,
  findByIdempotencyKey as findFactoryJobByKey,
  validateTargets as validateFactoryTargets,
  factoryEnabled,
} from "./factory.ts";

// A stray async error (e.g. a GCS stream 'error' after the response started, or a background
// promise rejecting) must not kill the whole Cloud Run instance mid-request — same guard the
// worker has (worker.ts main()). Log loudly and keep serving.
process.on("unhandledRejection", (reason) => console.error("[stepd-server] unhandledRejection (surviving):", reason));
process.on("uncaughtException", (err) => console.error("[stepd-server] uncaughtException (surviving):", err));

// Sync init — no CPU throttling issues on Cloud Run
let dbReady = false;
const FFMPEG = hasFfmpeg();
console.log(`[stepd-server] ffmpeg available: ${FFMPEG}`);

// Init DB in background — don't block server startup
initDb()
  .then(() => initQueue())
  .then(() => assertAuthPosture())
  .then(() => { dbReady = true; console.log("[stepd-server] database + queue ready"); })
  .catch((err) => console.error("[stepd-server] database init failed (server still running):", err));
console.log(`[stepd-server] storage mode: ${useGcs() ? "GCS" : "local"}`);

/** 요청 스코프 변수. 미들웨어가 세션을 풀어 넣고, 라우트가 c.get("user") 로 읽는다. */
type AppEnv = { Variables: { user?: User } };

const app = new Hono<AppEnv>();
app.use("*", logger());
app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: false }));

// ── 테넌트 컨텍스트 ────────────────────────────────────────────────────────────
// 모든 요청을 테넌트 스코프 안에서 처리한다. 이 미들웨어가 없으면 db-pg 의 풀 프록시가
// 스코프를 못 찾아 던지므로(fail-closed), **누락이 조용한 유출이 아니라 500 으로 드러난다.**
//
// 지금 테넌트를 정하는 경로는 하나뿐이다 — 웹/사내 호출 = 기본 테넌트.
// 외부 방송사용 API 키(ak_*) 해석은 과금 4단계에서 여기에 붙는다
// (docs/plans/active/billing-portone-plan.md §3·§7).
/**
 * 세션 없이도 통과해야 하는 경로.
 *   · /health          — 로드밸런서·모니터링
 *   · /api/auth/*      — 로그인 자체 (닭과 달걀)
 *   · OAuth 콜백       — 외부 서비스가 리다이렉트로 부른다. 쿠키가 붙는다는 보장이 없다
 * (구 `/lab` 예외는 Lab 제거와 함께 사라졌다 — 관리 콘솔은 admin.stepd.stepai.kr 이고
 *  세션 인증을 정상적으로 거친다.)
 * 이 목록은 **짧게 유지한다.** 여기 들어간 경로는 인증을 켜도 안 막힌다.
 */
const PUBLIC_PATHS: RegExp[] = [
  /^\/health$/,
  /^\/api\/auth\//,
  /^\/api\/(youtube|meta|tiktok|canva)\/oauth\/callback/,
  // 포트원 웹훅 — 세션이 없다. 대신 **서명으로 인증**한다(verifyWebhook).
  /^\/api\/billing\/portone\/webhook$/,
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(path));
}

/**
 * 요청 → 테넌트. 세 경로가 있다.
 *   1. 외부 API 키     → 그 키가 속한 회사 (고객사 시스템)
 *   2. 세션 쿠키       → 그 사용자의 테넌트 (사람이 화면에서)
 *   3. 인증 없음       → AUTH_REQUIRED 가 켜져 있으면 401, 아니면 기본 테넌트로 폴백
 *
 * **셋 다 같은 출구를 지난다** — 여기서 정한 scope 로 `runWithTenant` 가 돌고, 그 안의 모든
 * DB 접근은 RLS 가 막는다. 키 경로가 별도 필터를 갖기 시작하면 격리가 두 벌이 되고
 * 한 벌은 반드시 샌다. 여기서 하는 일은 "누구 것인가"를 정하는 것까지다.
 *
 * 3번의 폴백은 **테넌트가 t_default 하나뿐인 동안에만 안전하다.** 전제가 깨지는 순간은
 * 기동 시 assertAuthPosture() 가 잡는다 — 사람이 기억하는 데 기대지 않는다.
 */
async function resolveTenant(c: Context<AppEnv>): Promise<TenantContext> {
  const rawKey = bearerKey(c.req.header("authorization"));
  if (rawKey) {
    const row = await lookupApiKey(hashKey(rawKey));
    const blocked = keyBlockReason(row);
    // 왜 막혔는지 말한다 — "401" 만 주면 고객사가 키를 다시 발급받아도 같은 벽을 만난다.
    if (blocked || !row) throw new HTTPException(401, { message: blocked ?? "알 수 없는 API 키입니다." });

    // 라우트 화이트리스트. 세션용 라우트 118개를 키에 통째로 열지 않는다.
    const verdict = checkRoute(c.req.method, new URL(c.req.url).pathname, row.scopes);
    if (!verdict.ok) throw new HTTPException(403, { message: verdict.reason });

    // 안 쓰는 키를 회수할 근거. 매 요청 쓰기는 과해서 분 단위로 던다.
    if (shouldTouchLastUsed(row.lastUsedAt, Date.now())) void touchApiKey(row.id);
    return { scope: row.tenantId, via: "api-key", apiKeyId: row.id };
  }

  const user = await resolveSession(getCookie(c, SESSION_COOKIE)).catch(() => null);
  if (user) {
    c.set("user", user);
    return { scope: user.tenantId, via: "web" };
  }

  if (authRequired() && !isPublicPath(new URL(c.req.url).pathname)) {
    throw new HTTPException(401, { message: "login required" });
  }
  return { scope: DEFAULT_TENANT_ID, via: "web" };
}

app.use("*", async (c, next) => {
  // 인증 자세가 어긋난 상태(외부 테넌트가 있는데 AUTH_REQUIRED 가 꺼짐)면 아무것도 서빙하지
  // 않는다. 조용히 도는 것이 곧 유출이라, 실패 방향을 "안 뜸"으로 잡는다.
  if (authPostureError && !/^\/health$/.test(new URL(c.req.url).pathname)) {
    return c.json({ error: "auth_misconfigured", message: authPostureError }, 503);
  }
  const ctx = await resolveTenant(c);
  return runWithTenant(ctx, () => next());
});

/**
 * 기동 시 1회 점검: 테넌트가 둘 이상인데 인증이 꺼져 있으면 모든 요청이 기본 테넌트로
 * 해석된다 = 격리가 있으나 마나다. 그 조합을 허용하지 않는다.
 */
let authPostureError: string | null = null;

async function assertAuthPosture(): Promise<void> {
  if (authRequired()) return;
  const { rows } = await getRawPool().query("SELECT COUNT(*)::int AS n FROM tenants");
  const n = rows[0]?.n ?? 1;
  if (n > 1) {
    authPostureError =
      `테넌트가 ${n}개인데 AUTH_REQUIRED 가 꺼져 있다 — 모든 요청이 ${DEFAULT_TENANT_ID} 로 ` +
      "해석되어 테넌트 격리가 무의미해진다. AUTH_REQUIRED=1 로 켜거나, 추가 테넌트를 정리할 것.";
    console.error(`[auth] ${authPostureError}`);
  }
}

// ── health ──────────────────────────────────────────────────────────────────
app.get("/health", async (c) => {
  // `youtubeUpload` is the gate's state, not a secret — it's the fastest way to confirm a
  // deployed revision can't publish (and lets the web hide the publish action).
  return c.json({ ok: dbReady, ffmpeg: FFMPEG, youtubeUpload: youtubeUploadEnabled() });
});

// ── 로그인 (이메일+비밀번호 · 초대제) ─────────────────────────────────────────
// 화면은 apps/web 개편 후에 붙인다. 여기서는 API 만 완성해 둔다.

/** 쿠키 옵션 — HttpOnly 라 JS 가 못 읽고, Lax 라 크로스사이트 POST 에 안 실린다. */
function sessionCookieOpts(expiresAt: number) {
  return {
    httpOnly: true,
    secure: (process.env.PUBLIC_URL ?? "").startsWith("https://"),
    sameSite: "Lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}

/** 인증이 필요한 라우트에서 현재 사용자. 없으면 401 을 던진다. */
function requireUser(c: Context<AppEnv>): User {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "login required" });
  return user;
}

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as any);
  if (!email || !password) return c.json({ error: "email_and_password_required" }, 400);

  const user = await findUserByEmail(email);
  // 계정이 없어도 **해시 대조를 수행한 것과 같은 시간**을 쓰도록 더미 검증을 돌린다.
  // 응답 시간 차이로 "이 이메일은 가입돼 있다"를 알아내는 계정 열거를 막는다.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA").then(() => false);
  if (!user || !ok || user.status !== "active") {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  // 회사 정지는 자격증명 문제가 아니다. 401 로 뭉뚱그리면 사용자는 비밀번호가 틀린 줄 알고
  // 계속 다시 친다 — 할 일이 "문의"인지 "재입력"인지 구분해 줘야 한다.
  // 비밀번호가 맞은 뒤에만 알려주므로 계정 열거로는 새지 않는다.
  const workspaceBlocked = workspaceBlockReason(user.tenantStatus, user.role);
  if (workspaceBlocked) {
    return c.json({ error: "workspace_blocked", message: workspaceBlocked }, 403);
  }

  const { token, expiresAt } = await createSession(user, {
    userAgent: c.req.header("user-agent"),
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  setCookie(c, SESSION_COOKIE, token, sessionCookieOpts(expiresAt));
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } });
});

app.post("/api/auth/logout", async (c) => {
  await destroySession(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/me", (c) => {
  const user = c.get("user") as User | undefined;
  if (!user) return c.json({ user: null, authRequired: authRequired() });
  return c.json({
    user: {
      id: user.id, email: user.email, name: user.name,
      // 두 축을 함께 준다 — 화면이 관리 권한(role)과 방송 권한(opsRole)을 구분해서 쓴다.
      role: user.role,
      opsRole: opsCapabilityOf(user.opsRole).key,
      capabilities: opsCapabilityOf(user.opsRole),
      tenantId: user.tenantId,
    },
    authRequired: authRequired(),
  });
});

app.post("/api/auth/password", async (c) => {
  const user = requireUser(c);
  const { current, next } = await c.req.json<{ current?: string; next?: string }>().catch(() => ({}) as any);
  if (!current || !next) return c.json({ error: "current_and_next_required" }, 400);
  const full = await findUserByEmail(user.email);
  if (!full || !(await verifyPassword(current, full.passwordHash))) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const problem = passwordProblem(next);
  if (problem) return c.json({ error: "weak_password", message: problem }, 400);
  await setPassword(user.id, next);
  // 비밀번호를 바꿨다는 건 대개 "다른 데서 쓰고 있을지 모른다"는 뜻이다 — 다른 세션은 끊는다.
  await destroyAllSessions(user.id, getCookie(c, SESSION_COOKIE));
  return c.json({ ok: true });
});

// ── 워크스페이스 (= 테넌트 = 방송사 하나) ─────────────────────────────────────
// 방송사마다 직원이 여러 명이고 같은 자료를 함께 본다. 그래서 계정은 **워크스페이스에
// 소속**되고, 워크스페이스 안의 owner/admin 이 동료를 초대한다. 초대받은 admin 은 또
// 초대할 수 있어서, 우리가 매번 개입하지 않아도 조직이 스스로 늘어난다.
//
// 여기 라우트는 전부 **자기 워크스페이스만** 대상으로 한다 — tenantId 를 요청에서 받지 않고
// 세션에서 꺼낸다. 남의 워크스페이스를 건드리는 경로는 superadmin 콘솔뿐이고, 그쪽은 사유와
// 감사 기록을 요구한다.

/** 워크스페이스 관리 권한(owner·admin·superadmin) 확인. */
function requireManager(c: Context<AppEnv>): User {
  const user = requireUser(c);
  if (!canManageWorkspace(user.role)) {
    throw new HTTPException(403, { message: "워크스페이스 관리는 owner/admin 만 가능합니다." });
  }
  return user;
}

app.get("/api/workspace", async (c) => {
  const user = requireUser(c);
  const ws = await getWorkspace(user.tenantId);
  if (!ws) return c.json({ error: "not_found" }, 404);
  const members = await listMembers(user.tenantId);
  return c.json({
    workspace: ws,
    memberCount: members.filter((m) => m.status === "active").length,
    myRole: user.role,
    canManage: canManageWorkspace(user.role),
  });
});

app.patch("/api/workspace", async (c) => {
  const user = requireUser(c);
  if (!isWorkspaceOwner(user.role)) {
    return c.json({ error: "forbidden", message: "워크스페이스 이름 변경은 owner 만 가능합니다." }, 403);
  }
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({}) as any);
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return c.json({ error: "name_required" }, 400);
  if (trimmed.length > 60) return c.json({ error: "name_too_long" }, 400);
  await renameWorkspace(user.tenantId, trimmed);
  return c.json({ ok: true, name: trimmed });
});

/** 멤버 목록 — 워크스페이스 안에서는 누구나 동료가 누구인지 볼 수 있다(집단 작업이므로). */
app.get("/api/workspace/members", async (c) => {
  const user = requireUser(c);
  const members = await listMembers(user.tenantId);
  return c.json({
    members: members.map((m) => ({
      id: m.id, email: m.email, name: m.name, role: m.role, status: m.status,
      createdAt: m.createdAt, lastLoginAt: m.lastLoginAt, isMe: m.id === user.id,
    })),
  });
});

/**
 * 역할 변경 / 정지. 지켜야 할 선이 셋이다:
 *   · 자기 자신은 못 바꾼다 — 실수로 스스로 권한을 잃고 갇히는 사고를 막는다.
 *   · admin 은 owner 를 못 건드린다 — 아랫사람이 윗사람을 정지시킬 수 있으면 위계가 무의미해진다.
 *   · **마지막 owner 는 강등도 정지도 안 된다** — 주인 없는 워크스페이스는 아무도 초대를 못 해
 *     남은 사람이 갇힌다.
 */
app.patch("/api/workspace/members/:id", async (c) => {
  const user = requireManager(c);
  const targetId = c.req.param("id");
  const { role, status } = await c.req.json<{ role?: string; status?: string }>().catch(() => ({}) as any);

  if (targetId === user.id) {
    return c.json({ error: "cannot_change_self", message: "자기 자신의 권한은 바꿀 수 없습니다." }, 400);
  }
  if (role && !["owner", "admin", "member"].includes(role)) return c.json({ error: "invalid_role" }, 400);
  if (status && !["active", "suspended"].includes(status)) return c.json({ error: "invalid_status" }, 400);
  if (!role && !status) return c.json({ error: "nothing_to_update" }, 400);

  const target = await getMember(user.tenantId, targetId);
  if (!target) return c.json({ error: "not_found" }, 404);

  if (isWorkspaceOwner(target.role) && !isWorkspaceOwner(user.role)) {
    return c.json({ error: "forbidden", message: "admin 은 owner 를 변경할 수 없습니다." }, 403);
  }
  if (role === "owner" && !isWorkspaceOwner(user.role)) {
    return c.json({ error: "forbidden", message: "owner 승격은 owner 만 할 수 있습니다." }, 403);
  }

  const losesOwner = isWorkspaceOwner(target.role)
    && ((role && role !== "owner") || status === "suspended");
  if (losesOwner && (await countActiveOwners(user.tenantId)) <= 1) {
    return c.json({
      error: "last_owner",
      message: "마지막 owner 입니다. 다른 사람을 owner 로 올린 뒤에 변경하세요.",
    }, 400);
  }

  await updateMember(user.tenantId, targetId, { role: role as any, status });
  // 정지는 세션까지 끊어야 실제로 막힌다 — 안 그러면 이미 열려 있는 창은 계속 돈다.
  if (status === "suspended") await destroyAllSessions(targetId);
  return c.json({ ok: true });
});

/** 대기 중인 초대 — 누가 아직 안 들어왔는지 보여야 중복 초대를 안 한다. */
app.get("/api/workspace/invites", async (c) => {
  const user = requireManager(c);
  return c.json({ invites: await listPendingInvites(user.tenantId) });
});

/**
 * 동료 초대. 토큰은 **응답에 딱 한 번** 나간다(메일 발송은 아직 없으므로 직접 전달).
 * 초대할 수 있는 역할은 자기 이하로 제한한다 — admin 이 owner 를 만들어 자기 위를 세우지 못하게.
 */
app.post("/api/workspace/invites", async (c) => {
  const user = requireManager(c);
  const { email, role } = await c.req.json<{ email?: string; role?: string }>().catch(() => ({}) as any);
  if (!email) return c.json({ error: "email_required" }, 400);
  const wanted = role ?? "member";
  if (!["owner", "admin", "member"].includes(wanted)) return c.json({ error: "invalid_role" }, 400);
  if (wanted === "owner" && !isWorkspaceOwner(user.role)) {
    return c.json({ error: "forbidden", message: "owner 초대는 owner 만 가능합니다." }, 403);
  }
  try {
    const inv = await createInvite({
      tenantId: user.tenantId,          // 자기 워크스페이스로만 초대할 수 있다
      email,
      role: wanted as "owner" | "admin" | "member",
      invitedBy: user.id,
    });
    return c.json({ inviteId: inv.id, token: inv.token, expiresAt: inv.expiresAt });
  } catch (e: any) {
    return c.json({ error: "invite_failed", message: String(e?.message ?? e) }, 400);
  }
});

app.delete("/api/workspace/invites/:id", async (c) => {
  const user = requireManager(c);
  const ok = await revokeInvite(user.tenantId, c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// 구 경로. 워크스페이스 초대로 이름이 바뀌었지만 이미 쓰던 곳이 있을 수 있어 남겨 둔다.
app.post("/api/auth/invites", async (c) => {
  const user = requireManager(c);
  const { email, role } = await c.req.json<{ email?: string; role?: string }>().catch(() => ({}) as any);
  if (!email) return c.json({ error: "email_required" }, 400);
  if (role && !["admin", "member"].includes(role)) return c.json({ error: "invalid_role" }, 400);
  try {
    const inv = await createInvite({
      tenantId: user.tenantId,
      email,
      role: (role as "admin" | "member") ?? "member",
      invitedBy: user.id,
    });
    return c.json({ inviteId: inv.id, token: inv.token, expiresAt: inv.expiresAt });
  } catch (e: any) {
    return c.json({ error: "invite_failed", message: String(e?.message ?? e) }, 400);
  }
});

app.post("/api/auth/accept-invite", async (c) => {
  const { token, password, name } = await c.req
    .json<{ token?: string; password?: string; name?: string }>()
    .catch(() => ({}) as any);
  if (!token || !password) return c.json({ error: "token_and_password_required" }, 400);
  try {
    const user = await acceptInvite(token, { password, name });
    const sess = await createSession(user, { userAgent: c.req.header("user-agent") });
    setCookie(c, SESSION_COOKIE, sess.token, sessionCookieOpts(sess.expiresAt));
    return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } });
  } catch (e: any) {
    return c.json({ error: "accept_failed", message: String(e?.message ?? e) }, 400);
  }
});

// ── 플랫폼 관리자 API (admin.stepd.stepai.kr) ─────────────────────────────────
// 격리를 합법적으로 우회하는 유일한 경로다. 세 가지가 항상 같이 간다:
//   superadmin 세션 확인 → 사유 강제(남의 테넌트일 때) → 감사 기록 후 실행.
// 감사 기록이 실패하면 요청도 실패한다(admin.ts audit 참조).

/** 전 테넌트 요약 — 관리 콘솔 첫 화면. */
app.get("/api/superadmin/overview", async (c) => {
  const actor = requireSuperadmin(c);
  await audit(actor, { action: "overview.view" }, clientIp(c));
  const p = getRawPool();
  // tenants·users 는 RLS 대상이 아니라 rawPool 로 읽는다. job_queue·media 는 RLS 표라
  // 시스템 스코프가 필요하다 — rawPool 로 읽으면 0 이 나온다(또는 커넥션에 남은 남의 스코프).
  const [tenants, users, jobs, media] = await Promise.all([
    p.query(`SELECT COUNT(*)::int AS n FROM tenants`),
    p.query(`SELECT COUNT(*)::int AS n FROM users WHERE status = 'active'`),
    asSystem((db) => db.query(`SELECT status, COUNT(*)::int AS n FROM job_queue GROUP BY status`)),
    asSystem((db) => db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(durationSec), 0)::float AS sec FROM media`)),
  ]);
  const jobStats: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of jobs.rows as { status: string; n: number }[]) jobStats[r.status] = r.n;
  return c.json({
    tenants: tenants.rows[0].n,
    users: users.rows[0].n,
    jobs: jobStats,
    media: { count: media.rows[0].n, minutes: Math.round(media.rows[0].sec / 60) },
  });
});

/** 테넌트 목록 + 테넌트별 규모. 과금 화면의 원형이기도 하다(분 단위 사용량). */
app.get("/api/superadmin/tenants", async (c) => {
  const actor = requireSuperadmin(c);
  await audit(actor, { action: "tenant.list" }, clientIp(c));
  // media·credit_ledger 는 RLS 표다 — tenants·users 와 한 쿼리로 조인하면 rawPool 로는
  // 0 이 나오므로, 회사 기본정보(비 RLS)와 규모·잔액(RLS)을 나눠 읽고 코드에서 합친다.
  const [base, scale] = await Promise.all([
    getRawPool().query(`
      SELECT t.id, t.name, t.kind, t.status, t.billing_email AS "billingEmail", t.created_at AS "createdAt",
             (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS "userCount",
             (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS "lastLoginAt"
        FROM tenants t ORDER BY t.created_at DESC`),
    asSystem(async (db) => {
      const [media, credits] = await Promise.all([
        db.query(`SELECT tenant_id AS "tenantId", COUNT(*)::int AS "mediaCount",
                         COALESCE(SUM(durationSec), 0)::float AS "mediaSec"
                    FROM media GROUP BY tenant_id`),
        db.query(`SELECT tenant_id AS "tenantId",
                         COALESCE(SUM(delta), 0)::int AS credits,
                         COALESCE(SUM(CASE WHEN delta < 0 AND occurred_at >= date_trunc('month', now())
                                           THEN -delta ELSE 0 END), 0)::int AS "usedThisMonth"
                    FROM credit_ledger GROUP BY tenant_id`),
      ]);
      return { media: media.rows, credits: credits.rows };
    }),
  ]);
  const byMedia = new Map(scale.media.map((r: any) => [r.tenantId, r]));
  const byCredit = new Map(scale.credits.map((r: any) => [r.tenantId, r]));
  const tenants = base.rows.map((t: any) => ({
    ...t,
    mediaCount: byMedia.get(t.id)?.mediaCount ?? 0,
    mediaSec: byMedia.get(t.id)?.mediaSec ?? 0,
    credits: byCredit.get(t.id)?.credits ?? 0,
    usedThisMonth: byCredit.get(t.id)?.usedThisMonth ?? 0,
  }));
  return c.json({ tenants });
});

/**
 * 회사 개설 — 회사 + 첫 owner 초대 + 초기 크레딧을 **한 트랜잭션**으로 (다회사 2단계).
 *
 * 예전엔 회사 만들기와 초대가 따로였다. 초대가 실패하면 **아무도 들어갈 수 없는 회사**가
 * 남는데, 목록에선 그냥 "사용자 0명"으로 보여서 운영자가 사고를 알아채지 못했다.
 * 이제 셋 중 하나라도 실패하면 전부 롤백된다.
 */
app.post("/api/superadmin/tenants", async (c) => {
  const actor = requireSuperadmin(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  // 한글 이름은 슬러그가 통째로 비어서 예전엔 전부 `t__` 로 충돌했다 — nonce 로 대체한다.
  const checked = planOnboarding(body, crypto.randomBytes(5).toString("hex"));
  if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, 400);
  const plan = checked.plan;

  await audit(
    actor,
    {
      action: "tenant.create",
      targetTenant: plan.id,
      detail: { name: plan.name, kind: plan.kind, ownerEmail: plan.ownerEmail, initialCredits: plan.initialCredits },
    },
    clientIp(c),
  );

  let invite: { token: string; expiresAt: number; id: string };
  try {
    invite = await withRawTransaction(async (db) => {
      await db.query(`INSERT INTO tenants (id, name, kind, billing_email) VALUES ($1,$2,$3,$4)`, [
        plan.id, plan.name, plan.kind, plan.billingEmail,
      ]);
      // 초기 크레딧은 무상 지급(grant)이다 — 결제 원장(topup)과 섞이면 매출이 부풀어 보인다.
      if (plan.initialCredits > 0) {
        await db.query(
          `INSERT INTO credit_ledger (tenant_id, delta, reason, note, actor, dedupe_key)
           VALUES ($1,$2,'grant',$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
          [plan.id, plan.initialCredits, "개설 지급", actor.email, grantDedupeKey(plan.id)],
        );
      }
      return createInvite(
        { tenantId: plan.id, email: plan.ownerEmail, role: "owner", invitedBy: actor.id },
        db,
      );
    });
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: "duplicate_id", message: `이미 있는 회사 id 입니다: ${plan.id}` }, 409);
    // 초대 실패(이미 계정이 있는 이메일 등)도 여기로 온다 — 회사는 만들어지지 않았다.
    return c.json({ error: "create_failed", message: String(e?.message ?? e) }, 400);
  }

  // 테넌트가 둘 이상이 되는 순간 인증 없이 도는 건 위험하다 — 즉시 자세를 다시 점검한다.
  await assertAuthPosture();
  return c.json({
    id: plan.id,
    ownerEmail: plan.ownerEmail,
    initialCredits: plan.initialCredits,
    inviteToken: invite.token,
    inviteExpiresAt: invite.expiresAt,
    // 운영자가 그대로 복사해 보낼 수 있는 링크. PUBLIC_URL 이 없으면 null(가짜 링크는 안 만든다).
    inviteUrl: inviteLink(process.env.PUBLIC_URL, invite.token),
    authPostureError,
  });
});

app.patch("/api/superadmin/tenants/:id", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: string; name?: string; billingEmail?: string; reason?: string }>().catch(() => ({}) as any);
  const reason = requireReason(actor, id, body.reason);
  if (body.status && !["active", "suspended", "closed"].includes(body.status)) {
    return c.json({ error: "invalid_status" }, 400);
  }
  await audit(actor, { action: "tenant.update", targetTenant: id, reason, detail: { ...body, reason: undefined } }, clientIp(c));
  const { rowCount } = await getRawPool().query(
    `UPDATE tenants SET status = COALESCE($2, status), name = COALESCE($3, name),
            billing_email = COALESCE($4, billing_email) WHERE id = $1`,
    [id, body.status ?? null, body.name ?? null, body.billingEmail ?? null],
  );
  if (!rowCount) return c.json({ error: "not_found" }, 404);
  // 상태만 바꾸고 끝내면 이미 로그인해 있는 사람들은 계속 쓴다. 사용자 정지는 예전부터
  // 세션을 끊었는데(아래 users/:id/status) 회사 정지만 안 끊고 있었다 — 정지 버튼이
  // 아무것도 안 막던 이유. 몇 개를 끊었는지 돌려줘서 화면이 "정말 끊겼는지" 보여줄 수 있게 한다.
  let sessionsRevoked = 0;
  if (body.status === "suspended" || body.status === "closed") {
    sessionsRevoked = await destroyTenantSessions(id);
  }
  return c.json({ ok: true, sessionsRevoked });
});

/** 사용자 목록. tenant 파라미터로 좁힐 수 있고, 남의 테넌트를 볼 때는 사유가 필요하다. */
app.get("/api/superadmin/users", async (c) => {
  const actor = requireSuperadmin(c);
  const tenant = c.req.query("tenant") ?? null;
  const reason = requireReason(actor, tenant, c.req.query("reason"));
  await audit(actor, { action: "user.list", targetTenant: tenant, reason }, clientIp(c));
  const { rows } = await getRawPool().query(
    `SELECT id, tenant_id AS "tenantId", email, name, role, status,
            created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM users ${tenant ? "WHERE tenant_id = $1" : ""} ORDER BY created_at DESC LIMIT 500`,
    tenant ? [tenant] : [],
  );
  return c.json({ users: rows });
});

/** 계정 정지/해제. 정지는 세션까지 끊어야 실제로 막힌다 — 안 그러면 이미 로그인한 창은 계속 돈다. */
app.post("/api/superadmin/users/:id/status", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: string; reason?: string }>().catch(() => ({}) as any);
  if (!["active", "suspended"].includes(String(body.status))) return c.json({ error: "invalid_status" }, 400);
  if (id === actor.id) return c.json({ error: "cannot_change_self" }, 400);

  const { rows } = await getRawPool().query(`SELECT tenant_id AS "tenantId" FROM users WHERE id = $1`, [id]);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, rows[0].tenantId, body.reason);
  await audit(actor, { action: `user.${body.status}`, targetTenant: rows[0].tenantId, targetId: id, reason }, clientIp(c));

  await getRawPool().query(`UPDATE users SET status = $2 WHERE id = $1`, [id, body.status]);
  if (body.status === "suspended") await destroyAllSessions(id);
  return c.json({ ok: true });
});

/** 테넌트에 사람을 초대한다. 토큰은 이 응답에 한 번만 나온다(메일 발송은 아직 없음). */
app.post("/api/superadmin/tenants/:id/invite", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const body = await c.req.json<{ email?: string; role?: string; reason?: string }>().catch(() => ({}) as any);
  if (!body.email) return c.json({ error: "email_required" }, 400);
  const role = ["owner", "admin", "member"].includes(String(body.role)) ? (body.role as "owner" | "admin" | "member") : "owner";
  const reason = requireReason(actor, tenantId, body.reason);
  await audit(actor, { action: "user.invite", targetTenant: tenantId, reason, detail: { email: body.email, role } }, clientIp(c));
  try {
    const inv = await createInvite({ tenantId, email: body.email, role, invitedBy: actor.id });
    return c.json({ inviteId: inv.id, token: inv.token, expiresAt: inv.expiresAt });
  } catch (e: any) {
    return c.json({ error: "invite_failed", message: String(e?.message ?? e) }, 400);
  }
});

/** 전 테넌트 잡 — 운영 현황. 잡 payload 에 남의 콘텐츠 식별자가 들어 있어 열람도 감사한다. */
app.get("/api/superadmin/jobs", async (c) => {
  const actor = requireSuperadmin(c);
  await audit(actor, { action: "job.list" }, clientIp(c));
  const { rows } = await asSystem((db) => db.query(
    `SELECT id, type, status, attempts, tenant_id AS "tenantId", error,
            createdat AS "createdAt", updatedat AS "updatedAt"
       FROM job_queue ORDER BY updatedAt DESC LIMIT 200`,
  ));
  return c.json({ jobs: rows });
});

// ── 회사별 API 키 (다회사 3단계) ──────────────────────────────────────────────
// 평문은 **발급 응답에 한 번만** 나간다. DB 엔 sha256 과 접두만 둔다 — 저장하면
// DB 유출이 곧 남의 채널에 영상을 올릴 수 있는 권한이 된다.

app.get("/api/superadmin/tenants/:id/api-keys", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  await audit(actor, { action: "apikey.list", targetTenant: tenantId }, clientIp(c));
  // api_keys 는 RLS 표라 rawPool 로 읽으면 0행이 나온다 — 시스템 스코프로 읽는다.
  const { rows } = await asSystem((db) => db.query(
    `SELECT id, name, prefix, scopes, last_used_at AS "lastUsedAt",
            revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  ));
  return c.json({ keys: rows, scopes: API_SCOPES });
});

app.post("/api/superadmin/tenants/:id/api-keys", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const body = await c.req.json<{ name?: string; scopes?: unknown; reason?: string }>().catch(() => ({}) as any);
  const reason = requireReason(actor, tenantId, body.reason);

  // 모르는 스코프는 버린다. 다 버려서 비면 **키를 만들지 않는다** — 아무것도 못 하는 키를
  // 쥐여 주면 고객사는 그게 권한 문제인지 장애인지 구분하지 못한다.
  const scopes = normalizeScopes(body.scopes);
  if (scopes.length === 0) {
    return c.json(
      { error: "scopes_required", message: `허용할 권한을 하나 이상 고르세요: ${API_SCOPES.join(", ")}` },
      400,
    );
  }

  const raw = generateKey(true);
  const id = `ak_${crypto.randomBytes(9).toString("base64url")}`;
  await audit(
    actor,
    { action: "apikey.create", targetTenant: tenantId, targetId: id, reason, detail: { scopes, name: body.name ?? "" } },
    clientIp(c),
  );
  try {
    await asSystem((db) => db.query(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scopes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenantId, String(body.name ?? "").trim() || null, hashKey(raw), keyPrefix(raw), scopes],
    ));
  } catch (e: any) {
    if (e?.code === "23503") return c.json({ error: "tenant_not_found" }, 404);
    throw e;
  }
  // ⚠️ `key` 는 이 응답에만 있다. 다시 얻을 수 없다.
  return c.json({ id, key: raw, prefix: keyPrefix(raw), scopes });
});

app.post("/api/superadmin/api-keys/:keyId/revoke", async (c) => {
  const actor = requireSuperadmin(c);
  const keyId = c.req.param("keyId");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as any);
  // 어느 회사 키인지 먼저 알아야 사유 강제 판정이 선다.
  const { rows } = await asSystem((db) =>
    db.query(`SELECT tenant_id AS "tenantId" FROM api_keys WHERE id = $1`, [keyId]));
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, rows[0].tenantId, body.reason);
  await audit(
    actor,
    { action: "apikey.revoke", targetTenant: rows[0].tenantId, targetId: keyId, reason },
    clientIp(c),
  );
  // 행을 지우지 않고 revoked_at 을 찍는다 — 누가 언제 발급하고 폐기했는지가 남아야 한다.
  const { rowCount } = await asSystem((db) => db.query(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [keyId],
  ));
  return c.json({ ok: true, alreadyRevoked: rowCount === 0 });
});

/** 감사 로그. superadmin 이 서로를 볼 수 있어야 견제가 성립한다. */
app.get("/api/superadmin/audit", async (c) => {
  requireSuperadmin(c);   // 감사 로그 열람 자체는 감사하지 않는다 — 무한 증식만 만든다
  const { rows } = await getRawPool().query(
    `SELECT id, actor_email AS "actorEmail", action, target_tenant AS "targetTenant",
            target_id AS "targetId", reason, detail, ip, at
       FROM admin_audit ORDER BY at DESC LIMIT 300`,
  );
  return c.json({ entries: rows });
});

// ── full state (web InitialData + media) ──────────────────────────────────────
app.get("/api/state", async (c) => c.json(await getState()));

// ── 자연어 영상 검색 (search_segments · pgvector) ──────────────────────────────
// 필터(프로그램·스코프·회차·방영일·인물·장면유형)는 파라미터로, 의미검색은 q로.
// q → pg_trgm 키워드 + Vertex 쿼리 임베딩 코사인 하이브리드. 권리·스포일러는 SQL에서
// 걸러지고, 남은 상태(음원·PPL·미확인)는 카드에 주석으로 붙는다.
// NOTE: q를 {인물·스코프·회차} 필터로 쪼개는 LLM 쿼리 파서는 다음 슬라이스 — 지금은
//       구조 필터를 명시 파라미터로 받는다. core/search.py의 룰 파서가 그 참조 구현.
function annotateRights(rights: Record<string, unknown>): Record<string, string> {
  const n: Record<string, string> = {};
  if (rights.spoiler === true) n.spoiler = "⚠️ 스포일러";
  if (rights.cast_ok == null) n.cast_ok = "출연자 권리 확인필요";
  if (rights.music_cleared === false) n.music_cleared = "⚠️ 음원 미클리어";
  else if (rights.music_cleared == null) n.music_cleared = "음원 확인필요";
  // ppl_hint 는 파이프라인이 찾은 **힌트**다 — 권리 판정이 아니다(F3 자동 판정 없음).
  // 문구도 판정처럼 읽히지 않게 쓴다. 구 데이터의 ppl 도 같은 취급.
  if (rights.ppl_hint === true || rights.ppl === true) n.ppl = "PPL 가능성 — 검수 필요";
  return n;
}

app.get("/api/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const programId = c.req.query("program") || undefined;
  const explicitChars = (c.req.query("character") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const isShortParam = c.req.query("is_short");
  const explicitIsShort = isShortParam == null ? undefined : (isShortParam === "true" || isShortParam === "1");

  // LLM 쿼리 파서 — q를 {인물·장면유형·방영기간·쇼츠·semantic}로 분해. 명시 파라미터가 우선.
  // 인물 후보(roster)는 프로그램 세그먼트에서 뽑아 환각을 막는다. 실패 시 룰 폴백.
  const roster = await listKnownCharacters(programId).catch(() => [] as string[]);
  const parsed = q ? await parseQuery(q, { roster }) : { characters: [], semantic: "" };
  const mergedChars = explicitChars.length ? explicitChars : parsed.characters;
  const searchText = (parsed.semantic || q) || undefined;

  const query: SearchQuery = {
    queryText: searchText,
    programId,
    genre: c.req.query("genre") || undefined,
    scopeType: c.req.query("scope_type") || undefined,
    scopeId: c.req.query("scope_id") || undefined,
    episode: c.req.query("episode") || undefined,
    airedFrom: c.req.query("aired_from") || parsed.airedFrom || undefined,
    airedTo: c.req.query("aired_to") || parsed.airedTo || undefined,
    characters: mergedChars.length ? mergedChars : undefined,
    sceneType: c.req.query("scene_type") || parsed.sceneType || undefined,
    isShort: explicitIsShort ?? parsed.isShort,
    allowSpoiler: c.req.query("allow_spoiler") === "true",
    topK: c.req.query("top_k") ? Number(c.req.query("top_k")) : 20,
  };
  // 의미 축 — 파싱된 semantic을 임베딩 (실패하면 null → 키워드 축만으로 랭킹)
  query.queryVec = searchText ? await embedQuery(searchText) : null;

  let hits: SearchHit[];
  try {
    hits = await searchSegments(query);
  } catch (e) {
    // search_segments 테이블 미존재(마이그레이션 미적용) 등
    return c.json({ error: e instanceof Error ? e.message : String(e), results: [] }, 500);
  }

  // 검색 로그 — 노출 후보를 순위와 함께 남긴다(Recall 평가 · 이후 click/export 조인).
  // queryId 를 응답에 실어야 클라이언트가 후속 이벤트를 같은 쿼리에 묶을 수 있다.
  // await 하지 않는다 — 로그 지연이 검색 응답을 붙잡으면 안 된다.
  const queryId = newQueryId();
  void logSearchEvent({
    event: "search",
    queryId,
    source: "search",
    userId: c.req.header("x-user") ?? "",
    role: c.req.header("x-role") ?? "",
    query: q,
    parsed: { ...parsed, charactersUsed: query.characters ?? [], embedded: query.queryVec != null },
    candidates: hits.map((h, i) => ({
      rank: i + 1, segment_id: h.segmentId, score: h.score, lex: h.lex, vec: h.vec,
    })),
    resultCount: hits.length,
  });

  return c.json({
    query: q,
    queryId,
    parsed: { ...parsed, charactersUsed: query.characters ?? [] },
    embedded: query.queryVec != null,
    count: hits.length,
    results: hits.map((h) => ({
      segmentId: h.segmentId,
      mediaId: h.mediaId,
      start: h.start,
      end: h.end,
      duration: h.duration,
      characters: h.characters,
      sceneType: h.sceneType,
      isShort: h.isShort,
      highlightScore: h.highlightScore,
      summary: h.summary,
      dialogue: h.dialogue,
      rightsStatus: annotateRights(h.rights),
      score: h.score,
      lex: h.lex,
      vec: h.vec,
    })),
  });
});

// ── 검색 로그 수집 (click · export · boundary_adjust) ─────────────────────────
// search 이벤트는 /api/search 가 스스로 남긴다. 여기는 클라이언트가 그 뒤에 일어난 일을
// 같은 queryId 로 이어 붙이는 입구. 반환은 항상 202 — 로그가 UI 흐름을 막으면 안 된다.
const LOG_EVENTS: SearchEventKind[] = ["click", "export", "boundary_adjust"];

app.post("/api/search/log", async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const event = String(b.event ?? "") as SearchEventKind;
  if (!LOG_EVENTS.includes(event)) {
    return c.json({ error: `event must be one of ${LOG_EVENTS.join("|")}` }, 400);
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const bounds = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { start: num(o.start), end: num(o.end) };
  };
  void logSearchEvent({
    event,
    queryId: typeof b.queryId === "string" ? b.queryId : null,
    source: "search",
    userId: c.req.header("x-user") ?? "",
    role: c.req.header("x-role") ?? "",
    segmentId: typeof b.segmentId === "string" ? b.segmentId : null,
    mediaId: typeof b.mediaId === "string" ? b.mediaId : null,
    clipId: typeof b.clipId === "string" ? b.clipId : null,
    rank: num(b.rank),
    start: num(b.start),
    end: num(b.end),
    before: b.before ? bounds(b.before) : null,
    after: b.after ? bounds(b.after) : null,
  });
  return c.json({ ok: true }, 202);
});

// 로그 열람 — 평가·학습 추출용(운영 진단). 기본은 boundary_adjust 없이 전체 최신순.
app.get("/api/search/log", async (c) => {
  const ev = c.req.query("event") as SearchEventKind | undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  try {
    return c.json({ events: await listSearchEvents({ event: ev, limit }) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), events: [] }, 500);
  }
});

// ── create a program (content root — must exist before any upload) ──
app.post("/api/programs", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title required" }, 400);

  const section =
    typeof body.section === "string" && body.section.trim() ? body.section.trim() : "예능";
  const targetAge = typeof body.targetAge === "number" ? body.targetAge : 0;
  const cast = Array.isArray(body.cast)
    ? body.cast.filter((x: unknown): x is string => typeof x === "string")
    : [];

  // SMR feed metadata (program-level, set once — docs/plans/publish-fields-ux-plan.md §5.1③).
  const smr: { programCode?: string; category?: string; weekdays?: number[] } = {};
  if (typeof body.programCode === "string" && body.programCode.trim()) {
    smr.programCode = body.programCode.trim().toLowerCase();
  }
  if (typeof body.category === "string" && body.category.trim()) {
    smr.category = body.category.trim();
  }
  if (Array.isArray(body.weekdays)) {
    const days = body.weekdays.filter((n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 6);
    if (days.length) smr.weekdays = days;
  }

  const pipelineGenre =
    typeof body.pipelineGenre === "string" && (body.pipelineGenre === "variety" || body.pipelineGenre === "drama")
      ? body.pipelineGenre
      : undefined;

  const id = newId("p");
  const program = {
    id,
    title,
    section,
    targetAge,
    cast,
    episodeCount: 0,
    status: "active" as const,
    ...(pipelineGenre ? { pipelineGenre } : {}),
    ...(Object.keys(smr).length ? { smr } : {}),
    // Optional understanding profile (feeds candidate scoring — plan §program-fit). Stored
    // as JSON on the entity; normalized so downstream can trust the shape.
    ...(body.profile !== undefined ? { profile: normalizeProfile(body.profile) } : {}),
  };
  await prependEntity("program", id, program);
  return c.json({ program });
});

// ── get one program (incl. its understanding profile) ──
app.get("/api/programs/:id", async (c) => {
  const program = await getEntity<Record<string, unknown>>("program", c.req.param("id"));
  if (!program) return c.json({ error: "program not found" }, 404);
  return c.json({ program });
});

// ── 얼굴 분석 → program 수동 sync (파이프라인 native crash 우회) ──
// 워커 python subprocess가 native cleanup crash로 tsx까지 죽어 자동 sync 못 도달하는 경우
// 사용자가 UI에서 강제 트리거. mediaId 없으면 이 프로그램의 가장 최근 분석 media 자동 선택.
app.post("/api/programs/:id/sync-from-analysis", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<any>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  let mediaId = typeof body.mediaId === "string" ? body.mediaId : "";

  if (!mediaId) {
    // 이 프로그램의 최근 분석된 media 자동 선택. 최근 content_analysis 기준.
    try {
      const { rows } = await getPool().query(
        `SELECT ca.mediaid
           FROM content_analysis ca
           JOIN entities e ON e.kind='media' AND e.id = ca.mediaid
           JOIN entities ep ON ep.kind='episode' AND ep.id = e.data->>'episodeId'
          WHERE ep.data->>'programId' = $1
          ORDER BY ca.updatedat DESC NULLS LAST
          LIMIT 1`,
        [id],
      );
      if (rows[0]?.mediaid) mediaId = rows[0].mediaid as string;
    } catch (e) {
      console.warn("[sync-from-analysis] media lookup failed:", e);
    }
  }
  if (!mediaId) return c.json({ error: "no analyzed media found for this program" }, 404);

  try {
    const r = await syncProgramFromFacesForMedia(id, mediaId);
    return c.json({
      mediaId,
      workDirExists: r.workDirExists,
      addedNames: r.addedNames,
      addedPhotos: r.addedPhotos,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), mediaId }, 500);
  }
});

// ── autofill program metadata via Gemini + google_search grounding ──
// 프로그램 제목만으로 웹 검색·팩트체크로 나머지 필드 자동 채움 (2단계: 검색·수집 → 팩트체크).
// 출연자·SMR은 채우지 않음. 결과는 저장하지 않고 반환만 — 사용자가 UI에서 확인 후 저장.
app.post("/api/programs/:id/autofill", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);
  const title = typeof program.title === "string" ? program.title.trim() : "";
  if (!title) return c.json({ error: "program title empty" }, 400);

  const cwd = REPO_ROOT;

  const result: unknown = await new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON, ["-X", "utf8", "-m", "core.autofill_program", "--mode", "questions", title], {
      cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (b) => { out += b.toString(); });
    proc.stderr.on("data", (b) => { err += b.toString(); });
    // 90초 안에 안 끝나면 킬 — grounding 콜 2번이라 대개 20~40초.
    const to = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 90_000);
    proc.on("error", (e) => { clearTimeout(to); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`autofill exit ${code}: ${err.slice(-300)}`));
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`autofill parse: ${(e as Error).message} · out=${out.slice(0, 200)}`)); }
    });
  }).catch((e) => {
    console.error("[programs.autofill] failed:", e instanceof Error ? e.message : e);
    return { error: e instanceof Error ? e.message : String(e) };
  });

  const r = (result || {}) as Record<string, unknown>;
  if (r.error && !r.fields) {
    return c.json({ error: "autofill failed", detail: String(r.error).slice(0, 300) }, 502);
  }
  return c.json({
    draft: (r.draft as Record<string, unknown>) || {},
    sources: (r.sources as unknown[]) || [],
    evidence: (r.evidence as Record<string, unknown>) || {},
    dropped: (r.dropped as string[]) || [],
    questions: (r.questions as unknown[]) || [],
  });
});

// ── 대화형 자동 채움 (stateless · history 전체 클라이언트에서 전송) — [사용 안 함, 참고용] ──
app.post("/api/programs/:id/autofill/chat", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);
  const title = typeof program.title === "string" ? program.title.trim() : "";
  if (!title) return c.json({ error: "program title empty" }, 400);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const history = Array.isArray(body.history) ? body.history : [];
  const draft = (body.draft && typeof body.draft === "object") ? body.draft : {};
  const sources = Array.isArray(body.sources) ? body.sources : [];


  const result: unknown = await new Promise((resolve, reject) => {
    const args = [
      "-X", "utf8", "-m", "core.autofill_program",
      "--mode", "chat", title,
      "--history", JSON.stringify(history),
      "--draft", JSON.stringify(draft),
      "--sources", JSON.stringify(sources),
    ];
    const proc = spawn(CORE_PYTHON, args, {
      cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (b) => { out += b.toString(); });
    proc.stderr.on("data", (b) => { err += b.toString(); });
    const to = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 90_000);
    proc.on("error", (e) => { clearTimeout(to); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`autofill.chat exit ${code}: ${err.slice(-300)}`));
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`autofill.chat parse: ${(e as Error).message}`)); }
    });
  }).catch((e) => {
    console.error("[programs.autofill.chat] failed:", e instanceof Error ? e.message : e);
    return { message: e instanceof Error ? e.message : String(e), action: "error" };
  });

  const r = (result || {}) as Record<string, unknown>;
  return c.json({
    message: typeof r.message === "string" ? r.message : "",
    action: (r.action as string) || "error",
    draft: (r.draft as Record<string, unknown>) || {},
    fields: (r.fields as Record<string, unknown>) || undefined,
    sources: (r.sources as unknown[]) || [],
    evidence: (r.evidence as Record<string, unknown>) || undefined,
    dropped: (r.dropped as string[]) || undefined,
  });
});

// ── update a program (partial merge — only fields present in the body change) ──
app.patch("/api/programs/:id", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  const next: Record<string, unknown> = { ...program };
  if (typeof body.title === "string" && body.title.trim()) next.title = body.title.trim();
  if (typeof body.section === "string" && body.section.trim()) next.section = body.section.trim();
  if (typeof body.targetAge === "number") next.targetAge = body.targetAge;
  // 파이프라인 분기 축 — variety/drama만 유효. 빈 문자열/기타는 제거(=미설정 → auto).
  if (typeof body.pipelineGenre === "string") {
    const g = body.pipelineGenre.trim();
    if (g === "variety" || g === "drama") next.pipelineGenre = g;
    else delete next.pipelineGenre;
  }
  // 편성 상태 — 사람이 지정한다(FLOWS F10 · 자동 판정 없음). 구값 active/archived 도 그대로
  // 받아 둔다: 아직 안 고친 프로그램이 PATCH 될 때 상태가 날아가면 안 된다.
  if (typeof body.status === "string") {
    const s = body.status.trim();
    if (["airing", "ended", "upcoming", "active", "archived"].includes(s)) next.status = s;
  }
  // ── TV/OTT 프로그램 정보 필드 (모두 optional). 빈 문자열 = 필드 삭제, 문자열이면 저장. ──
  const strFields = [
    "synopsis", "broadcaster", "schedule", "firstAiredDate", "currentInfo",
    "director", "spinoff", "awards",
    // 담당 PD ("내 담당만" 필터의 비교 대상) · 권리 윈도우(만료일 + 자유 메모) · 종영일.
    // ⚠️ rightsUntil 은 경고용이다 — 지나도 배포를 자동 차단하지 않는다(F3 "자동 판정 없음").
    "owner", "rightsUntil", "rightsNote", "endedDate",
  ] as const;
  for (const k of strFields) {
    const v = body[k];
    if (typeof v === "string") {
      const t = v.trim();
      if (t) next[k] = t;
      else delete next[k];
    }
  }
  if (Array.isArray(body.moods)) {
    const moods: string[] = [];
    for (const x of body.moods) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      if (t) moods.push(t);
    }
    if (moods.length) next.moods = moods;
    else delete next.moods;
  }
  // 프로그램 포스터 이미지(data URL) — 빈 문자열이면 삭제, 값 있으면 저장.
  if (typeof body.posterImageDataUrl === "string") {
    const s = body.posterImageDataUrl.trim();
    if (s) next.posterImageDataUrl = s;
    else delete next.posterImageDataUrl;
  }
  // 출연자별 인물 이미지 매핑 — 객체(name→dataUrl). cast에 없는 키는 서버 측에서도 정리.
  if (body.castPhotos && typeof body.castPhotos === "object" && !Array.isArray(body.castPhotos)) {
    const photos: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.castPhotos)) {
      if (typeof k === "string" && typeof v === "string" && v.trim()) {
        photos[k] = v;
      }
    }
    if (Object.keys(photos).length) next.castPhotos = photos;
    else delete next.castPhotos;
  }
  if (Array.isArray(body.cast)) {
    next.cast = body.cast.filter((x: unknown): x is string => typeof x === "string");
    // 2026-07-23: entities.data.cast → program_cast 테이블 sync. 파이프라인(listProgramCast)이
    // program_cast에서 읽으므로 UI가 program_cast API 안 써도 여기서 sync. 기존 목록 전부
    // 삭제 후 새로 insert (덮어쓰기 시맨틱).
    const pool = getPool();
    await pool.query("DELETE FROM program_cast WHERE programid = $1", [id]);
    for (const name of next.cast as string[]) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const castId = newId("cast");
      try {
        await upsertCastMember({ 
          castId, 
          programId: id, 
          name: trimmed,
          aliases: [],
          role: "member",
          season: "",
          note: ""
        });
      } catch (e: any) {
        // (programId, name, season) unique · 중복이면 조용히 skip
        if (e?.code !== "23505") throw e;
      }
    }
    // cast에서 사라진 이름은 castPhotos 매핑에서도 orphan 정리.
    if (next.castPhotos && typeof next.castPhotos === "object") {
      const keep = new Set(next.cast as string[]);
      const pruned: Record<string, string> = {};
      for (const [k, v] of Object.entries(next.castPhotos as Record<string, string>)) {
        if (keep.has(k)) pruned[k] = v;
      }
      if (Object.keys(pruned).length) next.castPhotos = pruned;
      else delete next.castPhotos;
    }
  }

  // SMR: merge onto the existing config so fields absent from the body survive; an
  // explicitly-sent empty value clears that field (the edit UI sends what it manages).
  const smr = { ...((program.smr as Record<string, unknown> | undefined) ?? {}) };
  if (typeof body.programCode === "string") {
    const code = body.programCode.trim().toLowerCase();
    if (code) smr.programCode = code;
    else delete smr.programCode;
  }
  if (typeof body.category === "string") {
    if (body.category.trim()) smr.category = body.category.trim();
    else delete smr.category;
  }
  if (Array.isArray(body.weekdays)) {
    const days = body.weekdays.filter((n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 6);
    if (days.length) smr.weekdays = days;
    else delete smr.weekdays;
  }
  if (Object.keys(smr).length) next.smr = smr;
  else delete next.smr;

  await putEntity("program", id, next);
  return c.json({ program: next });
});

// ── generate an understanding profile via Vertex Gemini (3 modes) ──
// mode: direct(프로그램명/장르/설명) · websearch(프로그램명→웹검색+sources) · planning(기획정보).
// Returns a normalized profile; the caller reviews then POST/PATCHes it onto a program.
app.post("/api/programs/profile/generate", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const mode: GenerateMode =
    body.mode === "websearch" || body.mode === "planning" ? body.mode : "direct";
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return c.json({ error: "input required" }, 400);

  const prompt = `${promptForMode(mode)}\n\n=== 입력 ===\n${input}`;
  try {
    // Web-search mode grounds via the googleSearch tool (no responseSchema allowed with
    // tools); the other modes use the strict JSON responseSchema.
    const useSearch = mode === "websearch";
    const res = await geminiGenerate(prompt, {
      ...(useSearch
        ? { tools: [{ googleSearch: {} }], temperature: 0.4 }
        : { schema: PROFILE_RESPONSE_SCHEMA, temperature: 0.3 }),
    });
    const profile = normalizeProfile(parseJsonLoose(res.text));
    if (mode === "planning") profile.memes = []; // 미방영작 — 밈 없음
    if (useSearch && res.sources.length && !profile.sources?.length) profile.sources = res.sources;
    return c.json({ mode, profile });
  } catch (e) {
    // websearch may be unavailable (grounding/quota) → tell the caller so the UI can fall
    // back to client-provided material, rather than 500-ing the whole flow.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[profile.generate] failed:", msg);
    return c.json({ error: "profile generation failed", detail: msg.slice(0, 200), mode }, 502);
  }
});

// ── set/replace a program's understanding profile ──
app.patch("/api/programs/:id/profile", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const profile = normalizeProfile(body.profile ?? body);
  await putEntity("program", id, { ...program, profile });
  return c.json({ program: { ...program, profile } });
});

// ── cast registry (프로그램 출연자 레지스트리) ──
//
// The roster that turns "20대 여성" into "23기 영숙". The pipeline matches burned-in
// lower-third name captions against these entries (core/cast.py); a program with no roster
// analyzes exactly as before, with every detected name left as an unmatched candidate.

app.get("/api/programs/:id/cast", async (c) => {
  const program = await getEntity<Record<string, unknown>>("program", c.req.param("id"));
  if (!program) return c.json({ error: "program not found" }, 404);
  return c.json({ cast: await listProgramCast(c.req.param("id")) });
});

app.post("/api/programs/:id/cast", async (c) => {
  const programId = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 404);
  const input = normalizeCastInput(await c.req.json().catch(() => ({})));
  if (!input) return c.json({ error: "name is required" }, 400);
  const castId = newId("cast");
  try {
    await upsertCastMember({ castId, programId, ...input });
  } catch (e: any) {
    // The (programId, name, season) unique index — the operator already registered this person.
    if (e?.code === "23505") return c.json({ error: "이미 등록된 출연자입니다 (프로그램+이름+기수)" }, 409);
    throw e;
  }
  return c.json({ member: await getCastMember(castId) }, 201);
});

app.patch("/api/programs/:id/cast/:castId", async (c) => {
  const { id: programId, castId } = c.req.param();
  const existing = await getCastMember(castId);
  if (!existing || existing.programId !== programId) return c.json({ error: "cast member not found" }, 404);
  // Merge onto the stored row so a partial PATCH doesn't blank the fields it omits.
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const input = normalizeCastInput({ ...existing, ...body });
  if (!input) return c.json({ error: "name is required" }, 400);
  try {
    await upsertCastMember({ castId, programId, ...input });
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: "이미 등록된 출연자입니다 (프로그램+이름+기수)" }, 409);
    throw e;
  }
  return c.json({ member: await getCastMember(castId) });
});

app.delete("/api/programs/:id/cast/:castId", async (c) => {
  const { id: programId, castId } = c.req.param();
  const existing = await getCastMember(castId);
  if (!existing || existing.programId !== programId) return c.json({ error: "cast member not found" }, 404);
  // Past timelines keep their findings (they're evidence); they just lose the roster link.
  await deleteCastMember(castId);
  return c.json({ ok: true, castId });
});

// ── hard delete: media / episode / program (cascade — see admin/reset for the pattern) ──
//
// Order matters: GCS files first (source + thumb + analysis/{id} prefix) so a mid-delete
// crash leaves DB pointing at gone-files (recoverable) rather than DB gone with orphan
// files (silent GCS cost). Then per-media derived tables (content_analysis, transcript,
// episode_cast, in-flight jobs). Then entities.
async function deleteMediaCascade(m: MediaRow): Promise<void> {
  try { await deleteFile(parseObjectPath(m.path)); } catch {}
  if (m.thumbPath) { try { await deleteFile(parseObjectPath(m.thumbPath)); } catch {} }
  try { await deletePrefix(`analysis/${m.id}`); } catch {}
  await deleteMediaData(m.id);
}

app.delete("/api/media/:id", async (c) => {
  const id = c.req.param("id");
  const m = await getMedia(id);
  if (!m) return c.json({ error: "media not found" }, 404);
  await deleteMediaCascade(m);
  return c.json({ ok: true, mediaId: id });
});

app.delete("/api/episodes/:id", async (c) => {
  const id = c.req.param("id");
  const ep = await getEntity<{ id: string; programId?: string }>("episode", id);
  if (!ep) return c.json({ error: "episode not found" }, 404);

  // 자식 미디어 전부 (master + any derivatives)
  const media = (await listMedia()).filter((m) => m.episodeId === id);
  for (const m of media) await deleteMediaCascade(m);

  // 자식 recommendations · clips (JSONB scan)
  await deleteEntitiesByEpisode(id);
  await deleteEntityRow("episode", id);

  return c.json({ ok: true, episodeId: id, mediaDeleted: media.length });
});

app.delete("/api/programs/:id", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<{ id: string }>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);

  // 프로그램 하위 회차 전부 조회 → 각각 위 episode cascade와 동일 순서로 정리
  const episodes = (await listEntities<{ id: string; programId?: string }>("episode"))
    .filter((e) => e.programId === id);
  const allMedia = await listMedia();
  let mediaCount = 0;
  for (const ep of episodes) {
    const media = allMedia.filter((m) => m.episodeId === ep.id);
    for (const m of media) { await deleteMediaCascade(m); mediaCount++; }
    await deleteEntitiesByEpisode(ep.id);
    await deleteEntityRow("episode", ep.id);
  }

  // program_cast (roster) 정리 · 각 castId도 지워 episode_cast의 castId 링크가 orphan 되는 걸 방지.
  try {
    await getPool().query("DELETE FROM program_cast WHERE programid = $1", [id]);
  } catch {}

  await deleteEntityRow("program", id);
  return c.json({ ok: true, programId: id, episodesDeleted: episodes.length, mediaDeleted: mediaCount });
});

// ── episode cast timeline (출연자 × 등장 구간) ──

app.get("/api/media/:id/cast", async (c) => {
  const mediaId = c.req.param("id");
  if (!(await getMedia(mediaId))) return c.json({ error: "media not found" }, 404);
  const people = await listEpisodeCast(mediaId);
  return c.json({
    mediaId,
    people,
    matchedCount: people.filter((p) => p.castId && p.status !== "rejected").length,
    candidateCount: people.filter((p) => !p.castId && p.status === "candidate").length,
  });
});

/**
 * Operator decision on one detected person: confirm / reject / relink.
 * This is the ONLY path to `confirmed` — the pipeline can propose (matched/candidate) but
 * never confirm, so an OCR mistake can't harden into a fact without a human.
 * `castId` optionally links an unmatched candidate to a roster entry in the same call.
 */
app.post("/api/media/:id/cast/:name/status", async (c) => {
  const mediaId = c.req.param("id");
  // Hono already URL-decodes params — a second decodeURIComponent throws on literal '%'.
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const status = String(body.status ?? "");
  if (!["confirmed", "rejected", "candidate", "matched"].includes(status)) {
    return c.json({ error: "status must be confirmed|rejected|candidate|matched" }, 400);
  }
  let castId: string | undefined;
  if (body.castId != null) {
    const member = await getCastMember(String(body.castId));
    if (!member) return c.json({ error: "cast member not found" }, 404);
    castId = member.castId;
  }
  const row = await setEpisodeCastStatus(mediaId, name, status as any, castId);
  if (!row) return c.json({ error: "cast entry not found for this media" }, 404);
  return c.json({ person: row });
});

/**
 * Promote an unmatched candidate into the program's roster in one step: register the name,
 * then link + confirm this episode's finding. The common onboarding move — the pipeline
 * surfaces "누구지?" and the operator answers once, so every later episode matches it.
 */
app.post("/api/media/:id/cast/:name/register", async (c) => {
  const mediaId = c.req.param("id");
  const name = c.req.param("name");
  const media = await getMedia(mediaId);
  if (!media?.episodeId) return c.json({ error: "media not found or not linked to an episode" }, 404);
  const episode = await getEntity<any>("episode", media.episodeId);
  if (!episode?.programId) return c.json({ error: "episode has no program" }, 404);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  // Default the roster name to the detected caption, and keep that caption as an alias so
  // the same OCR spelling matches directly on the next episode.
  const input = normalizeCastInput({ name, ...body });
  if (!input) return c.json({ error: "name is required" }, 400);
  if (input.name !== name && !input.aliases.includes(name)) input.aliases.push(name);

  // Verify the episode-cast entry BEFORE creating the roster member: the old order
  // committed the member, then 404'd on a missing entry — and the client's retry hit
  // 409 "이미 등록된 출연자" for a request it was told had failed.
  const entry = (await listEpisodeCast(mediaId)).find((p) => p.name === name);
  if (!entry) return c.json({ error: "cast entry not found for this media" }, 404);

  const castId = newId("cast");
  try {
    await upsertCastMember({ castId, programId: episode.programId, ...input });
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: "이미 등록된 출연자입니다 (프로그램+이름+기수)" }, 409);
    throw e;
  }
  const person = await setEpisodeCastStatus(mediaId, name, "confirmed", castId);
  if (!person) return c.json({ error: "cast entry not found for this media" }, 404);
  return c.json({ member: await getCastMember(castId), person }, 201);
});

// ── admin: wipe all content (programs/episodes/recommendations/clips + media). Irreversible. ──
app.post("/api/admin/reset", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== "RESET") return c.json({ error: "body.confirm must be 'RESET'" }, 400);

  // Remove stored files first (best-effort) so GCS/local don't accrue orphans.
  const media = await listMedia();
  for (const m of media) {
    try { await deleteFile(parseObjectPath(m.path)); } catch {}
    if (m.thumbPath) { try { await deleteFile(parseObjectPath(m.thumbPath)); } catch {} }
    // Analysis artifacts (scene frames + stage outputs) live under analysis/{mediaId}/.
    try { await deletePrefix(`analysis/${m.id}`); } catch {}
  }

  const pool = getPool();
  await pool.query("DELETE FROM entities WHERE kind IN ('program','episode','recommendation','clip')");
  await pool.query("DELETE FROM media");
  try { await pool.query("DELETE FROM content_analysis"); } catch {}
  // Per-media derived stores. Without these, a reset leaves rows keyed by mediaIds that no
  // longer exist — and program_cast would keep a roster for a program that's gone.
  // Each is guarded: a table not yet migrated must not fail the reset.
  try { await pool.query("DELETE FROM transcript"); } catch {}
  try { await pool.query("DELETE FROM episode_cast"); } catch {}
  try { await pool.query("DELETE FROM program_cast"); } catch {}

  return c.json({ ok: true, deletedMedia: media.length });
});

// ── admin: drain the YouTube-analytics job flood + re-kick content.analyze ──
app.post("/api/admin/queue/purge", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== "PURGE") return c.json({ error: "body.confirm must be 'PURGE'" }, 400);
  const pool = getPool();
  const now = Date.now();
  // Drop the video.* backlog (comments/analytics) — safe to delete, re-enqueued on the
  // next channel tick. This is what starves content.analyze.
  const del = await pool.query(
    "DELETE FROM job_queue WHERE type LIKE 'video.%' AND status IN ('pending','failed')",
  );
  // Drop zombie content.analyze jobs whose media no longer exists (e.g. left over from a
  // reset). They fail "media not found" forever and, being oldest, block the real job.
  const dead = await pool.query(
    "DELETE FROM job_queue WHERE type='content.analyze' AND (payload->>'mediaId') NOT IN (SELECT id FROM media)",
  );
  // Free the surviving content.analyze jobs (stuck 'running' from a crash, or waiting) so
  // the worker runs them now.
  const rst = await pool.query(
    "UPDATE job_queue SET status='pending', lockedAt=NULL, runAfter=$1, attempts=0, updatedAt=$1 WHERE type='content.analyze' AND status IN ('running','pending')",
    [now],
  );
  // Guarantee every master media has a runnable analyze job (dedupe skips ones already
  // in flight) — covers the case where the job was lost/never created.
  const masters = await pool.query("SELECT id FROM media WHERE role = 'master'");
  let reQueued = 0;
  for (const m of masters.rows as { id: string }[]) {
    const id = await enqueue("content.analyze", { mediaId: m.id }, { dedupeKey: `content.analyze:${m.id}` });
    if (id) reQueued++;
  }
  return c.json({
    ok: true,
    deletedVideoJobs: del.rowCount ?? 0,
    deletedZombieContentJobs: dead.rowCount ?? 0,
    resetContentJobs: rst.rowCount ?? 0,
    reQueuedContentJobs: reQueued,
  });
});

// ── admin: remux an existing master to progressive mp4 in place (for files uploaded
//    before the ingest remux, or to re-fix a fragmented upload). ──
app.post("/api/admin/remux/:id", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);
  if (!FFMPEG || !useGcs()) return c.json({ error: "ffmpeg + GCS required" }, 400);
  const objPath = parseObjectPath(m.path);
  if (!(await fileExists(objPath))) return c.json({ error: "file not found in storage" }, 404);

  const tmpDir = path.resolve("/tmp/stepd-uploads");
  fs.mkdirSync(tmpDir, { recursive: true });
  const webTmp = path.join(tmpDir, `${m.id}-web.mp4`);
  try {
    const inUrl = await signedReadUrl(objPath);
    await remuxFaststart(inUrl, webTmp);
    await uploadFile(objPath, webTmp);
    return c.json({ ok: true, size: fs.statSync(webTmp).size });
  } catch (e) {
    return c.json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  } finally {
    try { fs.unlinkSync(webTmp); } catch {}
  }
});

// ── video streaming ───────────────────────────────────────────────────────────
app.get("/api/media/:id/stream", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);

  const objPath = parseObjectPath(m.path);
  const exists = await fileExists(objPath);
  if (!exists) return c.json({ error: "media file not found" }, 404);

  // GCS mode: redirect the player straight to a signed Cloud Storage URL and let it stream
  // directly from GCS — native range support, no size cap, CDN-fast. Routing a 74 MB video
  // through the Vercel proxy + Cloud Run chokes (proxy caps large responses). Same principle
  // as direct-to-GCS upload: the bytes should never pass through our servers.
  if (useGcs()) {
    const url = await signedReadUrl(objPath, 6 * 60 * 60 * 1000); // 6h — comfortably covers playback
    return c.redirect(url, 302);
  }

  // Local dev (no GCS): serve the file directly in bounded 206 chunks.
  const size = await fileSize(objPath);
  const range = c.req.header("range");
  const CHUNK = 4 * 1024 * 1024;
  let start = 0;
  let reqEnd = size - 1;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match?.[1]) start = parseInt(match[1], 10);
    if (match?.[2]) reqEnd = parseInt(match[2], 10);
  }
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(reqEnd) || reqEnd >= size) reqEnd = size - 1;
  if (start > reqEnd || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const end = Math.min(reqEnd, start + CHUNK - 1, size - 1);

  const stream = createReadStream(objPath, start, end);
  return new Response(stream, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": m.mime,
      "Cache-Control": "no-store",
    },
  });
});

// ── signed playback URL (browser sets <video src> to this → streams straight from GCS,
//    no proxy/redirect in the byte path; the reliable way to serve media). ──
app.get("/api/media/:id/stream-url", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);
  const objPath = parseObjectPath(m.path);
  if (!(await fileExists(objPath))) return c.json({ error: "media file not found" }, 404);
  if (useGcs()) {
    const url = await signedReadUrl(objPath, 6 * 60 * 60 * 1000); // 6h
    return c.json({ url, direct: true });
  }
  // Local dev: no GCS — fall back to the chunked stream endpoint (web prefixes apiBase).
  return c.json({ url: `/media/${m.id}/stream`, direct: false });
});

// ── thumbnail ─────────────────────────────────────────────────────────────────
app.get("/api/media/:id/thumb", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m || !m.thumbPath) return c.json({ error: "no thumbnail" }, 404);

  const objPath = parseObjectPath(m.thumbPath);
  const exists = await fileExists(objPath);
  if (!exists) return c.json({ error: "no thumbnail" }, 404);

  const stream = createReadStream(objPath);
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" },
  });
});

// ── frame at arbitrary timestamp — 쇼츠·씬 카드 미리보기용 정지 프레임 ─────────
//
// 쿼리 t(초)를 두 자리로 반올림해 캐시 키로 사용 · analysis/{id}/frames/{key}.jpg.
// 캐시 히트면 즉시 반환, 미스면 ffmpeg(-ss t -vframes 1)로 뽑아 저장 후 서빙.
// 클립 카드도 이 라우트로 원본 구간의 시작 프레임을 표시(트림 전에도 검증 가능).
app.get("/api/media/:id/frame", async (c) => {
  const id = c.req.param("id");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  const tRaw = c.req.query("t");
  const t = Number(tRaw);
  if (!Number.isFinite(t) || t < 0) return c.json({ error: "bad t" }, 400);

  const m = await getMedia(id);
  if (!m) return c.json({ error: "media not found" }, 404);
  // 끝단 ffmpeg 실패 방지: 마지막 100ms는 피하고 clamp.
  const dur = Number(m.durationSec ?? 0);
  const clamped = Math.max(0, Math.min(t, Math.max(0.1, dur - 0.1)));
  const key = clamped.toFixed(2);
  const objPath = `analysis/${id}/frames/${key}.jpg`;

  if (!(await fileExists(objPath))) {
    if (!FFMPEG) return c.json({ error: "ffmpeg unavailable" }, 503);
    const masterObjPath = parseObjectPath(m.path);
    if (!(await fileExists(masterObjPath))) return c.json({ error: "source not found" }, 404);
    const srcPath = useGcs() ? await signedReadUrl(masterObjPath, 60 * 60 * 1000) : m.path;
    const tmpDir = path.resolve("/tmp/stepd-frames");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${id}_${key.replace(/\./g, "_")}.jpg`);
    try {
      await captureThumbnail(srcPath, clamped, tmpPath);
      await uploadFile(objPath, tmpPath);
    } catch (err) {
      console.error("[frame] capture failed:", err);
      try { fs.unlinkSync(tmpPath); } catch {}
      return c.json({ error: "capture failed" }, 500);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
  });
});

// ── content analysis result (AI pipeline: transcript + scenes + shorts) ─────────
app.get("/api/media/:id/analysis", async (c) => {
  const row = await getContentAnalysis(c.req.param("id"));
  if (!row) return c.json({ status: "none" }, 404);
  return c.json(row);
});

// ── re-run the AI content pipeline for one media (operator recovery from a failed run) ──
// A failed analysis was a dead-end in the UI — nothing let the operator re-kick it. Resumes
// from checkpoints, so a re-run only pays for the stages that never finished.
/**
 * 분석을 시작해도 되는가 — **크레딧 게이트** (billing 계획 3단계).
 *
 * 시작 **전에** 본다. 58분짜리를 다 돌리고 나서 잔액이 없다고 하면 원가(₩285)는 이미 나갔다.
 * 러닝타임을 모르면(프로브 실패 등) 막지 않는다 — 분석 자체를 못 하게 만드는 것보다 낫고,
 * 차감은 끝난 뒤 실제 길이로 한다.
 *
 * @returns 막아야 하면 사유, 통과면 null.
 */
async function creditBlockReason(durationSec: number): Promise<string | null> {
  const need = billableMinutes(durationSec ?? 0);
  if (need <= 0) return null;
  const verdict = checkCredits({ balance: await creditBalance(), needMinutes: need });
  return verdict.allow ? null : verdict.reason;
}

app.post("/api/media/:id/analyze", async (c) => {
  const mediaId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const fast = body.fast === true;
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media not found" }, 404);

  // 402 — 결제가 필요하다는 뜻의 상태코드다. 400 으로 주면 클라이언트가 "잘못된 요청"으로
  // 읽어 충전 안내를 못 띄운다.
  const blocked = await creditBlockReason(media.durationSec ?? 0);
  if (blocked) return c.json({ error: "insufficient_credits", message: blocked }, 402);

  await markContentAnalysisPending(mediaId);
  const jobId = await enqueue(
    "content.analyze",
    { mediaId, ...(fast ? { fast: true } : {}) },
    { dedupeKey: `content.analyze:${mediaId}` },
  );
  if (media.episodeId) {
    const ep = await getEntity<Record<string, unknown>>("episode", media.episodeId);
    if (ep) {
      await putEntity("episode", media.episodeId, {
        ...ep,
        pipeline: { stage: "analyze", stageStatus: "progress", note: "재분석 대기 중", progress: 0 },
      });
    }
  }
  // jobId null = a run is already queued/in-flight; treat as success (idempotent).
  return c.json({ ok: true, queued: jobId != null });
});

// ── stored scene frames (uploaded by the worker to analysis/{mediaId}/scene_frames/) ──
// scenes[].frame in the analysis data is "scene_frames/scene_0001.jpg" — the web/Lab
// fetch it here. 404 for pre-persistence analyses (framesStored !== true).
app.get("/api/media/:id/analysis/frames/:name", async (c) => {
  const id = c.req.param("id");
  const name = c.req.param("name");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  if (!/^scene_\d+\.jpg$/.test(name)) return c.json({ error: "bad frame name" }, 400);

  const objPath = `analysis/${id}/scene_frames/${name}`;
  if (!(await fileExists(objPath))) return c.json({ error: "not found" }, 404);

  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" },
  });
});

// face_clusters/{label}_{i}.jpg — 얼굴 클러스터 대표 크롭. faces.py가 저장한 것.
// name 형식: M1_0.jpg / F2_2.jpg (성별 M|F + 클러스터 번호 + 대표 인덱스).
app.get("/api/media/:id/analysis/faces/:name", async (c) => {
  const id = c.req.param("id");
  const name = c.req.param("name");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  if (!/^[MF]\d+_\d+\.jpg$/.test(name)) return c.json({ error: "bad face crop name" }, 400);

  const objPath = `analysis/${id}/face_clusters/${name}`;
  if (!(await fileExists(objPath))) return c.json({ error: "not found" }, 404);

  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" },
  });
});

// faces.json — 얼굴 클러스터 메타(라벨·카운트·성별·대표 크롭 경로·매핑).
app.get("/api/media/:id/faces", async (c) => {
  const id = c.req.param("id");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  const objPath = `analysis/${id}/faces.json`;
  if (!(await fileExists(objPath))) return c.json({ clusters: {}, mapping: {}, labeled_segments: 0 });
  // 로컬 스토리지는 STEPD_STORAGE_DIR 하위 · GCS 모드는 signed URL로 refetch. 여기선 로컬만.
  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
});

// ppl_frames/{brand}_{idx}.jpg — PPL 검출 구간 대표 프레임. ppl.py가 저장 · UI 카드 썸네일.
// name 형식: 브랜드 sanitize + zero-padded 인덱스 (예: "CJ_00012.jpg", "unknown_00045.jpg").
app.get("/api/media/:id/analysis/ppl_frames/:name", async (c) => {
  const id = c.req.param("id");
  const name = c.req.param("name");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  if (!/^[\w-]+_\d+\.jpg$/.test(name)) return c.json({ error: "bad ppl frame name" }, 400);
  const objPath = `analysis/${id}/ppl_frames/${name}`;
  if (!(await fileExists(objPath))) return c.json({ error: "not found" }, 404);
  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" },
  });
});

// ppl.json — PPL·브랜드 검출 타임라인 (구간·브랜드·카테고리·대표 프레임·요약).
// analysis.json에도 ppl 필드가 들어가지만, UI에서 분석 안 끝나도 부분 결과 폴링용으로 별도 라우트.
app.get("/api/media/:id/ppl", async (c) => {
  const id = c.req.param("id");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  const objPath = `analysis/${id}/ppl.json`;
  if (!(await fileExists(objPath))) return c.json({ detections: [], brand_summary: {} });
  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
});

// 익명 화자/얼굴 클러스터 이름 지정 저장. 자동 추론은 하지 않으며, 운영자가 프론트에서 등록 cast를
// 선택하거나 직접 입력한 이름만 faces.json.mapping에 보존한다.
app.patch("/api/media/:id/faces/mapping", async (c) => {
  const id = c.req.param("id");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const patchMap = body.mapping;
  if (!patchMap || typeof patchMap !== "object" || Array.isArray(patchMap)) {
    return c.json({ error: "mapping (object) required" }, 400);
  }
  const useGCS = !!process.env.GCS_BUCKET;
  const facesObjectPath = `analysis/${id}/faces.json`;
  const storageBase = process.env.STEPD_STORAGE_DIR
    ? path.resolve(process.env.STEPD_STORAGE_DIR)
    : path.resolve(process.cwd(), "storage");
  const facesPath = path.join(storageBase, facesObjectPath);
  const refinedPath = path.join(storageBase, "analysis", id, "refined.json");
  if (useGCS ? !(await fileExists(facesObjectPath)) : !fs.existsSync(facesPath)) {
    return c.json({ error: "faces.json not found" }, 404);
  }

  // faces.json mapping 병합 (빈 문자열 값은 매핑 제거)
  const facesRaw = useGCS ? await readFile(facesObjectPath) : fs.readFileSync(facesPath);
  const faces = JSON.parse(facesRaw.toString("utf-8")) as {
    mapping?: Record<string, string>;
    clusters?: Record<string, unknown>;
    labeled_segments?: number;
  };
  const prev = faces.mapping ?? {};
  const next: Record<string, string> = { ...prev };
  for (const [k, v] of Object.entries(patchMap as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const val = v.trim();
    if (val) next[k] = val;
    else delete next[k];
  }
  faces.mapping = next;
  if (useGCS) {
    await writeFile(facesObjectPath, Buffer.from(JSON.stringify(faces, null, 2), "utf-8"));
    // UI는 faces.mapping을 다음 조회에서 읽어 익명 화자 표시명으로 사용한다. GCS 분석 산출물은
    // immutable하게 두고, 수동 이름을 transcript·추천 텍스트에 자동 확산하지 않는다.
    return c.json({
      ok: true,
      mapping: next,
      refined_rewritten: 0,
      narrative_rewritten: 0,
      shorts_rewritten: 0,
      db_content_analysis_updated: 0,
      db_recommendations_renamed: 0,
    });
  }
  fs.writeFileSync(facesPath, JSON.stringify(faces, null, 2), "utf-8");

  // 2026-07-23: 저장 즉시 모든 downstream rename (사용자 방향 · 재분석 없이 반영).
  // 규칙: (a) refined.speaker 정확 매칭 · (b) narrative/shorts text 필드는 word-boundary 정규식.
  //   cluster label(M1/F1/... 정형)만 매칭 · 실제 title에 우연 등장 확률 매우 낮음.
  const rename = (text: string): string => {
    let out = text;
    for (const [lbl, name] of Object.entries(next)) {
      if (!lbl || !name || lbl === name) continue;
      // \b은 한글에서 안 통해서 [^A-Za-z0-9_] lookahead/behind로. lbl은 항상 영숫자.
      const re = new RegExp(`(^|[^A-Za-z0-9_])${lbl}(?![A-Za-z0-9_])`, "g");
      out = out.replace(re, (_m, pre) => `${pre}${name}`);
    }
    return out;
  };
  const renameArr = (arr: unknown): unknown => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((v) => (typeof v === "string" ? rename(v) : v));
  };
  const walk = (obj: any): any => {
    // 재귀 rename — object 전체 문자열 필드에 적용. 성능 이슈 없을 크기.
    if (typeof obj === "string") return rename(obj);
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
      return out;
    }
    return obj;
  };

  let refinedRewritten = 0;
  if (fs.existsSync(refinedPath) && Object.keys(next).length > 0) {
    const refined = JSON.parse(fs.readFileSync(refinedPath, "utf-8")) as Array<Record<string, unknown>>;
    for (const seg of refined) {
      const sp = typeof seg.speaker === "string" ? (seg.speaker as string) : "";
      const mapped = next[sp];
      if (mapped && seg.speaker !== mapped) {
        seg.speaker = mapped;
        refinedRewritten++;
      }
    }
    fs.writeFileSync(refinedPath, JSON.stringify(refined, null, 2), "utf-8");
  }

  // narrative.json · shorts.json · analysis.json rename (문자열 필드 walk)
  const narrPath = path.join(storageBase, "analysis", id, "narrative.json");
  const shortsPath = path.join(storageBase, "analysis", id, "shorts.json");
  const analysisPath = path.join(storageBase, "analysis", id, "analysis.json");
  let narrRewritten = 0, shortsRewritten = 0;
  if (fs.existsSync(narrPath) && Object.keys(next).length > 0) {
    const narr = JSON.parse(fs.readFileSync(narrPath, "utf-8"));
    const before = JSON.stringify(narr);
    const after = walk(narr);
    const afterStr = JSON.stringify(after);
    if (before !== afterStr) {
      fs.writeFileSync(narrPath, JSON.stringify(after, null, 2), "utf-8");
      narrRewritten = 1;
    }
  }
  if (fs.existsSync(shortsPath) && Object.keys(next).length > 0) {
    const shorts = JSON.parse(fs.readFileSync(shortsPath, "utf-8"));
    const before = JSON.stringify(shorts);
    const after = walk(shorts);
    const afterStr = JSON.stringify(after);
    if (before !== afterStr) {
      fs.writeFileSync(shortsPath, JSON.stringify(after, null, 2), "utf-8");
      shortsRewritten = 1;
    }
    // analysis.json 도 shorts 필드 갱신 (통째 rename)
    if (fs.existsSync(analysisPath)) {
      const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
      const updated = walk(analysis);
      fs.writeFileSync(analysisPath, JSON.stringify(updated, null, 2), "utf-8");
    }
  }

  // DB rename: content_analysis.data · recommendations
  const pool = getPool();
  let dbShortsRenamed = 0, dbRecsRenamed = 0;
  if (Object.keys(next).length > 0) {
    // content_analysis 데이터 통째 walk
    try {
      const { rows } = await pool.query("SELECT data FROM content_analysis WHERE mediaId = $1", [id]);
      if (rows[0]?.data) {
        const before = JSON.stringify(rows[0].data);
        const after = walk(rows[0].data);
        const afterStr = JSON.stringify(after);
        if (before !== afterStr) {
          await pool.query(
            "UPDATE content_analysis SET data = $1::jsonb, updatedAt = $2 WHERE mediaId = $3",
            [afterStr, Date.now(), id],
          );
          dbShortsRenamed = 1;
        }
      }
    } catch (e) {
      console.error(`[faces/mapping] content_analysis rename failed:`, e);
    }
    // recommendations 엔티티들 rename
    try {
      // 이 media의 episode를 찾아서 그 episode의 recommendations 다 rename
      const mediaRow = await pool.query("SELECT episodeid FROM media WHERE id = $1", [id]);
      const episodeId = mediaRow.rows[0]?.episodeid;
      if (episodeId) {
        const recRows = await pool.query(
          "SELECT id, data FROM entities WHERE kind='recommendation' AND data->>'episodeId' = $1",
          [episodeId],
        );
        for (const r of recRows.rows) {
          const before = JSON.stringify(r.data);
          const after = walk(r.data);
          const afterStr = JSON.stringify(after);
          if (before !== afterStr) {
            await pool.query(
              "UPDATE entities SET data = $1::jsonb WHERE kind='recommendation' AND id = $2",
              [afterStr, r.id],
            );
            dbRecsRenamed++;
          }
        }
      }
    } catch (e) {
      console.error(`[faces/mapping] recommendations rename failed:`, e);
    }
  }

  return c.json({
    ok: true,
    mapping: next,
    refined_rewritten: refinedRewritten,
    narrative_rewritten: narrRewritten,
    shorts_rewritten: shortsRewritten,
    db_content_analysis_updated: dbShortsRenamed,
    db_recommendations_renamed: dbRecsRenamed,
  });
});

/**
 * Resolve a media's transcript from the canonical `transcript` table, falling back to
 * the copy embedded in content_analysis.data.transcript for rows analyzed before the
 * table existed (or if the table write was skipped). Returns the segments plus an
 * updatedAt for cache fingerprinting. This is the one place consumers share.
 */
async function resolveTranscript(
  mediaId: string,
): Promise<{ segments: unknown[]; updatedAt: number; source: "transcript" | "content_analysis" | "none" }> {
  const t = await getTranscript(mediaId);
  if (t && Array.isArray(t.segments) && t.segments.length) {
    return { segments: t.segments, updatedAt: t.updatedAt, source: "transcript" };
  }
  const ca = await getContentAnalysis(mediaId);
  const legacy = (ca?.data as any)?.transcript;
  if (Array.isArray(legacy) && legacy.length) {
    return { segments: legacy, updatedAt: ca?.updatedAt ?? 0, source: "content_analysis" };
  }
  return { segments: [], updatedAt: t?.updatedAt ?? ca?.updatedAt ?? 0, source: "none" };
}

// ── transcript (shared STT store: captions, framing, highlights read this) ──────
// Prefers the canonical transcript table; falls back to the analysis blob for older rows.
app.get("/api/media/:id/transcript", async (c) => {
  const { segments, updatedAt, source } = await resolveTranscript(c.req.param("id"));
  if (source === "none") return c.json({ status: "none" }, 404);
  return c.json({ mediaId: c.req.param("id"), source, updatedAt, segments });
});

// ── upload a real video → episode + master media + heuristic recommendations ───
// Shared tail of the upload flow: create the episode, master media row, heuristic
// recommendations, and enqueue content analysis. Both the legacy multipart upload and
// the direct-to-GCS finalize path funnel through here so the two stay in lockstep.
/**
 * 같은 프로그램에 같은 회차 번호 (FLOWS F1 ⊘). 라우트에서 409 로 바꾼다.
 * 진짜 보증은 유일 인덱스(migrations/0011)다 — check-then-insert 는 동시 요청을 못 막는다.
 */
class DuplicateEpisodeError extends Error {
  constructor(readonly programId: string, readonly episodeNumber: number) {
    super(`episode ${episodeNumber} already exists in program ${programId}`);
    this.name = "DuplicateEpisodeError";
  }
}

/** Postgres unique_violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** 회차 번호가 이미 쓰였는지 — 업로드 시작 전에 막아 준다(GB 를 올린 뒤 409 는 잔인하다). */
async function episodeNumberTaken(programId: string, episodeNumber: number): Promise<boolean> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT 1 AS n FROM entities
      WHERE kind = 'episode' AND data->>'programId' = $1 AND data->>'episodeNumber' = $2
      LIMIT 1`,
    [programId, String(episodeNumber)],
  );
  return rows.length > 0;
}

async function buildEpisodeAndMedia(opts: {
  mediaId: string;
  programId: string;
  program: { id: string; title: string; targetAge: number };
  /** 사람이 입력한 회차 번호(F1 필수). 없으면 MAX+1. */
  episodeNumber?: number;
  /** 방영일 YYYY-MM-DD. 없으면 오늘. */
  broadDate?: string;
  /** 분석 트랙(F1 필수) — 프로그램 기본값을 덮는다. */
  track?: "variety" | "drama";
  /** 자막을 같이 올렸는지. false 면 음성 인식으로 대체한다는 뜻. */
  hasSubtitle?: boolean;
  storedPath: string;
  filename: string;
  title: string;
  mime: string;
  size: number;
  meta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean };
  thumbPath: string | null;
  /** Set when the master file isn't in storage yet (YouTube import): replaces the default
   *  pipeline note and skips the content.analyze enqueue — the download job does that
   *  once the file actually lands in GCS. */
  pendingIngestNote?: string;
  /** 업로드 UI의 모드 선택("빠른 분석" = true, "정밀 분석" = false, 기본 false). 잡 페이로드로
   *  content.analyze로 전달돼 python -m core.analyze --fast 여부를 결정. */
  fast?: boolean;
}) {
  const { mediaId, programId, program, storedPath, filename, title, mime, size, meta } = opts;

  // 사람이 회차 번호를 넣었으면 그걸 쓴다(F1 필수 3개 중 하나). 안 넣었으면 MAX+1 —
  // MAX 는 getState 스냅샷이 아니라 DB 에서 바로 읽는다(await 를 건너뛴 값이면 두 업로드가
  // 같은 번호를 받는다).
  let epNum = opts.episodeNumber;
  if (!epNum || !Number.isInteger(epNum) || epNum < 1) {
    const { rows: epRows } = await getPool().query<{ m: number }>(
      `SELECT COALESCE(MAX((data->>'episodeNumber')::int), 0) AS m
         FROM entities WHERE kind = 'episode' AND data->>'programId' = $1`,
      [programId],
    );
    epNum = Number(epRows[0]?.m ?? 0) + 1;
  }

  const episodeId = newId("e");
  const broadDate = isoDateOrToday(opts.broadDate);
  const episode = {
    id: episodeId,
    programId,
    programTitle: program.title,
    episodeNumber: epNum,
    broadDate,
    targetAge: program.targetAge,
    // 분석 트랙 — 사람이 고른 값이 있으면 프로그램 기본값을 덮는다(F1).
    ...(opts.track ? { pipelineGenre: opts.track } : {}),
    // 자막을 같이 올렸는지 — 없으면 파이프라인이 음성 인식으로 대체한다.
    ...(opts.hasSubtitle === false ? { subtitleProvided: false } : {}),
    // F1 Invariant: 업로드 완료 ≠ 분석 완료 — 규칙과 그 이유는 episode-intake.ts 에.
    pipeline: initialPipeline(opts.pendingIngestNote),
  };
  try {
    await prependEntity("episode", episodeId, episode);
  } catch (err) {
    // 유일 인덱스(migrations/0011)가 잡은 중복. 라우트가 409 로 바꾼다.
    if (isUniqueViolation(err)) throw new DuplicateEpisodeError(programId, epNum);
    throw err;
  }

  const row: MediaRow = {
    id: mediaId,
    episodeId,
    role: "master",
    title,
    filename,
    path: storedPath,
    mime: mime || "video/mp4",
    size,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    codec: meta.codec,
    hasAudio: meta.hasAudio ? 1 : 0,
    thumbPath: opts.thumbPath,
    createdAt: Date.now(),
  };
  await insertMedia(row);

  // No heuristic placeholder recommendations — real segments come from the AI content
  // pipeline (content.analyze) on the worker. Uploads start with an empty recommend board.
  if (!opts.pendingIngestNote) {
    // 크레딧이 모자라면 **분석 잡을 넣지 않는다.** 업로드 자체는 성공으로 둔다 —
    // 파일은 이미 올라갔고, 충전 후 회차 화면에서 분석을 다시 시작하면 된다.
    const blocked = await creditBlockReason(meta.durationSec ?? 0);
    if (blocked) {
      console.warn(`[upload] ${mediaId}: 크레딧 부족으로 분석 보류 — ${blocked}`);
      await putEntity("episode", episodeId, {
        ...episode,
        pipeline: {
          stage: "analyze", stageStatus: "warn", progress: 0,
          note: "크레딧 부족 — 충전 후 분석을 시작하세요",
          blockedReason: blocked,
        },
      }).catch(() => {});
    } else {
      try {
        await markContentAnalysisPending(mediaId);
        await enqueue(
          "content.analyze",
          { mediaId, ...(opts.fast ? { fast: true } : {}) },
          { dedupeKey: `content.analyze:${mediaId}` },
        );
      } catch (err) {
        console.error("[upload] failed to enqueue content.analyze", err);
      }
    }
  }

  return { media: mediaPublic(row), episode, recommendations: [] };
}

// ── large upload, step 1: open a resumable session — bytes go browser → GCS directly ──
// The file never passes through Cloud Run, so the 32 MB request cap, in-memory buffering,
// and the 600 s request timeout no longer apply. Multi-hour masters upload fine.
app.post("/api/media/upload-init", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const programId =
    typeof body.programId === "string" && body.programId ? String(body.programId) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  // F1 ⊘ — 같은 프로그램·같은 회차 번호로 재업로드 금지. 여기서 먼저 막는다:
  // 몇 GB 를 다 올린 뒤 finalize 에서 409 를 주면 사용자는 업로드 시간을 통째로 잃는다.
  // (진짜 보증은 finalize 의 유일 인덱스다 — 이건 빨리 알려 주는 용도)
  const wantedEpNum = readEpisodeNumber(body.episodeNumber);
  if (wantedEpNum !== undefined && (await episodeNumberTaken(programId, wantedEpNum))) {
    return c.json(
      { error: "duplicate episode", episodeNumber: wantedEpNum, programId },
      409,
    );
  }

  const filename =
    typeof body.filename === "string" && body.filename ? String(body.filename) : "video.mp4";
  const contentType =
    typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";
  const mediaId = newId("m");
  const ext = path.extname(filename) || ".mp4";
  const objectPath = uploadPath(mediaId, ext);

  // Local dev (no GCS): there is no direct upload target — tell the client to fall back
  // to the legacy multipart /upload endpoint (fine for the small files used in dev).
  if (!useGcs()) return c.json({ mode: "multipart", mediaId, objectPath });

  try {
    const origin = c.req.header("origin") || undefined;
    const sessionUrl = await createResumableSession(objectPath, contentType, origin);
    return c.json({ mode: "resumable", mediaId, objectPath, sessionUrl });
  } catch (err) {
    console.error("[upload-init] resumable session failed", err);
    return c.json({ error: "failed to init upload" }, 500);
  }
});

// ── large upload, step 2: bytes are already in GCS → build episode/media, probe via signed URL ──
app.post("/api/media/finalize", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const mediaId = typeof body.mediaId === "string" ? String(body.mediaId) : "";
  const objectPath = typeof body.objectPath === "string" ? String(body.objectPath) : "";
  if (!mediaId || !objectPath) return c.json({ error: "mediaId and objectPath required" }, 400);
  // Only accept the objectPath this mediaId's upload-init would have issued — otherwise a
  // client could point finalize at (and remux-overwrite) an arbitrary object in the bucket.
  if (
    !/^[\w-]+$/.test(mediaId) ||
    !new RegExp(`^uploads/${mediaId}\\.\\w+$`).test(objectPath)
  ) {
    return c.json({ error: "objectPath does not match mediaId" }, 400);
  }
  if (!useGcs()) return c.json({ error: "finalize is GCS-mode only" }, 400);

  const programId =
    typeof body.programId === "string" && body.programId ? String(body.programId) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  // Idempotent replay: a client whose network dropped after a successful finalize will
  // retry it. The rows already exist — return them, instead of duplicating the episode
  // and then 500ing on the media INSERT (which stranded an orphan "분석 중" episode).
  const existing = await getMedia(mediaId);
  if (existing) {
    const episode = existing.episodeId
      ? await getEntity<Record<string, unknown>>("episode", existing.episodeId)
      : null;
    return c.json({ media: mediaPublic(existing), episode, recommendations: [] });
  }

  // Confirm the object actually landed in GCS before we build rows around it.
  if (!(await fileExists(objectPath))) return c.json({ error: "upload not found in storage" }, 400);

  const filename =
    typeof body.filename === "string" && body.filename ? String(body.filename) : `${mediaId}.mp4`;
  const title = typeof body.title === "string" && body.title ? String(body.title) : filename;
  const mime =
    typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";
  // Server-authoritative size: the remux gate below is an OOM guard for RAM-backed /tmp,
  // so it must never trust a client-supplied number (size: 1 on a 10 GB object would pull
  // the whole remux output into tmpfs). body.size is display-only.
  let size = await fileSize(objectPath).catch(() => 0);
  if (size <= 0 && typeof body.size === "number" && body.size > 0) size = body.size;
  const storedPath = `gs://${process.env.GCS_BUCKET}/${objectPath}`;

  // Normalize to a browser-streamable progressive mp4. Uploaded files are often fragmented
  // (fMP4: tiny init moov + moof/mdat fragments) which a plain <video> can't play smoothly.
  // Remux container-only (-c copy, no re-encode → seconds) to moov-at-front progressive and
  // replace the object in place. Size-guarded so Cloud Run's RAM-backed /tmp doesn't OOM;
  // larger masters keep the original (a disk-backed worker remux can cover those later).
  // The threshold must fit the instance's memory budget (the whole output lives in tmpfs
  // alongside node + ffmpeg), so it's env-tunable — default 512 MB is safe on a 2 GB
  // instance; raise REMUX_MAX_MB only if the Cloud Run instance has the RAM to spare.
  const REMUX_MAX = (Number(process.env.REMUX_MAX_MB) || 512) * 1024 * 1024;
  const remuxSize = await fileSize(objectPath).catch(() => 0); // never the client's number
  if (FFMPEG && remuxSize > 0 && remuxSize <= REMUX_MAX) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const webTmp = path.join(tmpDir, `${mediaId}-web.mp4`);
    try {
      const inUrl = await signedReadUrl(objectPath);
      await remuxFaststart(inUrl, webTmp);
      await uploadFile(objectPath, webTmp); // overwrite fMP4 with progressive
      size = fs.statSync(webTmp).size;
      console.log(`[finalize] remuxed ${mediaId} → progressive mp4 (${size} bytes)`);
    } catch (e) {
      console.error("[finalize] remux failed — keeping original (may not stream if fragmented):", e);
    } finally {
      try { fs.unlinkSync(webTmp); } catch {}
    }
  }

  // Probe + thumbnail by handing ffmpeg a short-lived signed URL. ffmpeg range-reads only
  // the bytes it needs (header for probe, one frame for the thumb) — no multi-GB download,
  // so Cloud Run memory stays flat regardless of source length.
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (FFMPEG) {
    try {
      const readUrl = await signedReadUrl(objectPath);
      meta = await probe(readUrl).catch((e) => {
        console.error("[finalize] probe failed", e);
        return meta;
      });
      const tmpDir = path.resolve("/tmp/stepd-uploads");
      fs.mkdirSync(tmpDir, { recursive: true });
      const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
      try {
        await captureThumbnail(readUrl, Math.max(1, meta.durationSec * 0.1), thumbTmp);
        thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
      } catch (e) {
        console.error("[finalize] thumbnail failed", e);
      } finally {
        // /tmp is RAM-backed on Cloud Run — clear the thumb temp regardless of outcome.
        try { fs.unlinkSync(thumbTmp); } catch {}
      }
    } catch (err) {
      // Most likely the runtime SA lacks signBlob — degrade gracefully (duration 0 → default recs).
      console.error("[finalize] signed-url probe unavailable (grant signBlob to the Cloud Run SA):", err);
    }
  }

  try {
    const result = await buildEpisodeAndMedia({
      mediaId, programId, program, storedPath,
      filename, title, mime, size, meta, thumbPath: thumbStored,
      fast: body.fast === true,
      episodeNumber: readEpisodeNumber(body.episodeNumber),
      broadDate: typeof body.broadDate === "string" ? body.broadDate : undefined,
      track: readTrack(body.track),
      hasSubtitle: body.hasSubtitle !== false,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof DuplicateEpisodeError) {
      return c.json({ error: "duplicate episode", episodeNumber: err.episodeNumber, programId }, 409);
    }
    throw err;
  }
});

app.post("/api/media/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (typeof file === "string" || !(file as any).arrayBuffer || typeof file === "boolean") return c.json({ error: "file field required" }, 400);

  const programId = typeof body["programId"] === "string" && body["programId"] ? String(body["programId"]) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  const mediaId = newId("m");
  const ext = path.extname(file.name) || ".mp4";
  const buffer = Buffer.from(await file.arrayBuffer());
  const objPath = uploadPath(mediaId, ext);

  // Write to GCS (or local fallback). NOTE: this path buffers the whole file in memory
  // and is subject to Cloud Run's ~32 MB request cap — it's only for small/local uploads.
  // Large masters go through /upload-init + /finalize (direct-to-GCS resumable).
  const storedPath = await writeFile(objPath, buffer);

  // Probe + thumbnail from a local temp copy (ffmpeg reads the filesystem).
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (FFMPEG) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${mediaId}${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
    try {
      meta = await probe(tmpPath);
      await captureThumbnail(tmpPath, Math.max(1, meta.durationSec * 0.1), thumbTmp);
      thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
    } catch {
      /* probe/thumb are best-effort */
    } finally {
      // /tmp is RAM-backed on Cloud Run — clear both temps even if probe/thumb failed.
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(thumbTmp); } catch {}
    }
  }

  const title = typeof body["title"] === "string" && body["title"] ? String(body["title"]) : file.name;
  try {
    const result = await buildEpisodeAndMedia({
      mediaId, programId, program, storedPath,
      filename: file.name, title, mime: file.type || "video/mp4", size: file.size,
      meta, thumbPath: thumbStored,
      fast: body["fast"] === "true",
      episodeNumber: readEpisodeNumber(body["episodeNumber"]),
      broadDate: typeof body["broadDate"] === "string" ? body["broadDate"] : undefined,
      track: readTrack(body["track"]),
      hasSubtitle: body["hasSubtitle"] !== "false",
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof DuplicateEpisodeError) {
      return c.json({ error: "duplicate episode", episodeNumber: err.episodeNumber, programId }, 409);
    }
    throw err;
  }
});

// ── YouTube URL import: episode + placeholder media now, download on the worker VM ──
// Cloud Run can't hold a multi-GB download, so this route only records intent: the
// youtube.download job (worker.ts) runs yt-dlp, lands the file in GCS, fills the media
// row with real facts, and enqueues content.analyze — rejoining the normal upload flow.
const YOUTUBE_URL_RE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^#]*\bv=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/;

app.post("/api/media/from-youtube", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!YOUTUBE_URL_RE.test(url)) return c.json({ error: "유효한 YouTube URL이 아닙니다" }, 400);

  const programId =
    typeof body.programId === "string" && body.programId ? String(body.programId) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "YouTube 영상";
  const mediaId = newId("m");

  // 이 영상이 어느 연동 채널 것인지 해석해 에피소드에 남긴다 — 분석 시 채널 포인트
  // 프로파일을 적용하기 위한 연결고리(계획서가 지적한 "채널→에피소드 연결 부재"를 메움).
  const vidMatch = url.match(/(?:v=|shorts\/|live\/|youtu\.be\/)([\w-]{6,})/);
  const sourceVideoId = vidMatch?.[1] ?? null;
  const sourceChannelId = sourceVideoId
    ? (await getChannelVideoByVideoId(sourceVideoId))?.channelId ?? null
    : null;

  const result = await buildEpisodeAndMedia({
    mediaId,
    programId,
    program,
    storedPath: `youtube:${url}`, // placeholder — replaced with the GCS URI after download
    filename: `${mediaId}.mp4`,
    title,
    mime: "video/mp4",
    size: 0,
    meta: { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false },
    thumbPath: null,
    pendingIngestNote: "YouTube 영상 다운로드 대기 중…",
  });

  // 채널 연결 기록 — content-pipeline이 이 값으로 채널 포인트 프로파일을 찾는다.
  if (sourceChannelId && result.episode?.id) {
    const ep = await getEntity<Record<string, unknown>>("episode", result.episode.id);
    if (ep) await putEntity("episode", result.episode.id, { ...ep, sourceChannelId, sourceVideoId });
  }

  let jobId: string | null;
  try {
    jobId = await enqueue(
      "youtube.download",
      { mediaId, url, programId, title, ...(body.fast ? { fast: true } : {}) },
      { dedupeKey: `youtube.download:${mediaId}` },
    );
  } catch (err) {
    // Without the job the placeholder episode would sit at "다운로드 대기 중…" forever
    // (content.analyze can't run against a youtube: placeholder path, so there's no
    // re-kick). Roll the rows back so the operator can simply retry the import.
    console.error("[from-youtube] enqueue failed — rolling back placeholder rows", err);
    await getPool().query("DELETE FROM media WHERE id = $1", [mediaId]).catch(() => {});
    await getPool()
      .query("DELETE FROM entities WHERE kind = 'episode' AND id = $1", [result.episode.id])
      .catch(() => {});
    return c.json({ error: "다운로드 잡 큐잉 실패 — 다시 시도해 주세요" }, 500);
  }
  // 시청자 댓글도 병행 수집 — 연동 채널의 영상일 때만(sourceChannelId 있을 때). yt-dlp 다운로드가
  // 수 분~수십 분 걸리는 동안 YouTube Data API 로 상위 좋아요 댓글을 미리 받아둔다. content.analyze
  // 가 시작될 때쯤이면 video_comments 에 이미 들어있어 content-pipeline 이 그대로 뽑아 comments.json
  // 으로 넘긴다. dedupe 로 스케줄러의 daily fan-out 잡과 중복돼도 하나만 실행.
  if (sourceVideoId && sourceChannelId) {
    try {
      await enqueue(
        "video.comments",
        { videoId: sourceVideoId, channelId: sourceChannelId },
        { dedupeKey: `video.comments:${sourceVideoId}` },
      );
    } catch (err) {
      console.warn("[from-youtube] video.comments enqueue skipped:", err);
    }
  }
  return c.json({ ...result, ok: true, queued: jobId != null });
});

// ── construct F: editorState → reframe dims + ASS overlay ──────────────────────
//
// The web editor authors overlays in a fixed-aspect preview stage (percent positions,
// px font sizes). To bake WYSIWYG we map: position% → output px, and font px → output px
// via a canonical stage size (portrait H≈640, landscape W≈900 — the CSS clamps in
// editor-preview.tsx). ASS PlayRes == output size so \pos maps 1:1.
function renderDims(aspect: string): { W: number; H: number; stageH: number } {
  switch (aspect) {
    case "16:9": return { W: 1920, H: 1080, stageH: (900 * 1080) / 1920 };
    case "1:1":  return { W: 1080, H: 1080, stageH: 900 };
    case "4:5":  return { W: 1080, H: 1350, stageH: 640 };
    case "9:16":
    default:     return { W: 1080, H: 1920, stageH: 640 };
  }
}

// ── F3: per-destination render presets ────────────────────────────────────────
//
// The render-side mirror of core/channels.py CHANNEL_PRESETS. That table ranks candidates
// per destination (scoring only); this one decides what the encoder actually emits. The two
// must agree — a candidate scored as SMR (16:9, up to 180s) that rendered as a 60s 9:16
// short would make the whole (candidate × destination) matrix a lie. Keep maxSec/aspect in
// sync with core/channels.py when either moves.
const RENDER_PRESETS: Record<string, { label: string; aspect: string; maxSec: number }> = {
  youtube_shorts:  { label: "YouTube Shorts",   aspect: "9:16", maxSec: 60 },
  instagram_reels: { label: "Instagram Reels",  aspect: "9:16", maxSec: 90 },
  smr:             { label: "SMR (포털 VOD)",   aspect: "16:9", maxSec: 180 },
};

/**
 * clip.aspectRatio uses the editor's vocabulary ("9:16-crop-main", "9:16-letterbox", "16:9"
 * — constants.ts ASPECT_RATIOS); renderDims uses bare frame ratios. Map between them so an
 * adopted highlight (aspectRatio "16:9", no editorState) doesn't fall through to the 9:16
 * default and get squeezed into a vertical frame it was never selected for.
 */
function normalizeAspect(aspectRatio: unknown): string | null {
  const s = String(aspectRatio ?? "");
  if (!s) return null;
  if (s.startsWith("9:16")) return "9:16";
  if (s.startsWith("16:9")) return "16:9";
  if (s === "1:1" || s === "4:5") return s;
  return null;
}

/**
 * Pick the destination a candidate is best suited to, from the (후보 × 배포처) matrix that
 * core/channels.py attached to the recommendation. Used at adopt to seed clip.targetChannel —
 * a default the operator can always override at export, never a decision.
 *
 * `usable` (the candidate's length sits inside the destination's range) is a gate, not a
 * tie-break: core deliberately deranks an out-of-range candidate instead of dropping it, so a
 * destination can win on score while still being one the clip cannot ship to. Among usable
 * destinations the highest score wins (score = 융합 × 프로그램적합 × 채널적합, comparable
 * across destinations because only the channel-fit factor differs).
 *
 * Returns null when nothing is usable, or the matrix is absent/unrecognised. Null means "no
 * preset" downstream — the clip renders at its own aspect over the full segment, i.e. exactly
 * what it did before this existed. That's the deliberate choice: guessing a destination the
 * clip doesn't fit would truncate or reframe a deliverable nobody asked to change.
 */
function pickTargetChannel(channelScores: unknown): string | null {
  if (!channelScores || typeof channelScores !== "object") return null;
  let best: { key: string; score: number } | null = null;
  for (const [key, cell] of Object.entries(channelScores as Record<string, any>)) {
    if (!RENDER_PRESETS[key] || !cell || typeof cell !== "object") continue;
    if (cell.usable !== true) continue;
    const score = Number(cell.score ?? cell.fit);
    if (!isFinite(score)) continue;
    if (!best || score > best.score) best = { key, score };
  }
  return best?.key ?? null;
}

/**
 * Resolve the render preset for an export. Explicit request `channel` wins, else whatever the
 * clip was adopted/targeted for. Unknown or absent → null (no preset; the clip's own aspect
 * and full segment are used), so a destination we don't model never silently reshapes a render.
 */
function resolveRenderPreset(channel: unknown, clip: any) {
  const key = String(channel ?? clip?.targetChannel ?? "").trim().toLowerCase();
  if (!key) return null;
  const preset = RENDER_PRESETS[key];
  return preset ? { key, ...preset } : null;
}

/** #RRGGBB → ASS &H00BBGGRR (opaque). */
function hexToAss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  if (!m) return "&H00FFFFFF&";
  return `&H00${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}`.toUpperCase() + "&";
}
function assEscape(text: string): string {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/[{}]/g, (ch) => "\\" + ch).replace(/\r?\n/g, "\\N");
}
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}
/**
 * Window a master-timeline transcript ({start,end,text} seconds) to a render window and
 * rebase to render-relative seconds (0-based). Keeps only segments that overlap
 * [winStart, winEnd] and carry text — the spoken subtitles that belong on this clip.
 */
type CaptionWord = { word: string; start: number; end: number };
type Caption = { start: number; end: number; text: string; words?: CaptionWord[] };

/**
 * 컷 boundary를 STT word 경계에 스냅한다 — 렌더가 대사 중간에서 시작/끊기는 걸 원천 차단.
 *
 * mode="start": target을 감싸는(또는 tolerance 이내) word가 있으면 그 word.start로 당김.
 *               target이 침묵 구간(어느 word 안에도 없음)이면 손대지 않음 — 침묵 컷은 안전.
 * mode="end":   대칭. 감싸는 word가 있으면 그 word.end로 밀어 발화 완결.
 *
 * words[] 없는 세그(구 Gemini 경로 등)는 seg.start/end를 word 하나로 취급해 폴백.
 * 이동 폭 tolerance(기본 0.4s)를 넘으면 스냅하지 않는다 — 원래 의도를 존중.
 */
function snapToWordBoundary(
  target: number,
  transcript: unknown,
  mode: "start" | "end",
  tolerance = 0.4,
): number {
  if (!Array.isArray(transcript)) return target;
  let best: number | null = null;
  for (const s of transcript) {
    const segStart = Number((s as any)?.start);
    const segEnd = Number((s as any)?.end);
    if (!isFinite(segStart) || !isFinite(segEnd)) continue;
    // Cheap early skip: seg 전체가 tolerance 밖이면 words 훑을 필요 없음.
    if (segEnd < target - tolerance || segStart > target + tolerance) continue;
    const rawWords = (s as any)?.words;
    const wordList: Array<{ start: number; end: number }> =
      Array.isArray(rawWords) && rawWords.length
        ? rawWords
            .map((w: any) => ({ start: Number(w?.start), end: Number(w?.end) }))
            .filter((w: { start: number; end: number }) => isFinite(w.start) && isFinite(w.end))
        : [{ start: segStart, end: segEnd }]; // 폴백: 세그 전체를 하나의 word로
    for (const w of wordList) {
      // target을 감싸는 word가 있으면 그 word 경계에 스냅
      if (w.start <= target && target <= w.end) {
        const snapped = mode === "start" ? w.start : w.end;
        return snapped;
      }
      // 감싸진 않지만 이 boundary 자체가 tolerance 안이면 후보로
      const candidate = mode === "start" ? w.start : w.end;
      const shift = Math.abs(candidate - target);
      if (shift <= tolerance && (best === null || shift < Math.abs(best - target))) {
        best = candidate;
      }
    }
  }
  return best ?? target;
}

/** 프레임 그리드로 quantize — round(t*fps)/fps. fps<=0이면 원값 (probe 실패 안전장치). */
function snapToFrame(t: number, fps: number): number {
  if (!fps || fps <= 0) return t;
  return Math.round(t * fps) / fps;
}

function windowCaptions(transcript: unknown, winStart: number, winEnd: number): Caption[] {
  if (!Array.isArray(transcript)) return [];
  const dur = winEnd - winStart;
  const out: Caption[] = [];
  for (const s of transcript) {
    const st = Number((s as any)?.start);
    const en = Number((s as any)?.end);
    const text = String((s as any)?.text ?? "").trim();
    if (!text || !isFinite(st) || !isFinite(en) || en <= winStart || st >= winEnd) continue;
    const rs = Math.max(0, st - winStart);
    const re = Math.min(dur, en - winStart);
    if (re <= rs + 0.05) continue;
    const cap: Caption = { start: rs, end: re, text };
    // Word timings (whisper path) → rebase into the window for \k karaoke. Gemini has none.
    const raw = (s as any)?.words;
    if (Array.isArray(raw) && raw.length) {
      const words: CaptionWord[] = [];
      for (const w of raw) {
        const wt = String((w as any)?.word ?? "");
        const ws0 = Number((w as any)?.start);
        const we0 = Number((w as any)?.end);
        if (!wt.trim() || !isFinite(ws0) || !isFinite(we0)) continue;
        const ws = Math.max(rs, ws0 - winStart);
        const we = Math.min(re, we0 - winStart);
        if (we > ws) words.push({ word: wt, start: ws, end: we });
      }
      if (words.length) cap.words = words;
    }
    out.push(cap);
  }
  return out;
}

/**
 * Approximate per-word timings from a caption's text + [start,end] when the STT provider
 * gave none. Production STT is Gemini (utterance-level, words:[]), so without this the
 * signature word-pop karaoke sweep never fires. Not frame-accurate, but allocating the
 * span by syllable count (Korean: 1 글자 ≈ 1 음절) gives a natural phrase-level sweep —
 * the same heuristic Opus-style tools use. Real word timings (whisper path) always win.
 */
function synthesizeWords(text: string, start: number, end: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const dur = end - start;
  if (tokens.length < 2 || !(dur > 0)) return []; // single token gains nothing from a sweep
  const weights = tokens.map((t) => Math.max(1, [...t].length));
  const total = weights.reduce((a, b) => a + b, 0);
  const words: CaptionWord[] = [];
  let t = start;
  tokens.forEach((tok, i) => {
    const we = i === tokens.length - 1 ? end : t + (weights[i] / total) * dur;
    words.push({ word: tok, start: t, end: we });
    t = we;
  });
  return words;
}

/**
 * Build an ASS file to burn at render time — the EditorState overlays (title/channel/
 * elements, Default style) PLUS the STT caption track (spoken subtitles, Caption style,
 * bottom-center per shorts convention). `captions` are render-relative seconds (see
 * windowCaptions). Returns null when there is nothing to burn. This is what replaces the
 * preview's static sample caption with the real transcript.
 */
type KfPoint = { time: number; x?: number; y?: number; scale?: number; opacity?: number; rotation?: number };
/** Server mirror of web sampleKeyframes() (lib/editor/presets.ts) — linear per-property
 *  interpolation, values hold at both ends. `t` is render-relative seconds (= the preview's
 *  localT = segT − trimIn), so keyframe timing burns identically to what the operator saw. */
function sampleKf(kfs: KfPoint[], t: number) {
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  const prop = (key: "x" | "y" | "scale" | "opacity" | "rotation"): number | undefined => {
    const pts = sorted.filter((k) => typeof k[key] === "number");
    if (!pts.length) return undefined;
    if (t <= pts[0].time) return pts[0][key];
    const last = pts[pts.length - 1];
    if (t >= last.time) return last[key];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (t >= a.time && t <= b.time) {
        const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
        return (a[key] as number) + ((b[key] as number) - (a[key] as number)) * f;
      }
    }
    return last[key];
  };
  return { x: prop("x"), y: prop("y"), scale: prop("scale") ?? 1, opacity: prop("opacity") ?? 1, rotation: prop("rotation") ?? 0 };
}
/** ASS alpha tag from CSS opacity (1=opaque→&H00&, 0=transparent→&HFF&). */
function assAlpha(opacity: number): string {
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
  return `\\alpha&H${a.toString(16).padStart(2, "0").toUpperCase()}&`;
}

/**
 * Pick the "keyword" tokens to color-emphasize in a caption — the content words that carry
 * the meaning (CapCut/Opus highlight these). Cheap, dependency-free heuristic: the longest
 * tokens by letter/number count (Korean content words tend to be 2+ syllables; particles and
 * endings are short), capped at ~a third of the line so it stays selective. Mirror this on
 * the web (editor-preview) so the burn matches the preview. Returns 0-based indices.
 */
export function pickKeywordIdx(tokens: string[]): Set<number> {
  const scored = tokens
    .map((t, i) => ({ i, len: [...t.replace(/[^\p{L}\p{N}]/gu, "")].length }))
    .filter((x) => x.len >= 2);
  if (!scored.length) return new Set();
  scored.sort((a, b) => b.len - a.len);
  const n = Math.max(1, Math.round(tokens.length / 3));
  return new Set(scored.slice(0, n).map((x) => x.i));
}

function buildEditorAss(
  es: any,
  W: number,
  H: number,
  stageH: number,
  durSec: number,
  captions?: Caption[],
): string | null {
  const scale = H / stageH;
  const end = assTime(durSec);
  const ev: string[] = [];
  // Overlay show-windows (startSec/endSec) are segment-relative (0 at the adopted segment
  // start); the render window starts at trimIn, so subtract it to get render-relative time.
  // Keyframe times are ALREADY render-relative (localT = segT − trimIn), so they need no shift.
  const trimIn = Number(es?.trimIn ?? 0);
  const putWin = (an: number, x: number, y: number, fs: number, color: string, bord: number, bordColor: string, text: string, vs: number, ve: number, extra = "") =>
    ev.push(`Dialogue: 0,${assTime(vs)},${assTime(ve)},Default,,0,0,0,,{\\an${an}\\pos(${Math.round(x)},${Math.round(y)})\\fs${fs}\\c${color}\\b1\\bord${bord}\\3c${bordColor}\\shad1${extra}}${assEscape(text)}`);
  const put = (an: number, x: number, y: number, fs: number, color: string, bord: number, bordColor: string, text: string) =>
    putWin(an, x, y, fs, color, bord, bordColor, text, 0, durSec);
  // Visible [start,end] render-relative window for an overlay; null if it never shows.
  const winFor = (o: { startSec?: number; endSec?: number }): [number, number] | null => {
    const vs = Math.max(0, o.startSec != null ? o.startSec - trimIn : 0);
    const ve = Math.min(durSec, o.endSec != null ? o.endSec - trimIn : durSec);
    return ve > vs + 0.02 ? [vs, ve] : null;
  };
  const SAMPLE_STEP = 0.1; // 10 fps keyframe sampling — smooth enough, cheap for libass

  if (es && typeof es === "object") {
    let yOff = 0;
    for (const t of Array.isArray(es.titleLines) ? es.titleLines : []) {
      if (!t?.text?.trim()) continue;
      const fs = Math.max(12, Math.round((t.size ?? 30) * scale));
      const bx = ((es.titleX ?? 50) / 100) * W;
      const by = ((es.titleY ?? 8) / 100) * H + yOff;
      const an = es.titleAlign === "left" ? 7 : es.titleAlign === "right" ? 9 : 8;
      const color = hexToAss(t.color ?? "#FFFFFF");
      const win = winFor(t);
      if (win) {
        const kfs: KfPoint[] = Array.isArray(t.keyframes) ? t.keyframes : [];
        if (kfs.length) {
          // Title-line keyframe x/y are OFFSETS from the layout (cqw/cqh = % of stage).
          for (let s = win[0]; s < win[1] - 1e-6; s += SAMPLE_STEP) {
            const k = sampleKf(kfs, s);
            const extra = `\\fscx${Math.round(k.scale * 100)}\\fscy${Math.round(k.scale * 100)}${assAlpha(k.opacity)}\\frz${(-k.rotation).toFixed(1)}`;
            putWin(an, bx + ((k.x ?? 0) / 100) * W, by + ((k.y ?? 0) / 100) * H, fs, color, 2, "&H00000000&", t.text, s, Math.min(win[1], s + SAMPLE_STEP), extra);
          }
        } else {
          putWin(an, bx, by, fs, color, 2, "&H00000000&", t.text, win[0], win[1]);
        }
      }
      yOff += Math.round(fs * 1.15);
    }
    if (es.showChannel && es.channelName?.trim()) {
      const fs = Math.max(12, Math.round(14 * scale * 1.2));
      put(8, Math.round(0.5 * W), Math.round(((es.channelY ?? 82) / 100) * H), fs, "&H00FFFFFF&", 2, "&H00000000&", "▶ " + es.channelName);
    }
    for (const el of Array.isArray(es.elements) ? es.elements : []) {
      if (!el?.text?.trim()) continue;
      const fs = Math.max(12, Math.round((el.size ?? (el.type === "arrow" ? 40 : 14)) * scale));
      const win = winFor(el);
      if (!win) continue;
      const kfs: KfPoint[] = Array.isArray(el.keyframes) ? el.keyframes : [];
      if (kfs.length) {
        // Element keyframe x/y are ABSOLUTE stage % (fall back to the element's own x/y).
        for (let s = win[0]; s < win[1] - 1e-6; s += SAMPLE_STEP) {
          const k = sampleKf(kfs, s);
          const extra = `\\fscx${Math.round(k.scale * 100)}\\fscy${Math.round(k.scale * 100)}${assAlpha(k.opacity)}\\frz${(-k.rotation).toFixed(1)}`;
          putWin(5, ((k.x ?? el.x ?? 50) / 100) * W, ((k.y ?? el.y ?? 50) / 100) * H, fs, "&H0016120D&", 3, "&H00FFFFFF&", el.text, s, Math.min(win[1], s + SAMPLE_STEP), extra);
        }
      } else {
        putWin(5, ((el.x ?? 50) / 100) * W, ((el.y ?? 50) / 100) * H, fs, "&H0016120D&", 3, "&H00FFFFFF&", el.text, win[0], win[1]);
      }
    }
  }

  // STT captions — bottom-center Caption style. On unless editorState explicitly turns them
  // off (captionsOn === false). When word timings are present (whisper path) we burn \k
  // karaoke — the sung word sweeps from white to the highlight colour; otherwise one plain
  // Dialogue per sentence (gemini path). Inline \1c/\2c keep the Caption style unchanged.
  const capOn = es && typeof es === "object" ? es.captionsOn !== false : true;
  if (capOn) {
    const capHi = hexToAss((es && typeof es === "object" && es.highlightColor) || "#FFD400");
    // Keyword tokens sweep to a distinct colour; default = the highlight colour (so it's a
    // no-op unless the operator picks one), matching CapCut/Opus keyword emphasis.
    const capKey = hexToAss((es && typeof es === "object" && es.keywordColor) || (es && typeof es === "object" && es.highlightColor) || "#FFD400");
    const white = "&H00FFFFFF&";
    for (const cap of Array.isArray(captions) ? captions : []) {
      const text = String(cap.text ?? "").trim();
      if (!text || !(cap.end > cap.start)) continue;
      // Real word timings if the STT had them; otherwise synthesize (unless karaoke is off).
      const karaokeOn = !(es && typeof es === "object" && (es as any).karaoke === false);
      const words =
        Array.isArray(cap.words) && cap.words.length
          ? cap.words
          : karaokeOn
            ? synthesizeWords(text, cap.start, cap.end)
            : [];
      if (words.length) {
        // Word-by-word highlight (the signature "AI short" caption): one Dialogue per word
        // window, whole line in white, the active word in the highlight colour and keyword
        // words in the keyword colour. Colour-only (no per-word scale) so a centre-anchored
        // line never jitters as the active word changes. Windows are sequential → exactly one
        // line shows at a time; each spans [prevEnd, wordEnd] so there's no gap.
        const keyIdx = pickKeywordIdx(words.map((w) => String(w.word)));
        let prev = cap.start;
        words.forEach((w, i) => {
          const we = Math.max(prev + 0.01, Math.min(cap.end, Number(w.end)));
          const lineEnd = i === words.length - 1 ? cap.end : we;
          const parts = words.map((ww, j) => {
            const tok = assEscape(String(ww.word));
            if (j === i) return `{\\1c${keyIdx.has(j) ? capKey : capHi}}${tok}{\\1c${white}}`;
            return tok;
          });
          ev.push(`Dialogue: 0,${assTime(prev)},${assTime(lineEnd)},Caption,,0,0,0,,{\\1c${white}}${parts.join(" ")}`);
          prev = we;
        });
      } else {
        ev.push(`Dialogue: 0,${assTime(cap.start)},${assTime(cap.end)},Caption,,0,0,0,,${assEscape(text)}`);
      }
    }
  }

  if (!ev.length) return null;
  const capFs = Math.round(H * 0.042);
  const capMV = Math.round(H * 0.14);
  const capStyle = (es && typeof es === "object" && es.captionStyle) || "korean_pop";
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,Noto Sans CJK KR,48,&H00FFFFFF,&H00000000,&H00000000,1,1,2,1,5,20,20,20,1\n` +
    captionAssStyle(capStyle, capFs, capMV) + "\n\n" +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    ev.join("\n") + "\n"
  );
}

/**
 * The Caption ASS style line, branched by editorState.captionStyle so the burn matches the
 * editor preview. Mirror of captionStyleClasses() on the web (editor-preview.tsx):
 *   korean_pop — 예능 팝: thick black outline + shadow, bold, slightly larger (default)
 *   clean      — 미니멀: thin outline, no shadow, a touch smaller
 *   news       — 뉴스 바: opaque lower-third box (BorderStyle=3), no outline
 * Fields: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,
 *         Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding.
 */
function captionAssStyle(style: string, fs: number, mv: number): string {
  const font = "Noto Sans CJK KR";
  // ASS 필드: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold,
  //          BorderStyle(1=outline+shadow, 3=box), Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  // 색은 &HAABBGGRR (Alpha·B·G·R). 프리뷰(editor-preview.tsx:captionStyleClasses)와 시각 매칭.
  switch (style) {
    case "news":
      // 뉴스: 흰 텍스트 + 반투명 검은 박스 (프리뷰 rounded bg-black/70)
      return `Style: Caption,${font},${fs},&H00FFFFFF,&H00000000,&HA0000000,1,3,0,0,2,60,60,${mv},1`;
    case "clean":
      // 클린: 흰 텍스트 + 얇은 그림자 (프리뷰 textShadow 0 1px 3px)
      return `Style: Caption,${font},${Math.round(fs * 0.92)},&H00FFFFFF,&H00000000,&H00000000,1,1,1,0,2,60,60,${mv},1`;
    case "yellow_pop":
      // 노란 팝 (하하 학습 신호): 노랑 #FFD400 (BGR &H0000D4FF) + 검정 스트로크 + 그림자
      return `Style: Caption,${font},${Math.round(fs * 1.05)},&H0000D4FF,&H00000000,&H80000000,1,1,4,2,2,60,60,${mv},1`;
    case "cyan_neon":
      // 시안 네온: 시안 #00E5FF (BGR &H00FFE500) + 시안 아웃라인 (네온 그로우 근사, ASS는 진짜 glow 없음)
      return `Style: Caption,${font},${Math.round(fs * 1.03)},&H00FFE500,&H00CC8500,&H00000000,1,1,3,0,2,60,60,${mv},1`;
    case "pink_bubble":
      // 핑크 버블: 흰 텍스트 + 핑크 박스 #EC4899 (BGR &H009948EC)
      return `Style: Caption,${font},${Math.round(fs * 0.93)},&H00FFFFFF,&H00000000,&HD09948EC,1,3,0,0,2,60,60,${mv},1`;
    case "outline_bold":
      // 굵은 아웃라인만: 프리뷰가 transparent + 2px 흰 stroke → 검정 fill + 굵은 흰 스트로크(근사)
      return `Style: Caption,${font},${Math.round(fs * 1.10)},&H00000000,&H00FFFFFF,&H00000000,1,1,5,0,2,60,60,${mv},1`;
    case "shadow_soft":
      // 부드러운 그림자: 흰 텍스트 + 큰 부드러운 그림자 (프리뷰 0 2px 12px)
      return `Style: Caption,${font},${Math.round(fs * 0.93)},&H00FFFFFF,&H00000000,&H80000000,0,1,0,4,2,60,60,${mv},1`;
    case "highlight_bar":
      // 형광펜: 검정 텍스트 + 노랑 박스 #FFE066 (BGR &H0066E0FF)
      return `Style: Caption,${font},${Math.round(fs * 0.98)},&H00000000,&H00000000,&H0066E0FF,1,3,0,0,2,60,60,${mv},1`;
    case "typewriter":
      // 타자기: 흰 텍스트 + 검정 박스 + 자간 넓게 (Bold=1)
      return `Style: Caption,Courier New,${Math.round(fs * 0.91)},&H00FFFFFF,&H00000000,&HFF000000,1,3,0,0,2,60,60,${mv},1`;
    case "korean_pop":
    default:
      // 예능 팝 (기본): 흰 텍스트 + 두꺼운 검정 스트로크 + 그림자
      return `Style: Caption,${font},${Math.round(fs * 1.05)},&H00FFFFFF,&H00000000,&H80000000,1,1,4,2,2,60,60,${mv},1`;
  }
}

/**
/**
 * Map the editor's colour filters (FilterSettings, CSS-percent scale mirrored from
 * lib/editor/presets.ts::filterCss) to an ffmpeg video-filter fragment. Returns null when
 * everything is at its neutral default. brightness is CSS-multiplicative in the preview but
 * ffmpeg eq.brightness is additive — approximated so the direction/feel matches (not a
 * pixel-exact match, which is impossible across CSS and libavfilter).
 */
function ffGradeFilter(f: any): string | null {
  if (!f || typeof f !== "object") return null;
  const parts: string[] = [];
  const eq: string[] = [];
  const b = Number(f.brightness ?? 100);
  const c = Number(f.contrast ?? 100);
  const s = Number(f.saturation ?? 100);
  const w = Number(f.warmth ?? 0);
  if (b !== 100) eq.push(`brightness=${((b - 100) / 200).toFixed(3)}`); // additive approx of CSS %
  if (c !== 100) eq.push(`contrast=${(c / 100).toFixed(3)}`);
  if (s !== 100) eq.push(`saturation=${(s / 100).toFixed(3)}`);
  if (eq.length) parts.push(`eq=${eq.join(":")}`);
  if (w) {
    const k = (Math.max(-100, Math.min(100, w)) / 100) * 0.3; // warm = +red/−blue, cool = inverse
    parts.push(`colorbalance=rm=${k.toFixed(3)}:bm=${(-k).toFixed(3)}`);
  }
  return parts.length ? parts.join(",") : null;
}

/** Map the main track's volume/mute to an ffmpeg audio-filter fragment, or null if neutral. */
function ffVolumeFilter(track: any): string | null {
  if (!track || typeof track !== "object") return null;
  if (track.muted) return "volume=0";
  const v = Number(track.volume ?? 1);
  if (!isFinite(v) || v === 1) return null;
  return `volume=${Math.max(0, Math.min(2, v)).toFixed(3)}`;
}

/**
 * Uniform playback speed to bake, from EditorState. Only the global `speed` (the timeline's
 * ×-button) is baked; per-track speedPoints (ramping) are variable-rate and need a
 * multi-segment render, so they're deferred — returning 1 there keeps the render at normal
 * speed rather than faking a ramp as uniform (which would mismatch the preview).
 */
function uniformSpeed(es: any): number {
  const mt = Array.isArray(es?.tracks) ? es.tracks[0] : undefined;
  if (Array.isArray(mt?.speedPoints) && mt.speedPoints.length > 0) return 1;
  const s = Number(es?.speed ?? 1);
  return isFinite(s) && s > 0 ? s : 1;
}

/** ffmpeg atempo is limited to [0.5, 2] per instance — chain to reach any factor. */
function atempoChain(speed: number): string {
  let s = speed;
  const parts: string[] = [];
  while (s > 2.0 + 1e-9) { parts.push("atempo=2.0"); s /= 2; }
  while (s < 0.5 - 1e-9) { parts.push("atempo=0.5"); s *= 2; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

/**
 * Render one clip's segment into the final deliverable — the ONE expensive render (plan
 * §2.4 deferred-render invariant), called only from /clips/:id/export. Reframes to the
 * chosen aspect (blur-cover 9:16) and burns the editorState overlays via libass. A plain
 * 16:9 highlight with no overlay/grade/volume takes the cheap trim path. Returns the new
 * clip media + probe metadata, or null if the master is missing / the render fails.
 */
async function renderClipMedia(opts: {
  master: MediaRow;
  episodeId: string;
  startTime: number;
  endTime: number;
  title: string;
  editorState?: any;
  aspect?: string;
  captions?: Caption[];
  /** 첫 3초 hook 프리롤 (편집자가 "첫 3초 훅" 토글 ON + clip.hookTimeSec 있을 때만). */
  hookPreroll?: { startTime: number; durationSec: number; hasAudio?: boolean } | null;
}): Promise<
  | { clipMediaId: string; clipStored: string; thumbStored: string | null;
      cmeta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean } }
  | null
> {
  const { master, episodeId, startTime, endTime, title, editorState } = opts;
  const aspect = opts.aspect ?? editorState?.aspect ?? "9:16";
  const masterObjPath = parseObjectPath(master.path);
  if (!(await fileExists(masterObjPath))) return null;

  const tmpDir = path.resolve("/tmp/stepd-clips");
  fs.mkdirSync(tmpDir, { recursive: true });
  const clipMediaId = newId("m");
  const clipObjPath = clipPath(clipMediaId);
  const tmpPath = path.join(tmpDir, `${clipMediaId}.mp4`);
  const thumbTmp = path.join(tmpDir, `${clipMediaId}.jpg`);
  const assTmp = path.join(tmpDir, `${clipMediaId}.ass`);

  const { W, H, stageH } = renderDims(aspect);
  const ass = buildEditorAss(editorState, W, H, stageH, endTime - startTime, opts.captions);
  if (ass) fs.writeFileSync(assTmp, ass, "utf-8");

  // Bake the main track's colour grade + volume + uniform speed into the render — previously
  // these were preview-only, so the deliverable silently ignored the operator's edits.
  const mainTrack = Array.isArray(editorState?.tracks) ? editorState.tracks[0] : undefined;
  const videoFilters = ffGradeFilter(mainTrack?.filters);
  const speed = uniformSpeed(editorState);
  const audioParts = [ffVolumeFilter(mainTrack), speed !== 1 ? atempoChain(speed) : null].filter(Boolean) as string[];
  // NOT gated on master.hasAudio: finalize's probe may degrade to hasAudio=0 on a video
  // that does have audio, and skipping atempo then ships a desynced deliverable (video at
  // 2×, audio at 1×, chopped by -t). With `-map 0:a?`, -af on a truly audio-less file is
  // simply a no-op — safe either way.
  const audioFilter = audioParts.length ? audioParts.join(",") : null;

  // ffmpeg reads the master directly. For GCS we hand it a short-lived signed URL and seek
  // via HTTP range (-ss before -i) — only the requested segment is fetched, so a multi-hour
  // master never lands in Cloud Run's RAM.
  const srcPath = useGcs() ? await signedReadUrl(masterObjPath) : master.path;
  const hookPreroll = opts.hookPreroll && opts.hookPreroll.durationSec > 0 ? opts.hookPreroll : null;
  try {
    if (!ass && !videoFilters && !audioFilter && speed === 1 && aspect === "16:9" && !hookPreroll) {
      // Fast path only when there's genuinely nothing to bake (no overlays, no grade, no
      // volume change, no speed change, native 16:9, no hook preroll). Any edit routes through renderShort.
      await trimEncode(srcPath, startTime, endTime, tmpPath);
    } else {
      // 배경 채우기 방식 — 에디터에서 지정한 bgType(solid/blur/image). image는 아직 렌더 파이프라인
      // 미지원이라 solid로 폴백(renderShort 내부에서 처리). solid일 때 letterbox 색은 state.bg.
      const bgType = (editorState?.bgType === "solid" || editorState?.bgType === "image"
        ? editorState.bgType
        : "blur") as "solid" | "blur" | "image";
      const bgColor = typeof editorState?.bg === "string" ? editorState.bg : undefined;
      // 프레임 템플릿 — editorState.templateId 가 assets/shorts-template 의 디렉토리 이름이다.
      // 목록에 없으면(구 프리셋 id 등) null 이라 기존 blur/solid 경로로 떨어진다.
      const tpl = typeof editorState?.templateId === "string"
        ? getShortsTemplate(editorState.templateId)
        : null;
      const frame = tpl
        ? { overlayPath: tpl.overlayPath, video: tpl.video, bands: tpl.bands, overlayRegions: tpl.overlayRegions }
        : null;
      await renderShort({
        inputPath: srcPath, startTime, endTime, outputPath: tmpPath, width: W, height: H,
        assPath: ass ? assTmp : null, videoFilters, audioFilter, speed,
        bgType, bgColor, frame,
        hookPreroll,
      });
    }
    const cmeta = await probe(tmpPath).catch(() => ({
      durationSec: Math.max(1, endTime - startTime), width: W, height: H, codec: "h264", hasAudio: true,
    }));
    const clipStored = await uploadFile(clipObjPath, tmpPath);

    await captureThumbnail(tmpPath, Math.min(1, cmeta.durationSec / 2), thumbTmp).catch(() => {});
    let thumbStored: string | null = null;
    if (fs.existsSync(thumbTmp)) thumbStored = await uploadFile(thumbPath(clipMediaId), thumbTmp);

    const cRow: MediaRow = {
      id: clipMediaId, episodeId, role: "clip", title,
      filename: `${title}.mp4`, path: clipStored, mime: "video/mp4",
      size: fs.statSync(tmpPath).size, durationSec: cmeta.durationSec,
      width: cmeta.width, height: cmeta.height, codec: cmeta.codec, hasAudio: cmeta.hasAudio ? 1 : 0,
      thumbPath: thumbStored, createdAt: Date.now(),
    };
    await insertMedia(cRow);
    return { clipMediaId, clipStored, thumbStored, cmeta };
  } catch (err) {
    console.error("[render] render failed:", err);
    return null;
  } finally {
    // /tmp is RAM-backed on Cloud Run — always clear the temps.
    try { fs.unlinkSync(tmpPath); } catch {}
    try { fs.unlinkSync(thumbTmp); } catch {}
    try { fs.unlinkSync(assTmp); } catch {}
  }
}

// ── thumbnail template refs (Web UI CRUD · 2026-07-28) ─────────────────────────
// Templates = 방송사 완성작 · swap 파이프라인용 reference.
// Storage:
//   Production (GCS mode): templates/thumbnail/{id}.{ext} + templates/thumbnail/manifest.json
//   Local dev: assets/thumbnail-reference/{id}.{ext} + manifest.json (기존)
// Cloud Run 컨테이너는 재시작 시 로컬 fs 유실 · GCS 우선.
const THUMB_REF_DIR = path.join(REPO_ROOT, "assets", "thumbnail-reference");
const THUMB_MANIFEST = path.join(THUMB_REF_DIR, "manifest.json");
const THUMB_GCS_PREFIX = "templates/thumbnail";
const THUMB_GCS_MANIFEST = `${THUMB_GCS_PREFIX}/manifest.json`;

async function readThumbManifest(): Promise<any[]> {
  if (useGcs()) {
    try {
      if (await fileExists(THUMB_GCS_MANIFEST)) {
        const buf = await readFile(THUMB_GCS_MANIFEST);
        return JSON.parse(buf.toString("utf-8"));
      }
    } catch (e) { console.warn("[thumb-refs] GCS manifest read fail", e); }
    return [];
  }
  try {
    if (!fs.existsSync(THUMB_MANIFEST)) return [];
    return JSON.parse(fs.readFileSync(THUMB_MANIFEST, "utf-8")) as any[];
  } catch { return []; }
}

async function writeThumbManifest(entries: any[]): Promise<void> {
  const json = JSON.stringify(entries, null, 2);
  if (useGcs()) {
    await writeFile(THUMB_GCS_MANIFEST, Buffer.from(json, "utf-8"));
    return;
  }
  fs.mkdirSync(THUMB_REF_DIR, { recursive: true });
  fs.writeFileSync(THUMB_MANIFEST, json, "utf-8");
}

/** Resolve stored path (relative to repo root) → GCS object path or local fs path. */
function refGcsPath(entry: any): string | null {
  if (!useGcs() || !entry?.path) return null;
  // entry.path is either "assets/thumbnail-reference/{id}.{ext}" (legacy · migrate) or
  // "templates/thumbnail/{id}.{ext}" (GCS-native).
  const p = String(entry.path);
  if (p.startsWith("templates/")) return p;
  // Legacy assets/ path → migrate to templates/thumbnail/ convention
  const fname = path.basename(p);
  return `${THUMB_GCS_PREFIX}/${fname}`;
}

function refCleanedGcsPath(entry: any): string | null {
  if (!useGcs() || !entry?.cleaned_path) return null;
  const p = String(entry.cleaned_path);
  if (p.startsWith("templates/")) return p;
  const fname = path.basename(p);
  return `${THUMB_GCS_PREFIX}/cleaned/${fname}`;
}

// GET · 모든 template metadata
app.get("/api/thumbnail-refs", async (c) => {
  const items = await readThumbManifest();
  return c.json({ items });
});

// GET · template 이미지 (GCS or local)
app.get("/api/thumbnail-refs/:id/image", async (c) => {
  const id = c.req.param("id").replace(/[^\w.-]/g, "");
  const variant = c.req.query("variant"); // "cleaned" 또는 원본
  const entries = await readThumbManifest();
  const entry = entries.find((e: any) => e.id === id);
  if (!entry) return c.json({ error: "not found" }, 404);
  const gcsPath = variant === "cleaned" ? refCleanedGcsPath(entry) : refGcsPath(entry);
  if (useGcs() && gcsPath) {
    if (!(await fileExists(gcsPath))) return c.json({ error: "file missing on GCS" }, 404);
    const buf = await readFile(gcsPath);
    const ext = gcsPath.split(".").pop()?.toLowerCase() || "jpg";
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return new Response(buf, { headers: { "content-type": mime, "cache-control": "public, max-age=600" } });
  }
  // Local fallback
  const rel = variant === "cleaned" ? entry.cleaned_path : entry.path;
  if (!rel) return c.json({ error: "no path" }, 404);
  const p = path.join(REPO_ROOT, String(rel));
  if (!fs.existsSync(p)) return c.json({ error: "file missing" }, 404);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return new Response(fs.readFileSync(p), { headers: { "content-type": mime } });
});

// POST · 이미지 업로드 (multipart) · GCS(prod) or local(dev) 저장
app.post("/api/thumbnail-refs", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "multipart required" }, 400);
  const file = form.get("file");
  const idHint = String(form.get("id") || "").trim();
  const program = String(form.get("program") || "").trim();
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  if (!["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return c.json({ error: "unsupported ext" }, 400);
  }
  const entries = await readThumbManifest();
  const usedIds = new Set(entries.map((e: any) => e.id));
  let id = idHint || `ref_${String(Date.now()).slice(-8)}`;
  id = id.replace(/[^\w.-]/g, "_");
  let n = 1;
  while (usedIds.has(id)) { id = `${idHint || "ref"}_${n++}`; }
  const fname = `${id}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  let storedPath: string;
  if (useGcs()) {
    const gcsPath = `${THUMB_GCS_PREFIX}/${fname}`;
    await writeFile(gcsPath, buf);
    storedPath = gcsPath;
  } else {
    fs.mkdirSync(THUMB_REF_DIR, { recursive: true });
    fs.writeFileSync(path.join(THUMB_REF_DIR, fname), buf);
    storedPath = `assets/thumbnail-reference/${fname}`;
  }
  const entry = {
    id, path: storedPath,
    _analyzed: false, program, custom_tags: [],
    uploaded_at: new Date().toISOString(),
  };
  entries.push(entry);
  await writeThumbManifest(entries);
  return c.json({ item: entry });
});

// PATCH · metadata 편집 (program·custom_tags·user_note 등)
app.patch("/api/thumbnail-refs/:id", async (c) => {
  const id = c.req.param("id");
  const entries = await readThumbManifest();
  const idx = entries.findIndex((e: any) => e.id === id);
  if (idx < 0) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>().catch(() => ({}));
  const patch: any = {};
  for (const k of ["program", "custom_tags", "user_note", "person_count", "mood", "composition"]) {
    if (k in body) patch[k] = body[k];
  }
  entries[idx] = { ...entries[idx], ...patch };
  await writeThumbManifest(entries);
  return c.json({ item: entries[idx] });
});

// DELETE · manifest + 파일 삭제 (GCS + local)
app.delete("/api/thumbnail-refs/:id", async (c) => {
  const id = c.req.param("id");
  const entries = await readThumbManifest();
  const entry = entries.find((e: any) => e.id === id);
  if (!entry) return c.json({ error: "not found" }, 404);
  if (useGcs()) {
    try {
      const gp = refGcsPath(entry); if (gp) await deleteFile(gp);
      const cp = refCleanedGcsPath(entry); if (cp) await deleteFile(cp);
    } catch (e) { console.warn("[thumb-refs] GCS delete err", e); }
  } else {
    const p = path.join(REPO_ROOT, String(entry.path || ""));
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    if (entry.cleaned_path) {
      const cp = path.join(REPO_ROOT, String(entry.cleaned_path));
      try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch {}
    }
  }
  await writeThumbManifest(entries.filter((e: any) => e.id !== id));
  return c.json({ ok: true });
});

// POST · 전체 미분석/미가공 항목 배치 처리 (분석 or 가공)
app.post("/api/thumbnail-refs/batch/:action", async (c) => {
  const action = c.req.param("action");
  if (!["analyze", "preprocess"].includes(action)) return c.json({ error: "action" }, 400);
  const entries = await readThumbManifest();
  const targets = entries.filter((e: any) =>
    action === "analyze" ? !e._analyzed : !e.cleaned_path);
  if (!targets.length) return c.json({ ok: true, processed: 0, note: "nothing to do" });
  const scriptName = action === "analyze"
    ? "thumbnail_reference_manifest.py"
    : "thumbnail_preprocess_template.py";
  const scriptPath = path.join(REPO_ROOT, "scripts", scriptName);
  const { spawn } = await import("node:child_process");
  const results: any[] = [];
  for (const target of targets) {
    try {
      await new Promise<void>((resolve, reject) => {
        const args = action === "analyze" ? [scriptPath] : [scriptPath, target.id];
        const proc = spawn(CORE_PYTHON, args, {
          cwd: REPO_ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${action} ${target.id} exit ${code}: ${stderr.slice(-300)}`)));
        proc.on("error", reject);
      });
      results.push({ id: target.id, ok: true });
    } catch (e: any) {
      results.push({ id: target.id, ok: false, error: String(e?.message || e) });
    }
    if (action === "analyze") break;  // analyze 는 전체 스캔 · 한 번만
  }
  return c.json({ ok: true, processed: results.length, results });
});

// POST · template 사전 가공 (텍스트→슬롯 라벨 · 얼굴→실루엣)
app.post("/api/thumbnail-refs/:id/preprocess", async (c) => {
  const id = c.req.param("id").replace(/[^\w.-]/g, "");
  const entries = await readThumbManifest();
  const entry = entries.find((e: any) => e.id === id);
  if (!entry) return c.json({ error: "not found" }, 404);
  if (useGcs()) {
    return c.json({
      error: "preprocess not supported on Cloud Run",
      hint: "로컬 워커에서 실행하세요: python scripts/thumbnail_preprocess_template.py " + id,
    }, 501);
  }
  const scriptPath = path.join(REPO_ROOT, "scripts", "thumbnail_preprocess_template.py");
  const { spawn } = await import("node:child_process");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(CORE_PYTHON, [scriptPath, id, "--force"], {
        cwd: REPO_ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`preprocess exit ${code}: ${stderr.slice(-500)}`)));
      proc.on("error", reject);
    });
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
  const updated = (await readThumbManifest()).find((e: any) => e.id === id);
  return c.json({ item: updated });
});

// POST · Vision 자동 분석 (기존 entry · 새 업로드 후 · manifest _analyzed=false → true)
app.post("/api/thumbnail-refs/:id/analyze", async (c) => {
  const id = c.req.param("id").replace(/[^\w.-]/g, "");
  const entries = await readThumbManifest();
  const entry = entries.find((e: any) => e.id === id);
  if (!entry) return c.json({ error: "not found" }, 404);
  if (useGcs()) {
    return c.json({
      error: "analyze not supported on Cloud Run",
      hint: "로컬 워커에서 실행: python scripts/thumbnail_reference_manifest.py",
    }, 501);
  }
  // Python 스크립트 호출
  const scriptPath = path.join(REPO_ROOT, "scripts", "thumbnail_reference_manifest.py");
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(CORE_PYTHON, [scriptPath], {
      cwd: REPO_ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`analyze exit ${code}: ${stderr.slice(-500)}`)));
    proc.on("error", reject);
  }).catch((e) => c.json({ error: String(e) }, 500));
  const updated2 = (await readThumbManifest()).find((e: any) => e.id === id);
  return c.json({ item: updated2 });
});

// POST · YouTube 채널 이미 sync 된 영상 중 상위 뷰 썸네일 자동 수집 → refs 로 추가
// 전제: 해당 채널이 이미 sync 완료 · entities table 에 youtube_video 저장됨
app.post("/api/thumbnail-refs/import-youtube", async (c) => {
  const body = await c.req.json<{ channelId?: string; program?: string; max?: number }>()
    .catch(() => ({} as any));
  const channelId = String(body?.channelId || "").trim();
  const program = String(body?.program || "").trim();
  const max = Math.min(20, Math.max(1, Number(body?.max) || 6));
  if (!channelId) return c.json({ error: "channelId required" }, 400);
  // channel_videos 테이블에서 상위 뷰 조회 (sync 결과)
  const { rows } = await getPool().query(
    `SELECT videoid AS "videoId", title, thumbnail, viewcount AS "viewCount"
       FROM channel_videos WHERE channelid = $1 AND thumbnail IS NOT NULL
       ORDER BY viewcount DESC NULLS LAST LIMIT $2`,
    [channelId, max]
  );
  if (!rows.length) return c.json({ error: "no synced videos for channel", channelId }, 404);
  const entries = await readThumbManifest();
  const usedIds = new Set(entries.map((e: any) => e.id));
  const added: any[] = [];
  for (const v of rows) {
    const thumbUrl = String(v.thumbnail || "");
    if (!thumbUrl) continue;
    let id = `yt_${v.videoId}`.replace(/[^\w.-]/g, "_");
    let n = 1;
    while (usedIds.has(id)) { id = `yt_${v.videoId}_${n++}`; }
    try {
      const buf = Buffer.from(await (await fetch(thumbUrl)).arrayBuffer());
      const fname = `${id}.jpg`;
      let storedPath: string;
      if (useGcs()) {
        const gcsPath = `${THUMB_GCS_PREFIX}/${fname}`;
        await writeFile(gcsPath, buf);
        storedPath = gcsPath;
      } else {
        fs.mkdirSync(THUMB_REF_DIR, { recursive: true });
        fs.writeFileSync(path.join(THUMB_REF_DIR, fname), buf);
        storedPath = `assets/thumbnail-reference/${fname}`;
      }
      const entry = {
        id, path: storedPath,
        _analyzed: false, program, custom_tags: ["youtube"],
        source: { videoId: v.videoId, title: v.title, viewCount: v.viewCount },
        uploaded_at: new Date().toISOString(),
      };
      entries.push(entry); usedIds.add(id); added.push(entry);
    } catch (e) {
      console.error("[thumb-import]", id, e);
    }
  }
  await writeThumbManifest(entries);
  return c.json({ added: added.length, items: added });
});

// ── 게이트: 권리·심의 이슈 (FLOWS F3) ──────────────────────────────────────────
//
// **자동 판정이 없다.** 여기 있는 라우트는 전부 사람이 누르는 것이고, 그래서 전부
// actor(누가)를 요구한다. actor 가 비면 400 이다 — "시스템이 등록했다"는 이슈는
// 존재하면 안 되기 때문이다.
//
// ⚠️ actor 는 지금 클라이언트가 보내는 이름이다. 서버 인증은 S3 에서 붙는다.
// 그때까지 감사 로그의 actor 는 "자칭"이라는 걸 전제로 읽어야 한다.

const SUBJECT_TYPES = ["episode", "recommendation", "clip"] as const;

function readSubjectType(v: unknown): GateSubjectType | null {
  return (SUBJECT_TYPES as readonly string[]).includes(String(v)) ? (v as GateSubjectType) : null;
}

function readActor(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** DB 행 → gate.ts 가 보는 모양. */
function toIssue(r: { id: string; kind: string; resolution: string; bandStart: number | null; bandEnd: number | null; note: string }): Issue {
  return {
    id: r.id,
    kind: r.kind,
    resolution: r.resolution,
    bandStart: r.bandStart,
    bandEnd: r.bandEnd,
    note: r.note,
  };
}

/** 한 대상의 게이트를 계산한다. 저장된 상태를 읽는 게 아니라 매번 계산이다. */
async function gateFor(subjectType: GateSubjectType, subjectId: string): Promise<GateResult> {
  const [issues, judged] = await Promise.all([
    listRightsIssues(subjectType, subjectId),
    isJudged(subjectType, subjectId),
  ]);
  return evaluateGate({ judged, issues: issues.map(toIssue) });
}

// ── 자동 배포 (FLOWS F6 · README §12) ───────────────────────────────────────────
//
// **규칙이 없으면 아무것도 하지 않는다.** 전체 자동 실행 같은 기본 동작이 없다 —
// 이건 편의가 아니라 안전장치다. 판정은 automation.ts(순수)가 하고 여기는 배선이다.

const PAUSE_KEY = "automation.paused";

app.get("/api/automation", async (c) => {
  const [rules, runs, holds, paused] = await Promise.all([
    listAutomationRules(),
    listRuleRuns(50),
    openHolds(),
    getAutomationSetting(PAUSE_KEY),
  ]);
  const plan = planCycle({ paused: paused === "true", rules: rules as any });
  return c.json({
    rules, runs, holds,
    paused: paused === "true",
    idleReason: plan.idleReason,
    options: { mediaKinds: RULE_MEDIA_KINDS, criteria: RULE_CRITERIA, gatePolicies: GATE_POLICIES },
  });
});

app.post("/api/automation/rules", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const programId = typeof body.programId === "string" ? body.programId.trim() : "";
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (!programId || !platform || !accountId) {
    return c.json({ error: "programId · platform · accountId 가 필요합니다." }, 400);
  }
  if (!isRuleMediaKind(body.mediaKind)) return c.json({ error: "invalid mediaKind" }, 400);
  if (!isRuleCriterion(body.criterion)) return c.json({ error: "invalid criterion" }, 400);
  if (!isGatePolicy(body.gatePolicy)) return c.json({ error: "invalid gatePolicy" }, 400);

  const row = {
    id: typeof body.id === "string" && body.id ? body.id : newId("ar"),
    programId, platform, accountId,
    mediaKind: body.mediaKind, criterion: body.criterion, gatePolicy: body.gatePolicy,
    window: typeof body.window === "string" ? body.window.trim() || "수시" : "수시",
    enabled: body.enabled !== false,
  };
  await upsertAutomationRule(row);
  return c.json({
    rule: row,
    state: initialRuleState(platform, row.enabled),
    // ⚑ 기록만 하는 채널은 만들 때 그 사실을 말해야 한다(F6).
    notice: ruleCreatedNotice(platform),
  });
});

app.delete("/api/automation/rules/:id", async (c) => {
  const ok = await deleteAutomationRule(c.req.param("id"));
  // ⚑ 이미 게시된 건은 내려가지 않는다(F6).
  return c.json({ ok, notice: RULE_DELETED_NOTICE });
});

/**
 * 전역 일시정지 (F6 전역 토글).
 * 일시정지는 **새 회차를 잡지 않는 것**이지 진행 중인 걸 죽이는 게 아니다.
 */
app.post("/api/automation/pause", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const paused = body.paused !== false;
  await setAutomationSetting(PAUSE_KEY, paused ? "true" : "false");
  return c.json({
    paused,
    notice: paused
      ? "새 회차는 잡지 않습니다 — 이미 대기열에 들어간 건은 그대로 나갑니다."
      : "다음 순방부터 재개합니다.",
  });
});

/**
 * 보류 해제 — **사람이 확정하는 지점** (F6 Invariant · V15).
 *
 * 게이트가 열렸다고 자동이 저절로 다시 밀어내지 않는다. 여기를 눌러야 다음 순방에 다시 잡힌다.
 */
app.post("/api/automation/holds/release", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const ruleId = typeof body.ruleId === "string" ? body.ruleId : "";
  const clipId = typeof body.clipId === "string" ? body.clipId : "";
  const actor = typeof body.actor === "string" ? body.actor.trim() : "";
  if (!ruleId || !clipId) return c.json({ error: "ruleId · clipId 가 필요합니다." }, 400);
  if (!actor) return c.json({ error: "actor required — 보류 해제는 사람이 합니다." }, 400);

  const ok = await releaseHold(ruleId, clipId, actor);
  if (ok) {
    await appendRuleRun({ ruleId, clipId, result: "skipped", detail: `보류 해제 · ${actor}` });
  }
  return c.json({ ok, notice: ok ? "확정했습니다 — 다음 순방에 다시 잡힙니다." : "이미 해제된 건입니다." });
});

// ── 에셋 (FLOWS F8 · README §6) ─────────────────────────────────────────────────
//
// ⊘ 이름 변경 없음 — 에셋은 이름으로 참조된다. 이름을 바꾸면 그 참조가 전부 끊기고
//   되돌릴 수도 없다. 그래서 라우트 자체를 두지 않는다(asset-path.test.ts 가 감시).
// ⊘ 되돌리기 없음 — 그래서 삭제는 확인을 받고(화면), 이동은 미리 검증한다(여기).

app.get("/api/assets", async (c) => {
  const folder = normalizeFolderPath(c.req.query("folder") ?? ASSET_ROOT);
  if (!folder) return c.json({ error: "invalid folder path" }, 400);
  const [folders, files] = await Promise.all([listAssetFolders(), listAssetFiles(folder)]);
  return c.json({ folder, folders, files });
});

app.post("/api/assets/folders", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const parent = normalizeFolderPath(body.parent ?? ASSET_ROOT);
  if (!parent) return c.json({ error: "invalid parent path" }, 400);
  const check = validateName(body.name);
  if (!check.ok) return c.json({ error: check.reason }, 400);

  const name = String(body.name).trim();
  const path = childPath(parent, name);
  if (await assetFolderExists(path)) return c.json({ error: "같은 이름의 폴더가 이미 있습니다." }, 409);
  await insertAssetFolder(path, parent, name);
  return c.json({ folder: { path, parent, name } });
});

app.post("/api/assets/folders/move", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const from = normalizeFolderPath(body.from);
  const to = normalizeFolderPath(body.to);
  if (!from || !to) return c.json({ error: "invalid path" }, 400);

  // 되돌리기가 없으므로 여기서 막는다 — 자기 하위로 옮긴 폴더는 트리에서 사라진다.
  const check = canMoveFolder(from, to);
  if (!check.ok) return c.json({ error: check.reason }, 400);
  if (!(await assetFolderExists(to))) return c.json({ error: "옮길 위치가 없습니다." }, 404);

  await moveAssetFolder(from, to);
  return c.json({ ok: true });
});

app.delete("/api/assets/folders", async (c) => {
  const folder = normalizeFolderPath(c.req.query("path"));
  if (!folder || folder === ASSET_ROOT) return c.json({ error: "invalid path" }, 400);

  // 무엇이 함께 지워지는지 세어서 돌려준다 — 확인 문구가 숫자를 말할 수 있어야 한다.
  const tree = await listAssetSubtree(folder);
  if (c.req.query("dryRun") === "true") {
    return c.json({ folders: tree.folders.length, files: tree.files.length });
  }
  const removed = await deleteAssetFiles(tree.files.map((f) => f.id));
  for (const f of removed) {
    await deleteFile(f.storagePath).catch((e) => console.warn("[assets] 파일 삭제 실패(무시):", e));
  }
  await deleteAssetFolderTree(folder);
  return c.json({ ok: true, folders: tree.folders.length, files: removed.length });
});

app.post("/api/assets/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (typeof file === "string" || typeof file === "boolean" || !(file as any)?.arrayBuffer) {
    return c.json({ error: "file field required" }, 400);
  }
  const folder = normalizeFolderPath(body["folder"] ?? ASSET_ROOT);
  if (!folder) return c.json({ error: "invalid folder path" }, 400);
  if (!(await assetFolderExists(folder))) return c.json({ error: "폴더가 없습니다." }, 404);

  const f = file as File;
  const check = validateName(f.name);
  if (!check.ok) return c.json({ error: check.reason }, 400);

  const id = newId("as");
  const ext = path.extname(f.name) || "";
  const objectPath = `assets/${id}${ext}`;
  const buffer = Buffer.from(await f.arrayBuffer());
  const storedPath = await writeFile(objectPath, buffer);

  try {
    await insertAssetFile({
      id, folder, name: f.name.trim(),
      kind: kindOf(f.type || f.name),
      mime: f.type || "application/octet-stream",
      size: buffer.length,
      storagePath: storedPath,
    });
  } catch (err) {
    // 행이 안 들어갔으면 올라간 바이트도 지운다 — 아무도 못 보는 파일이 요금만 먹는다.
    await deleteFile(storedPath).catch(() => {});
    if (isUniqueViolation(err)) return c.json({ error: "같은 이름의 파일이 이미 있습니다." }, 409);
    throw err;
  }
  return c.json({ file: await getAssetFile(id) });
});

app.get("/api/assets/:id/raw", async (c) => {
  const row = await getAssetFile(c.req.param("id"));
  if (!row) return c.json({ error: "asset not found" }, 404);
  const objectPath = parseObjectPath(row.storagePath);
  if (!(await fileExists(objectPath))) return c.json({ error: "파일이 스토리지에 없습니다." }, 404);
  const buf = await readFile(objectPath);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": row.mime || "application/octet-stream", "Cache-Control": "private, max-age=300" },
  });
});

app.post("/api/assets/move", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
  const ids = rawIds.filter((x): x is string => typeof x === "string");
  const folder = normalizeFolderPath(body.folder);
  if (!folder) return c.json({ error: "invalid folder path" }, 400);
  if (!(await assetFolderExists(folder))) return c.json({ error: "옮길 폴더가 없습니다." }, 404);
  try {
    return c.json({ moved: await moveAssetFiles(ids, folder) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: "옮길 폴더에 같은 이름의 파일이 있습니다." }, 409);
    }
    throw err;
  }
});

app.delete("/api/assets", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
  const ids = rawIds.filter((x): x is string => typeof x === "string");
  const removed = await deleteAssetFiles(ids);
  for (const f of removed) {
    await deleteFile(f.storagePath).catch((e) => console.warn("[assets] 파일 삭제 실패(무시):", e));
  }
  return c.json({ deleted: removed.length });
});

// ── 크레딧 (선불 · 일반결제) ────────────────────────────────────────────────────
//
// 크레딧 1개 = 분석 1분. 결제는 포트원 결제창(일반결제)으로 하고, **확정은 웹훅으로만** 한다 —
// 브라우저가 "성공했다"고 말하는 것만 믿고 크레딧을 올리면 조작 한 번에 공짜가 된다.

app.get("/api/credits", async (c) => {
  const [balance, ledger] = await Promise.all([creditBalance(), listCreditLedger(50)]);
  return c.json({
    balance,
    unit: CREDIT_UNIT_LABEL,
    priceKrw: creditPriceKrw(),
    ledger,
  });
});

/**
 * 충전 주문 생성. **결제창을 띄우기 전에** 우리가 먼저 만든다 —
 * paymentId 를 우리가 정해야 멱등이 성립하고, 결제 결과를 대조할 기준이 생긴다.
 *
 * 금액은 서버가 계산한다. 클라이언트가 보낸 금액을 쓰면 1원에 10만 크레딧을 산다.
 */
app.post("/api/credits/topup", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const check = buildTopup(body.credits);
  if (!check.ok) return c.json({ error: "bad_request", message: check.reason }, 400);

  // 설정이 빠졌으면 **여기서** 막는다. 예전엔 그냥 통과시켜서 `storeId: ""` 가 브라우저
  // SDK 로 나갔고, 사용자는 결제창에서 원인 모를 실패만 봤다. 뭐가 없는지 이름을 말해준다.
  const pg = portoneConfigured();
  if (!pg.ok) {
    return c.json(
      { error: "billing_unconfigured", message: `결제 설정이 없습니다: ${pg.missing.join(", ")}` },
      503,
    );
  }

  const paymentId = topupPaymentId(currentTenantId(), crypto.randomUUID().replace(/-/g, "").slice(0, 12));
  const actor = readActor(body.actor) || "unknown";
  await createTopup({
    paymentId, credits: check.credits, amountKrw: check.amountKrw,
    status: "pending", requestedBy: actor,
  });

  // 브라우저 SDK 에 그대로 넘길 값들. storeId·channelKey 는 공개해도 되는 식별자다
  // (결제 실행 권한은 API Secret 에 있고 그건 서버에만 있다).
  return c.json({
    paymentId,
    credits: check.credits,
    amountKrw: check.amountKrw,
    storeId: String(process.env.PORTONE_STORE_ID ?? ""),
    channelKey: String(process.env.PORTONE_CHANNEL_KEY ?? ""),
    orderName: `STEP-D 크레딧 ${check.credits}개`,
  });
});

/**
 * 포트원 웹훅 — **크레딧이 실제로 올라가는 유일한 지점.**
 *
 * 순서가 중요하다:
 *   1. 서명 검증 (위조 웹훅으로 크레딧이 올라가면 되돌릴 수 없다)
 *   2. 포트원에 **직접 조회** (웹훅 본문의 금액도 믿지 않는다)
 *   3. 우리 주문과 대조 (금액·상태가 맞아야)
 *   4. 원장 기록 (dedupeKey 로 재전송 방어)
 *
 * 이 라우트는 세션이 없다 — PUBLIC_PATHS 에 들어 있어야 하고, 테넌트는 주문에서 찾는다.
 */
app.post("/api/billing/portone/webhook", async (c) => {
  const raw = await c.req.text();
  const verdict = verifyWebhook(
    raw,
    {
      id: c.req.header("webhook-id") ?? null,
      timestamp: c.req.header("webhook-timestamp") ?? null,
      signature: c.req.header("webhook-signature") ?? null,
    },
    String(process.env.PORTONE_WEBHOOK_SECRET ?? ""),
  );
  if (!verdict.ok) {
    console.warn(`[billing] 웹훅 검증 실패: ${verdict.reason}`);
    // 사유를 본문에 싣지 않는다 — 검증을 뚫으려는 쪽에 힌트를 주지 않는다.
    return c.json({ error: "invalid_signature" }, 401);
  }

  const body = JSON.parse(raw || "{}") as { data?: { paymentId?: string }; type?: string };
  const paymentId = String(body.data?.paymentId ?? "");
  // 어떤 이벤트가 왔는지 남긴다 — 결제 성공/실패/취소를 로그에서 구분할 수 있어야
  // "웹훅은 왔는데 왜 충전이 안 됐나"를 되짚을 수 있다.
  console.log(`[billing] 웹훅 수신 type=${body.type ?? "?"} paymentId=${paymentId || "-"}`);
  if (!paymentId) return c.json({ ok: true, note: "paymentId 없음 — 무시" });

  // 테넌트를 주문에서 찾는다. 웹훅에는 세션이 없으므로 시스템 스코프로 한 번 읽고,
  // 그 뒤 작업은 그 테넌트 컨텍스트 안에서 한다.
  // ⚠️ 예전엔 runAsSystem 안에서 getRawPool() 을 썼는데, rawPool 은 app.tenant_id 를
  // 세우지 않으므로 **시스템 스코프가 무시됐다.** credit_topup 은 RLS 표라 결과가
  // "0행" 이거나 "커넥션에 남아 있던 남의 스코프" 였다 — 결제가 조용히 무시되거나
  // 엉뚱한 회사로 붙을 수 있는 자리였다.
  const owner = await asSystem(async (db) => {
    const { rows } = await db.query(
      `SELECT tenant_id FROM credit_topup WHERE payment_id = $1`, [paymentId],
    );
    return rows[0]?.tenant_id as string | undefined;
  });
  if (!owner) return c.json({ ok: true, note: "우리 주문이 아님 — 무시" });

  return runWithTenant({ scope: owner, via: "system" }, async () => {
    const order = await getTopup(paymentId);
    let payment: { status?: string; amountTotal?: number } | null = null;
    try {
      const p = (await getPayment(paymentId)) as any;
      payment = { status: p?.status, amountTotal: p?.amount?.total };
    } catch (e) {
      // 조회가 실패하면 크레딧을 올리지 않는다. 포트원이 웹훅을 재전송하므로
      // 일시적 오류면 다음 번에 성공한다 — 여기서 성공으로 치는 게 최악이다.
      console.error(`[billing] 결제 조회 실패 ${paymentId}`, e);
    }

      // 취소·실패 이벤트는 **기록만** 한다. 환불 정책상 크레딧을 자동으로 빼지 않지만,
    // 포트원엔 "취소됨"인데 우리 원장엔 흔적이 없으면 나중에 정산이 안 맞을 때
    // 원인을 못 찾는다. 잔액을 건드리지 않으므로 delta 0 으로 남긴다.
    if (/Cancelled|Canceled|Failed/i.test(String(body.type ?? ""))) {
      await addCreditEntry({
        delta: 0,
        reason: "adjust",
        paymentId,
        note: `PG 이벤트 ${body.type} — 정책상 크레딧은 회수하지 않음`,
        actor: "portone-webhook",
        dedupeKey: `pgevent:${paymentId}:${body.type}`,
      }).catch((e) => console.error("[billing] 취소 기록 실패", e));
      console.warn(`[billing] ${body.type} 수신 ${paymentId} — 기록만 함(크레딧 유지)`);
      return c.json({ ok: true, credited: false, reason: "취소/실패 이벤트 — 기록만" });
    }

    const settle = settleTopup({ order, payment });
    if (!settle.credit) {
      console.warn(`[billing] 충전 보류 ${paymentId}: ${settle.reason}`);
      // 실패로 확정하지 않는다 — 조회 실패였을 수 있고, 포트원이 재전송한다.
      return c.json({ ok: true, credited: false, reason: settle.reason });
    }

    const claimed = await markTopupPaid(paymentId, "paid");
    if (!claimed) return c.json({ ok: true, credited: false, reason: "이미 처리됨" });

    await addCreditEntry({
      delta: settle.credits,
      reason: "topup",
      paymentId,
      amountKrw: order?.amountKrw ?? null,
      note: `포트원 결제 ${paymentId}`,
      actor: "portone-webhook",
      dedupeKey: topupDedupeKey(paymentId),
    });
    console.log(`[billing] 충전 완료 ${paymentId} · +${settle.credits} 크레딧`);
    return c.json({ ok: true, credited: true, credits: settle.credits });
  });
});

// ── 채널별 업로드 규칙 (FLOWS F4-2 · README §10) ────────────────────────────────

app.get("/api/channel-rules", async (c) => {
  return c.json({ rules: await listChannelRules(), roles: CHANNEL_ROLES });
});

/** 규칙 저장 — 없으면 역할 기본값에서 시작한다. */
app.put("/api/channel-rules/:platform/:accountId", async (c) => {
  const platform = c.req.param("platform");
  const accountId = c.req.param("accountId");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  const role = isChannelRole(body.role) ? body.role : "main";
  const base = defaultRuleFor(role, platform);
  const existing = await getChannelRule(platform, accountId);

  const num = (v: unknown, fallback: number | null): number | null => {
    if (v === null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };
  const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v.trim() : fallback);

  const row: ChannelRuleRow = {
    platform,
    accountId,
    label: str(body.label, existing?.label ?? accountId),
    role,
    maxSec: "maxSec" in body ? num(body.maxSec, existing?.maxSec ?? base.maxSec) : (existing?.maxSec ?? base.maxSec),
    aspect: ["9:16", "16:9", "any"].includes(String(body.aspect)) ? String(body.aspect) : (existing?.aspect ?? base.aspect),
    titlePrefix: str(body.titlePrefix, existing?.titlePrefix ?? base.titlePrefix),
    hashtagTemplate: str(body.hashtagTemplate, existing?.hashtagTemplate ?? base.hashtagTemplate),
    tonePreset: str(body.tonePreset, existing?.tonePreset ?? base.tonePreset),
    privacy: ["public", "unlisted", "private"].includes(String(body.privacy))
      ? String(body.privacy)
      : (existing?.privacy ?? base.privacy),
    scheduleWindow: str(body.scheduleWindow, existing?.scheduleWindow ?? base.scheduleWindow),
    enabled: typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? true),
  };
  await upsertChannelRule(row);
  return c.json({ rule: row });
});

app.delete("/api/channel-rules/:platform/:accountId", async (c) => {
  const ok = await deleteChannelRule(c.req.param("platform"), c.req.param("accountId"));
  return c.json({ ok });
});

/**
 * 배포 모달용 — 이 미디어들을 각 채널에 보낼 수 있는지 (F4-2).
 *
 * 판정을 서버가 하는 이유: 화면이 자기 나름대로 계산하면 규칙이 두 벌이 되고,
 * 한쪽만 고치는 순간 "고를 수 있는데 실패하는" 채널이 생긴다.
 */
app.post("/api/channel-rules/eligibility", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const rawIds: unknown[] = Array.isArray(body.clipIds) ? body.clipIds : [];
  const clipIds = rawIds.filter((x): x is string => typeof x === "string");

  const rules = await listChannelRules();
  const medias: { id: string; durationSec: number; aspectRatio?: string | null; rendered?: boolean }[] = [];
  for (const id of clipIds) {
    const clip = await getEntity<any>("clip", id);
    if (!clip) continue;
    medias.push({
      id, durationSec: Number(clip.durationSec ?? 0),
      aspectRatio: clip.aspectRatio, rendered: clip.rendered !== false,
    });
  }

  const out: Record<string, { ok: boolean; reason: string; code: string; blockedClipIds: string[] }> = {};
  for (const r of rules) {
    const rule = r as unknown as ChannelRule;
    const blocked = medias.map((m) => ({ m, why: eligibility(rule, m) })).filter((x) => !x.why.ok);
    const key = `${r.platform}:${r.accountId}`;
    out[key] = blocked.length === 0
      ? { ok: true, reason: "", code: "", blockedClipIds: [] }
      : {
          ok: false,
          // 여러 건이 막히면 첫 사유를 대표로 쓰고 건수를 붙인다.
          reason: blocked.length === 1 ? blocked[0].why.reason : `${blocked[0].why.reason} (외 ${blocked.length - 1}건)`,
          code: blocked[0].why.code,
          blockedClipIds: blocked.map((b) => b.m.id),
        };
  }
  return c.json({ rules, eligibility: out });
});

app.get("/api/gate/:subjectType/:subjectId", async (c) => {
  const subjectType = readSubjectType(c.req.param("subjectType"));
  if (!subjectType) return c.json({ error: "invalid subjectType" }, 400);
  const subjectId = c.req.param("subjectId");
  const [gate, issues, judged] = await Promise.all([
    gateFor(subjectType, subjectId),
    listRightsIssues(subjectType, subjectId),
    isJudged(subjectType, subjectId),
  ]);
  return c.json({ gate, issues, judged });
});

/**
 * 여러 대상의 게이트를 한 번에 (미디어 목록용).
 *
 * 목록에서 대상마다 /api/gate 를 부르면 N+1 이 된다 — 100건짜리 목록이 100번 왕복하고,
 * 그러면 화면은 "느려서" 게이트 표시를 생략하고 싶어진다. 생략된 게이트가 곧 사고다.
 */
app.post("/api/gate/batch", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const subjectType = readSubjectType(body.subjectType);
  const rawIds: unknown[] = Array.isArray(body.subjectIds) ? body.subjectIds : [];
  const ids = rawIds.filter((x): x is string => typeof x === "string");
  if (!subjectType) return c.json({ error: "invalid subjectType" }, 400);
  if (ids.length === 0) return c.json({ gates: {}, issues: {} });
  if (ids.length > 500) return c.json({ error: "too many ids (max 500)" }, 400);

  const [issueMap, judged] = await Promise.all([
    listRightsIssuesFor(subjectType, ids),
    judgedSet(subjectType, ids),
  ]);

  const gates: Record<string, GateResult> = {};
  const issues: Record<string, unknown[]> = {};
  for (const id of ids) {
    const rows = issueMap.get(id) ?? [];
    gates[id] = evaluateGate({ judged: judged.has(id), issues: rows.map(toIssue) });
    issues[id] = rows;
  }
  return c.json({ gates, issues });
});

app.get("/api/rights-issues", async (c) => {
  const subjectType = readSubjectType(c.req.query("subjectType"));
  const subjectId = c.req.query("subjectId") ?? "";
  if (!subjectType || !subjectId) return c.json({ error: "subjectType and subjectId required" }, 400);
  return c.json({ issues: await listRightsIssues(subjectType, subjectId) });
});

app.post("/api/rights-issues", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const subjectType = readSubjectType(body.subjectType);
  const subjectId = typeof body.subjectId === "string" ? body.subjectId.trim() : "";
  const actor = readActor(body.actor);
  if (!subjectType || !subjectId) return c.json({ error: "subjectType and subjectId required" }, 400);
  // 등록자가 없는 이슈는 만들지 않는다 — 자동 판정과 구분이 안 된다.
  if (!actor) return c.json({ error: "actor required — 이슈는 사람이 등록합니다" }, 400);
  if (!isIssueKind(body.kind)) {
    return c.json({ error: "invalid kind", allowed: ISSUE_KINDS }, 400);
  }
  const resolution = isResolution(body.resolution) ? body.resolution : "open";
  if (resolution === "resolved") {
    // 처음부터 해제 상태로 만드는 건 "등록 없이 통과"와 같다.
    return c.json({ error: "새 이슈를 resolved 로 만들 수 없습니다" }, 400);
  }

  const bandStart = typeof body.bandStart === "number" ? body.bandStart : null;
  const bandEnd = typeof body.bandEnd === "number" ? body.bandEnd : null;
  if ((bandStart === null) !== (bandEnd === null)) {
    return c.json({ error: "bandStart 와 bandEnd 는 함께 있어야 합니다" }, 400);
  }
  if (bandStart !== null && bandEnd !== null && bandEnd <= bandStart) {
    return c.json({ error: "bandEnd 는 bandStart 보다 커야 합니다" }, 400);
  }

  const id = newId("ri");
  await insertRightsIssue({
    id, subjectType, subjectId,
    kind: body.kind, resolution, bandStart, bandEnd,
    note: typeof body.note === "string" ? body.note.trim() : "",
    actor,
  });
  await appendGateAudit({
    subjectType, subjectId, action: "issue.create",
    toState: resolution, actor,
    basis: typeof body.note === "string" ? body.note.trim() : "",
    issueId: id,
  });
  return c.json({ issue: await getRightsIssue(id), gate: await gateFor(subjectType, subjectId) });
});

app.patch("/api/rights-issues/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getRightsIssue(id);
  if (!existing) return c.json({ error: "issue not found" }, 404);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const actor = readActor(body.actor);
  if (!actor) return c.json({ error: "actor required — 해제도 사람이 합니다" }, 400);
  if (!isResolution(body.resolution)) return c.json({ error: "invalid resolution" }, 400);

  const resolutionNote = typeof body.resolutionNote === "string" ? body.resolutionNote : "";
  if (body.resolution === "resolved") {
    // "블러 처리 완료" 같은 조치 확인이 있어야 통과로 바뀐다 (FLOWS.md:61).
    const check = canResolve(toIssue(existing), resolutionNote);
    if (!check.ok) return c.json({ error: check.reason }, 400);
  }

  const prev = await updateRightsIssueResolution(id, {
    resolution: body.resolution,
    actor,
    resolutionNote: resolutionNote.trim(),
  });
  await appendGateAudit({
    subjectType: existing.subjectType, subjectId: existing.subjectId,
    action: body.resolution === "resolved" ? "issue.resolve" : "issue.reopen",
    fromState: prev, toState: body.resolution, actor,
    basis: resolutionNote.trim(), issueId: id,
  });
  return c.json({
    issue: await getRightsIssue(id),
    gate: await gateFor(existing.subjectType, existing.subjectId),
  });
});

app.delete("/api/rights-issues/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getRightsIssue(id);
  if (!existing) return c.json({ error: "issue not found" }, 404);
  const actor = readActor(c.req.query("actor"));
  if (!actor) return c.json({ error: "actor required" }, 400);

  // 삭제 기록을 먼저 남긴다 — 지운 뒤 기록에 실패하면 흔적 없이 사라진다.
  await appendGateAudit({
    subjectType: existing.subjectType, subjectId: existing.subjectId,
    action: "issue.delete", fromState: existing.resolution, actor,
    basis: `${existing.kind} · ${existing.note}`, issueId: id,
  });
  await deleteRightsIssue(id);
  return c.json({ ok: true, gate: await gateFor(existing.subjectType, existing.subjectId) });
});

/** "이슈 없음" 판정 — 이것도 사람의 판단이다(F2 Invariant). */
app.post("/api/rights-judgement", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const subjectType = readSubjectType(body.subjectType);
  const subjectId = typeof body.subjectId === "string" ? body.subjectId.trim() : "";
  const actor = readActor(body.actor);
  if (!subjectType || !subjectId) return c.json({ error: "subjectType and subjectId required" }, 400);
  if (!actor) return c.json({ error: "actor required" }, 400);

  const note = typeof body.note === "string" ? body.note.trim() : "";
  await putRightsJudgement(subjectType, subjectId, actor, note);
  await appendGateAudit({
    subjectType, subjectId, action: "judge", toState: "judged", actor, basis: note,
  });
  return c.json({ gate: await gateFor(subjectType, subjectId) });
});

/**
 * 순방을 지금 한 번 돈다 — 규칙을 만들고 결과를 바로 보고 싶을 때.
 *
 * **현재 워크스페이스 것만** 평가한다. 요청 컨텍스트가 이미 이 테넌트로 세워져 있고,
 * 순방은 RLS 안에서 돌기 때문에 남의 채널·프로그램이 보이지 않는다.
 */
app.post("/api/automation/run", async (c) => {
  return c.json(await runAutomationCycle());
});

app.get("/api/gate-audit/:subjectType/:subjectId", async (c) => {
  const subjectType = readSubjectType(c.req.param("subjectType"));
  if (!subjectType) return c.json({ error: "invalid subjectType" }, 400);
  return c.json({ events: await listGateAudit(subjectType, c.req.param("subjectId")) });
});

// ── select generated thumbnail ─────────────────────────────────────────────────
// Exactly one variant is marked chosen so later adoption has a stable, persisted decision.
app.patch("/api/recommendations/:id/thumbnail", async (c) => {
  const recId = c.req.param("id");
  const rec = await getEntity<any>("recommendation", recId);
  if (!rec) return c.json({ error: "recommendation not found" }, 404);
  const body = await c.req.json<{ variantId?: unknown }>().catch(() => null);
  const variantId = typeof body?.variantId === "string" ? body.variantId.trim() : "";
  if (!variantId) return c.json({ error: "variantId is required" }, 400);
  const thumbnails = Array.isArray(rec.thumbnails) ? rec.thumbnails : [];
  if (!thumbnails.some((thumbnail: any) => thumbnail?.id === variantId)) {
    return c.json({ error: "thumbnail variant not found" }, 404);
  }
  const updated = {
    ...rec,
    selectedThumbnailId: variantId,
    thumbnails: thumbnails.map((thumbnail: any) => ({ ...thumbnail, chosen: thumbnail.id === variantId })),
  };
  await putEntity("recommendation", recId, updated);
  return c.json({ recommendation: updated });
});

// ── adopt recommendation → clip (METADATA ONLY — no render, plan §2.4) ─────────
//
// Adopt confirms the segment + decision; it does NOT encode. The expensive 9:16 +
// subtitle bake happens exactly once, later, at /clips/:id/export. Until then the
// editor previews the segment by streaming the master windowed to [startTime,endTime]
// (editor-shell falls back to sourceMediaId / master when clip.mediaId is absent).
app.post("/api/recommendations/:id/adopt", async (c) => {
  const recId = c.req.param("id");
  const rec = await getEntity<any>("recommendation", recId);
  if (!rec) return c.json({ error: "recommendation not found" }, 404);
  if (rec.status !== "pending") return c.json({ clipId: rec.adoptedClipId });

  const episode = await getEntity<any>("episode", rec.episodeId);
  const allMedia = await listMedia();
  const master = allMedia.find((m) => m.episodeId === rec.episodeId && m.role === "master");
  const chosenVariant = Array.isArray(rec.thumbnails)
    ? rec.thumbnails.find((thumbnail: any) => thumbnail.id === rec.selectedThumbnailId)
      ?? rec.thumbnails.find((thumbnail: any) => thumbnail.chosen)
      ?? rec.thumbnails[0]
    : undefined;
  const chosenCandidate = rec.thumbnailCandidates?.find((thumbnail: any) => thumbnail.id === rec.selectedThumbnailId)
    ?? rec.thumbnailCandidates?.[0];
  const chosenThumbnailUrl = chosenVariant?.urls?.["16:9"]
    ?? chosenVariant?.urls?.["9:16"]
    ?? rec.thumbnailUrl;

  const clipId = newId("c");
  const clip: any = {
    id: clipId,
    episodeId: rec.episodeId,
    programTitle: episode?.programTitle ?? "",
    title: rec.title,
    // 두 줄 제목 (2026-07-29): recommend 가 뽑은 AI setup/payoff 를 editor 초기 오버레이로 전달.
    titleLine1: rec.titleLine1,
    titleLine2: rec.titleLine2,
    // 첫 3초 hook intro (2026-08-02 · docs/plans/shorts-hook-intro-3sec.md). 에디터의 "첫 3초 훅"
    // 토글(editorState.hookOn)이 켜지면 /export 가 hookTimeSec 지점을 프리롤로 붙인다. 없으면 미동작.
    hookQuote: rec.hookQuote,
    hookTimeSec: rec.hookTimeSec,
    hookIntroCaption: rec.hookIntroCaption,
    clipType: rec.kind === "short" ? "T6" : "TZ",
    targetAge: episode?.targetAge ?? 0,
    aspectRatio: rec.kind === "short" ? "9:16-crop-main" : "16:9",
    durationSec: Math.max(1, rec.endTime - rec.startTime),
    thumbnailLabel: chosenVariant?.caption_text ?? chosenCandidate?.label,
    thumbnailUrl: chosenThumbnailUrl,
    synopsis: rec.editNote ?? undefined,
    // Decision-only state: not yet rendered. Segment + source drive render-free preview
    // and the later single render.
    status: "editing",
    rendered: false,
    startTime: rec.startTime,
    endTime: rec.endTime,
    sourceMediaId: master?.id,
    sourceRecommendationId: rec.id,
    // The AI's suggested destination (F3) — metadata only, still no render (§2.4). It seeds
    // the export selector's default; the operator's pick at export overrides it.
    targetChannel: pickTargetChannel(rec.channelScores),
    distributions: [],
  };

  // Atomic: clip insert + rec flip commit together, so a crash can't orphan a clip and
  // let a retry mint a second one. commitAdoption's own pending-guard closes the race the
  // route-level check above can't (two concurrent adopts both reading 'pending').
  // 채택 커밋 + 이슈 승계는 adopt.ts 하나로 모았다 — 경로가 둘이면 한쪽만 고치게 된다.
  const committed = await commitAndInherit(clipId, clip, recId, rec);
  if (!committed) {
    const latest = await getEntity<any>("recommendation", recId);
    return c.json({ clipId: latest?.adoptedClipId });
  }
  return c.json({ clipId, clip, gate: await gateFor("clip", clipId) });
});

// ── reject recommendation ─────────────────────────────────────────────────────
app.post("/api/recommendations/:id/reject", async (c) => {
  const recId = c.req.param("id");
  const rec = await getEntity<any>("recommendation", recId);
  if (!rec) return c.json({ error: "recommendation not found" }, 404);
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "기타" }));
  // Guarded single write: rejecting an already-adopted rec (race with adopt) would strand
  // the minted clip on the board while the rec claims 'rejected'.
  const flipped = await markRecommendationRejected(recId, reason ?? "기타");
  if (!flipped) {
    const latest = await getEntity<any>("recommendation", recId);
    return c.json({ error: "already decided", status: latest?.status ?? "unknown" }, 409);
  }
  return c.json({ ok: true });
});

// ── publish clips to one channel ──────────────────────────────────────────────
//
// A clip is renderable-shipped once it has the single export render (mediaId) or is already
// live (plan §2.4: distribution consumes the final render, never a draft). Un-rendered adopts
// are skipped and reported so the caller can prompt export.
// isClipRendered · upsertDistribution 은 publish-guard.ts 로 이동했다 —
// 배포 판정이 index.ts·worker.ts·factory.ts 로 갈려 있으면 게이트가 새어 나간다.

/** The upload grant is the plain youtube scope; readonly (analytics) can't upload. */
// 스코프 판정은 youtube.ts 한 곳에서 — 문자열을 두 벌 두면 어긋난다(2026-08-10 사고).
const YT_UPLOAD_SCOPE = YT_PUBLISH_SCOPE;

/**
 * Resolve the connected channel we upload to. A channel can publish only if its consent
 * included the upload scope (channels connected in analytics mode cannot). `explicitId`
 * picks a specific channel; otherwise, when exactly one channel is publish-capable we use
 * it. Returns null when none qualify (caller tells the operator to connect one in publish
 * mode) or when the id is ambiguous/unknown.
 */
async function resolveYouTubePublishChannel(explicitId?: string): Promise<YouTubeChannel | null> {
  const channels = await listYouTubeChannels();
  const canPublish = (ch: YouTubeChannel) =>
    ch.status !== "revoked" && Boolean(ch.refreshToken) &&
    (ch.scope ?? "").split(" ").includes(YT_UPLOAD_SCOPE);
  if (explicitId) {
    const ch = channels.find((c) => c.channelId === explicitId);
    return ch && canPublish(ch) ? ch : null;
  }
  const eligible = channels.filter(canPublish);
  // Exactly one publish channel is the common case (single operator channel). With several,
  // require an explicit id rather than guessing which one the operator meant.
  return eligible.length === 1 ? eligible[0] : null;
}

app.post("/api/distributions/publish", async (c) => {
  const b = await c.req.json<{
    clipIds: string[];
    channel: string;
    reserveDate?: string;
    scheduled?: boolean;
    platforms?: string[];
    /** YouTube: which connected channel to upload to (defaults to the sole publish channel). */
    youtubeChannelId?: string;
    /** YouTube visibility for an immediate publish. Defaults to "public" (the publish intent). */
    privacy?: "public" | "unlisted" | "private";
  }>().catch(() => null);

  // Reject malformed input up front — a bad/empty body must be a 400, not a 500.
  if (!b || !Array.isArray(b.clipIds) || !b.channel) {
    return c.json({ error: "bad_request", message: "clipIds(배열)와 channel이 필요합니다." }, 400);
  }

  // ── 관문 하나 (FLOWS F3 강제①) ─────────────────────────────────────────
  // 게이트·렌더 판정, 상태 기록, 큐 투입이 전부 publish-dispatch 안에서 일어난다.
  // 여기서 직접 enqueue 하지 않는다 — 그러면 경로가 둘이 되고, 나중에 하나만 고치게 된다.
  if (b.channel === "youtube") {
    // 실업로드 킬스위치 (게이트와 별개 축). 부작용 전에 거부해서, 나가지 않을 업로드 때문에
    // 클립이 'pending' 으로 남는 일이 없게 한다.
    if (!youtubeUploadEnabled()) {
      console.warn(`[publish] blocked: YouTube 실업로드 비활성 (clips=${b.clipIds?.length ?? 0})`);
      return c.json({ error: UPLOAD_DISABLED_CODE, message: UPLOAD_DISABLED_MESSAGE }, 409);
    }
    const target = await resolveYouTubePublishChannel(b.youtubeChannelId);
    if (!target) {
      return c.json({
        error: "no_publish_channel",
        message: "업로드 권한(게시 모드)으로 연결된 YouTube 채널이 없거나, 여러 채널 중 대상을 지정해야 합니다.",
      }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: b.clipIds, channel: "youtube",
      scheduled: b.scheduled, reserveDate: b.reserveDate, privacy: b.privacy,
      youtubeChannelId: target.channelId,
      actor: readActor(c.req.header("x-actor")) || "unknown",
      origin: "manual",
    });
    return c.json({ ok: true, ...outcome });
  }

  const outcome = await dispatchPublish({
    clipIds: b.clipIds, channel: b.channel,
    scheduled: b.scheduled, reserveDate: b.reserveDate, platforms: b.platforms,
    actor: readActor(c.req.header("x-actor")) || "unknown",
    origin: "manual",
  });
  return c.json({ ok: true, ...outcome });
});

// ── retry a failed distribution ───────────────────────────────────────────────
app.post("/api/distributions/retry", async (c) => {
  const b = await c.req.json<{ clipId: string; channel: string }>().catch(() => null);
  if (!b || !b.clipId || !b.channel) {
    return c.json({ error: "bad_request", message: "clipId와 channel이 필요합니다." }, 400);
  }
  const clip = await getEntity<any>("clip", b.clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  // 재시도도 같은 관문을 지난다 — 안 그러면 /retry 가 게이트를 우회하는 뒷문이 된다.
  // **자동 재시도가 아니다.** 사람이 로그 행의 버튼을 눌러야 여기 온다(F4-4 ⊘).
  if (b.channel === "youtube") {
    if (!youtubeUploadEnabled()) {
      console.warn(`[publish/retry] blocked: YouTube 실업로드 비활성 (clip=${b.clipId})`);
      return c.json({ error: UPLOAD_DISABLED_CODE, message: UPLOAD_DISABLED_MESSAGE }, 409);
    }
    const prev = (clip.distributions ?? []).find((d: any) => d.channel === "youtube");
    const target = await resolveYouTubePublishChannel(prev?.youtubeChannelId);
    if (!target) {
      return c.json({ error: "no_publish_channel", message: "재시도할 YouTube 채널을 찾을 수 없습니다." }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: [b.clipId], channel: "youtube",
      reserveDate: prev?.reserveDate,
      youtubeChannelId: target.channelId,
      actor: readActor(c.req.header("x-actor")) || "unknown",
      origin: "retry",
    });
    return c.json({ ok: true, ...outcome });
  }

  const outcome = await dispatchPublish({
    clipIds: [b.clipId], channel: b.channel,
    actor: readActor(c.req.header("x-actor")) || "unknown",
    origin: "retry",
  });
  return c.json({ ok: true, ...outcome });
});

// ── link a clip to the YouTube video it was published as ──────────────────────
//
// The minimal join between our clip metadata and the per-video YouTube metrics
// (video_analytics / video_retention / video_comments). Manual for now — pass the
// published videoId; pass null/"" to unlink. We don't require the video to be synced
// yet, so `videoKnown` tells the caller whether metrics already exist for it.
app.patch("/api/clips/:id/link-video", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const body = await c.req.json<{ videoId?: string | null }>().catch(() => ({ videoId: undefined }));
  if (!("videoId" in body)) return c.json({ error: "videoId is required" }, 400);

  const videoId = body.videoId ? String(body.videoId).trim() : null;
  const videoKnown = videoId ? Boolean(await getChannelVideoByVideoId(videoId)) : false;

  await putEntity("clip", clipId, { ...clip, publishedVideoId: videoId });
  return c.json({ ok: true, clipId, publishedVideoId: videoId, videoKnown });
});

// ── persist the editor's decision blob (revision JSON) ────────────────────────
//
// Save = metadata only, never a render (plan §2.4 deferred-render invariant). We store
// the whole EditorState on the clip entity; the actual 9:16 + subtitle bake happens
// once, later, at final export. Reopening the editor restores from this.
app.patch("/api/clips/:id/editor", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const body = await c.req.json<{ editorState?: unknown }>().catch(() => ({ editorState: undefined }));
  if (typeof body.editorState !== "object" || body.editorState === null) {
    return c.json({ error: "editorState is required" }, 400);
  }

  const es = body.editorState as {
    trimIn?: unknown; trimOut?: unknown; trimBase?: unknown;
  };
  // Master-absolute trim(에디터 새 모델): editorState.trimIn/trimOut이 이미 마스터 절대 초.
  // 세그먼트(=clip.startTime/endTime)를 트림에 맞춰 이동시켜 두면, 아래 /export의 세그먼트
  // 상대 계산이 자연스럽게 trimIn=0, trimOut=segLen인 상태로 굽는다 — 렌더 로직 손 안 대고 통합.
  const patch: Record<string, unknown> = { ...clip, editorState: body.editorState };
  if (
    es.trimBase === "master" &&
    typeof es.trimIn === "number" && Number.isFinite(es.trimIn) &&
    typeof es.trimOut === "number" && Number.isFinite(es.trimOut) &&
    (es.trimOut as number) > (es.trimIn as number)
  ) {
    patch.startTime = Math.max(0, es.trimIn as number);
    patch.endTime = es.trimOut as number;
    patch.durationSec = Number(((es.trimOut as number) - (es.trimIn as number)).toFixed(3));
    // 새 세그먼트 좌표로 옮겼으니 다음 로드 때 다시 shift되지 않도록 trim은 0..segLen로 정규화.
    (body.editorState as { trimIn: number; trimOut: number; trimBase: string }).trimIn = 0;
    (body.editorState as { trimOut: number }).trimOut = Number(((es.trimOut as number) - (es.trimIn as number)).toFixed(3));
    (body.editorState as { trimBase: string }).trimBase = "segment";
    // Track[0]도 같이 재정규화 (main track이 trim을 미러링해야 render 일관성 유지)
    const tracks = (body.editorState as { tracks?: Array<Record<string, unknown>> }).tracks;
    if (Array.isArray(tracks) && tracks.length > 0) {
      const segLen = (body.editorState as { trimOut: number }).trimOut;
      tracks[0].trimIn = 0;
      tracks[0].trimOut = segLen;
      tracks[0].startTime = 0;
      tracks[0].duration = segLen;
    }
    patch.editorState = body.editorState;
  }

  // 경계 조정 로그 — AI 가 제안한 [start,end] 를 사람이 어디로 옮겼나. 컷 지점 학습의
  // 지도 신호(core/search_log.py:6)라 실제로 값이 바뀐 저장만 남긴다. 채택 직후 clip 의
  // startTime/endTime 은 추천 원본이므로, 이 클립의 **첫 이벤트 before = AI 제안**이다.
  const beforeStart = Number(clip.startTime ?? NaN);
  const beforeEnd = Number(clip.endTime ?? NaN);
  const afterStart = Number(patch.startTime ?? clip.startTime ?? NaN);
  const afterEnd = Number(patch.endTime ?? clip.endTime ?? NaN);
  const moved =
    Number.isFinite(beforeStart) && Number.isFinite(afterStart) &&
    (Math.abs(afterStart - beforeStart) > 0.01 || Math.abs(afterEnd - beforeEnd) > 0.01);
  await putEntity("clip", clipId, patch);

  // 저장이 실제로 성공한 뒤에만 남긴다 — 안 일어난 조정을 학습 데이터에 넣으면 안 된다.
  if (moved) {
    void logSearchEvent({
      event: "boundary_adjust",
      source: "editor",
      userId: c.req.header("x-user") ?? "",
      role: c.req.header("x-role") ?? "",
      clipId,
      mediaId: typeof clip.sourceMediaId === "string" ? clip.sourceMediaId : null,
      segmentId: typeof clip.sourceRecommendationId === "string" ? clip.sourceRecommendationId : null,
      before: { start: beforeStart, end: beforeEnd },
      after: { start: afterStart, end: afterEnd },
    });
  }

  return c.json({ ok: true, clipId });
});

// ── 제목 후보 재생성 — 에디터에서 사용자가 추가 지시(예: "더 자극적으로", "이모지 넣지 마")를
//    넣어 요청하면, 그 클립의 자막 창을 기반으로 새 후보 4~5개를 뽑아 돌려준다.
//    저장하지 않는다(에디터 세션 로컬). editorState.uploadMeta 흐름과 별개 — 여기서 나온
//    후보 중 하나를 사용자가 클릭하면 클립 제목이 갈아끼워질 뿐이고, DB에 커밋되지 않는다.
app.post("/api/clips/:id/regenerate-titles", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }));
  const extra = String(body.prompt ?? "").trim().slice(0, 400); // 지나치게 긴 지시는 컷

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));
  if (!(end > start)) return c.json({ error: "clip has no valid segment" }, 400);

  // 소스 미디어의 자막(마스터 절대 초) → 현재 세그먼트 창으로 windowCaptions rebase.
  // 자막이 없으면 제목 근거가 없어 재생성 의미가 없음 → 409.
  const resolved = clip.sourceMediaId
    ? await resolveTranscript(clip.sourceMediaId)
    : { segments: [] as unknown[], updatedAt: 0, source: "none" as const };
  const captions = windowCaptions(resolved.segments, start, end);
  if (captions.length === 0) {
    return c.json({ error: "no captions in clip segment — cannot regenerate titles" }, 409);
  }

  // 자막을 프롬프트에 실을 최대 개수 (지나치게 길면 토큰 낭비, 처음 24개 창은 충분히 대표적).
  const shown = captions.slice(0, 24)
    .map((cp) => `[${cp.start.toFixed(1)}s] ${cp.text.slice(0, 140)}`)
    .join("\n");

  const old = String(clip.title ?? "").trim() || "-";
  // 재제목 프롬프트(core/recommend.py _retitle_final_windows)와 동일 규칙을 짧게 반영 —
  // 어그로 강하게, 자막 근거 필수, 답 없는 물음표 금지, 이모지 최대 1개.
  // 그 위에 사용자의 extra 지시를 '우선순위 규칙'으로 얹는다.
  const systemBase =
    "너는 한국 예능 방송의 자막 카피라이터다. 방송 화면 하단에 뜨는 CG 자막처럼 " +
    "**담백하게 상황을 관찰조로 서술**하되, 다음 장면이 궁금해지는 여운을 남기는 톤으로 " +
    "제목을 짓는다. 아래 자막이 이 클립의 실제 대사다. 실제로 있는 일만 짧게 툭 던져라. " +
    "**5개 후보를 서로 다른 결로 흩어** 뽑아라 (구체 문구 예시는 주지 않으니 결에 맞게 스스로 만들어라).\n\n" +
    "[감성]\n" +
    "- 길이 8~18자. 명사구 하나만으로도 좋다.\n" +
    "- 담백한 관찰조·현재형. 감정 어휘는 최소화, 벌어진 일을 담담히.\n" +
    "- '…' 여운은 강한 훅. 인용은 자막 원문 그대로 인용부호로. 인용 뒤 서술 최소.\n" +
    "- 5개 결(반드시 흩어라): (a) 상황 관찰형 (b) 명사구형 (c) 여운형 (d) 인용형 (e) 자유.\n\n" +
    "[치명적 금지 — 어기면 실격]\n" +
    "- 다음 어휘 금지: 미친, 헐, 실화, 대박, 소름, 레전드, 폭발, 폭탄, 어이없는, 충격, " +
    "초토화, 뒤집어졌다, 뒤집혔다, 해버렸다, 터졌다, 저질렀다, 스튜디오.\n" +
    "- 화살표(→)·물결(~)·이모지·특수문자 금지 (인용부호와 '…'만 허용).\n" +
    "- ㅋㅋㅋ·ㅎㅎ 자모 반복 금지. 감탄사(오·와·헐 등) 문두 금지.\n" +
    "- 대괄호 뉴스 접두어([속보]/[단독]/[충격]) 금지. 두루뭉술 명사(썰/이야기/모먼트/사연) 금지.\n" +
    "- **자막에 없는 사실 금지**. 인물·장소·수치·행동을 만들지 마라. 인용은 자막 원문 그대로.";
  const extraBlock = extra
    ? `\n\n[사용자 추가 요청 — 위 규칙과 충돌하면 사용자 요청을 우선]\n${extra}`
    : "";
  const prompt =
    `${systemBase}${extraBlock}\n\n` +
    `[기존 제목(참고만)]\n${old}\n\n` +
    `[클립 자막]\n${shown}\n\n` +
    'Return ONLY a valid JSON object like {"titles": ["...", "...", "...", "...", "..."]}. ' +
    "정확히 5개.";

  const schema = {
    type: "OBJECT",
    properties: {
      titles: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["titles"],
  };

  try {
    // temperature 1.5 — 예시 문구를 프롬프트에서 뺐으므로 결이 실제로 흩어지려면 창의 상한을
    // 밀어야 함. 자막 근거는 금지 규칙으로 통제해 hallucination은 별개 축.
    const res = await geminiGenerate(prompt, { schema, temperature: 1.5, maxOutputTokens: 1024 });
    const parsed = parseJsonLoose(res.text) as { titles?: unknown };
    const raw = Array.isArray(parsed.titles) ? parsed.titles : [];
    // dedupe + trim + 빈 문자열 제거, 상위 5개까지 유지.
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const t of raw) {
      const v = String(t ?? "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      titles.push(v);
      if (titles.length >= 5) break;
    }
    if (titles.length === 0) {
      // 원인 파악을 위해 raw text와 파싱 결과를 로그 + 에러 응답에 실어 반환.
      console.error("[regenerate-titles] empty result — raw:", res.text?.slice(0, 500));
      return c.json({
        error: "no titles generated",
        rawText: res.text?.slice(0, 500) ?? "",
        parsedShape: typeof parsed === "object" && parsed ? Object.keys(parsed) : [],
      }, 502);
    }
    return c.json({ titles });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[regenerate-titles] failed:", msg);
    return c.json({ error: "generation failed", message: msg.slice(0, 300) }, 502);
  }
});

// ── 업로드 메타데이터 AI 자동 생성 — YouTube 업로드용 title/description/tags를 자막 근거로 생성.
//    저장 X. 프론트 MetadataButton의 '생성' 버튼이 호출 → 결과를 state.uploadMeta에 얹는다. ──
app.post("/api/clips/:id/generate-metadata", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));
  if (!(end > start)) return c.json({ error: "clip has no valid segment" }, 400);

  const resolved = clip.sourceMediaId
    ? await resolveTranscript(clip.sourceMediaId)
    : { segments: [] as unknown[], updatedAt: 0, source: "none" as const };
  const captions = windowCaptions(resolved.segments, start, end);
  if (captions.length === 0) {
    return c.json({ error: "no captions in clip segment — cannot generate metadata" }, 409);
  }

  const shown = captions.slice(0, 40)
    .map((cp) => `[${cp.start.toFixed(1)}s] ${cp.text.slice(0, 180)}`)
    .join("\n");
  const currentTitle = String(clip.title ?? "").trim() || "-";
  const channelHint = typeof clip.programTitle === "string" ? clip.programTitle : "";

  // 제목은 '예능 자막 톤' 원칙 유지 (title-prompt-yeneung-caption-tone 메모리 참고).
  // 설명은 3~5 문장, 자연스럽고 담담하게. 마지막에 해시태그 2~4개.
  // 태그는 YouTube 태그 필드용 5~10개, 인물·상황·프로그램 키워드.
  const prompt =
    "너는 한국 예능 유튜브 채널의 업로드 담당자다. 아래 자막이 이 쇼츠 클립의 실제 대사다. " +
    "이 자막 안에서 벌어진 일만을 근거로 YouTube 업로드용 **title·description·tags**를 만들어라.\n\n" +
    "[title — 예능 자막 톤]\n" +
    "- 8~18자. 담백한 관찰조·현재형, 여운(…) 활용 가능.\n" +
    "- 다음 어휘 금지: 미친/헐/실화/대박/소름/레전드/폭발/폭탄/충격/초토화/뒤집혔다/해버렸다/터졌다/저질렀다/스튜디오.\n" +
    "- 화살표(→)·이모지·특수문자 금지. ㅋㅋ·ㅎㅎ 반복 금지.\n" +
    "- 두루뭉술 명사(썰/이야기/모먼트/사연) 금지.\n\n" +
    "[description — 3~5문장 · 자연스럽게]\n" +
    "- 클립에서 벌어지는 상황을 간결히 소개. 감정어휘 남발 금지, TV 프로그램 소개 톤.\n" +
    "- 등장 인물·상황·핵심 대사는 자막에 있는 것만.\n" +
    "- 마지막 줄에 관련 해시태그 2~4개 (프로그램/인물/장르 키워드).\n\n" +
    "[tags — 5~10개]\n" +
    "- YouTube 태그 필드용. 인물명·프로그램명·장르·상황 키워드. 한 태그당 1~4단어.\n" +
    "- 자막에 등장한 실 인물명은 반드시 포함. 만들어낸 이름 금지.\n\n" +
    "[절대 규칙]\n" +
    "- **자막에 없는 사실 금지**. 인물·장소·수치·행동을 만들지 마라.\n\n" +
    `[기존 제목] ${currentTitle}\n` +
    (channelHint ? `[채널/프로그램] ${channelHint}\n` : "") +
    `\n[자막]\n${shown}\n\n` +
    'Return ONLY a valid JSON object like {"title":"...","description":"...","tags":["...","..."]}.';

  const schema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      description: { type: "STRING" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["title", "description", "tags"],
  };

  try {
    const res = await geminiGenerate(prompt, { schema, temperature: 1.1, maxOutputTokens: 2048 });
    const parsed = parseJsonLoose(res.text) as { title?: unknown; description?: unknown; tags?: unknown };
    const title = String(parsed.title ?? "").trim();
    const description = String(parsed.description ?? "").trim();
    const tagsRaw = Array.isArray(parsed.tags) ? parsed.tags : [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const t of tagsRaw) {
      const v = String(t ?? "").trim().replace(/^#/, "");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      tags.push(v);
      if (tags.length >= 10) break;
    }
    if (!title || !description) {
      console.error("[generate-metadata] empty result — raw:", res.text?.slice(0, 500));
      return c.json({ error: "empty metadata", rawText: res.text?.slice(0, 500) ?? "" }, 502);
    }
    return c.json({ title, description, tags });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-metadata] failed:", msg);
    return c.json({ error: "generation failed", message: msg.slice(0, 300) }, 502);
  }
});

// ── export/render a clip → the single expensive render (plan §2.4) ────────────
//
// The ONLY place ffmpeg bakes the deliverable. Idempotent: a render-revision hash of
// the operator's decisions (segment + aspect + editorState) caches the result, so
// re-confirming identical decisions returns the existing render instead of re-encoding.
// (v1 trims the segment; the 9:16 reframe + ASS subtitle bake — construct F — layers in
//  here later without changing this contract.)
app.post("/api/clips/:id/export", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));
  if (!(end > start)) return c.json({ error: "clip has no valid segment to render" }, 400);

  // F3: the destination this render is for. Body `channel` lets the operator export the same
  // adopted segment once per destination; absent that, the clip's own target.
  const body = await c.req.json<{ channel?: string }>().catch(() => ({} as { channel?: string }));
  const preset = resolveRenderPreset(body.channel, clip);

  // STT transcript for the master (spoken subtitles). Segments are master-timeline seconds;
  // we window them to the render range below. Read from the canonical transcript table
  // (fallback: the analysis blob for pre-table rows). A fingerprint (count + updatedAt) goes
  // into the revision hash so a re-transcribe invalidates the cached render.
  const resolved = clip.sourceMediaId
    ? await resolveTranscript(clip.sourceMediaId)
    : { segments: [] as unknown[], updatedAt: 0, source: "none" as const };
  const transcript = resolved.segments;
  const captionsFp = { n: transcript.length, u: resolved.updatedAt };

  // 첫 3초 hook 프리롤 요청 여부 — 에디터 "첫 3초 훅" 토글(editorState.hookOn) ON + clip 에
  // hookTimeSec 이 있을 때만. 토글/시각이 바뀌면 revision 이 달라져 캐시가 자동 무효화되도록 해시에 포함.
  const hookPrerollReq =
    (clip.editorState as any)?.hookOn === true && typeof clip.hookTimeSec === "number";

  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify({ start, end, aspectRatio: clip.aspectRatio, editorState: clip.editorState ?? null, captionsFp, preset: preset?.key ?? null, hookPreroll: hookPrerollReq ? { t: clip.hookTimeSec } : null }))
    .digest("hex")
    .slice(0, 16);

  // Apply the editor's fine trim within the adopted segment (trimIn/trimOut are relative to
  // the segment). Clamp so the render never escapes [start, end] — the AI-selected window is
  // the outer bound; F just reflects the editor's decisions inside it (§2.4).
  const es = clip.editorState;
  const segLen = end - start;
  const inRel = Math.min(Math.max(0, Number(es?.trimIn ?? 0)), Math.max(0, segLen - 0.1));
  const outRel = Math.min(Math.max(inRel + 0.1, Number(es?.trimOut ?? segLen)), segLen);
  const renderStart = start + inRel;
  let renderEnd = start + outRel;

  // F3 length cap. A destination's maxSec is a hard delivery constraint, not a preference —
  // YouTube rejects a >60s upload as a Short outright. So unlike core/channels.py (which
  // deranks over-length candidates rather than dropping them), the render clamps. It is
  // reported back as `capped` rather than silently truncated: the operator asked for a
  // longer segment and deserves to know the deliverable is shorter than the segment.
  // The delivered length is the segment scaled by playback speed (2× fast halves it), so the
  // maxSec cap must clamp the OUTPUT length, not the raw segment — otherwise a slowed clip
  // could still overrun YouTube's 60s Shorts limit.
  const spd = uniformSpeed(es);
  let capped: { maxSec: number; requestedSec: number } | null = null;
  if (preset && (renderEnd - renderStart) / spd > preset.maxSec) {
    capped = { maxSec: preset.maxSec, requestedSec: Number(((renderEnd - renderStart) / spd).toFixed(2)) };
    renderEnd = renderStart + preset.maxSec * spd; // segment length that yields maxSec output
  }

  // Cache hit: identical decisions already rendered — don't re-encode.
  if (clip.rendered && clip.renderRevision === revision && clip.mediaId) {
    return c.json({ clipId, clip, cached: true, preset: preset?.key ?? null, capped, hookPreroll: hookPrerollReq });
  }

  const allMedia = await listMedia();
  const master =
    (clip.sourceMediaId ? allMedia.find((m) => m.id === clip.sourceMediaId) : undefined) ??
    allMedia.find((m) => m.episodeId === clip.episodeId && m.role === "master");
  if (!master || !FFMPEG) {
    return c.json({ error: "no master video or ffmpeg unavailable to render" }, 409);
  }

  // Aspect precedence: an explicit operator choice in the editor wins (they saw the frame and
  // decided); otherwise the destination preset; otherwise the clip's own adopted ratio. The
  // last step is what keeps a 16:9 highlight that was never opened in the editor out of a
  // 9:16 blur frame.
  const aspect = normalizeAspect(es?.aspect) ?? preset?.aspect ?? normalizeAspect(clip.aspectRatio) ?? "9:16";

  // 컷 boundary를 STT word 경계 → 프레임 그리드로 스냅. 대사 중간 절단 방지 + ffmpeg -ss
  // 요청 시각이 실제 디코드 프레임과 일치해 렌더 결과가 요청 시각과 sub-frame 일치.
  // fps 못 얻으면(probe 실패·오디오만 있는 파일) frame snap은 no-op이라 안전.
  const wordSnapStart = snapToWordBoundary(renderStart, transcript, "start");
  const wordSnapEnd = snapToWordBoundary(renderEnd, transcript, "end");
  let masterFps = 0;
  try {
    const srcForProbe = useGcs() ? await signedReadUrl(parseObjectPath(master.path)) : master.path;
    masterFps = (await probe(srcForProbe)).fps;
  } catch {
    // probe 실패해도 word-snap만으로도 대사 안전은 확보됨 — frame snap만 스킵.
  }
  const snappedStart = snapToFrame(wordSnapStart, masterFps);
  const snappedEnd = snapToFrame(wordSnapEnd, masterFps);
  if (Math.abs(snappedStart - renderStart) > 0.001 || Math.abs(snappedEnd - renderEnd) > 0.001) {
    console.log(`[render] snap ${renderStart.toFixed(3)}→${snappedStart.toFixed(3)}s · ` +
      `${renderEnd.toFixed(3)}→${snappedEnd.toFixed(3)}s @ ${masterFps.toFixed(2)}fps`);
  }

  // Spoken subtitles that fall inside the render window, rebased to 0.
  const captions = windowCaptions(transcript, snappedStart, snappedEnd);

  // 첫 3초 hook 프리롤 구간 계산 — hook 대사 절대 시각(= clip.startTime + hookTimeSec)에서 최대 3초.
  // 세그먼트([snappedStart, snappedEnd]) 안으로 클램프하고, 세그먼트가 3초보다 짧으면 그만큼 줄인다.
  // hookTimeSec 은 clip.startTime(=start) 기준 상대이므로 절대 = start + hookTimeSec.
  let hookPreroll: { startTime: number; durationSec: number; hasAudio?: boolean } | null = null;
  if (hookPrerollReq) {
    const HOOK_MAX = 3.0;
    const hookAbs = start + Math.max(0, Number(clip.hookTimeSec));
    const preStart = Math.min(Math.max(snappedStart, hookAbs), Math.max(snappedStart, snappedEnd - 0.5));
    const preDur = Math.min(HOOK_MAX, Math.max(0.5, snappedEnd - preStart));
    if (preDur >= 0.5) {
      hookPreroll = { startTime: preStart, durationSec: Number(preDur.toFixed(3)), hasAudio: master.hasAudio === 1 };
    }
  }

  const rendered = await renderClipMedia({
    master, episodeId: clip.episodeId,
    startTime: snappedStart, endTime: snappedEnd,
    title: clip.title, editorState: es, aspect, captions,
    hookPreroll,
  });
  if (!rendered) return c.json({ error: "render failed" }, 500);

  // Merge onto the LATEST row, not the pre-render snapshot: the render takes up to minutes,
  // and an editor save (PATCH /:id/editor) landing meanwhile must survive this write. If the
  // editorState did change, `revision` no longer matches it, so the cache check correctly
  // re-renders on the next export.
  const latest = (await getEntity<any>("clip", clipId)) ?? clip;
  const next = {
    ...latest,
    status: "ready",
    rendered: true,
    renderRevision: revision,
    mediaId: rendered.clipMediaId,
    sourceMediaId: master.id,
    videoUrl: `/media/${rendered.clipMediaId}/stream`,
    durationSec: rendered.cmeta.durationSec || latest.durationSec,
    renderPreset: preset?.key ?? null,
  };
  await putEntity("clip", clipId, next);
  return c.json({ clipId, clip: next, preset: preset?.key ?? null, capped, hookPreroll: !!hookPreroll });
});

// ── YouTube OAuth & channel management ────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 4000);

/**
 * Two consent modes, two scope sets.
 *
 * analytics — an external creator connecting their own channel so we can read its
 *   metrics. Read-only on purpose: these refresh tokens sit in our DB, and a leaked
 *   write-scoped token would let an attacker edit or delete a partner's videos.
 * publish — our own channels, which we upload to.
 */
export type ConsentMode = "analytics" | "publish";

const YT_ANALYTICS_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly", // channel + video metadata (Data API)
  "https://www.googleapis.com/auth/yt-analytics.readonly", // watch time, traffic, demographics
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly", // revenue (monetized channels only)
].join(" ");

const YT_PUBLISH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.channel-memberships.creator",
].join(" ");

/** Analytics needs this scope; channels connected before the split won't have it. */
const YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/** Must byte-match a redirect URI registered on the OAuth client in GCP. */
const OAUTH_CALLBACK_PATH = "/api/youtube/oauth/callback";

function redirectUri(): string {
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${OAUTH_CALLBACK_PATH}`;
}

function scopesFor(mode: ConsentMode): string {
  return mode === "publish" ? YT_PUBLISH_SCOPES : YT_ANALYTICS_SCOPES;
}

function googleAuthUrl(state: string, mode: ConsentMode): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopesFor(mode),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>;
}

async function fetchYtChannelInfo(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`YouTube API failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string } }[] };
  if (!data.items?.length) throw new Error("No YouTube channel found for this account");
  const ch = data.items[0];
  return {
    channelId: ch.id,
    channelName: ch.snippet.title,
    thumbnail: ch.snippet.thumbnails?.default?.url ?? null,
    subscribers: ch.statistics?.subscriberCount ?? "0",
  };
}


interface OAuthState {
  channel?: string;
  mode?: ConsentMode;
  /** Where to send the browser after connecting — the page the flow started from. */
  return?: string;
}

function decodeState(raw: string | undefined): OAuthState {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString()) as OAuthState;
  } catch {
    return {};
  }
}

/**
 * Only allow same-site relative paths as a post-OAuth destination, so a crafted
 * `return` can't turn this into an open redirect. Anything else falls back to
 * /register (the external-creator landing page).
 */
function safeReturn(path: string | undefined): string {
  if (path && /^\/[A-Za-z0-9/_-]*$/.test(path) && !path.startsWith("//")) return path;
  return "/register";
}

/**
 * 외부(AENA 등) 로 돌려보낼 복귀 URL. **allowlist 에 있는 오리진만** 허용한다.
 *
 * 리프레시 토큰을 받으려면 채널 주인이 우리 OAuth 화면을 거쳐야 하고, 끝나면 붙이는 쪽
 * 화면으로 돌아가야 한다. 여기를 열어두면 오픈 리다이렉트가 되므로 오리진을 못박는다.
 * FACTORY_RETURN_ORIGINS="https://aena.example,https://x.example"
 */
function safeExternalReturn(url: string | undefined): string | null {
  if (!url) return null;
  const allowed = (process.env.FACTORY_RETURN_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return null;
  try {
    const u = new URL(url);
    return allowed.includes(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}

app.get("/api/youtube/auth", (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
  const channelUrl = c.req.query("channel") ?? "";
  const mode: ConsentMode = c.req.query("mode") === "publish" ? "publish" : "analytics";
  const returnTo = safeReturn(c.req.query("return"));
  const state = Buffer.from(JSON.stringify({ channel: channelUrl, mode, return: returnTo })).toString("base64");
  return c.redirect(googleAuthUrl(state, mode));
});

/**
 * 외부 연동용 채널 연결 URL 발급.
 *
 * 붙이는 쪽이 이 URL 을 채널 주인에게 열어주면, 동의 후 우리가 refresh token 을 저장하고
 * `returnUrl` 로 돌려보낸다. **토큰을 우리가 직접 발급받는 유일한 안전한 경로다** —
 * 남이 만든 refresh token 은 우리 client_id 로 발급된 게 아니면 갱신이 안 된다.
 */
app.post("/api/factory/channels/connect-url", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "oauth_not_configured" }, 500);

  const b = await c.req.json<{ returnUrl?: string; channelUrl?: string }>().catch(() => null);
  const extReturn = safeExternalReturn(b?.returnUrl);
  if (b?.returnUrl && !extReturn) {
    return c.json({
      error: "return_url_not_allowed",
      message: "FACTORY_RETURN_ORIGINS 에 등록된 오리진만 복귀 주소로 쓸 수 있습니다.",
    }, 400);
  }
  // publish 모드여야 업로드 스코프가 붙는다. analytics 로 연결하면 배포에 못 쓴다.
  const state = Buffer.from(JSON.stringify({
    channel: b?.channelUrl ?? "", mode: "publish", return: "/register",
    ...(extReturn ? { extReturn } : {}),
  })).toString("base64");
  return c.json({ url: googleAuthUrl(state, "publish") });
});

/**
 * 영상 등록 — YouTube URL 하나로 미디어·회차를 만든다.
 *
 * ingest 는 **이미 등록된 미디어**만 받는다(재현 가능한 소스만 다루기 위해). 그래서
 * 붙이는 쪽이 새 영상을 넣으려면 먼저 여기를 부른다. 반환된 mediaId 를 ingest 의
 * sourceUrl 대신 쓰거나, 같은 URL 로 ingest 하면 이 미디어가 재사용된다.
 */
app.post("/api/factory/videos", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;

  const b = await c.req.json<{ url?: string; programId?: string; title?: string }>()
    .catch(() => null);
  const url = (b?.url ?? "").trim();
  const programId = (b?.programId ?? "").trim();
  if (!YOUTUBE_URL_RE.test(url)) {
    return c.json({ error: "bad_request", message: "유효한 YouTube URL 이 아닙니다." }, 400);
  }
  const program = await getEntity<{ id: string; title: string; targetAge: number }>(
    "program", programId);
  if (!program) return c.json({ error: "program_not_found" }, 404);

  // 같은 영상을 두 번 넣지 않는다 — 분석은 회당 ₩600 대다.
  const dup = (await listMedia()).find((m: any) => m.storedPath === `youtube:${url}`);
  if (dup) {
    return c.json({ mediaId: (dup as any).id, episodeId: (dup as any).episodeId, reused: true });
  }

  const mediaId = newId("m");
  const vid = url.match(/(?:v=|shorts\/|live\/|youtu\.be\/)([\w-]{6,})/)?.[1] ?? null;
  const result = await buildEpisodeAndMedia({
    mediaId, programId, program,
    storedPath: `youtube:${url}`,
    filename: `${mediaId}.mp4`,
    title: (b?.title ?? "").trim() || "YouTube 영상",
    mime: "video/mp4",
    size: 0,
    meta: { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false },
    thumbPath: null,
    pendingIngestNote: "YouTube 영상 다운로드 대기 중…",
  });
  await enqueue("youtube.download", { mediaId, url, programId },
    { dedupeKey: `youtube.download:${mediaId}` });

  return c.json({
    mediaId, episodeId: result.episode?.id ?? null,
    sourceVideoId: vid, status: "downloading",
  }, 202);
});

/**
 * 성과 조회 — 공장이 올린 영상들의 지표.
 *
 * 지표는 `video.analyze` 잡이 채운다(채널 동기화 주기). **업로드 직후엔 비어 있는 게
 * 정상**이고, 그걸 "실패"로 읽지 않도록 `hasMetrics` 를 함께 내려준다.
 */
app.get("/api/factory/jobs/:id/performance", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;

  const job = await getEntity<any>("factoryJob", c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);

  const clips = await Promise.all(
    (job.clipIds ?? []).map((id: string) => getEntity<any>("clip", id)));

  const items = [];
  for (const clip of clips.filter(Boolean) as any[]) {
    for (const d of (clip.distributions ?? [])) {
      if (d.channel !== "youtube" || !d.externalId) continue;
      const a = await getVideoAnalytics(d.externalId);
      items.push({
        clipId: clip.id,
        title: clip.title,
        videoId: d.externalId,
        channelId: d.youtubeChannelId ?? null,
        status: d.status,
        url: `https://www.youtube.com/watch?v=${d.externalId}`,
        hasMetrics: Boolean(a),
        fetchedAt: a?.fetchedAt ?? null,
        // summary 는 YouTube Analytics 원본 키를 그대로 둔다 — 우리가 이름을 바꾸면
        // 붙이는 쪽이 YouTube 문서와 대조를 못 한다.
        metrics: a?.summary ?? null,
        trafficSources: a?.trafficSources ?? null,
      });
    }
  }
  return c.json({ jobId: job.id, status: job.state, items });
});

/**
 * refresh token 직접 등록 (붙이는 쪽이 이미 토큰을 갖고 있을 때).
 *
 * ⚠️ **우리 GOOGLE_CLIENT_ID 로 발급된 토큰만 동작한다.** 다른 OAuth 클라이언트로 받은
 * refresh token 은 우리 client_secret 으로 갱신이 안 된다. 그래서 저장 전에 **실제로 한 번
 * 갱신해 보고** 실패하면 거절한다 — 나중에 배포 시점에 알면 이미 늦다.
 */
app.post("/api/factory/channels", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "oauth_not_configured" }, 500);
  }
  const b = await c.req.json<{ refreshToken?: string; channelUrl?: string }>().catch(() => null);
  const refreshToken = (b?.refreshToken ?? "").trim();
  if (!refreshToken) {
    return c.json({ error: "bad_request", message: "refreshToken 이 필요합니다." }, 400);
  }

  let accessToken: string;
  let scope = "";
  let expiresIn = 3600;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      return c.json({
        error: "refresh_token_invalid",
        message: "이 refresh token 으로 갱신할 수 없습니다. 우리 OAuth 클라이언트로 발급된 토큰이어야 합니다 — /api/factory/channels/connect-url 로 연결해 주세요.",
        detail: (await res.text()).slice(0, 200),
      }, 400);
    }
    const t = await res.json() as { access_token: string; scope?: string; expires_in?: number };
    accessToken = t.access_token;
    scope = t.scope ?? "";
    expiresIn = t.expires_in ?? 3600;
  } catch (e) {
    return c.json({ error: "refresh_failed", message: String(e).slice(0, 200) }, 502);
  }

  if (!scopeCanPublish(scope)) {
    return c.json({
      error: "scope_insufficient",
      message: `업로드 권한이 없는 토큰입니다 (${YT_PUBLISH_SCOPE} 필요).`,
      scope,
    }, 400);
  }

  const info = await fetchYtChannelInfo(accessToken);
  await upsertYouTubeChannel({
    id: info.channelId,
    channelId: info.channelId,
    channelName: info.channelName,
    channelUrl: b?.channelUrl ?? null,
    thumbnail: info.thumbnail,
    subscribers: info.subscribers,
    refreshToken,
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
    email: null,
    status: "active",
    connectedAt: Date.now(),
  });
  return c.json({
    ok: true,
    target: `youtube:${info.channelId}`,
    channelId: info.channelId,
    name: info.channelName,
  });
});

const oauthCallback = async (c: Context) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const st = decodeState(c.req.query("state"));
  const returnTo = safeReturn(st.return);

  if (error) return c.redirect(`${returnTo}?error=access_denied`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    const tokens = await exchangeCode(code);
    const channelInfo = await fetchYtChannelInfo(tokens.access_token);
    const channel: YouTubeChannel = {
      id: channelInfo.channelId,
      channelId: channelInfo.channelId,
      channelName: channelInfo.channelName,
      channelUrl: st.channel || null,
      thumbnail: channelInfo.thumbnail,
      subscribers: channelInfo.subscribers,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
      email: null,
      status: "active",
      connectedAt: Date.now(),
    };

    await upsertYouTubeChannel(channel);

    // Channel-level analysis (video sync + daily analytics + revenue) is light, so run it
    // HERE on Cloud Run, awaited inside the request — CPU is available while we haven't
    // responded yet (the throttle only hits work left running after the response). This
    // keeps it off the shared worker queue, which is reserved for the heavy per-video and
    // content jobs, so a fresh connect isn't stuck behind that backlog.
    try {
      await runChannelPipeline(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, channel.channelId, { force: true });
    } catch (err) {
      console.error("[oauth/callback] inline channel analysis failed; worker will retry", err);
    }
    // Fan out the heavy part — per-video analytics for every upload — to the worker. force
    // is off: if the inline run above already synced, the worker skips the re-sync and just
    // enqueues the per-video jobs; if it failed, the channel is still due so the worker runs it.
    await enqueue("channel.analyze", { channelId: channel.channelId, force: false }, {
      dedupeKey: `channel.analyze:${channel.channelId}`,
    });

    const params = new URLSearchParams({ success: "1", channelId: channel.channelId, channelName: channel.channelName });
    // 외부에서 시작한 연결이면 그쪽 화면으로 돌려보낸다 (allowlist 통과분만).
    const ext = safeExternalReturn((st as any).extReturn);
    if (ext) {
      const sep = ext.includes("?") ? "&" : "?";
      return c.redirect(`${ext}${sep}${params}`);
    }
    return c.redirect(`${returnTo}?${params}`);
  } catch (err: any) {
    console.error("[oauth/callback]", err);
    return c.redirect(`${returnTo}?error=${encodeURIComponent(err.message)}`);
  }
};

// The path registered in GCP. The bare /callback is kept so links already sent out
// (and the legacy client config) keep working.
app.get(OAUTH_CALLBACK_PATH, oauthCallback);
app.get("/api/youtube/callback", oauthCallback);

// ── Meta (Facebook + Instagram) OAuth ─────────────────────────────────────────
// One connect flow covers both — Facebook Page owner grants us the Page + its
// linked Instagram Business account. 1 DB row per Page, long-lived Page token.
// Redirect URI MUST match what's registered in developers.facebook.com > App > Login.
const META_APP_ID = process.env.META_APP_ID ?? "";
const META_APP_SECRET = process.env.META_APP_SECRET ?? "";
const META_GRAPH_VERSION = "v21.0";
const META_OAUTH_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const META_CALLBACK_PATH = "/api/meta/oauth/callback";
const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
].join(",");

function metaRedirectUri(): string {
  // Prod: web (stepd.stepai.kr) proxies /api/proxy/* → server, so the callback
  // Meta redirects the browser to is a web URL, not the Cloud Run URL. Register
  // exactly this in developers.facebook.com > App > Login > Valid OAuth Redirect URIs.
  // Override with META_REDIRECT_URI if the domain ever changes.
  const explicit = process.env.META_REDIRECT_URI;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    return `https://stepd.stepai.kr/api/proxy${META_CALLBACK_PATH}`;
  }
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${META_CALLBACK_PATH}`;
}

app.get("/api/meta/auth", (c) => {
  if (!META_APP_ID) return c.json({ error: "META_APP_ID not configured" }, 500);
  const returnTo = safeReturn(c.req.query("return"));
  const rerequest = c.req.query("rerequest") === "1";
  const state = Buffer.from(JSON.stringify({ return: returnTo })).toString("base64");
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: metaRedirectUri(),
    response_type: "code",
    scope: META_SCOPES,
    state,
  });
  if (rerequest) params.set("auth_type", "rerequest");
  return c.redirect(`${META_OAUTH_DIALOG}?${params}`);
});

const metaOauthCallback = async (c: Context) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  let returnTo = "/publish-channels";
  try {
    const st = JSON.parse(Buffer.from(c.req.query("state") ?? "", "base64").toString("utf8"));
    returnTo = safeReturn(st?.return);
  } catch {}

  if (error) return c.redirect(`${returnTo}?meta_error=access_denied`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!META_APP_ID || !META_APP_SECRET) return c.json({ error: "Meta OAuth not configured" }, 500);

  try {
    // 1. code → short-lived user token
    const tokenParams = new URLSearchParams({
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: metaRedirectUri(),
      code,
    });
    const tokenRes = await fetch(`${META_GRAPH_BASE}/oauth/access_token?${tokenParams}`);
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
    const tokenData = (await tokenRes.json()) as { access_token: string };

    // 2. short-lived → long-lived user token (~60 days)
    const exchangeParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: tokenData.access_token,
    });
    const longRes = await fetch(`${META_GRAPH_BASE}/oauth/access_token?${exchangeParams}`);
    if (!longRes.ok) throw new Error(`long-lived exchange failed: ${await longRes.text()}`);
    const userToken = ((await longRes.json()) as { access_token: string }).access_token;

    // 3. /me/accounts — Pages + linked IG Business accounts (Page tokens here are long-lived)
    const accountsParams = new URLSearchParams({
      access_token: userToken,
      fields:
        "id,name,access_token,picture{data{url}},instagram_business_account{id,username,profile_picture_url}",
      limit: "100",
    });
    const accountsRes = await fetch(`${META_GRAPH_BASE}/me/accounts?${accountsParams}`);
    if (!accountsRes.ok) throw new Error(`/me/accounts failed: ${await accountsRes.text()}`);
    const accountsData = (await accountsRes.json()) as {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        picture?: { data?: { url?: string } };
        instagram_business_account?: {
          id: string;
          username?: string;
          profile_picture_url?: string;
        };
      }>;
    };

    const now = Date.now();
    let saved = 0;
    for (const page of accountsData.data ?? []) {
      const account: MetaAccount = {
        publicId: crypto.randomUUID(),
        pageId: page.id,
        pageName: page.name,
        pageProfilePictureUrl: page.picture?.data?.url ?? null,
        pageAccessToken: page.access_token,
        igUserId: page.instagram_business_account?.id ?? null,
        igUsername: page.instagram_business_account?.username ?? null,
        igProfilePictureUrl: page.instagram_business_account?.profile_picture_url ?? null,
        status: "active",
        connectedAt: now,
      };
      // upsert by pageId — publicId only used on first insert
      await upsertMetaAccount(account);
      saved += 1;
    }

    return c.redirect(`${returnTo}?meta_success=1&meta_count=${saved}`);
  } catch (err: any) {
    console.error("[meta/oauth]", err);
    return c.redirect(`${returnTo}?meta_error=${encodeURIComponent(err.message ?? "unknown")}`);
  }
};
app.get(META_CALLBACK_PATH, metaOauthCallback);

app.get("/api/meta/accounts", async (c) => {
  const accounts = await listMetaAccounts();
  return c.json({
    accounts: accounts.map((a) => ({
      publicId: a.publicId,
      pageId: a.pageId,
      pageName: a.pageName,
      pageProfilePictureUrl: a.pageProfilePictureUrl,
      igUserId: a.igUserId,
      igUsername: a.igUsername,
      igProfilePictureUrl: a.igProfilePictureUrl,
      status: a.status,
      connectedAt: a.connectedAt,
    })),
  });
});

app.delete("/api/meta/accounts/:publicId", async (c) => {
  await deleteMetaAccount(c.req.param("publicId"));
  return c.json({ ok: true });
});

// ── TikTok OAuth (Content Posting API) ────────────────────────────────────────
// Access token ~24h, refresh token ~365d. Worker must refresh before upload.
// Register in developers.tiktok.com > App > Login Kit + Content Posting API.
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const TIKTOK_CALLBACK_PATH = "/api/tiktok/oauth/callback";
// 승인된 scope 만 요청한다 — 미승인 scope 를 섞으면 인증 화면에서 통째로 거부된다.
// video.upload / video.publish 는 Content Posting API 구현 + 심사 통과 후 여기에 추가할 것.
const TIKTOK_SCOPES = ["user.info.basic"].join(",");

function tiktokRedirectUri(): string {
  const explicit = process.env.TIKTOK_REDIRECT_URI;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    return `https://stepd.stepai.kr/api/proxy${TIKTOK_CALLBACK_PATH}`;
  }
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${TIKTOK_CALLBACK_PATH}`;
}

app.get("/api/tiktok/auth", (c) => {
  if (!TIKTOK_CLIENT_KEY) return c.json({ error: "TIKTOK_CLIENT_KEY not configured" }, 500);
  const returnTo = safeReturn(c.req.query("return"));
  const state = Buffer.from(JSON.stringify({ return: returnTo, nonce: crypto.randomUUID() })).toString("base64url");
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    redirect_uri: tiktokRedirectUri(),
    response_type: "code",
    scope: TIKTOK_SCOPES,
    state,
  });
  return c.redirect(`${TIKTOK_AUTH_URL}?${params}`);
});

const tiktokOauthCallback = async (c: Context) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  let returnTo = "/publish-channels";
  try {
    const st = JSON.parse(Buffer.from(c.req.query("state") ?? "", "base64url").toString("utf8"));
    returnTo = safeReturn(st?.return);
  } catch {}

  if (error) return c.redirect(`${returnTo}?tiktok_error=${encodeURIComponent(error)}`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    return c.json({ error: "TikTok OAuth not configured" }, 500);
  }

  try {
    // 1. code → access + refresh token
    const tokenBody = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: tiktokRedirectUri(),
    });
    const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
      open_id: string;
      scope: string;
      error?: string;
      error_description?: string;
    };
    if (tokenData.error) throw new Error(`${tokenData.error}: ${tokenData.error_description ?? ""}`);

    // 2. /v2/user/info/ — user.info.basic 로 읽을 수 있는 필드만 요청한다.
    // username 은 user.info.profile scope 가 있어야 하고, 섞어 보내면 응답 전체가
    // scope_not_authorized 로 실패한다 (일부만 빠지는 게 아니다).
    const userRes = await fetch(
      `${TIKTOK_USER_INFO_URL}?fields=open_id,union_id,avatar_url,display_name`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    if (!userRes.ok) throw new Error(`/user/info failed: ${await userRes.text()}`);
    const userData = (await userRes.json()) as {
      data?: {
        user?: {
          open_id: string;
          union_id?: string;
          avatar_url?: string;
          display_name?: string;
          username?: string;
        };
      };
    };
    const user = userData.data?.user;
    if (!user) throw new Error("user info missing");

    const now = Date.now();
    const account: TikTokAccount = {
      publicId: crypto.randomUUID(),
      openId: user.open_id ?? tokenData.open_id,
      unionId: user.union_id ?? null,
      displayName: user.display_name ?? "TikTok User",
      username: user.username ?? null,
      avatarUrl: user.avatar_url ?? null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: now + tokenData.expires_in * 1000,
      refreshExpiresAt: now + tokenData.refresh_expires_in * 1000,
      scope: tokenData.scope ?? "",
      status: "active",
      connectedAt: now,
    };
    await upsertTikTokAccount(account);

    return c.redirect(`${returnTo}?tiktok_success=1&tiktok_name=${encodeURIComponent(account.displayName)}`);
  } catch (err: any) {
    console.error("[tiktok/oauth]", err);
    return c.redirect(`${returnTo}?tiktok_error=${encodeURIComponent(err.message ?? "unknown")}`);
  }
};
app.get(TIKTOK_CALLBACK_PATH, tiktokOauthCallback);

app.get("/api/tiktok/accounts", async (c) => {
  const accounts = await listTikTokAccounts();
  return c.json({
    accounts: accounts.map((a) => ({
      publicId: a.publicId,
      openId: a.openId,
      displayName: a.displayName,
      username: a.username,
      avatarUrl: a.avatarUrl,
      scope: a.scope,
      status: a.status,
      connectedAt: a.connectedAt,
      expiresAt: a.expiresAt,
      refreshExpiresAt: a.refreshExpiresAt,
    })),
  });
});

app.delete("/api/tiktok/accounts/:publicId", async (c) => {
  await deleteTikTokAccount(c.req.param("publicId"));
  return c.json({ ok: true });
});

app.get("/api/youtube/channels", async (c) => {
  const channels = (await listYouTubeChannels()).map((ch: YouTubeChannel) => ({
    channelId: ch.channelId,
    channelName: ch.channelName,
    channelUrl: ch.channelUrl,
    thumbnail: ch.thumbnail,
    subscribers: ch.subscribers,
    status: ch.status,
    connectedAt: ch.connectedAt,
    email: ch.email,
    // Progress signals so the onboarding flow knows when the analyze job settled
    // (and can finish fast on channels that simply have no uploads).
    lastSyncedAt: ch.lastSyncedAt ?? null,
    lastAnalyzedAt: ch.lastAnalyzedAt ?? null,
    // Did this channel's consent include the revenue (monetary) scope? Lets the UI tell
    // "connected without revenue permission" apart from "has permission but $0 revenue".
    hasMonetaryScope: (ch.scope ?? "").includes("yt-analytics-monetary.readonly"),
    lastError: ch.lastError ?? null,
  }));
  return c.json({ channels });
});

app.delete("/api/youtube/channels/:channelId", async (c) => {
  await deleteYouTubeChannel(c.req.param("channelId"));
  return c.json({ ok: true });
});

app.post("/api/youtube/refresh", async (c) => {
  const { channelId } = await c.req.json<{ channelId: string }>().catch(() => ({ channelId: "" }));
  if (!channelId) return c.json({ error: "channelId required" }, 400);
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token" }, 400);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    await refreshChannelToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch));
    return c.json({ ok: true, expiresAt: ch.expiresAt });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

// ── 네이버 계정 (B2B 다계정) ──────────────────────────────────────────────────
//
// 여기서 하는 건 **등록·조회뿐**이다. 실제 로그인은 워커 PC 에서 사람이 브라우저로
// 한다(`naver:login --account <key>`) — 서버는 네이버 자격증명을 받지도 저장하지도 않는다.
// 그래서 이 API 는 "어느 고객사의 어떤 채널을 쓸 것인가" 라는 **메타만** 다룬다.

app.get("/api/naver/accounts", async (c) => {
  const accounts = await listNaverAccounts();
  return c.json({
    accounts: accounts.map((a) => ({
      id: a.id, label: a.label, accountKey: a.accountKey,
      target: a.target, status: a.status,
      lastLoginAt: a.lastLoginAt, lastPublishAt: a.lastPublishAt,
      // 워커 PC 에서 실행할 명령을 그대로 준다 — 운영자가 옮겨 적다 틀리지 않게.
      loginCommand: `pnpm --filter @stepd/server naver:login --account ${a.accountKey}`,
    })),
  });
});

app.post("/api/naver/accounts", async (c) => {
  const b = await c.req.json<{ label?: string; target?: string }>().catch(() => null);
  const label = b?.label?.trim();
  if (!label) return c.json({ error: "label required" }, 400);
  const target = ["clip", "tv", "both"].includes(String(b?.target)) ? String(b?.target) : "both";

  // accountKey 는 **우리가 발급하는 불투명 키**다. 네이버 아이디를 받지 않는다 —
  // 파일 경로·로그·DB 에 고객사 계정 아이디가 박히면 안 된다.
  const id = `nva_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const accountKey = id;
  await upsertNaverAccount({
    id, label, accountKey, target: target as "clip" | "tv" | "both",
    status: "session_expired",   // 로그인 전이라 아직 못 쓴다 — active 로 시작하면 거짓말이다
    lastLoginAt: null, lastPublishAt: null, createdAt: Date.now(),
  });
  return c.json({
    id, accountKey, label, target, status: "session_expired",
    loginCommand: `pnpm --filter @stepd/server naver:login --account ${accountKey}`,
    hint: "워커 PC 에서 위 명령을 실행해 로그인해야 발행이 가능합니다.",
  });
});

app.patch("/api/naver/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const acct = await getNaverAccount(id);
  if (!acct) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{ status?: string }>().catch(() => null);
  const status = ["active", "session_expired", "disabled"].includes(String(b?.status))
    ? (String(b?.status) as "active" | "session_expired" | "disabled") : undefined;
  if (!status) return c.json({ error: "status required" }, 400);
  await markNaverAccount(id, { status });
  return c.json({ ok: true, id, status });
});

/** 워커 PC 에서만 의미 있는 진단 — 이 머신에 그 계정 세션 파일이 있는가. */
app.get("/api/naver/accounts/:id/session", async (c) => {
  const acct = await getNaverAccount(c.req.param("id"));
  if (!acct) return c.json({ error: "not_found" }, 404);
  const p = naverSessionPath(acct.accountKey);
  return c.json({ id: acct.id, accountKey: acct.accountKey, present: fs.existsSync(p) });
});

// ── 쇼츠 프레임 템플릿 (편집기·렌더 공용 기하) ────────────────────────────────

app.get("/api/shorts-templates", (c) =>
  c.json({ templates: listShortsTemplates().map(toPercent) }));

app.get("/api/shorts-templates/:name/overlay.png", (c) => {
  const t = getShortsTemplate(c.req.param("name"));
  if (!t) return c.json({ error: "template_not_found" }, 404);
  const buf = fs.readFileSync(t.overlayPath);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      // 프레임은 canva:sync 로만 바뀐다 — 편집기가 매 렌더마다 다시 받지 않게 캐시.
      "Cache-Control": "public, max-age=300",
    },
  });
});

// ── Canva OAuth (쇼츠 오버레이 템플릿 export) ──────────────────────────────────

app.get("/api/canva/auth", async (c) => {
  if (!canvaConfigured()) return c.json({ error: "canva_not_configured" }, 500);
  return c.redirect(await canvaAuthUrl());
});

app.get(CANVA_CALLBACK_PATH, async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const err = c.req.query("error");
  if (err) return c.redirect(`/publish-channels?canva=${encodeURIComponent(err)}`);
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);
  try {
    await canvaExchangeCode(code, state);
    return c.redirect("/publish-channels?canva=connected");
  } catch (e: any) {
    console.error("[canva/oauth/callback]", e);
    return c.redirect(`/publish-channels?canva=${encodeURIComponent(e.message ?? "failed")}`);
  }
});

// DB 가 죽어도 `configured` 는 답한다 — env 설정 문제와 DB 장애를 화면에서 구분해야 한다.
app.get("/api/canva/status", async (c) => {
  const configured = canvaConfigured();
  try {
    return c.json({ configured, connected: await canvaConnected() });
  } catch (e: any) {
    return c.json({ configured, connected: false, error: `db_unavailable: ${e.message}` }, 200);
  }
});

app.delete("/api/canva/connection", async (c) => {
  await disconnectCanva();
  return c.json({ ok: true });
});

app.get("/api/canva/designs", async (c) => {
  try {
    return c.json({ designs: await listCanvaDesigns() });
  } catch (e: any) {
    if (e.message === "canva_not_connected") return c.json({ error: "canva_not_connected" }, 409);
    return c.json({ error: e.message }, 502);
  }
});

// ── YouTube Analytics (channel analysis) ─────────────────────────────────

/** YYYY-MM-DD, `days` ago (Analytics API only accepts this format). */
function isoDay(days = 0): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Writes a refreshed access token (and its expiry) back to the channel row. */
function persistTokensFor(ch: YouTubeChannel): PersistTokens {
  // Targeted two-column write — a full-row upsert from this snapshot could clobber a
  // concurrent reconnect's refreshToken or revive a just-revoked channel (see B6).
  return ({ accessToken, expiresAt }) =>
    updateYouTubeTokens(ch.channelId, accessToken, expiresAt);
}

/**
 * A dead refresh token means the creator must reconnect — park the channel.
 * Status-only guarded write (see db-pg B6): a full-row upsert from this handler's stale
 * snapshot would overwrite a concurrent reconnect's fresh refreshToken with the dead one
 * and brick the channel. Passing the dead token makes the park a no-op after a reconnect.
 */
async function markRevoked(ch: YouTubeChannel): Promise<void> {
  await markYouTubeChannelRevoked(ch.channelId, ch.refreshToken);
}

/**
 * Channel analysis report. Defaults to the last 90 days broken down by day.
 *
 *   GET /api/youtube/analytics/:channelId
 *       ?start=2026-01-01&end=2026-07-14
 *       &dimensions=day|video|insightTrafficSourceType|ageGroup,gender
 *       &metrics=views,estimatedMinutesWatched,...
 */
app.get("/api/youtube/analytics/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token for this channel" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  // Channels connected before the scope split have no analytics grant — Google would
  // answer 403, so say plainly that the creator has to reconnect.
  if (ch.scope && !ch.scope.includes(YT_ANALYTICS_SCOPE)) {
    return c.json({
      error: "channel_needs_reconsent",
      message: "This channel was connected without the analytics scope. Ask the creator to reconnect via /register.",
      scope: ch.scope,
    }, 409);
  }

  try {
    const report = await withAccessToken(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      ch,
      persistTokensFor(ch),
      (accessToken) =>
        fetchChannelAnalytics(accessToken, {
          startDate: c.req.query("start") ?? isoDay(90),
          endDate: c.req.query("end") ?? isoDay(0),
          dimensions: c.req.query("dimensions") ?? "day",
          metrics: c.req.query("metrics") ?? undefined,
          sort: c.req.query("sort") ?? undefined,
          maxResults: Number(c.req.query("maxResults")) || undefined,
        }),
    );
    return c.json({ channelId, channelName: ch.channelName, ...report });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    console.error("[youtube/analytics]", err);
    return c.json({ error: err.message }, 500);
  }
});

// ── Analysis pipeline (scheduler-driven) ─────────────────────────────────

/**
 * Cloud Scheduler hits this. Runs every channel that is due — and a freshly
 * connected channel is always due, so this also catches anything the on-connect
 * kick failed to finish before Cloud Run throttled it.
 *
 * The service is IAM-protected (no public invoker), so the scheduler's OIDC token
 * is the auth; there is no separate shared secret to leak.
 */
app.post("/api/youtube/pipeline/run", async (c) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  const started = Date.now();
  const results = await runDueChannels(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  const ran = results.filter((r) => !r.skipped);

  console.log(`[pipeline/run] ${ran.length}/${results.length} channels in ${Date.now() - started}ms`);
  return c.json({
    ok: true,
    channels: results.length,
    ran: ran.length,
    tookMs: Date.now() - started,
    results,
  });
});

/** Queue a single channel for the worker to pick up now. */
app.post("/api/youtube/pipeline/run/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const jobId = await enqueue("channel.analyze", { channelId, force: true }, {
    dedupeKey: `channel.analyze:${channelId}`,
  });
  return c.json({
    ok: true,
    channelId,
    jobId,
    queued: jobId !== null,
    note: jobId ? "queued" : "a run for this channel is already in flight",
  });
});

/** Queue depth — the quickest way to tell whether the worker VM is alive. */
// ── 썸네일 엔진 ───────────────────────────────────────────────────────────────
// 서버는 잡을 큐잉만 한다 (content.analyze 와 동일). 수집·Vision·이미지 생성은 워커.
// 스타일 프로파일과 출연자 등록부는 프로그램 단위 — assets 루트는 워커 env 로 정한다.

/**
 * 프로그램 스타일 프로파일 생성/갱신. 프로그램당 1회성(톤이 바뀌면 재실행).
 * sourceUrl 은 **재생목록 URL 을 권한다** — 큰 채널은 프로그램·기수를 재생목록으로
 * 나눠 담아서, 채널 전체로 학습하면 여러 프로그램 톤이 섞인다.
 */
app.post("/api/programs/:id/thumbnail-style", async (c) => {
  const programId = c.req.param("id");
  const body = await c.req.json<{
    sourceUrl?: string; channelUrl?: string; limit?: number; sample?: number;
  }>().catch(() => null);
  const sourceUrl = (body?.sourceUrl ?? body?.channelUrl ?? "").trim();
  if (!sourceUrl) {
    return c.json({ error: "bad_request", message: "sourceUrl(재생목록 URL 권장) 이 필요합니다." }, 400);
  }
  const program = await getEntity<any>("program", programId);
  if (!program) return c.json({ error: "program_not_found" }, 404);

  const jobId = await enqueue("thumbnail.style", {
    programId, sourceUrl, title: program.title ?? "",
    limit: body?.limit ?? 50, sample: body?.sample ?? 20,
  }, { dedupeKey: `thumbnail.style:${programId}` });
  return c.json({ ok: true, jobId });
});

/** 저장된 스타일 프로파일 조회. 없으면 404 — 먼저 학습을 돌려야 한다. */
app.get("/api/programs/:id/thumbnail-style", async (c) => {
  const programId = c.req.param("id");
  const prefix = stylePrefix(programId);
  if (!(await fileExists(`${prefix}/style_profile.json`))) {
    return c.json({ error: "not_trained", message: "이 프로그램의 스타일 프로파일이 없습니다." }, 404);
  }
  const data = JSON.parse((await readFile(`${prefix}/style_profile.json`)).toString("utf-8"));
  let prompt = "";
  if (await fileExists(`${prefix}/style_prompt.txt`)) {
    prompt = (await readFile(`${prefix}/style_prompt.txt`)).toString("utf-8");
  }
  return c.json({ programId, title: data.title ?? "", aggregate: data.aggregate ?? null, prompt });
});

/** 이 프로그램에 등록된 출연자 목록. 등록은 사람이 파일로 한다(자동 판정 없음). */
app.get("/api/programs/:id/cast-photos", async (c) => {
  const prefix = castPrefix(c.req.param("id"));
  const objects = await listPrefix(prefix);
  const counts = new Map<string, number>();
  for (const o of objects) {
    const rel = o.slice(prefix.length).replace(/^\//, "");
    const name = rel.split("/")[0];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return c.json({
    cast: [...counts.entries()].map(([name, photos]) => ({ name, photos })),
  });
});

/** 출연자 사진 등록 — 사람이 한다. multipart: name=<출연자명>, file=<이미지>. */
app.post("/api/programs/:id/cast-photos", async (c) => {
  const programId = c.req.param("id");
  const form = await c.req.formData().catch(() => null);
  const name = String(form?.get("name") ?? "").trim();
  const file = form?.get("file");
  if (!name || !(file instanceof File)) {
    return c.json({ error: "bad_request", message: "name 과 file 이 필요합니다." }, 400);
  }
  // 폴더명이 곧 인물 식별자라 경로 조작을 막는다.
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    return c.json({ error: "bad_request", message: "이름에 경로 문자를 쓸 수 없습니다." }, 400);
  }
  const ext = (file.name.match(/\.(jpe?g|png|webp)$/i)?.[0] ?? "").toLowerCase();
  if (!ext) return c.json({ error: "bad_request", message: "jpg·png·webp 만 됩니다." }, 400);

  const buf = Buffer.from(await file.arrayBuffer());
  const objectPath = `${castPrefix(programId)}/${name}/${Date.now()}${ext}`;
  await writeFile(objectPath, buf);
  return c.json({ ok: true, name, path: objectPath, bytes: buf.length });
});

app.delete("/api/programs/:id/cast-photos/:name", async (c) => {
  const name = c.req.param("name");
  if (name.includes("/") || name.includes("\\")) {
    return c.json({ error: "bad_request" }, 400);
  }
  await deletePrefix(`${castPrefix(c.req.param("id"))}/${name}/`);
  return c.json({ ok: true });
});

/** 회차 → 썸네일 후보 생성. 인물이 등록 안 됐으면 워커가 실패로 남긴다. */
app.post("/api/media/:id/thumbnail", async (c) => {
  const mediaId = c.req.param("id");
  const body = await c.req.json<{ programId?: string; candidates?: number }>()
    .catch(() => null);
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);

  const programId = (body?.programId ?? (media as any).programId ?? "").trim();
  if (!programId) {
    return c.json({ error: "bad_request", message: "programId 가 필요합니다." }, 400);
  }
  const program = await getEntity<any>("program", programId);

  const jobId = await enqueue("thumbnail.generate", {
    mediaId, programId, title: program?.title ?? "",
    candidates: body?.candidates ?? 3,
  }, { dedupeKey: `thumbnail.generate:${mediaId}` });
  return c.json({ ok: true, jobId });
});

/**
 * 생성된 썸네일 후보 목록 (F7-3).
 *
 * 워커가 만든 결과는 스토리지에 남는다 — 화면을 떠나도, 잡이 끝난 뒤에도. F7-5 가
 * "완료 알림이 따로 없다 · 다른 화면으로 가도 결과는 미디어에 남는다"라고 한 게 이것이다.
 * 그래서 알림을 만들지 않고 **언제든 다시 조회되게** 둔다.
 */
app.get("/api/media/:id/thumbnails", async (c) => {
  const mediaId = c.req.param("id");
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);

  const paths = await listPrefix(`${thumbnailPrefix(mediaId)}/`);
  const candidates = paths
    .filter((p) => /\.(png|jpe?g|webp)$/i.test(p))
    .sort()
    .map((p) => ({ id: p, name: p.slice(p.lastIndexOf("/") + 1), url: `/api/media/${mediaId}/thumbnails/raw?path=${encodeURIComponent(p)}` }));

  return c.json({ candidates, selected: (media as any).thumbPath ?? null });
});

app.get("/api/media/:id/thumbnails/raw", async (c) => {
  const mediaId = c.req.param("id");
  const objectPath = c.req.query("path") ?? "";
  // 이 미디어의 썸네일 폴더 밖은 못 읽는다 — 경로를 쿼리로 받으므로 반드시 가둔다.
  if (!objectPath.startsWith(`${thumbnailPrefix(mediaId)}/`) || objectPath.includes("..")) {
    return c.json({ error: "path not allowed" }, 400);
  }
  if (!(await fileExists(objectPath))) return c.json({ error: "not found" }, 404);
  const buf = await readFile(objectPath);
  const ext = objectPath.slice(objectPath.lastIndexOf(".") + 1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": mime, "Cache-Control": "private, max-age=600" },
  });
});

/** 후보 하나를 이 미디어의 대표 썸네일로 지정 (F7-3). */
app.post("/api/media/:id/thumbnails/select", async (c) => {
  const mediaId = c.req.param("id");
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const objectPath = typeof body.path === "string" ? body.path : "";
  if (!objectPath.startsWith(`${thumbnailPrefix(mediaId)}/`) || objectPath.includes("..")) {
    return c.json({ error: "path not allowed" }, 400);
  }
  if (!(await fileExists(objectPath))) return c.json({ error: "not found" }, 404);

  await updateMediaThumb(mediaId, objectPath);
  return c.json({ ok: true, selected: objectPath });
});

// ── 콘텐츠 공장 (Factory API) ─────────────────────────────────────────────────
// 소비자는 AENA(사내). 소스 영상 하나 → 분석·쇼츠·클립·YouTube 배포까지 자동 완주.
// 서버는 잡을 만들기만 하고, 진행은 factory.orchestrate 상태기계가 워커에서 굴린다.
// 계획·결정 근거: docs/plans/active/factory-api-plan.md
//
// **외부 서버가 부른다.** Cloud Run 이 allow-unauthenticated 라 IAM 이 막아주지 않으므로
// 이 라우트들이 스스로 인증해야 한다. 남이 이 엔드포인트를 찾으면 우리 YouTube 채널에
// 영상을 올릴 수 있다 — Lab 쓰기 토큰과 같은 방식으로 막는다.

const FACTORY_API_KEY = process.env.FACTORY_API_KEY ?? "";
/** 키 미설정 = 열림이 아니라 닫힘. env 실수의 실패 방향을 '안 됨' 쪽으로 둔다. */
function factoryAuthDenied(c: Context) {
  if (!FACTORY_API_KEY) {
    return c.json({
      error: "factory_key_unset",
      message: "FACTORY_API_KEY 가 서버에 설정되지 않아 Factory API 가 닫혀 있습니다.",
    }, 503);
  }
  const given = c.req.header("x-factory-key") ?? "";
  // 길이가 다르면 어차피 다르다. 같은 길이일 때만 상수시간 비교로 타이밍 누출을 줄인다.
  const ok = given.length === FACTORY_API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(FACTORY_API_KEY));
  if (!ok) return c.json({ error: "unauthorized", message: "x-factory-key 가 올바르지 않습니다." }, 401);
  return null;
}

/** 브라우저에서 직접 부르는 경우 대비. 서버간 호출이면 안 쓰인다. */
const FACTORY_ALLOWED_ORIGIN = process.env.FACTORY_ALLOWED_ORIGIN ?? "";
app.options("/api/factory/*", (c) => {
  if (!FACTORY_ALLOWED_ORIGIN) return c.body(null, 204);
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": FACTORY_ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "content-type,x-factory-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "3600",
  });
});

/**
 * 시간당 ingest 상한. 남용 방지가 아니라 **사고 방지**다 — 붙이는 쪽 루프 버그로
 * 같은 영상이 수백 번 들어오면 API 비용과 채널이 같이 망가진다.
 */
async function ingestRateExceeded(): Promise<boolean> {
  const limit = Number(process.env.FACTORY_HOURLY_LIMIT) || 20;
  const since = Date.now() - 60 * 60 * 1000;
  const jobs = await listEntities<any>("factoryJob");
  return jobs.filter((j) => (j.createdAt ?? 0) >= since).length >= limit;
}

/** 진입. 즉시 202 로 jobId 만 준다 — 완주까지 수십 분 걸리므로 붙잡지 않는다. */
app.post("/api/factory/ingest", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;
  // 킬 스위치. 잘못된 env 의 실패 모드가 "안 돌아감"이지 "실수로 배포됨"이 아니게.
  if (!factoryEnabled()) {
    return c.json({
      error: "factory_disabled",
      message: "FACTORY_ENABLED 가 켜져 있지 않습니다.",
    }, 503);
  }

  const b = await c.req.json<{
    sourceUrl?: string; programId?: string; targets?: string[];
    policy?: Record<string, unknown>; idempotencyKey?: string;
  }>().catch(() => null);

  const sourceUrl = (b?.sourceUrl ?? "").trim();
  const programId = (b?.programId ?? "").trim();
  const targets = Array.isArray(b?.targets) ? b!.targets.filter(Boolean) : [];
  if (!sourceUrl || !programId || targets.length === 0) {
    return c.json({
      error: "bad_request",
      message: "sourceUrl · programId · targets 가 필요합니다.",
    }, 400);
  }
  // **지정한 채널로만 나간다.** 여기서 검증하지 않으면 배포 시점에 워커가 잡을 조용히
  // 버리고(채널 없음 → 경고 후 drop) 공장은 "배포됨"으로 끝난다. 그게 가장 나쁜 실패다.
  // 미지원 채널·미연동·권한 없음을 전부 여기서 거절한다.
  const targetProblems = await validateFactoryTargets(targets);
  if (targetProblems.length) {
    return c.json({
      error: "invalid_target",
      message: "배포 대상 채널을 확인해 주세요.",
      problems: targetProblems,
    }, 400);
  }
  if (!(await getEntity("program", programId))) {
    return c.json({ error: "program_not_found" }, 404);
  }
  if (await ingestRateExceeded()) {
    return c.json({
      error: "rate_limited",
      message: "시간당 ingest 상한에 걸렸습니다 (FACTORY_HOURLY_LIMIT).",
    }, 429);
  }

  // 같은 요청이 두 번 와도 재작업하지 않는다 — 이중 배포가 가장 비싼 사고다.
  const key = (b?.idempotencyKey ?? "").trim();
  const existing = key ? await findFactoryJobByKey(key) : undefined;
  if (existing) return c.json({ jobId: existing.id, status: existing.state, reused: true }, 202);

  const job = await createFactoryJob({
    sourceUrl, programId, targets,
    policy: (b?.policy ?? {}) as any,
    idempotencyKey: key || undefined,
  });
  return c.json({ jobId: job.id, status: job.state }, 202);
});

/**
 * 지정 가능한 배포 대상 목록. AENA 가 targets 에 무엇을 넣을 수 있는지 알려면 필요하다.
 * 업로드 권한이 없는 채널은 `canPublish:false` 로 함께 보여준다 — 목록에서 빼버리면
 * "왜 내 채널이 안 보이지"에서 막힌다.
 */
app.get("/api/factory/targets", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;
  const channels = await listYouTubeChannels();
  return c.json({
    targets: channels.map((ch) => {
      const live = ch.status !== "revoked" && Boolean(ch.refreshToken);
      const canPublish = live && scopeCanPublish((ch as any).scope);
      return {
        target: `youtube:${ch.channelId}`,
        channelId: ch.channelId,
        name: ch.channelName,
        canPublish,
        reason: canPublish ? null
          : !live ? "연결 끊김 (재인증 필요)"
          : "업로드 권한 없음 (게시 모드로 재연결 필요)",
      };
    }),
  });
});

/**
 * 내부용 공장 실행 — 우리 앱 화면에서 회차 하나를 공장에 태운다.
 *
 * 외부용(`/api/factory/ingest`)과 달리 **x-factory-key 를 요구하지 않는다.** 그 키를
 * 브라우저에 내려보내면 유출되고, 유출되면 남이 우리 채널에 영상을 올릴 수 있다.
 * 외부 키는 서버-대-서버(AENA) 전용으로 남긴다.
 *
 * 킬 스위치·상한·타깃 검증은 외부 경로와 똑같이 통과해야 한다 — 내부라고 느슨해지면
 * 사고는 내부에서 난다.
 */
app.post("/api/media/:id/factory-run", async (c) => {
  if (!factoryEnabled()) {
    return c.json({ error: "factory_disabled", message: "FACTORY_ENABLED 가 꺼져 있습니다." }, 503);
  }
  const mediaId = c.req.param("id");
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);

  const b = await c.req.json<{ targets?: string[]; policy?: Record<string, unknown> }>()
    .catch(() => null);
  const targets = Array.isArray(b?.targets) ? b!.targets.filter(Boolean) : [];
  if (targets.length === 0) {
    return c.json({ error: "bad_request", message: "배포할 채널을 하나 이상 선택해 주세요." }, 400);
  }
  const problems = await validateFactoryTargets(targets);
  if (problems.length) {
    return c.json({ error: "invalid_target", message: "배포 대상 채널을 확인해 주세요.", problems }, 400);
  }

  const episode = (media as any).episodeId
    ? await getEntity<any>("episode", (media as any).episodeId) : null;
  const programId = episode?.programId ?? "";
  if (!programId) {
    return c.json({ error: "program_not_found", message: "이 회차의 프로그램을 찾을 수 없습니다." }, 404);
  }

  // 같은 회차를 두 번 누르면 기존 잡을 그대로 돌려준다 — 이중 배포가 가장 비싼 사고다.
  const key = `internal:${mediaId}`;
  const existing = await findFactoryJobByKey(key);
  if (existing) return c.json({ jobId: existing.id, status: existing.state, reused: true }, 202);

  const job = await createFactoryJob({
    sourceUrl: (media as any).storedPath ?? mediaId,
    programId, targets,
    policy: (b?.policy ?? {}) as any,
    idempotencyKey: key,
  });
  return c.json({ jobId: job.id, status: job.state }, 202);
});

/** 이 회차의 공장 실행 상태 (내부용 폴링). 없으면 null. */
app.get("/api/media/:id/factory-run", async (c) => {
  const job = await findFactoryJobByKey(`internal:${c.req.param("id")}`);
  if (!job) return c.json({ job: null });
  const clips = await Promise.all(
    (job.clipIds ?? []).map((id: string) => getEntity<any>("clip", id)));
  return c.json({
    job: {
      jobId: job.id, status: job.state, note: job.note ?? null, error: job.error ?? null,
      dryRun: Boolean(job.policy?.dryRun), updatedAt: job.updatedAt,
      clips: clips.filter(Boolean).map((cl: any) => ({
        clipId: cl.id, title: cl.title, rendered: Boolean(cl.rendered),
        distributions: (cl.distributions ?? []).map((d: any) => ({
          channel: d.channel, status: d.status, externalId: d.externalId ?? null })),
      })),
    },
  });
});

/** 폴링용 상태 조회. 웹훅은 후순위 — 내부 소비자라 폴링으로 시작한다. */
app.get("/api/factory/jobs/:id", async (c) => {
  const denied = factoryAuthDenied(c);
  if (denied) return denied;
  const job = await getEntity<any>("factoryJob", c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);

  const clips = await Promise.all(
    (job.clipIds ?? []).map((id: string) => getEntity<any>("clip", id)));
  return c.json({
    jobId: job.id,
    status: job.state,
    programId: job.programId,
    mediaId: job.mediaId ?? null,
    note: job.note ?? null,
    error: job.error ?? null,
    dryRun: Boolean(job.policy?.dryRun),
    clips: clips.filter(Boolean).map((cl: any) => ({
      clipId: cl.id,
      title: cl.title,
      durationSec: cl.durationSec,
      rendered: Boolean(cl.rendered),
      distributions: (cl.distributions ?? []).map((d: any) => ({
        channel: d.channel, status: d.status, externalId: d.externalId ?? null,
      })),
    })),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

app.get("/api/queue/stats", async (c) => c.json(await queueStats()));

/**
 * On-demand VM 부팅 · Cloud Scheduler 가 매 3분 호출.
 * pending content/youtube 잡 있으면 stepd-worker VM start (idempotent · 이미 RUNNING 이면 no-op).
 * GEBD 잡은 별 VM (stepd-gebd · deploy/gebd-vm.sh · 별 라우트) 이라 여기서 제외.
 *
 * 인증: Cloud Scheduler OIDC 또는 admin token 헤더 (Cloud Run IAM 으로 게이팅).
 * 필요 IAM: Cloud Run SA 에 roles/compute.instanceAdmin.v1 부여 (VM start 권한).
 *
 * docs/plans/gce-worker-restore.md 참조.
 */
/**
 * GEBD GPU VM 깨우기 — `gebd.detect` 가 큐에 있으면 `stepd-gebd-vm` 을 START 한다.
 *
 * VM 은 잡을 다 처리하면 **스스로 종료**한다(`deploy/gebd/vm-startup.sh`). 그래서 반대로
 * "잡이 생겼을 때 켜 주는" 쪽이 필요하다. Cloud Scheduler 가 주기적으로 이걸 때린다.
 *
 * ⚠️ 아래 `/api/admin/worker-vm/wake` 는 쓸 수 없다 — 존재하지 않는 `stepd-worker` VM 을
 * 대상으로 하고, `gebd.detect` 를 **제외**하며(정반대다), `gcloud` CLI 를 스폰하는데
 * Cloud Run 이미지에는 gcloud 가 없다. 여기서는 **Compute REST API** 를 직접 부른다.
 */
app.post("/api/admin/gebd-vm/wake", async (c) => {
  const project = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
  const zone = process.env.GEBD_VM_ZONE || "us-central1-b";
  const instance = process.env.GEBD_VM_NAME || "stepd-gebd-vm";

  // 대기 중인 gebd.detect 가 있는지 — 없으면 켜지 않는다 (VM 이 켜지면 시간당 과금이다).
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM job_queue
      WHERE type = 'gebd.detect' AND status IN ('pending','running')`,
  );
  const pending = Number((rows[0] as { n: number } | undefined)?.n ?? 0);
  if (pending === 0) return c.json({ waked: false, reason: "no pending gebd.detect", pending });

  // Cloud Run 의 메타데이터 서버에서 액세스 토큰 (SA 는 이미 compute 권한을 가진다)
  const tokRes = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  ).catch(() => null);
  if (!tokRes?.ok) return c.json({ waked: false, error: "metadata token 실패", pending }, 500);
  const { access_token: token } = (await tokRes.json()) as { access_token: string };

  const base = `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${instance}`;
  const cur = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  if (!cur.ok) {
    return c.json({ waked: false, error: `instance 조회 실패 ${cur.status}`, pending }, 500);
  }
  const status = ((await cur.json()) as { status?: string }).status;
  // RUNNING/STAGING 이면 이미 일하는 중 — 중복 start 는 409 를 부른다.
  if (status && status !== "TERMINATED" && status !== "SUSPENDED") {
    return c.json({ waked: false, reason: `already ${status}`, pending, status });
  }

  const start = await fetch(`${base}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Length": "0" },
  });
  if (!start.ok) {
    return c.json(
      { waked: false, error: `start 실패 ${start.status}: ${(await start.text()).slice(0, 200)}`, pending },
      500,
    );
  }
  console.log(`[gebd-vm] ${instance} START (대기 ${pending}건)`);
  return c.json({ waked: true, instance, zone, pending });
});

app.post("/api/admin/worker-vm/wake", async (c) => {
  const zone = process.env.WORKER_VM_ZONE || "asia-northeast3-c";
  const instance = process.env.WORKER_VM_NAME || "stepd-worker";
  const stats = await queueStats();
  // queueStats 는 type 별 pending count 를 반환한다고 가정 · 모든 content/youtube 계열 합산
  // GEBD 는 다른 VM 이라 제외.
  const excludedTypes = new Set(["gebd.detect"]);
  let pending = 0;
  const perType = (stats as any)?.pending_by_type || {};
  if (perType && typeof perType === "object") {
    for (const [t, n] of Object.entries(perType)) {
      if (!excludedTypes.has(t)) pending += Number(n) || 0;
    }
  } else {
    // fallback: 전체 pending 을 그대로 (gebd 는 나중에 별 VM 자체 트리거로 커버)
    pending = Number((stats as any)?.pending ?? 0);
  }
  if (pending === 0) {
    return c.json({ waked: false, reason: "no pending jobs", pending });
  }
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("gcloud", [
    "compute", "instances", "start", instance,
    "--zone", zone, "--async",
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    return c.json({ waked: false, error: (r.stderr || r.stdout || "").slice(0, 400), pending }, 500);
  }
  return c.json({ waked: true, instance, zone, pending });
});

// ── ops/diagnostics: raw queue + per-media analysis (superadmin dashboard /ops) ──
/** Individual jobs, newest activity first — the live view of what the worker is doing. */
app.get("/api/admin/jobs", async (c) => {
  const limit = Number(c.req.query("limit")) || 100;
  const jobs = await listJobs(limit);
  return c.json({ jobs, stats: await queueStats() });
});

/**
 * Per-uploaded-video summary: analysis status + scene/shorts/cast counts + genre + error +
 * the episode's live pipeline stage/progress. One row per master media — the "what came out
 * of each upload, and what broke" table. Drill-down stays on GET /api/media/:id/analysis.
 */
app.get("/api/admin/media-analysis", async (c) => {
  const [media, summaries, episodes] = await Promise.all([
    listMedia(),
    listContentAnalysisSummary(),
    listEntities<any>("episode"),
  ]);
  const byMedia = new Map(summaries.map((s) => [s.mediaId, s]));
  const epById = new Map(episodes.map((e) => [e.id, e]));
  const rows = media
    .filter((m) => m.role === "master")
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => {
      const ca = byMedia.get(m.id);
      const ep = m.episodeId ? epById.get(m.episodeId) : undefined;
      return {
        mediaId: m.id,
        episodeId: m.episodeId,
        title: m.title,
        durationSec: m.durationSec,
        hasAudio: !!m.hasAudio,
        createdAt: m.createdAt,
        analysis: ca
          ? {
              status: ca.status,
              error: ca.error,
              genre: ca.genre,
              scenes: ca.scenes,
              shorts: ca.shorts,
              cast: ca.cast,
              stagesDone: ca.stagesDone,
              hasData: ca.hasData,
              tookMs: ca.updatedAt - ca.createdAt,
              updatedAt: ca.updatedAt,
            }
          : null,
        pipeline: ep?.pipeline ?? null,
      };
    });
  return c.json({ media: rows });
});

/** Stored daily analytics for a channel — served from our DB, not YouTube. */
app.get("/api/youtube/analytics/:channelId/daily", async (c) => {
  const channelId = c.req.param("channelId");
  const days = Number(c.req.query("days")) || 90;
  const fromDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await getChannelAnalytics(channelId, fromDay);
  return c.json({ channelId, days: rows.length, rows });
});

// ── YouTube video sync & trends ──────────────────────────────────────────

app.post("/api/youtube/sync/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token for this channel" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    // syncChannelVideos refreshes and persists the token itself (expiry included).
    const result = await syncChannelVideos(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch));

    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const v of result.videos) {
      const existing = await getChannelVideoByVideoId(v.videoId);
      const cv: ChannelVideo = {
        id: existing?.id ?? `cv_${v.videoId}`,
        channelId,
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        thumbnail: v.thumbnail,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
        lastSynced: now,
      };
      await upsertChannelVideo(cv);

      const lastStat = await getLatestVideoStat(v.videoId);
      if (!lastStat || (now - lastStat.snapshotAt) > 3_600_000) {
        await insertVideoStat({
          id: `vs_${v.videoId}_${now}`,
          videoId: v.videoId,
          channelId,
          snapshotAt: now,
          viewCount: v.viewCount,
          likeCount: v.likeCount,
          commentCount: v.commentCount,
        });
      }

      if (existing) updated++;
      else inserted++;
    }

    // Verify Shorts by probing youtube.com/shorts/<id> — the Data API has no Shorts flag
    // and duration is unreliable. Cached per video (shortCheckedAt), so this only probes
    // not-yet-classified uploads; a large backlog spreads across successive syncs.
    const uncheckedIds = await getUncheckedShortVideoIds(channelId, SHORTS_PROBE_MAX_PER_SYNC);
    const verdicts = await classifyShorts(uncheckedIds, SHORTS_PROBE_CONCURRENCY);
    for (const [videoId, isShort] of verdicts) {
      await setChannelVideoShort(videoId, isShort, now);
    }
    const shortsPending = await countUncheckedShortVideos(channelId);

    return c.json({
      ok: true,
      channelId,
      videoCount: result.videos.length,
      inserted,
      updated,
      snapshotCount: result.videos.length,
      shortsClassified: verdicts.size,
      shortsPending,
    });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    console.error("[sync]", err);
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/youtube/videos/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);

  const videos = await listChannelVideos(channelId);
  return c.json({ channelId, channelName: ch.channelName, videoCount: videos.length, videos });
});

app.get("/api/youtube/trends/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);

  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const trend = await getChannelViewTrend(channelId, days);
  const summary = await getChannelTrendSummary(channelId, days);

  return c.json({
    channelId,
    channelName: ch.channelName,
    days,
    trend,
    summary,
  });
});

app.get("/api/youtube/trends/video/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const video = await getChannelVideoByVideoId(videoId);
  if (!video) return c.json({ error: "video not found" }, 404);

  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const stats = await getVideoStats(videoId, days);

  const dailyData = new Map<string, { views: number; likes: number; comments: number }>();
  for (const s of stats) {
    // snapshotAt is BIGINT → node-postgres returns it as a string; new Date(str) would be
    // Invalid Date and .toISOString() throws (500). Coerce to number (infra.md §3 함정2).
    const date = new Date(Number(s.snapshotAt)).toISOString().slice(0, 10);
    dailyData.set(date, {
      views: Number(s.viewCount),
      likes: Number(s.likeCount),
      comments: Number(s.commentCount),
    });
  }

  const trend = Array.from(dailyData.entries()).map(([date, d]) => ({
    date,
    ...d,
  }));

  return c.json({ video, trend });
});

// ── YouTube trending (public mostPopular chart) ──────────────────────────────
//
// "지금 유튜브에서 뜨는 영상" — 우리 채널 시계열이 아니라 국가별 인기 급상승. 편집자
// 아이디어/트렌드 참고용. 인증은 API key 우선 · 없으면 아무 등록 채널의 accessToken.

async function getPublicYouTubeAuth(): Promise<YouTubeAuth | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) return { apiKey };
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  const channels = await listYouTubeChannels();
  const ch = channels.find((c) => c.refreshToken);
  if (!ch) return null;
  try {
    const token = await withAccessToken(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      ch,
      persistTokensFor(ch),
      async (t) => t,
    );
    return { accessToken: token };
  } catch {
    return null;
  }
}

app.get("/api/youtube/popular", async (c) => {
  const regionCode = (c.req.query("regionCode") || "KR").toUpperCase();
  const categoryId = c.req.query("categoryId") || "";
  const maxResults = Math.min(50, Math.max(1, Number(c.req.query("maxResults") ?? 50)));

  const auth = await getPublicYouTubeAuth();
  if (!auth) {
    return c.json(
      { error: "no_auth", message: "YOUTUBE_API_KEY env 또는 최소 1개 등록된 채널이 필요합니다." },
      400,
    );
  }
  try {
    const videos = await fetchPopularVideos(auth, {
      regionCode,
      videoCategoryId: categoryId || undefined,
      maxResults,
    });
    return c.json({ regionCode, categoryId, count: videos.length, videos, fetchedAt: Date.now() });
  } catch (err: any) {
    console.error("[popular]", err);
    return c.json({ error: err?.message ?? "unknown" }, err?.status ?? 500);
  }
});

app.get("/api/youtube/video-categories", async (c) => {
  const regionCode = (c.req.query("regionCode") || "KR").toUpperCase();
  const auth = await getPublicYouTubeAuth();
  if (!auth) return c.json({ error: "no_auth" }, 400);
  try {
    const categories = await fetchVideoCategories(auth, { regionCode });
    return c.json({ regionCode, categories });
  } catch (err: any) {
    console.error("[video-categories]", err);
    return c.json({ error: err?.message ?? "unknown" }, err?.status ?? 500);
  }
});

/**
 * Everything the video.analyze / video.comments jobs collected for one upload, served
 * from our DB (no live YouTube call). Empty sections just mean the job hasn't run yet
 * or YouTube had no data for that report.
 */
app.get("/api/youtube/videos/:videoId/analytics", async (c) => {
  const videoId = c.req.param("videoId");
  const video = await getChannelVideoByVideoId(videoId);
  if (!video) return c.json({ error: "video not found" }, 404);

  const [analytics, retention, comments] = await Promise.all([
    getVideoAnalytics(videoId),
    getVideoRetention(videoId),
    listVideoComments(videoId),
  ]);

  return c.json({
    video,
    summary: analytics?.summary ?? {},
    trafficSources: analytics?.trafficSources ?? [],
    demographics: analytics?.demographics ?? [],
    retention: retention?.curve ?? [],
    comments,
    fetchedAt: analytics?.fetchedAt ?? null,
  });
});

/**
 * On-demand comment collection for ONE video, at any age.
 * The scheduled fan-out (worker enqueueDueVideoJobs) only queues video.comments for
 * uploads younger than FRESH_VIDEO_WINDOW_MS, so older videos never get comments unless
 * an operator asks here. Queue-only (Cloud Run does not call YouTube); the caller polls
 * /analytics for the result. dedupeKey keeps repeat clicks from stacking jobs.
 */
app.post("/api/youtube/videos/:videoId/comments/refresh", async (c) => {
  const videoId = c.req.param("videoId");
  const video = await getChannelVideoByVideoId(videoId);
  if (!video) return c.json({ error: "video not found" }, 404);

  const jobId = await enqueue(
    "video.comments",
    { videoId, channelId: video.channelId },
    { dedupeKey: `video.comments:${videoId}` },
  );
  // enqueue() returns null when an identical job is already pending — that is success
  // from the caller's point of view, not an error.
  return c.json({ queued: true, jobId, alreadyPending: jobId == null });
});

app.delete("/api/youtube/videos/:videoId", async (c) => {
  await deleteChannelVideo(c.req.param("videoId"));
  return c.json({ ok: true });
});
// ── start ─────────────────────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[stepd-server] listening on http://localhost:${info.port}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[stepd-server] SIGTERM received, shutting down...");
  // Pool cleanup happens automatically via idle timeout
  process.exit(0);
});