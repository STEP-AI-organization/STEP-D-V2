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
import { compress } from "hono/compress";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  runWithTenant, runAsSystem, currentContext, currentTenantId, DEFAULT_TENANT_ID,
  type TenantContext,
} from "./tenant.ts";
import {
  SESSION_COOKIE,
  authRequired,
  acceptInvite,
  canManageWorkspace,
  countActiveOwners,
  createUser,
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
import { audit, clientIp, requireReason, requireSuperadmin, requireOpsAccess, requireOpsOrInternal } from "./admin.ts";
import { grantDedupeKey, nextTenantId, planOnboarding } from "./onboarding.ts";
import {
  billingConfig, cardBlock, cardBlockReason, cardLabel, cardTopupPaymentId, checkCustomer,
  declineMessage, extractCardDisplay, issueIdFor, unwrapPayment, verifyCharge,
} from "./billing-card.ts";
import { buildInvoice, invoiceFromTopup, issuerInfo, monthRange, parseMonth, supplierFromEnv } from "./invoice.ts";
import { checkProfile, incompleteFields } from "./business.ts";
import {
  captionMaxCharsOf, chunkCaption,
  type Caption as CaptionT, type CaptionWord as CaptionWordT,
} from "./caption-chunk.ts";
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
  patchClipEditorAtomic,
  setClipReframe,
  tryQueueClipReframe,
  compareAndSetClipReframe,
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
  publishedTodayKst,
  updateAutomationRuleById,
  upsertAutomationRule,
  deleteAutomationRule,
  appendRuleRun,
  listRuleRuns,
  releaseHold,
  rejectHold,
  openHolds,
  getAutomationSetting,
  setAutomationSetting,
  getAutoTopupAlert,
  getBillingNotifyEmails,
  setBillingNotifyEmails,
  monthUsageCredits,
  creditBalance,
  addCreditEntry,
  listCreditLedger,
  createTopup,
  getTopup,
  listPaidTopups,
  markTopupPaid,
  withTenantLock,
  getBillingCard,
  saveBillingCard,
  updateBillingCardBuyer,
  updateBillingCardDisplay,
  revokeBillingCard,
  getAutoTopupPolicy,
  saveAutoTopupPolicy,
  getBusinessProfile,
  saveBusinessProfile,
  listChannelRules,
  getChannelRule,
  upsertChannelRule,
  deleteChannelRule,
  deleteChannelRulesForAccount,
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
  disconnectYouTubeChannel,
  listMetaAccounts,
  upsertMetaAccount,
  deleteMetaAccount,
  disconnectMetaAccount,
  type MetaAccount,
  listInstagramAccounts,
  upsertInstagramAccount,
  deleteInstagramAccount,
  disconnectInstagramAccount,
  type InstagramAccount,
  listTikTokAccounts,
  upsertTikTokAccount,
  deleteTikTokAccount,
  disconnectTikTokAccount,
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
  saveContentAnalysis,
  getContentAnalysis,
  listContentAnalysisSummary,
  recordMetadataEdits,
  listMetadataEdits,
  recordReframeLabel,
  listReframeLabels,
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
import { hasFfmpeg, probe, captureThumbnail, circleCrop, trimEncode, remuxFaststart, renderShort } from "./ffmpeg.ts";
import { issueOAuthState, consumeOAuthState, HANDOFF_TTL_MS } from "./oauth-state.ts";
import { synthesizeHookNarration } from "./tts.ts";
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
import {
  youtubeUploadEnabled, UPLOAD_DISABLED_CODE, UPLOAD_DISABLED_MESSAGE, tiktokUploadEnabled,
  tiktokDirectPostEnabled,
  instagramUploadEnabled, facebookUploadEnabled,
} from "./upload-gate.ts";
import { geminiGenerate, parseJsonLoose } from "./gemini.ts";
import { syncProgramFromFacesForMedia, CORE_PYTHON, CORE_DIR, REPO_ROOT } from "./content-pipeline.ts";
import {
  basicReframeState,
  canonicalRenderedClipAspect,
  COMPARE_FILE_RE,
  COMPARE_ID_RE,
  compareArtifactPrefix,
  effectiveReframeState,
  fitIntervalsForPlan,
  normalizeReframePlan,
  reframeFingerprint,
  reframePlanHash,
  type ClipReframeState,
  type ReframePlan,
} from "./reframe.ts";
import { getAspectPreset } from "./aspect-presets.ts";
import { renderTextLayerPng, overlayCanvasAvailable, measureOverlayImage, type OverlayTextItem } from "./overlay-canvas.ts";
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
import { initQueue, enqueue, queueStats, listJobs, pendingByType, oldestPendingAgeMs } from "./queue.ts";
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
  uploadGcsUri,
  uploadFileSize,
  uploadFileExists,
  promoteUpload,
  signedReadUrl,
  deleteFile,
  deletePrefix,
  listPrefix,
} from "./storage-gcs.ts";
import { castPrefix, stylePrefix, thumbnailPrefix } from "./thumbnail-assets.ts";
import { isClipRendered, upsertDistribution, isNaverChannel, NAVER_CHANNELS } from "./publish-guard.ts";
import {
  buildMetadataPrompt, normalizeForChannel, validateForChannel,
  META_CHANNELS, CHANNEL_SPECS, type MetaChannel,
} from "./clip-metadata.ts";
import { naverUploadEnabled, NAVER_DISABLED_MESSAGE, DESC_MIN } from "./naver-gate.ts";
import {
  commerceLinksEnabled, parseProductQueries, usableLinks, withCommerceLinks, normalizeStatus,
} from "./commerce.ts";
// `looksLikeStorageState` 는 두 제공자가 같은 검사를 쓴다(session-crypto 공용) — 이미
// naver-session-store 로 들어와 있어 여기서 또 들이지 않는다.
import { commerceSessionStoreReady, sealCommerceSession } from "./commerce-session-store.ts";
import {
  initialPipeline,
  isoDateOrToday,
  readEpisodeNumber,
  readTrack,
} from "./episode-intake.ts";
import { dispatchPublish } from "./publish-dispatch.ts";
import { opsCapabilityOf, canPublish, isOpsRole, OPS_ROLES } from "./ops-role.ts";
import {
  AUTO_TOPUP_HARD_MAX_KRW_PER_MONTH, AUTO_TOPUP_HARD_MAX_PER_DAY, FIXED_AUTO_TOPUP,
  CREDIT_UNIT_LABEL, MANUAL_REASONS, buildTopup, checkCredits, creditPriceKrw,
  fixedAutoTopupPolicy, manualDedupeKey, planManualCredit, settleTopup, topupDedupeKey,
  topupPaymentId,
} from "./credits.ts";
import { billableMinutes, portoneConfigured } from "./billing.ts";
import { chargeWithBillingKey, getBillingKeyInfo, getPayment, verifyWebhook } from "./portone.ts";
// 자동 충전 알림 해제는 **이 한 함수**로만 한다 — 라우트마다 db-pg 의 저장 함수를 직접
// 부르면 반드시 한 자리가 빠진다(실제로 직접 충전 경로가 빠져 있었다).
import { clearAutoTopupAlert, maybeAutoTopup, topupAndRecheck } from "./auto-topup.ts";
import { buyerFor, sendInvoiceEmail } from "./invoice-email.ts";
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
  CREDIT_IDLE_REASON,
  LAST_CYCLE_KEY,
  NOTIFY_EMAIL_KEY,
  RULE_CRITERIA,
  type RuleCriterion,
  RULE_MEDIA_KINDS,
  GATE_POLICIES,
  RULE_DELETED_NOTICE,
  initialRuleState,
  findAutomationChannelConflicts,
  isGatePolicy,

  isRuleMediaKind,
  isRuleOrientation,
  isRuleReframe,
  isRuleThumbnailMode,
  planCycle,
  ruleCreatedNotice,
  ruleWeekdays,
  ruleSlots,
  type RuleSlotInput,
  monthlyPublishEstimate,
} from "./automation.ts";
import {
  CHANNEL_ROLES,
  capRenderWindow,
  defaultRuleFor,
  eligibility,
  isChannelRole,
  normalizePublishDelayMin,
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
import { listNaverAccounts, getNaverAccount, upsertNaverAccount, markNaverAccount,
  deleteNaverAccount } from "./db-pg.ts";
import { naverSessionPath } from "./naver-session.ts";
import { sealSession, sessionStoreReady, looksLikeStorageState } from "./naver-session-store.ts";
import { setNaverSessionBlob, clearNaverSessionBlob } from "./db-pg.ts";
import {
  getCommerceAccount, upsertCommerceAccount, setCommerceSessionBlob, markCommerceSessionExpired,
} from "./db-pg.ts";
import {
  CANVA_CALLBACK_PATH, canvaConfigured, canvaConnected, canvaAuthUrl,
  canvaExchangeCode, disconnectCanva, listCanvaDesigns,
} from "./canva.ts";
import {
  createJob as createFactoryJob,
  findByIdempotencyKey as findFactoryJobByKey,
  validateTargets as validateFactoryTargets,
  factoryEnabled,
  TERMINAL_STATES,
} from "./factory.ts";

// A stray async error (e.g. a GCS stream 'error' after the response started, or a background
// promise rejecting) must not kill the whole Cloud Run instance mid-request — same guard the
// worker has (worker.ts main()). Log loudly and keep serving.
process.on("unhandledRejection", (reason) => console.error("[stepd-server] unhandledRejection (surviving):", reason));
process.on("uncaughtException", (err) => console.error("[stepd-server] uncaughtException (surviving):", err));

// Sync init — no CPU throttling issues on Cloud Run
let dbReady = false;
// 상수 캐시 금지 — hasFfmpeg 가 성공을 캐시하고 실패만 재프로브한다 (ffmpeg.ts 주석 참조).
console.log(`[stepd-server] ffmpeg available: ${hasFfmpeg()}`);

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

// JSON 응답 gzip — /api/state 같은 큰 페이로드의 전송을 줄인다 (Cloud Run 은 자동 압축이
// 없다). 바이너리·스트림 경로는 제외 — 이미 압축된 포맷(jpg/mp4)이고, Range 스트리밍에
// 압축이 끼면 시킹이 깨진다.
const NO_COMPRESS = /\/(stream|thumb|frame|overlay\.png|analysis\/frames|analysis\/faces|thumbnails\/)/;
app.use("/api/*", async (c, next) => {
  if (NO_COMPRESS.test(new URL(c.req.url).pathname)) return next();
  return compress()(c, next);
});

/**
 * 잡히지 않은 예외 → **사유가 있는 JSON**.
 *
 * 이게 없으면 Hono 기본 핸들러가 **본문 없는 500** 을 돌려준다. 그러면 이 리포가 공들여
 * 써둔 메시지들 — `tenant.ts` 의 "tenant scope missing …", `auth.ts` 의 로그인 사유,
 * `factory.ts` 의 거절 이유 — 이 전부 사용자에게 도달하지 못하고, 프론트는 본문이 없어서
 * `res.json()` 에서 또 던진다. 화면에는 "500" 만 남는다.
 *
 * 규칙:
 *  - `HTTPException` 은 던진 쪽이 status·message 를 정한 것이다. 그대로 존중한다.
 *  - 나머지는 500 + `{error, message}`. **message 는 삼키지 않는다** — 이 리포의 실패는
 *    대부분 "왜 안 됐는지 모르는 것" 이지 "터진 것" 이 아니다.
 *  - 스택은 **서버 로그로만** 보낸다. 경로·내부 구조가 응답으로 새면 안 된다.
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    // getResponse() 는 본문이 비어 있을 수 있다(message 만 준 경우) — JSON 으로 통일한다.
    if (res.headers.get("content-type")?.includes("application/json")) return res;
    return c.json({ error: "request_failed", message: err.message || res.statusText }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${c.req.method} ${new URL(c.req.url).pathname} 처리 중 예외:`,
    err instanceof Error ? (err.stack ?? message) : err);
  return c.json({ error: "internal_error", message }, 500);
});

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
  /^\/api\/(youtube|meta|instagram|tiktok|canva)\/oauth\/callback/,
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
/**
 * 기계가 읽을 수 있는 인증 오류. onError 는 JSON 본문이 실린 HTTPException 을 그대로
 * 내보내므로(위), 여기서 본문을 만들면 `{error:"invalid_api_key"|"scope_denied", …}` 가 나간다.
 */
function keyError(status: 401 | 403, code: string, message: string): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: code, message }), {
      status, headers: { "content-type": "application/json; charset=utf-8" },
    }),
  });
}

async function resolveTenant(c: Context<AppEnv>): Promise<TenantContext> {
  // 키는 두 자리에서 받는다.
  //   Authorization: Bearer stepd_live_…  → Cloud Run 직통 호출(정석)
  //   x-api-key: stepd_live_…             → **웹 프록시를 거치는 호출**
  // 프로덕션 공개 주소(stepd.stepai.kr/api/proxy/…)는 Vercel 프록시가 Cloud Run IAM 용
  // ID 토큰을 Authorization 에 덮어써서 보낸다 — 고객사가 Bearer 로 키를 실어도 서버까지
  // 오지 않는다(그 경로로는 단 한 건도 인증되지 않는다). 프록시는 나머지 헤더를 그대로
  // 통과시키므로, 별도 헤더를 정문으로 함께 열어 둔다.
  const rawKey = bearerKey(c.req.header("authorization"))
    ?? bearerKey(`Bearer ${c.req.header("x-api-key") ?? ""}`);
  if (rawKey) {
    const row = await lookupApiKey(hashKey(rawKey));
    const blocked = keyBlockReason(row);
    // 왜 막혔는지 말한다 — "401" 만 주면 고객사가 키를 다시 발급받아도 같은 벽을 만난다.
    // ⚠️ **기계가 읽을 코드**도 같이 준다. 예전엔 전부 `request_failed` 라, 호출자가
    // "키를 새로 발급받아야 함"과 "이 라우트는 원래 안 열림"과 "일시 오류"를 구분할 수
    // 없어 재시도할지 멈출지를 코드로 판단하지 못했다(한국어 문자열 매칭 말고는).
    if (blocked || !row) throw keyError(401, "invalid_api_key", blocked ?? "알 수 없는 API 키입니다.");

    // 라우트 화이트리스트. 세션용 라우트 118개를 키에 통째로 열지 않는다.
    const verdict = checkRoute(c.req.method, new URL(c.req.url).pathname, row.scopes);
    if (!verdict.ok) throw keyError(403, "scope_denied", verdict.reason);

    // 안 쓰는 키를 회수할 근거. 매 요청 쓰기는 과해서 분 단위로 던다.
    if (shouldTouchLastUsed(row.lastUsedAt, Date.now())) void touchApiKey(row.id);
    return { scope: row.tenantId, via: "api-key", apiKeyId: row.id };
  }

  // 내부 서비스 호출 (워커 → 서버 렌더 등). Cloud Run IAM 은 GFE 가 ID 토큰으로 검증하고,
  // 앱 레벨에서는 이 공유 토큰으로 "우리 워커다"를 증명한다. 테넌트는 호출자가 잡의
  // tenant 스코프를 헤더로 넘긴다 — 워커는 이미 그 스코프로 실행 중이므로 위임이 맞다.
  // 토큰 env 미설정 = 경로 자체가 닫힘 (fail-closed).
  const internalGiven = c.req.header("x-internal-token") ?? "";
  const internalToken = process.env.INTERNAL_API_TOKEN ?? "";
  if (internalGiven && internalToken && internalGiven.length === internalToken.length &&
      crypto.timingSafeEqual(Buffer.from(internalGiven), Buffer.from(internalToken))) {
    return { scope: c.req.header("x-tenant-id") || DEFAULT_TENANT_ID, via: "internal" };
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
 * 공장 라우트는 **익명 폴백을 허용하지 않는다.** AUTH_REQUIRED 가 꺼진 단일 테넌트
 * 자세에서는 인증 없는 요청이 기본 테넌트로 폴백하는데(resolveTenant 3번 경로),
 * 공장은 남의 YouTube 채널에 영상을 올릴 수 있는 표면이라 그 폴백이 곧 사고다.
 * API 키 또는 로그인 세션이 있어야만 통과시킨다 (구 x-factory-key 의 방어를 대체).
 */
app.use("/api/factory/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const via = currentContext()?.via;
  if (via !== "api-key" && !c.get("user")) {
    return c.json({ error: "unauthorized", message: "API 키(Authorization: Bearer)가 필요합니다." }, 401);
  }
  return next();
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
  return c.json({ ok: dbReady, ffmpeg: hasFfmpeg(), youtubeUpload: youtubeUploadEnabled() });
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

/**
 * 발행(송출) 권한 확인 + **감사 로그에 쓸 행위자**를 함께 돌려준다.
 *
 * 두 가지를 한 번에 고친다:
 *  1. `ops-role.ts` 의 `canPublish()` 는 만들어져 있고 테스트도 있는데 **어느 라우트도
 *     부르지 않았다**(2026-08-12 확인). 그래서 "워크스페이스 owner 인 외주 편집자에게
 *     배포 버튼이 열린다" 는, 그 파일이 막으려던 바로 그 상황이 서버에서 열려 있었다.
 *  2. 감사 로그의 행위자를 `x-actor` **헤더**에서 읽고 있었다 — 잘못된 발행 뒤에 찾아볼
 *     바로 그 기록이 위조 가능했다. 세션이 정본이다.
 *
 * ⚠️ 세션이 없는 배치(AUTH_REQUIRED=0 · 단일 테넌트)에서는 막지 않는다. 지금 도는 배포를
 *    깨지 않으면서 다테넌트 구멍만 닫는다 — 인증 자세가 어긋난 상태는 assertAuthPosture 가 잡는다.
 */
function requirePublisher(c: Context<AppEnv>): string {
  const user = c.get("user");
  if (!user) return readActor(c.req.header("x-actor")) || "unknown";
  if (!canPublish(user.opsRole)) {
    throw new HTTPException(403, {
      message: "송출 권한이 없습니다 — 운영 역할(cp 등)이 필요합니다. 워크스페이스 관리 권한과는 별개입니다.",
    });
  }
  return user.email || user.id;
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

app.get("/api/auth/me", async (c) => {
  const user = c.get("user") as User | undefined;
  if (!user) return c.json({ user: null, authRequired: authRequired() });
  // 워크스페이스(테넌트) 이름 — 로그인 후 "어느 회사 워크스페이스인지" 화면에 보여준다
  // (사용자 2026-08-20: "어느 회사 워크스페이스인지 알 수가 없음"). 본인 테넌트 id 로만 조회하므로
  // getRawPool 로 시스템 조회해도 남의 데이터를 보지 않는다. 실패는 치명적이지 않다(이름 없이 진행).
  let tenantName: string | null = null;
  try {
    const { rows } = await getRawPool().query<{ name: string }>(
      "SELECT name FROM tenants WHERE id = $1", [user.tenantId]);
    tenantName = rows[0]?.name ?? null;
  } catch { /* 이름 조회 실패는 무시 — 화면은 이름 없이 뜬다 */ }
  return c.json({
    user: {
      id: user.id, email: user.email, name: user.name,
      // 두 축을 함께 준다 — 화면이 관리 권한(role)과 방송 권한(opsRole)을 구분해서 쓴다.
      role: user.role,
      opsRole: opsCapabilityOf(user.opsRole).key,
      capabilities: opsCapabilityOf(user.opsRole),
      tenantId: user.tenantId,
      tenantName,
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

/**
 * 결제 수단 **등록** 경로의 행위자. 세션이면 매니저, API 키면 그 키.
 *
 * 왜 키를 통과시키는가: 고객사가 자기 도메인 화면에서 카드를 등록한다(2026-08-20 확정).
 * 키가 여기 도달했다는 건 화이트리스트가 이미 `billing:write` 를 확인했다는 뜻이다
 * (api-keys.ts `checkRoute`) — 스코프 검사를 여기서 두 벌 하지 않는다.
 *
 * ⚠️ **`requireManager` 를 이걸로 갈아치우지 말 것.** 즉시 결제(`/credits/topup*`)와 파괴적
 * 경로(카드 제거)는 계속 세션 전용이어야 한다. 여기 쓰는 자리는 **카드 등록 2개 + 자동 충전
 * 정책 1개**뿐이다.
 *
 * 자동 충전을 이 목록에 넣은 이유(2026-08-21): 카드를 등록해 두면 잔액이 말라 라인이 서지
 * 않아야 한다는 요구. 즉시 결제와 달리 자동 충전은 **자기 상한을 스스로 들고 있다** —
 * 임계·충전량·일일 횟수·월 금액 + 절대 상한(AUTO_TOPUP_HARD_MAX_*), 그리고 카드가 없으면
 * 켜지지도 않는다. 상한 없는 즉시 결제와는 위험의 성격이 다르다.
 *
 * 행위자 문자열을 키 id 로 남기는 이유: 사람 이메일이 없다고 익명으로 적으면, 나중에
 * "누가 이 카드를 등록했나" 에 답할 근거가 사라진다.
 */
function requireCardActor(c: Context<AppEnv>): string {
  if (currentContext()?.via === "api-key") {
    return `api-key:${currentContext()?.apiKeyId ?? "unknown"}`;
  }
  return requireManager(c).email;
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
      // 송출 권한(운영 역할)도 함께 — 화면이 현재 값을 못 보여주면 아무도 못 고친다.
      opsRole: (m as any).opsRole ?? null,
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
  const { role, status, opsRole } = await c.req
    .json<{ role?: string; status?: string; opsRole?: string }>().catch(() => ({}) as any);

  if (targetId === user.id) {
    return c.json({ error: "cannot_change_self", message: "자기 자신의 권한은 바꿀 수 없습니다." }, 400);
  }
  if (role && !["owner", "admin", "member"].includes(role)) return c.json({ error: "invalid_role" }, 400);
  if (status && !["active", "suspended"].includes(status)) return c.json({ error: "invalid_status" }, 400);
  // 송출 권한(cp/editor/vendor 등)은 워크스페이스 역할과 **다른 축**이다 — 여기서 안 받으면
  // 제품 안에 배포 권한을 주는 문이 하나도 없다(새 워크스페이스는 배포가 영구 403이었다).
  if (opsRole !== undefined && !isOpsRole(opsRole)) {
    return c.json({ error: "invalid_ops_role", message: `운영 역할은 ${OPS_ROLES.join(" · ")} 중 하나여야 합니다.` }, 400);
  }
  if (!role && !status && opsRole === undefined) return c.json({ error: "nothing_to_update" }, 400);

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

  await updateMember(user.tenantId, targetId, { role: role as any, status, opsRole });
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

  const checked = planOnboarding(body);
  if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, 400);
  const plan = checked.plan;

  const ownerName = String(body.ownerName ?? "").trim();
  const ownerPassword = String(body.ownerPassword ?? "").trim() || crypto.randomBytes(12).toString("base64url");
  let made: { id: string; owner: User };
  try {
    made = await withRawTransaction(async (db) => {
      // id 는 여기서 정한다 — **트랜잭션 안에서** 읽고 써야 두 개가 동시에 만들어져도
      // 같은 번호가 둘 생기지 않는다(최악이 PK 충돌 409, 조용한 중복이 아니다).
      let id = plan.id;
      if (!id) {
        const { rows } = await db.query(`SELECT id FROM tenants`);
        id = nextTenantId(rows.map((r: { id: string }) => r.id));
      }
      // credit_ledger 는 RLS FORCE 라, 스코프 없는 rawPool 트랜잭션에서 새 테넌트 행을 넣으면
      // WITH CHECK 에 막힌다(app.tenant_id 미설정 → 새 id 도 '*' 도 아님 → "violates RLS policy").
      // 이 트랜잭션 동안만 새 테넌트로 스코프를 세운다 — is_local=true 라 COMMIT/ROLLBACK 시 리셋된다.
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      await db.query(`INSERT INTO tenants (id, name, kind, billing_email) VALUES ($1,$2,$3,$4)`, [
        id, plan.name, plan.kind, plan.billingEmail,
      ]);
      // 초기 크레딧은 무상 지급(grant)이다 — 결제 원장(topup)과 섞이면 매출이 부풀어 보인다.
      if (plan.initialCredits > 0) {
        await db.query(
          `INSERT INTO credit_ledger (tenant_id, delta, reason, note, actor, dedupe_key)
           VALUES ($1,$2,'grant',$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
          [id, plan.initialCredits, "개설 지급", actor.email, grantDedupeKey(id)],
        );
      }
      const owner = await createUser({
        tenantId: id, email: plan.ownerEmail, name: ownerName, password: ownerPassword, role: "owner",
      }, db);
      return { id, owner };
    });
  } catch (e: any) {
    if (e?.code === "23505") {
      return c.json({ error: "duplicate_id", message: "같은 순간에 다른 회사가 만들어졌습니다 — 다시 시도해 주세요." }, 409);
    }
    // 초대 실패(이미 계정이 있는 이메일 등)도 여기로 온다 — 회사는 만들어지지 않았다.
    return c.json({ error: "create_failed", message: String(e?.message ?? e) }, 400);
  }
  // 감사는 **만들어진 뒤**에 남긴다 — id 가 트랜잭션 안에서 정해지므로, 앞에 두면
  // 기록에 남는 대상이 null 이 된다.
  await audit(
    actor,
    {
      action: "tenant.create",
      targetTenant: made.id,
      detail: { name: plan.name, kind: plan.kind, ownerEmail: plan.ownerEmail, ownerName, initialCredits: plan.initialCredits },
    },
    clientIp(c),
  );

  // 테넌트가 둘 이상이 되는 순간 인증 없이 도는 건 위험하다 — 즉시 자세를 다시 점검한다.
  await assertAuthPosture();
  return c.json({
    id: made.id,
    name: plan.name,
    ownerEmail: plan.ownerEmail,
    initialCredits: plan.initialCredits,
    owner: made.owner,
    temporaryPassword: ownerPassword,
    // 운영자가 그대로 복사해 보낼 수 있는 링크. PUBLIC_URL 이 없으면 null(가짜 링크는 안 만든다).
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
  const reason = c.req.query("reason") ?? null;
  await audit(actor, { action: "user.list", targetTenant: tenant, reason }, clientIp(c));
  // 읽기에는 사유를 요구하지 않는다 (2026-08-11 결정 · docs/plans/admin-multi-tenant-plan.md).
  // 운영자가 조회할 때마다 사유를 적어야 하면 지원이 안 굴러간다. 대신 **누가 무엇을 봤는지는
  // 반드시 남긴다** — 다 볼 수 있게 열어 준 만큼 견제는 기록으로 한다. 쓰기는 여전히 사유 강제.
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
/** A company-first admin payload. It keeps related operational decisions in one place. */
app.get("/api/superadmin/tenants/:id/detail", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  await audit(actor, { action: "tenant.detail.view", targetTenant: tenantId }, clientIp(c));
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const [tenantResult, membersResult, scoped] = await Promise.all([
    getRawPool().query(
      `SELECT id, name, kind, status, billing_email AS "billingEmail", created_at AS "createdAt"
         FROM tenants WHERE id = $1`, [tenantId]),
    getRawPool().query(
      `SELECT id, email, name, role, status, created_at AS "createdAt", last_login_at AS "lastLoginAt"
         FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]),
    asSystem(async (db) => {
      const [credits, media, channels, jobs, payments, activity] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(delta), 0)::int AS balance,
                         COALESCE(SUM(CASE WHEN delta < 0 AND occurred_at >= date_trunc('month', now()) THEN -delta ELSE 0 END), 0)::int AS "usedThisMonth"
                    FROM credit_ledger WHERE tenant_id = $1`, [tenantId]),
        db.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(durationSec), 0)::float AS seconds
                    FROM media WHERE tenant_id = $1`, [tenantId]),
        db.query(`SELECT COUNT(*)::int AS count FROM youtube_channels WHERE tenant_id = $1`, [tenantId]),
        db.query(`SELECT id, type, status, attempts, error, updatedat AS "updatedAt"
                    FROM job_queue WHERE tenant_id = $1 AND status IN ('failed', 'pending', 'running')
                   ORDER BY updatedat DESC LIMIT 20`, [tenantId]),
        db.query(`SELECT payment_id AS "paymentId", credits, amount_krw AS "amountKrw", status,
                         requested_by AS "requestedBy", created_at AS "createdAt", settled_at AS "settledAt"
                    FROM credit_topup WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [tenantId]),
        db.query(`SELECT COALESCE(SUM(ca.views), 0)::bigint AS views,
                         COALESCE(SUM(ca.estimatedMinutesWatched), 0)::bigint AS "minutesWatched",
                         COALESCE(SUM(ca.subscribersGained - ca.subscribersLost), 0)::bigint AS "netSubscribers",
                         COALESCE(SUM(ca.estimatedRevenue), 0)::float8 AS revenue
                    FROM channel_analytics ca JOIN youtube_channels yc ON yc.channelid = ca.channelid
                   WHERE yc.tenant_id = $1 AND ca.day >= $2`, [tenantId, from]),
      ]);
      return { credits: credits.rows[0], media: media.rows[0], channels: channels.rows[0], jobs: jobs.rows, payments: payments.rows, activity: activity.rows[0] };
    }),
  ]);
  const tenant = tenantResult.rows[0];
  if (!tenant) return c.json({ error: "not_found" }, 404);
  const { rows: auditRows } = await getRawPool().query(
    `SELECT id, actor_email AS "actorEmail", action, target_id AS "targetId", reason, detail, at
       FROM admin_audit WHERE target_tenant = $1 AND action NOT LIKE '%.list' AND action NOT LIKE '%.view'
      ORDER BY at DESC LIMIT 50`, [tenantId]);
  return c.json({
    tenant,
    members: membersResult.rows,
    summary: {
      members: membersResult.rows.filter((row: any) => row.status === "active").length,
      mediaCount: Number(scoped.media?.count ?? 0),
      mediaMinutes: Math.round(Number(scoped.media?.seconds ?? 0) / 60),
      credits: Number(scoped.credits?.balance ?? 0),
      usedThisMonth: Number(scoped.credits?.usedThisMonth ?? 0),
      channels: Number(scoped.channels?.count ?? 0),
      failedJobs: scoped.jobs.filter((job: any) => job.status === "failed").length,
      performance: scoped.activity,
    },
    jobs: scoped.jobs,
    payments: scoped.payments,
    audit: auditRows,
  });
});

app.get("/api/superadmin/tenants/:id/performance", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  await audit(actor, { action: "tenant.performance.view", targetTenant: tenantId }, clientIp(c));
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const { summary, channels, daily } = await asSystem(async (db) => {
    const [summaryResult, channelResult, dailyResult] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(ca.views), 0)::bigint AS views,
                       COALESCE(SUM(ca.estimatedMinutesWatched), 0)::bigint AS "minutesWatched",
                       COALESCE(SUM(ca.subscribersGained - ca.subscribersLost), 0)::bigint AS "netSubscribers",
                       COALESCE(SUM(ca.estimatedRevenue), 0)::float8 AS revenue
                  FROM channel_analytics ca JOIN youtube_channels yc ON yc.channelid = ca.channelid
                 WHERE yc.tenant_id = $1 AND ca.day >= $2`, [tenantId, from]),
      db.query(`SELECT yc.channelid AS "channelId", yc.channelname AS "channelName", yc.status,
                       COALESCE(SUM(ca.views), 0)::bigint AS views,
                       COALESCE(SUM(ca.estimatedMinutesWatched), 0)::bigint AS "minutesWatched",
                       COALESCE(SUM(ca.subscribersGained - ca.subscribersLost), 0)::bigint AS "netSubscribers",
                       COALESCE(SUM(ca.estimatedRevenue), 0)::float8 AS revenue
                  FROM youtube_channels yc LEFT JOIN channel_analytics ca ON ca.channelid = yc.channelid AND ca.day >= $2
                 WHERE yc.tenant_id = $1
                 GROUP BY yc.channelid, yc.channelname, yc.status ORDER BY views DESC`, [tenantId, from]),
      db.query(`SELECT ca.day, COALESCE(SUM(ca.views), 0)::bigint AS views
                  FROM channel_analytics ca JOIN youtube_channels yc ON yc.channelid = ca.channelid
                 WHERE yc.tenant_id = $1 AND ca.day >= $2 GROUP BY ca.day ORDER BY ca.day ASC`, [tenantId, from]),
    ]);
    return { summary: summaryResult.rows[0], channels: channelResult.rows, daily: dailyResult.rows };
  });
  return c.json({ from, summary, channels, daily });
});

app.post("/api/superadmin/tenants/:id/members", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const reason = requireReason(actor, tenantId, "admin_member_manage");
  const body = await c.req.json<{ email?: string; name?: string; role?: string; password?: string }>()
    .catch(() => ({} as { email?: string; name?: string; role?: string; password?: string }));
  const email = String(body.email ?? "").trim();
  if (!email) return c.json({ error: "email_required" }, 400);
  const role = ["owner", "admin", "member"].includes(String(body.role)) ? body.role as "owner" | "admin" | "member" : "member";
  const password = String(body.password ?? "").trim() || crypto.randomBytes(12).toString("base64url");
  try {
    const member = await createUser({ tenantId, email, name: String(body.name ?? "").trim(), role, password });
    await audit(actor, { action: "member.create", targetTenant: tenantId, targetId: member.id, reason, detail: { email: member.email, name: member.name, role } }, clientIp(c));
    return c.json({ member, temporaryPassword: password }, 201);
  } catch (error: any) {
    return c.json({ error: "member_create_failed", message: String(error?.message ?? error) }, 400);
  }
});

app.post("/api/superadmin/users/:id/password", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
  const { rows } = await getRawPool().query(`SELECT tenant_id AS "tenantId", email FROM users WHERE id = $1`, [id]);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, rows[0].tenantId, "admin_password_reset");
  const password = String(body.password ?? "").trim() || crypto.randomBytes(12).toString("base64url");
  try {
    await setPassword(id, password);
    await destroyAllSessions(id);
    await audit(actor, { action: "member.password_reset", targetTenant: rows[0].tenantId, targetId: id, reason, detail: { email: rows[0].email } }, clientIp(c));
    return c.json({ ok: true, temporaryPassword: password });
  } catch (error: any) {
    return c.json({ error: "password_reset_failed", message: String(error?.message ?? error) }, 400);
  }
});

app.delete("/api/superadmin/users/:id", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  if (id === actor.id) return c.json({ error: "cannot_delete_self" }, 400);
  const { rows } = await getRawPool().query(`SELECT tenant_id AS "tenantId", email, role, status FROM users WHERE id = $1`, [id]);
  const member = rows[0] as { tenantId: string; email: string; role: string; status: string } | undefined;
  if (!member) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, member.tenantId, "admin_member_delete");
  if (member.role === "superadmin") return c.json({ error: "cannot_delete_superadmin" }, 400);
  if (member.status === "active" && member.role === "owner" && await countActiveOwners(member.tenantId) <= 1) {
    return c.json({ error: "last_owner" }, 400);
  }
  await audit(actor, { action: "member.delete", targetTenant: member.tenantId, targetId: id, reason, detail: { email: member.email, role: member.role } }, clientIp(c));
  await withRawTransaction(async (db) => {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    await db.query("DELETE FROM users WHERE id = $1", [id]);
  });
  return c.json({ ok: true });
});

app.post("/api/superadmin/jobs/:id/retry", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  const now = Date.now();
  const { rows } = await asSystem((db) => db.query(`SELECT tenant_id AS "tenantId", type FROM job_queue WHERE id = $1`, [id]));
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, rows[0].tenantId, "admin_job_retry");
  const changed = await asSystem((db) => db.query(
    `UPDATE job_queue SET status = 'pending', attempts = 0, error = NULL, lockedat = NULL, runafter = $2, updatedat = $2
      WHERE id = $1 AND status = 'failed'`, [id, now]));
  if (!changed.rowCount) return c.json({ error: "not_retryable" }, 409);
  await audit(actor, { action: "job.retry", targetTenant: rows[0].tenantId, targetId: id, reason, detail: { type: rows[0].type } }, clientIp(c));
  return c.json({ ok: true });
});

app.delete("/api/superadmin/jobs/:id", async (c) => {
  const actor = requireSuperadmin(c);
  const id = c.req.param("id");
  const { rows } = await asSystem((db) => db.query(`SELECT tenant_id AS "tenantId", type, status FROM job_queue WHERE id = $1`, [id]));
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const reason = requireReason(actor, rows[0].tenantId, "admin_job_remove");
  const deleted = await asSystem((db) => db.query(`DELETE FROM job_queue WHERE id = $1 AND status IN ('pending', 'failed')`, [id]));
  if (!deleted.rowCount) return c.json({ error: "cannot_remove_running" }, 409);
  await audit(actor, { action: "job.remove", targetTenant: rows[0].tenantId, targetId: id, reason, detail: { type: rows[0].type, status: rows[0].status } }, clientIp(c));
  return c.json({ ok: true });
});

app.get("/api/superadmin/jobs", async (c) => {
  const actor = requireSuperadmin(c);
  const tenant = c.req.query("tenant") ?? null;
  await audit(actor, { action: "job.list", targetTenant: tenant }, clientIp(c));
  const { rows } = await asSystem((db) => db.query(
    `SELECT id, type, status, attempts, tenant_id AS "tenantId", error,
            createdat AS "createdAt", updatedat AS "updatedAt"
       FROM job_queue ${tenant ? "WHERE tenant_id = $1" : ""}
      ORDER BY updatedAt DESC LIMIT 200`,
    tenant ? [tenant] : [],
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
  const body = await c.req.json<{ name?: string; reason?: string; scopes?: unknown }>()
    .catch(() => ({}) as any);
  const reason = requireReason(actor, tenantId, body.reason);

  // 모르는 스코프는 버린다. 다 버려서 비면 **키를 만들지 않는다** — 아무것도 못 하는 키를
  // 쥐여 주면 고객사는 그게 권한 문제인지 장애인지 구분하지 못한다.
  // scopes 를 안 보내면(구 admin UI) 기존 동작대로 전체 표면을 준다.
  const scopes = body.scopes === undefined ? [...API_SCOPES] : normalizeScopes(body.scopes);
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

/**
 * 키 회전 — 같은 회사·이름·스코프로 **새 키를 먼저 발급**하고 옛 키를 폐기한다.
 * 순서가 반대면 새 키 배포 전 인증이 통째로 끊기는 창이 생긴다. revoke+create 를 손으로
 * 두 번 하는 것보다 실수(스코프 누락)가 없다. 새 평문은 이 응답에만 1회 노출된다.
 */
app.post("/api/superadmin/api-keys/:keyId/rotate", async (c) => {
  const actor = requireSuperadmin(c);
  const keyId = c.req.param("keyId");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as any);
  const { rows } = await asSystem((db) => db.query(
    `SELECT tenant_id AS "tenantId", name, scopes FROM api_keys WHERE id = $1`, [keyId]));
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const old = rows[0] as { tenantId: string; name: string | null; scopes: string[] };
  const reason = requireReason(actor, old.tenantId, body.reason);
  const scopes = Array.isArray(old.scopes) ? old.scopes : [];
  const raw = generateKey(true);
  const newId = `ak_${crypto.randomBytes(9).toString("base64url")}`;
  await audit(
    actor,
    { action: "apikey.rotate", targetTenant: old.tenantId, targetId: newId, reason, detail: { replaced: keyId, scopes } },
    clientIp(c),
  );
  await asSystem((db) => db.query(
    `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId, old.tenantId, old.name ?? null, hashKey(raw), keyPrefix(raw), scopes]));
  await asSystem((db) => db.query(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [keyId]));
  return c.json({ id: newId, key: raw, prefix: keyPrefix(raw), scopes, replaced: keyId });
});

// ── 결제 · 크레딧 (4단계) ─────────────────────────────────────────────────────

/**
 * 결제 로그 — 전 회사의 충전 주문. `credit_topup` 이 곧 결제 이력이다.
 *
 * `pending` 이 오래 남아 있으면 **결제창까지 갔다가 안 된 건**이다. 그게 몇 건인지 보이는 게
 * 이 화면의 목적이라, 성공한 것만 보여주지 않는다.
 */
/**
 * 인보이스(거래명세서) — 회사·월 단위.
 *
 * ⚠️ **세금계산서가 아니다.** 전자세금계산서는 국세청 신고가 필요한 법정 증빙이라 별도
 * 발행 서비스(팝빌·바로빌 등)를 붙여야 한다. 여기서 주는 건 우리 데이터로 만든 명세다.
 *
 * 금액은 원장이 아니라 **결제**에서 온다 — 원장에는 무상 지급(grant)·정정(adjust)이
 * 섞여 있고, 그걸 청구서에 얹으면 받지도 않은 돈을 청구하는 게 된다.
 */
app.get("/api/superadmin/tenants/:id/invoice", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const month = parseMonth(c.req.query("month"));
  if (!month) return c.json({ error: "bad_month", message: "month 는 YYYY-MM 형식이어야 합니다." }, 400);
  await audit(actor, { action: "invoice.view", targetTenant: tenantId, detail: { month: month.key } }, clientIp(c));

  const range = monthRange(month.year, month.month);
  const { rows: tenantRows } = await getRawPool().query(
    `SELECT id, name, billing_email AS "billingEmail" FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenantRows[0]) return c.json({ error: "not_found" }, 404);

  const { rows: payments } = await asSystem((db) => db.query(
    `SELECT payment_id AS "paymentId", credits, amount_krw AS "amountKrw", status,
            created_at AS "createdAt", settled_at AS "settledAt"
       FROM credit_topup
      WHERE tenant_id = $1 AND created_at >= $2::date AND created_at < $3::date
      ORDER BY created_at ASC`,
    [tenantId, range.from, range.to],
  ));

  const issuer = issuerInfo();
  const profile = await asSystem((db) => getBusinessProfile(db, tenantId));
  const invoice = buildInvoice({ tenantId, monthKey: month.key, payments });
  return c.json({
    invoice,
    // 문서에 찍히는 건 등기상 **상호**다 — 화면에서 부르는 이름과 다를 수 있다.
    customer: { ...tenantRows[0], profile, incomplete: incompleteFields(profile) },
    issuer: issuer.issuer,
    // 없는 값을 지어내지 않는다 — 빠진 항목을 그대로 알려주고 화면이 경고한다.
    issuerMissing: issuer.ok ? [] : issuer.missing,
    note: "세금계산서가 아닙니다 (거래명세서).",
  });
});

/** 회사 사업자정보 — 거래명세서의 "공급받는 자". */
app.get("/api/superadmin/tenants/:id/business", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  await audit(actor, { action: "business.view", targetTenant: tenantId }, clientIp(c));
  const profile = await asSystem((db) => getBusinessProfile(db, tenantId));
  return c.json({ profile, incomplete: incompleteFields(profile) });
});

app.put("/api/superadmin/tenants/:id/business", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const reason = requireReason(actor, tenantId, body.reason);

  const checked = checkProfile(body);
  if (!checked.ok) return c.json({ error: "bad_request", field: checked.field, message: checked.message }, 400);

  await audit(
    actor,
    { action: "business.update", targetTenant: tenantId, reason, detail: { bizNo: checked.profile.bizNo } },
    clientIp(c),
  );
  const saved = await asSystem((db) =>
    saveBusinessProfile(db, tenantId, { ...checked.profile, updatedBy: actor.email }));
  return c.json({ ok: true, profile: saved, incomplete: incompleteFields(saved) });
});

/** 인보이스를 뽑을 수 있는 달 — 결제가 있는 달만. 빈 달을 고르게 두면 빈 문서가 나온다. */
app.get("/api/superadmin/tenants/:id/invoice-months", async (c) => {
  const actor = requireSuperadmin(c);
  // 결제 금액이 실린 목록이라 열람도 남긴다. 인보이스 화면을 열면 이 라우트와
  // /invoice 가 각각 한 줄씩 남지만, **기록이 빠진 라우트를 만드는 것보다 낫다.**
  await audit(actor, { action: "invoice.months", targetTenant: c.req.param("id") }, clientIp(c));
  const { rows } = await asSystem((db) => db.query(
    `SELECT to_char(created_at, 'YYYY-MM') AS month,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(SUM(amount_krw) FILTER (WHERE status = 'paid'), 0)::int AS "totalKrw"
       FROM credit_topup WHERE tenant_id = $1
      GROUP BY 1 HAVING COUNT(*) FILTER (WHERE status = 'paid') > 0
      ORDER BY 1 DESC LIMIT 36`,
    [c.req.param("id")],
  ));
  return c.json({ months: rows });
});

app.get("/api/superadmin/payments", async (c) => {
  const actor = requireSuperadmin(c);
  const tenant = c.req.query("tenant") ?? null;
  await audit(actor, { action: "payment.list", targetTenant: tenant }, clientIp(c));
  const { rows } = await asSystem((db) => db.query(
    `SELECT payment_id AS "paymentId", tenant_id AS "tenantId", credits,
            amount_krw AS "amountKrw", status, requested_by AS "requestedBy",
            created_at AS "createdAt", settled_at AS "settledAt"
       FROM credit_topup ${tenant ? "WHERE tenant_id = $1" : ""}
      ORDER BY created_at DESC LIMIT 300`,
    tenant ? [tenant] : [],
  ));
  return c.json({ payments: rows });
});

/** 한 회사의 크레딧 원장 + 잔액. 잔액은 **원장 합계**다 — 따로 저장하지 않는다. */
app.get("/api/superadmin/tenants/:id/credits", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  await audit(actor, { action: "credit.list", targetTenant: tenantId }, clientIp(c));
  const { entries, balance } = await asSystem(async (db) => {
    const [led, bal] = await Promise.all([
      db.query(
        `SELECT id, delta, reason, media_id AS "mediaId", payment_id AS "paymentId",
                amount_krw AS "amountKrw", note, actor, occurred_at AS "occurredAt"
           FROM credit_ledger WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
        [tenantId],
      ),
      db.query(`SELECT COALESCE(SUM(delta), 0)::int AS n FROM credit_ledger WHERE tenant_id = $1`, [tenantId]),
    ]);
    return { entries: led.rows, balance: bal.rows[0]?.n ?? 0 };
  });
  return c.json({ entries, balance, reasons: MANUAL_REASONS, unit: CREDIT_UNIT_LABEL });
});

/**
 * 운영자 수동 조정 — 무상 지급·정정·환불분 회수.
 *
 * **원장은 append-only 다**(0024 트리거). 정정도 반대 부호 행을 쌓는 것이지 지우는 게 아니라,
 * 잘못 넣으면 기록이 영구히 남는다. 그래서 사유(감사용) + 메모(원장에 남는 설명)를 둘 다 받는다.
 */
app.post("/api/superadmin/tenants/:id/credits", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const reason = requireReason(actor, tenantId, body.reason);

  const checked = planManualCredit({ delta: body.delta, reason: body.kind, note: body.note });
  if (!checked.ok) return c.json({ error: "bad_request", message: checked.message }, 400);

  // 멱등키는 **클라이언트가 보낸 nonce** 로 만든다. 서버에서 매번 랜덤으로 만들면
  // ON CONFLICT (dedupe_key) 가 충돌할 일이 없어 중복 방지가 장식이 된다 — 느린 응답에
  // 재클릭하거나 네트워크가 재전송하면 지급·차감이 두 번 쌓이고, credit_ledger 는
  // append-only(0024)라 되돌릴 수도 없다. nonce 가 없으면 (금액·사유·메모)로 만든다:
  // 같은 조정을 연달아 두 번 누른 경우를 막는 게 목적이고, 진짜로 두 번 넣어야 하면
  // 메모를 달리 쓰면 된다.
  // 폴백 키에는 5분 버킷을 넣는다 — 같은 조정을 나중에 정말 한 번 더 해야 할 때까지
  // 막지는 않으면서, 연달아 두 번 도달하는 것만 막는다.
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const nonce = String(body.nonce ?? "").trim()
    || `${checked.delta}:${checked.reason}:${checked.note ?? ""}:${bucket}`;
  const dedupeKey = manualDedupeKey(tenantId, nonce);
  await audit(
    actor,
    {
      action: "credit.adjust",
      targetTenant: tenantId,
      reason,
      detail: { delta: checked.delta, kind: checked.reason, note: checked.note },
    },
    clientIp(c),
  );
  const { balance, applied } = await asSystem(async (db) => {
    const ins = await db.query(
      `INSERT INTO credit_ledger (tenant_id, delta, reason, note, actor, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
      [tenantId, checked.delta, checked.reason, checked.note, actor.email, dedupeKey],
    );
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(delta), 0)::int AS n FROM credit_ledger WHERE tenant_id = $1`,
      [tenantId],
    );
    return { balance: rows[0]?.n ?? 0, applied: (ins.rowCount ?? 0) > 0 };
  });
  // 중복이라 안 쌓인 건 **그렇다고 말한다** — ok:true 만 주면 운영자는 적용된 줄 안다.
  return c.json({
    ok: true, delta: checked.delta, balance, applied,
    ...(applied ? {} : { duplicate: true, message: "같은 조정이 방금 이미 반영돼 있어 다시 쌓지 않았습니다." }),
  });
});

/** 감사 로그. superadmin 이 서로를 볼 수 있어야 견제가 성립한다. */
app.get("/api/superadmin/audit", async (c) => {
  requireSuperadmin(c);   // 감사 로그 열람 자체는 감사하지 않는다 — 무한 증식만 만든다
  const tenant = c.req.query("tenant") ?? null;
  const q = (c.req.query("q") ?? "").trim();
  // 300건 하드캡 + 부분검색만으로는 컴플라이언스 조회가 안 된다 → 기간(from/to) + 한도 + CSV 추가.
  const fromMs = Date.parse(c.req.query("from") ?? "");
  const toMs = Date.parse(c.req.query("to") ?? "");
  const csv = c.req.query("format") === "csv";
  const limit = Math.min(5000, Math.max(1, Number(c.req.query("limit")) || 300));
  const where: string[] = [];
  const args: unknown[] = [];
  if (tenant) { args.push(tenant); where.push(`target_tenant = $${args.length}`); }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(actor_email ILIKE $${args.length} OR action ILIKE $${args.length}
                 OR target_id ILIKE $${args.length} OR reason ILIKE $${args.length})`);
  }
  // at 은 Date.now() ms(BIGINT)로 저장된다 — from/to 도 ms 로 비교한다.
  if (Number.isFinite(fromMs)) { args.push(fromMs); where.push(`at >= $${args.length}`); }
  if (Number.isFinite(toMs)) { args.push(toMs + 86_399_999); where.push(`at <= $${args.length}`); }
  const { rows } = await getRawPool().query(
    `SELECT id, actor_email AS "actorEmail", action, target_tenant AS "targetTenant",
            target_id AS "targetId", reason, detail, ip, at
       FROM admin_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY at DESC LIMIT ${limit}`,
    args,
  );
  if (csv) {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["at", "actorEmail", "action", "targetTenant", "targetId", "reason", "ip"];
    const lines = [head.join(",")];
    for (const r of rows as Record<string, unknown>[]) {
      lines.push([new Date(Number(r.at)).toISOString(), r.actorEmail, r.action, r.targetTenant, r.targetId, r.reason, r.ip].map(esc).join(","));
    }
    // BOM — Excel 이 UTF-8 한글을 깨지 않게.
    return c.body("﻿" + lines.join("\r\n"), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="admin-audit-${Date.now()}.csv"`,
    });
  }
  return c.json({ entries: rows });
});

/**
 * 메타데이터 수정 로그 — **AI 원본 → 사용자 최종**(워크스페이스별 학습 데이터 · 사용자 2026-08-21).
 * 관리 콘솔이 "AI 가 뽑은 값 vs 회사가 고친 값" 을 회사·장르별로 본다. `was_ai=true` 만 순수
 * AI→사람 페어(재수정분 제외). json(콘솔) · `?format=csv`(엑셀) · `?format=jsonl`(학습). `?tenant=`·`?limit=`.
 */
app.get("/api/superadmin/metadata-edits", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.query("tenant") || undefined;
  // 열람도 감사에 남긴다(운영자 견제 · superadmin-guard 테스트 강제). 이 로그는 metadata_edit_log
  // 를 **읽고** admin_audit 에 쓰므로 /audit 처럼 무한 증식하지 않는다.
  await audit(actor, { action: "metadata-edits.view", targetTenant: tenantId ?? null }, clientIp(c));
  const limit = Math.min(50000, Math.max(1, Number(c.req.query("limit")) || 2000));
  const rows = await runAsSystem(() => listMetadataEdits({ tenantId, limit }));
  const format = c.req.query("format");
  if (format === "jsonl") {
    const body = (rows as Record<string, unknown>[]).map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    return c.body(body, 200, { "content-type": "application/x-ndjson; charset=utf-8" });
  }
  if (format === "csv") {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["created_at", "tenant_id", "clip_id", "program_id", "genre", "channel", "field", "ai_original", "user_final", "was_ai", "editor"];
    const lines = [head.join(",")];
    for (const r of rows as Record<string, any>[]) {
      lines.push([new Date(Number(r.created_at)).toISOString(), r.tenant_id, r.clip_id, r.program_id, r.genre,
        r.channel, r.field, r.ai_original, r.user_final, r.was_ai, r.editor].map(esc).join(","));
    }
    return c.body("﻿" + lines.join("\r\n"), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="metadata-edits-${Date.now()}.csv"`,
    });
  }
  return c.json({ rows });
});

/**
 * 사용 원가 · 충전액 · 마진 — 플랫폼/회사별. `usage_events.cost_krw` 는 우리 **실측 원가**
 * (청구액이 아니다)인데 지금까지 어디에도 노출되지 않아 마진을 볼 수 없었다. 충전(credit_topup)과
 * 나란히 두어 회사별 원가/매출/마진을 본다. 두 표 모두 RLS 라 asSystem('*') 로 횡단 집계한다.
 */
app.get("/api/superadmin/usage", async (c) => {
  const actor = requireSuperadmin(c);
  const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
  // 회사별 원가·매출을 횡단으로 보는 열람이라 기록을 남긴다("누가 봤나" — admin.ts 원칙 3).
  await audit(actor, { action: "usage.view", detail: { days } }, clientIp(c));
  const iv = `${days} days`;
  const [cost, rev] = await asSystem((db) => Promise.all([
    db.query(
      `SELECT tenant_id AS "tenantId",
              COALESCE(SUM(quantity) FILTER (WHERE kind='analyze_minutes'),0)::float AS minutes,
              COALESCE(SUM(cost_krw),0)::float AS "costKrw",
              COUNT(*)::int AS events
         FROM usage_events WHERE occurred_at >= now() - $1::interval
        GROUP BY tenant_id`, [iv]),
    db.query(
      `SELECT tenant_id AS "tenantId", COALESCE(SUM(amount_krw),0)::float AS "revenueKrw"
         FROM credit_topup WHERE status='paid' AND created_at >= now() - $1::interval
        GROUP BY tenant_id`, [iv]),
  ]));
  const revBy = new Map<string, number>((rev.rows as any[]).map((r) => [r.tenantId, Number(r.revenueKrw)]));
  const byTenant = (cost.rows as any[]).map((r) => {
    const revenueKrw = revBy.get(r.tenantId) ?? 0;
    revBy.delete(r.tenantId);
    const costKrw = Number(r.costKrw);
    return { tenantId: r.tenantId, minutes: Number(r.minutes), events: r.events, costKrw, revenueKrw, marginKrw: revenueKrw - costKrw };
  });
  // 원가는 없고 충전만 있는 회사도 포함(순마진 플러스로).
  for (const [tenantId, revenueKrw] of revBy) {
    byTenant.push({ tenantId, minutes: 0, events: 0, costKrw: 0, revenueKrw, marginKrw: revenueKrw });
  }
  byTenant.sort((a, b) => b.costKrw - a.costKrw);
  const totals = byTenant.reduce(
    (t, r) => ({ minutes: t.minutes + r.minutes, costKrw: t.costKrw + r.costKrw, revenueKrw: t.revenueKrw + r.revenueKrw }),
    { minutes: 0, costKrw: 0, revenueKrw: 0 },
  );
  return c.json({ days, totals: { ...totals, marginKrw: totals.revenueKrw - totals.costKrw }, byTenant });
});

// ── full state (web InitialData + media) ──────────────────────────────────────
//
// ⚠️ 고객사 API 키 호출에는 **clips[].editorState 를 빼고 준다.**
// 2026-08-27 실측: 응답 18.9MB 중 17.3MB(92%)가 editorState 였고, 그 때문에 고객사 화면
// (aena 자동배포)이 뜨는 데 3.5~6.4초가 걸렸다 — 30초 폴링이라 계속 반복된다.
// editorState 는 **우리 편집기 전용 내부 상태**라 고객사 API 로는 쓸 일이 없다(파트너
// 응답 계약: 목록·상태·배포 기록). 웹(세션) 호출은 편집기가 그걸로 화면을 그리므로 그대로 둔다.
app.get("/api/state", async (c) => {
  const state = await getState();
  if (currentContext()?.via !== "api-key") return c.json(state);
  const clips = Array.isArray((state as { clips?: unknown[] }).clips) ? (state as { clips: unknown[] }).clips : [];
  return c.json({
    ...state,
    clips: clips.map((clip) => {
      if (!clip || typeof clip !== "object") return clip;
      const { editorState: _drop, ...rest } = clip as Record<string, unknown>;
      return rest;
    }),
  });
});

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

  // q 가 비어 있으면 파서·임베딩을 건너뛰고 기본 목록 — 필터는 그대로, 하이라이트 순.
  // 검색어 없이 화면에 들어와도 뭐라도 떠야 한다 (2026-08-12).
  if (!q) {
    const query: SearchQuery = {
      programId,
      genre: c.req.query("genre") || undefined,
      scopeType: c.req.query("scope_type") || undefined,
      scopeId: c.req.query("scope_id") || undefined,
      episode: c.req.query("episode") || undefined,
      airedFrom: c.req.query("aired_from") || undefined,
      airedTo: c.req.query("aired_to") || undefined,
      characters: explicitChars.length ? explicitChars : undefined,
      sceneType: c.req.query("scene_type") || undefined,
      isShort: explicitIsShort,
      allowSpoiler: c.req.query("allow_spoiler") === "true",
      topK: c.req.query("top_k") ? Number(c.req.query("top_k")) : 30,
    };
    let hits: SearchHit[];
    try {
      hits = await searchSegments(query);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e), results: [] }, 500);
    }
    return c.json({
      query: "",
      parsed: { empty: true, characters: [], semantic: "", charactersUsed: query.characters ?? [] },
      embedded: false,
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
  }

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

  // 예전엔 여기서 SMR 피드 메타(programCode·category·weekdays)를 받아 program.smr 에 저장했다.
  // **읽는 곳이 어디에도 없었다** — 실제 네이버 발행은 브라우저 자동화 경로(naver.publish)라
  // 이 값들을 쓰지 않는다. 운영자가 채워 넣어도 아무 데도 닿지 않는 폼이라 제거했다.
  // (2026-08-12. 네이버 발행에 실제로 필요한 것은 배포채널 화면의 네이버 계정 + 세션이다.)

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
// 출연자는 채우지 않음. 결과는 저장하지 않고 반환만 — 사용자가 UI에서 확인 후 저장.
app.post("/api/programs/:id/autofill", async (c) => {
  const id = c.req.param("id");
  const program = await getEntity<Record<string, unknown>>("program", id);
  if (!program) return c.json({ error: "program not found" }, 404);
  const title = typeof program.title === "string" ? program.title.trim() : "";
  if (!title) return c.json({ error: "program title empty" }, 400);

  const cwd = REPO_ROOT;

  const result: unknown = await new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON, ["-X", "utf8", "-m", "core.common.autofill_program", "--mode", "questions", title], {
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
      "-X", "utf8", "-m", "core.common.autofill_program",
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
    // 프로그램별 커스텀 프롬프트 2종 — titlePrompt(제목 생성에 얹는 지시) ·
    // recommendPrompt(beat 이어붙여 추천 구간 만들 때 얹는 지시). 소비처: core recommend
    // 프롬프트(program_context.json 경유) + clip-metadata·regenerate-titles. 빈 문자열 = 삭제.
    "titlePrompt", "recommendPrompt",
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
  // 쇼츠 브랜딩 아이콘(data URL) — 자동 렌더 하단의 원형 아이콘. 프로그램에서 미리 설정한다
  // (사용자 결정 2026-08-12). 빈 문자열이면 삭제.
  if (typeof body.brandIconDataUrl === "string") {
    const s = body.brandIconDataUrl.trim();
    if (s) next.brandIconDataUrl = s;
    else delete next.brandIconDataUrl;
  }
  // 자동배포 기본값 — 자동배포 화면에서 프로그램별로 저장 (채널·템플릿). null 이면 해제.
  if (body.autoPublish === null) {
    delete next.autoPublish;
  } else if (body.autoPublish && typeof body.autoPublish === "object" && !Array.isArray(body.autoPublish)) {
    const ap = body.autoPublish as Record<string, unknown>;
    next.autoPublish = {
      ...(typeof ap.channelId === "string" && ap.channelId.trim() ? { channelId: ap.channelId.trim() } : {}),
      ...(typeof ap.templateId === "string" && ap.templateId.trim() ? { templateId: ap.templateId.trim() } : {}),
    };
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

  // (구 SMR 피드 설정 제거 — 2026-08-12. 읽는 곳이 없는 필드였다. index.ts:1579 주석 참고.
  //  기존 행에 남아 있는 program.smr 값은 건드리지 않는다: 지우는 마이그레이션을 따로 돌리지
  //  않는 한, 쓰지 않는 필드를 저장 때마다 삭제하면 되돌릴 수 없다.)

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

  // 영상 DB(검색 인덱스) 보강 삭제 — media 캐스케이드가 media_id 기준으로 지우지만,
  // media 행이 먼저 사라졌던 과거 삭제의 잔재가 program_id 로 남아 검색에 유령으로 뜬다.
  try {
    await getPool().query("DELETE FROM search_segments WHERE program_id = $1", [id]);
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
  // ⚠️ `requireOpsAccess` 는 이 목적으로 만들어져 있었는데 **어디서도 호출되지 않았다**
  //    (2026-08-12 확인). AUTH_REQUIRED off 면 현상 유지, on 이면 superadmin 필수 —
  //    "잊어버려서 영영 열려 있는" 상태를 피하려고 그렇게 설계된 함수다.
  requireOpsAccess(c);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== "RESET") return c.json({ error: "body.confirm must be 'RESET'" }, 400);

  // Remove stored files first (best-effort) so GCS/local don't accrue orphans.
  // 삭제 실패를 세어 응답에 담는다 — 예전엔 전부 삼키고 ok:true 를 줘서, GCS 객체가 통째로
  // 남아도 "깨끗이 지웠다"로 보고했다. DB reset 은 성공해도 스토리지 고아는 사실대로 알린다.
  const media = await listMedia();
  let storageFailures = 0;
  for (const m of media) {
    try { await deleteFile(parseObjectPath(m.path)); } catch { storageFailures++; }
    if (m.thumbPath) { try { await deleteFile(parseObjectPath(m.thumbPath)); } catch { storageFailures++; } }
    // Analysis artifacts (scene frames + stage outputs) live under analysis/{mediaId}/.
    try { await deletePrefix(`analysis/${m.id}`); } catch { storageFailures++; }
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
  // 영상 DB(검색 인덱스)도 같이 — /api/search 는 media 와 조인하지 않으므로, 안 지우면
  // 초기화 뒤에도 삭제된 회차가 영상검색에 유령으로 계속 뜬다(썸네일·미리보기는 404).
  // 미디어 삭제 캐스케이드(db-pg.ts deleteMediaData)에는 이미 있는데 여기만 빠져 있었다.
  try { await pool.query("DELETE FROM search_segments"); } catch {}

  return c.json({ ok: true, deletedMedia: media.length, storageFailures, orphansMayRemain: storageFailures > 0 });
});

// ── admin: drain the YouTube-analytics job flood + re-kick content.analyze ──
app.post("/api/admin/queue/purge", async (c) => {
  requireOpsAccess(c);
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
  requireOpsAccess(c);
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);
  if (!hasFfmpeg() || !useGcs()) return c.json({ error: "ffmpeg + GCS required" }, 400);
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

/**
 * 캡처 동시성 제한 — 카드 그리드가 프레임 8~10장을 한꺼번에 요청하면 ffmpeg 이 그 수만큼
 * 동시에 떠서 2vCPU 를 나눠 먹고 **전부 7초대**가 된다 (2026-08-12 로그 실측). 2개씩
 * 직렬화하면 개당 ~1초라 전체 체감이 오히려 빨라진다. 캐시 히트는 세마포어를 안 탄다.
 */
const FRAME_CAPTURE_LIMIT = 2;
let frameCaptureActive = 0;
const frameCaptureWaiters: (() => void)[] = [];
async function withFrameCaptureSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (frameCaptureActive >= FRAME_CAPTURE_LIMIT) {
    await new Promise<void>((res) => frameCaptureWaiters.push(res));
  }
  frameCaptureActive++;
  try { return await fn(); }
  finally {
    frameCaptureActive--;
    frameCaptureWaiters.shift()?.();
  }
}

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
    if (!hasFfmpeg()) return c.json({ error: "ffmpeg unavailable" }, 503);
    const masterObjPath = parseObjectPath(m.path);
    if (!(await fileExists(masterObjPath))) return c.json({ error: "source not found" }, 404);
    const srcPath = useGcs() ? await signedReadUrl(masterObjPath, 60 * 60 * 1000) : m.path;
    const tmpDir = path.resolve("/tmp/stepd-frames");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${id}_${key.replace(/\./g, "_")}.jpg`);
    try {
      await withFrameCaptureSlot(async () => {
        // 세마포어 대기 중에 다른 요청이 같은 키를 이미 만들었을 수 있다 — 재확인.
        if (await fileExists(objPath)) return;
        await captureThumbnail(srcPath, clamped, tmpPath);
        await uploadFile(objPath, tmpPath);
      });
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

// ── segment download — 검색 히트 구간을 mp4 로 잘라 준다 ──────────────────────
//
// 캐시: analysis/{id}/segments/{s}_{e}.mp4 (s·e 는 toFixed(2), 점→_). 미스면 원본
// (GCS 서명 URL 또는 로컬 경로)에서 trimEncode 후 업로드·서빙. ffmpeg 동시성은
// frame 캡처와 같은 세마포어를 공유한다 (2vCPU 나눠먹기 방지).
app.get("/api/media/:id/segment", async (c) => {
  const id = c.req.param("id");
  if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad media id" }, 400);
  const start = Number(c.req.query("start"));
  const end = Number(c.req.query("end"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) {
    return c.json({ error: "bad range" }, 400);
  }
  if (end - start > 300) return c.json({ error: "segment too long (max 300s)" }, 400);

  const sKey = start.toFixed(2).replace(/\./g, "_");
  const eKey = end.toFixed(2).replace(/\./g, "_");
  const objPath = `analysis/${id}/segments/${sKey}_${eKey}.mp4`;

  if (!(await fileExists(objPath))) {
    if (!hasFfmpeg()) return c.json({ error: "ffmpeg unavailable" }, 503);
    const m = await getMedia(id);
    if (!m) return c.json({ error: "media not found" }, 404);
    const masterObjPath = parseObjectPath(m.path);
    if (!(await fileExists(masterObjPath))) return c.json({ error: "source not found" }, 404);
    const srcPath = useGcs() ? await signedReadUrl(masterObjPath, 60 * 60 * 1000) : m.path;
    const tmpDir = path.resolve("/tmp/stepd-segments");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${id}_${sKey}_${eKey}.mp4`);
    try {
      await withFrameCaptureSlot(async () => {
        // 대기 중 다른 요청이 같은 구간을 이미 만들었을 수 있다 — 재확인.
        if (await fileExists(objPath)) return;
        await trimEncode(srcPath, start, end, tmpPath);
        await uploadFile(objPath, tmpPath);
      });
    } catch (err) {
      console.error("[segment] trim failed:", err);
      return c.json({ error: "trim failed" }, 500);
    } finally {
      // Cloud Run 의 /tmp 는 tmpfs(RAM) — 반드시 지운다.
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  return new Response(createReadStream(objPath), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="segment_${sKey}-${eKey}.mp4"`,
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ── content analysis result (AI pipeline: transcript + scenes + shorts) ─────────
app.get("/api/media/:id/analysis", async (c) => {
  const row = await getContentAnalysis(c.req.param("id"));
  if (!row) return c.json({ status: "none" }, 404);
  return c.json(row);
});

// ── 파생 컨텐츠 조회 (외부 API 키 대상) ────────────────────────────────────────
// 웹은 /api/state 로 상태를 통째로 받지만, 고객사 API 에 그걸 열면 워크스페이스 전체가
// 새어 나간다. 미디어 하나 단위의 절단면만 준다 — 쇼츠 추천과 클립.

/** 이 미디어의 쇼츠 추천 목록. 분석이 아직이면 404 가 아니라 빈 목록 + 상태를 준다. */
app.get("/api/media/:id/shorts", async (c) => {
  const mediaId = c.req.param("id");
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);
  const episodeId = (media as any).episodeId ?? null;
  const recs = episodeId
    ? (await listEntities<any>("recommendation")).filter((r) => r.episodeId === episodeId)
    : [];
  const analysis = await getContentAnalysis(mediaId);
  return c.json({
    mediaId,
    episodeId,
    analysisStatus: (analysis as any)?.status ?? "none",
    shorts: recs
      .sort((a, b) => (b.score100 ?? 0) - (a.score100 ?? 0))
      .map((r) => ({
        id: r.id,
        title: r.title ?? null,
        startTime: r.startTime ?? null,
        endTime: r.endTime ?? null,
        status: r.status ?? null,
        score100: r.score100 ?? null,
        // ⚠️ 추천 엔티티에는 `reason`·`clipId` 키가 없다 — 사유는 editNote, 채택된 클립은
        // adoptedClipId 다(content-pipeline recFromShort · adopt.ts). 없는 키를 읽어서
        // 고객사 응답의 두 필드가 **항상 null** 이었다.
        reason: r.editNote ?? null,
        clipId: r.adoptedClipId ?? null,
        thumbnails: Array.isArray(r.thumbnails)
          ? r.thumbnails.map((t: any) => ({ id: t.id, chosen: Boolean(t.chosen), urls: t.urls ?? {} }))
          : [],
      })),
  });
});

/** 이 미디어에서 만들어진 클립 목록 (채택된 추천의 산출물 + 배포 상태). */
app.get("/api/media/:id/clips", async (c) => {
  const mediaId = c.req.param("id");
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);
  const episodeId = (media as any).episodeId ?? null;
  const clips = (await listEntities<any>("clip")).filter(
    (cl) => (episodeId && cl.episodeId === episodeId) || cl.sourceMediaId === mediaId,
  );
  return c.json({
    mediaId,
    episodeId,
    clips: clips.map((cl) => ({
      id: cl.id,
      title: cl.title ?? null,
      startTime: cl.startTime ?? null,
      endTime: cl.endTime ?? null,
      durationSec: cl.durationSec ?? null,
      status: cl.status ?? null,
      rendered: Boolean(cl.rendered),
      publishedVideoId: cl.publishedVideoId ?? null,
      distributions: (cl.distributions ?? []).map((d: any) => ({
        channel: d.channel, status: d.status, externalId: d.externalId ?? null,
      })),
    })),
  });
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
  if (need <= 0) {
    // **길이를 몰라도 잔액 0 이면 막는다** (2026-08-26). 예전엔 need<=0 이면 잔액을 아예
    // 조회하지 않고 통과시켜서, durationSec 이 0 인 미디어는 잔액 0 에서도 큐잉됐다.
    // 정밀 판정은 분석 직전(runContentAnalyze)이 실측 길이로 다시 하지만, 여기서 싼 컷을
    // 한 번 넣어 두면 잔액 없는 워크스페이스가 다운로드 이그레스부터 태우지 않는다.
    // 이 판정(`잔액 <= 0`)은 등록 라우트 3곳이 이미 쓰는 것과 같다 — 여기만 빠져 있었다.
    return (await creditBalance()) <= 0
      ? "크레딧이 없습니다 — 충전 후 다시 시도하세요."
      : null;
  }
  const verdict = checkCredits({ balance: await creditBalance(), needMinutes: need });
  if (verdict.allow) return null;
  // 부족하면 402 로 끝내기 전에 **저장 카드 자동 충전을 먼저 시도**한다(ENA "다 쓰면 바로
  // 채움" · 2026-08-24). 필요분 기준 트리거라 잔액이 0 에 정확히 닿지 않아도 걸린다.
  // 충전이 안 됐으면(꺼짐·카드 없음·상한) 원판정 그대로 402 — 사유는 자동충전 알림이 따로 남는다.
  const retried = await topupAndRecheck(need);
  if (retried?.allow) return null;
  return (retried ?? verdict).reason;
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
        // ⚠️ 여기서 그냥 삼키면 **회차가 "분석 중" 인 채로 영원히 멈춘다.**
        // markContentAnalysisPending 은 이미 실행됐고 큐에는 행이 없어서, 화면은 진행 중처럼
        // 보이는데 실제로는 아무도 그 일을 하지 않는다 — 이 리포가 문서화한 최악의 실패 모드다.
        // 업로드 자체는 성공했으므로(파일은 저장됐다) 요청을 실패시키지는 않되,
        // **거짓 진행 상태는 반드시 지운다.**
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[upload] content.analyze 큐잉 실패 ${mediaId}:`, reason);
        await saveContentAnalysis(mediaId, {
          error: `분석 큐 등록 실패 — 다시 시도해 주세요: ${reason}`,
        }).catch((e) => console.error("[upload] 분석 실패 상태 기록도 실패:", e));
      }
    }
  }

  return { media: mediaPublic(row), episode, recommendations: [] };
}

// ── 직접 업로드한 완성 영상 → 배포 가능한 클립 (분석 파이프라인을 태우지 않는다) ──────────
//
// 편집자가 우리 도구 밖에서 이미 만든 영상을 올려 바로 배포하고 싶을 때의 경로다. 업로드는
// content.analyze 를 큐잉하지 않고, 회차도 만들지 않는다. **파일 자체가 최종 산출물**이므로
// media(role="clip") + rendered=true 클립을 만들어 미디어 목록·배포 흐름에 바로 얹는다.
// 배포 워커는 clip.mediaId → media.path 로 파일을 내려받으므로, 채택→익스포트로 렌더된
// 클립과 완전히 같은 방식으로 게시된다.

/**
 * GCS 에 올라온 업로드 객체를 재생 가능한 상태로 만든다 — faststart 리먹스 + 프로브 + 썸네일.
 * `/media/finalize` 가 인라인으로 하던 처리와 같다(완성본 clip-finalize 도 이걸 쓴다).
 * `size` 는 **서버가 실제 객체에서 읽은 값**이다 — 클라이언트 숫자를 신뢰하지 않는다.
 */
async function prepareUploadedObject(mediaId: string, objectPath: string): Promise<{
  size: number;
  meta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean };
  thumbStored: string | null;
  storedPath: string;
}> {
  const storedPath = `gs://${process.env.GCS_BUCKET}/${objectPath}`;
  let size = await fileSize(objectPath).catch(() => 0);

  // 브라우저가 <video> 로 매끄럽게 재생하도록 progressive(moov-at-front) mp4 로 리먹스.
  // RAM 백엔드 /tmp 에 통째로 올라가므로 크기 가드(REMUX_MAX_MB, 기본 512MB)를 둔다.
  const REMUX_MAX = (Number(process.env.REMUX_MAX_MB) || 512) * 1024 * 1024;
  const remuxSize = await fileSize(objectPath).catch(() => 0);
  if (hasFfmpeg() && remuxSize > 0 && remuxSize <= REMUX_MAX) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const webTmp = path.join(tmpDir, `${mediaId}-web.mp4`);
    try {
      const inUrl = await signedReadUrl(objectPath);
      await remuxFaststart(inUrl, webTmp);
      await uploadFile(objectPath, webTmp); // fMP4 를 progressive 로 덮어쓴다
      size = fs.statSync(webTmp).size;
    } catch (e) {
      console.error("[prepare] remux failed — keeping original (may not stream if fragmented):", e);
    } finally {
      try { fs.unlinkSync(webTmp); } catch {}
    }
  }

  // 프로브·썸네일은 짧은 서명 URL 을 ffmpeg 에 넘겨 range-read 로만 뽑는다(전량 다운로드 없음).
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (hasFfmpeg()) {
    try {
      const readUrl = await signedReadUrl(objectPath);
      meta = await probe(readUrl).catch((e) => { console.error("[prepare] probe failed", e); return meta; });
      const tmpDir = path.resolve("/tmp/stepd-uploads");
      fs.mkdirSync(tmpDir, { recursive: true });
      const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
      try {
        await captureThumbnail(readUrl, Math.max(1, meta.durationSec * 0.1), thumbTmp);
        thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
      } catch (e) {
        console.error("[prepare] thumbnail failed", e);
      } finally {
        try { fs.unlinkSync(thumbTmp); } catch {}
      }
    } catch (err) {
      console.error("[prepare] signed-url probe unavailable (grant signBlob to the Cloud Run SA):", err);
    }
  }
  return { size, meta, thumbStored, storedPath };
}

/** 편집본 유형 — 숏폼·클립·하이라이트만 유효. 그 외는 undefined(미지정). */
const EDIT_KINDS = ["shorts", "clip", "highlight"] as const;
type EditKind = (typeof EDIT_KINDS)[number];
function readEditKind(raw: unknown): EditKind | undefined {
  return (EDIT_KINDS as readonly string[]).includes(String(raw)) ? (raw as EditKind) : undefined;
}

/**
 * 완성 영상 하나를 배포 가능한 클립으로 만든다. 회차·분석 없이 media(role="clip") 행과
 * rendered=true 클립 엔티티를 만들어 미디어 목록·배포 게이트에 바로 얹는다. 세로/가로는
 * 프로브 결과로 판정한다(원본 그대로 — 크롭·리프레임하지 않는다).
 *
 * 회차 번호가 오면 기록하고, 그 번호의 회차가 시스템에 있으면 연결까지 한다.
 * 없어도 번호는 남긴다 — 편집본은 회차를 만들지 않으므로(설계), 표시용 사실로 기록한다.
 */
async function buildFinishedClip(opts: {
  mediaId: string;
  programId: string;
  program: { id: string; title: string; targetAge: number };
  storedPath: string;
  filename: string;
  title: string;
  mime: string;
  size: number;
  meta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean };
  thumbPath: string | null;
  episodeNumber?: number;
  editKind?: EditKind;
}) {
  const { mediaId, programId, program, storedPath, filename, title, mime, size, meta } = opts;

  let episodeId = "";
  if (opts.episodeNumber !== undefined) {
    const { rows } = await getPool().query(
      `SELECT id FROM entities
        WHERE kind = 'episode' AND data->>'programId' = $1 AND data->>'episodeNumber' = $2
        LIMIT 1`,
      [programId, String(opts.episodeNumber)],
    );
    episodeId = rows[0]?.id ?? "";
  }

  const row: MediaRow = {
    id: mediaId,
    // 같은 번호의 회차가 있으면 연결, 없으면 비운다(media.episodeId 는 nullable).
    episodeId,
    role: "clip",
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

  const portrait = meta.height > 0 && meta.width > 0 && meta.height > meta.width;
  const clipId = newId("c");
  const clip = {
    id: clipId,
    episodeId,
    programId,
    programTitle: program.title,
    title,
    // 회차 번호는 회차 엔티티가 없어도 남긴다 — 매트릭스가 "몇 화 편집본"인지 보여줄 근거.
    episodeNumber: opts.episodeNumber,
    // 편집본 유형(숏폼·클립·하이라이트) — 배포 채널 선택·목록 필터의 근거.
    editKind: opts.editKind,
    clipType: portrait ? "T6" : "TZ",
    targetAge: program.targetAge ?? 0,
    aspectRatio: portrait ? "9:16" : "16:9",
    durationSec: Math.round(meta.durationSec),
    // 서버 상대 경로다(접두사 /api 없음). 프론트 absolute()/clipThumbSrc 가 API_BASE 를 붙인다 —
    // export 라우트(videoUrl:`/media/…`)와 같은 컨벤션. /api 를 넣으면 /api 가 두 번 붙는다.
    thumbnailUrl: opts.thumbPath ? `/media/${mediaId}/thumb` : undefined,
    // 이미 완성된 파일이라 결정 상태가 아니다 — 곧바로 배포 가능(rendered).
    status: "editing",
    rendered: true,
    mediaId,                // 배포 워커가 이 미디어의 path 로 파일을 내려받아 올린다
    sourceMediaId: mediaId,
    videoUrl: `/media/${mediaId}/stream`,
    // 직접 업로드 완성본 표식 — 편집(트림·리프레임)이 아니라 배포가 목적이다.
    directUpload: true,
    distributions: [] as unknown[],
  };
  await prependEntity("clip", clipId, clip);
  return { clip, media: mediaPublic(row) };
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
    // A previous finalize may have committed the rows and lost the response before the
    // prepare enqueue. Replaying finalize must repair that gap instead of stranding a
    // duration=0 episode forever. Queue dedupe makes this safe when the job already exists.
    if (!(existing.durationSec > 0)) {
      await enqueue(
        "media.prepare",
        { mediaId, ...(body.fast === true ? { fast: true } : {}) },
        { dedupeKey: `media.prepare:${mediaId}` },
      ).catch((err) => console.error(`[finalize] media.prepare replay enqueue failed ${mediaId}`, err));
    }
    return c.json({ media: mediaPublic(existing), episode, recommendations: [], queued: true });
  }

  // Confirm the object actually landed in the regional upload bucket before we build rows.
  if (!(await uploadFileExists(objectPath))) return c.json({ error: "upload not found in storage" }, 400);

  const filename =
    typeof body.filename === "string" && body.filename ? String(body.filename) : `${mediaId}.mp4`;
  const title = typeof body.title === "string" && body.title ? String(body.title) : filename;
  const mime =
    typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";
  // Server-authoritative size from the staging bucket. body.size is display-only.
  let size = await uploadFileSize(objectPath).catch(() => 0);
  if (size <= 0 && typeof body.size === "number" && body.size > 0) size = body.size;
  const storedPath = uploadGcsUri(objectPath);

  try {
    const result = await buildEpisodeAndMedia({
      mediaId, programId, program, storedPath,
      filename, title, mime, size,
      meta: { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false },
      thumbPath: null,
      fast: body.fast === true,
      episodeNumber: readEpisodeNumber(body.episodeNumber),
      broadDate: typeof body.broadDate === "string" ? body.broadDate : undefined,
      track: readTrack(body.track),
      hasSubtitle: body.hasSubtitle !== false,
      pendingIngestNote: "서울 업로드 완료 · 서버 후처리 대기 중…",
    });
    try {
      await enqueue(
        "media.prepare",
        { mediaId, ...(body.fast === true ? { fast: true } : {}) },
        { dedupeKey: `media.prepare:${mediaId}` },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[finalize] media.prepare 큐잉 실패 ${mediaId}:`, reason);
      await putEntity("episode", result.episode.id, {
        ...result.episode,
        pipeline: {
          stage: "analyze", stageStatus: "error", progress: 0,
          note: `업로드 후처리 큐 등록 실패 — 다시 시도해 주세요: ${reason}`,
        },
      }).catch(() => {});
    }
    return c.json({ ...result, queued: true }, 202);
  } catch (err) {
    if (err instanceof DuplicateEpisodeError) {
      return c.json({ error: "duplicate episode", episodeNumber: err.episodeNumber, programId }, 409);
    }
    throw err;
  }
});

// ── 완성 영상 직접 업로드, 2단계(GCS): 올라간 파일로 배포 가능한 클립을 만든다 ──────────────
// upload-init 이 발급한 (mediaId, objectPath) 를 그대로 받아 회차·분석 없이 클립을 만든다.
app.post("/api/media/clip-finalize", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const mediaId = typeof body.mediaId === "string" ? String(body.mediaId) : "";
  const objectPath = typeof body.objectPath === "string" ? String(body.objectPath) : "";
  if (!mediaId || !objectPath) return c.json({ error: "mediaId and objectPath required" }, 400);
  // finalize 와 같은 가드 — 이 mediaId 의 upload-init 이 발급했을 objectPath 만 받는다.
  if (!/^[\w-]+$/.test(mediaId) || !new RegExp(`^uploads/${mediaId}\\.\\w+$`).test(objectPath)) {
    return c.json({ error: "objectPath does not match mediaId" }, 400);
  }
  if (!useGcs()) return c.json({ error: "clip-finalize is GCS-mode only" }, 400);

  const programId = typeof body.programId === "string" && body.programId ? String(body.programId) : "";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  // 멱등 재시도: 네트워크가 끊긴 뒤 다시 부르면 이미 만든 클립을 돌려준다(중복 생성 금지).
  const existing = await getMedia(mediaId);
  if (existing) {
    const clip = (await listEntities<{ mediaId?: string }>("clip")).find((x) => x.mediaId === mediaId);
    return c.json({ clip: clip ?? null, media: mediaPublic(existing) });
  }

  if (!(await uploadFileExists(objectPath))) return c.json({ error: "upload not found in storage" }, 400);
  // clip uploads share upload-init, so a separate regional upload bucket must be promoted
  // before the existing clip preparation path reads from the primary bucket.
  await promoteUpload(objectPath);

  const filename = typeof body.filename === "string" && body.filename ? String(body.filename) : `${mediaId}.mp4`;
  const title = typeof body.title === "string" && body.title ? String(body.title) : filename;
  const mime = typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";

  const { size, meta, thumbStored, storedPath } = await prepareUploadedObject(mediaId, objectPath);
  let finalSize = size;
  if (finalSize <= 0 && typeof body.size === "number" && body.size > 0) finalSize = body.size;

  const result = await buildFinishedClip({
    mediaId, programId, program, storedPath, filename, title,
    mime, size: finalSize, meta, thumbPath: thumbStored,
    episodeNumber: readEpisodeNumber(body.episodeNumber),
    editKind: readEditKind(body.editKind),
  });
  return c.json(result);
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
  if (hasFfmpeg()) {
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

// ── 완성 영상 직접 업로드 (로컬 dev · 소용량 multipart 폴백) → 배포 가능한 클립 ──────────────
// GCS 미설정(로컬)이면 브라우저가 clip-upload-init 의 mode:"multipart" 를 받고 이리로 폴백한다.
app.post("/api/media/clip-upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (typeof file === "string" || !(file as any).arrayBuffer || typeof file === "boolean") return c.json({ error: "file field required" }, 400);

  const programId = typeof body["programId"] === "string" && body["programId"] ? String(body["programId"]) : "";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  const mediaId = newId("m");
  const ext = path.extname(file.name) || ".mp4";
  const buffer = Buffer.from(await file.arrayBuffer());
  const storedPath = await writeFile(uploadPath(mediaId, ext), buffer);

  // Probe + thumbnail from a local temp copy (ffmpeg reads the filesystem).
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (hasFfmpeg()) {
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
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(thumbTmp); } catch {}
    }
  }

  const title = typeof body["title"] === "string" && body["title"] ? String(body["title"]) : file.name;
  const result = await buildFinishedClip({
    mediaId, programId, program, storedPath,
    filename: file.name, title, mime: file.type || "video/mp4", size: file.size,
    meta, thumbPath: thumbStored,
    episodeNumber: readEpisodeNumber(body["episodeNumber"]),
    editKind: readEditKind(body["editKind"]),
  });
  return c.json(result);
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

  // 잔액 없는 워크스페이스의 등록은 받지 않는다 — 같은 성격의 /api/factory/videos 와 같은
  // 기준(잔액 0 이하 = 402). 다운로드·분석이 곧 원가인데, 러닝타임을 아직 모르므로 여기서는
  // 0 판정만 하고 정밀 게이트는 다운로드 완료 후(워커의 content.analyze 큐잉 직전)에 선다.
  if ((await creditBalance()) <= 0) {
    return c.json({ error: "insufficient_credits", message: "크레딧 잔액이 없습니다. 충전 후 다시 시도해 주세요." }, 402);
  }

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
// **단일 출력 해상도 좌표계.** 에디터 미리보기 스테이지가 출력 해상도(W×H) 그대로라(웹
// editor-preview.tsx: 고정 캔버스 + 단일 scale transform), 오버레이 크기(line.size 등)는 저장부터
// 출력 px 다(normalizeEditorCoords 가 옛 저장분·시드를 여기로 1회 올린다). 렌더는 그 출력 px 를
// 그대로 쓴다 — position% → 출력 px, ASS PlayRes == 출력 size 라 \pos 1:1.
// `stageH`(설계 스테이지 높이)는 이제 **좌표 basis 가 아니라** 마이그레이션 계수(H/stageH)와 고정
// 설계 상수(그림자·패딩·gap)를 출력 px 로 올리는 데만 쓰는 잔여값이다(constScale). 값은 그대로 —
// 웹 presets.ts designStageH 와 1:1 이어야 옛 클립이 무회귀로 올라온다(overlay-parity 강제).
function renderDims(aspect: string): { W: number; H: number; stageH: number } {
  switch (aspect) {
    case "16:9": return { W: 1920, H: 1080, stageH: (900 * 1080) / 1920 };
    case "1:1":  return { W: 1080, H: 1080, stageH: 900 };
    case "4:5":  return { W: 1080, H: 1350, stageH: 640 };
    // 세로 계열 — bare "9:16" 과 5-값 enum(레터박스·꽉채우기·메인/서브 크롭) 전부 1080×1920.
    case "9:16":
    case "9:16-letterbox":
    case "9:16-crop-full":
    case "9:16-crop-main":
    case "9:16-crop-sub":
    default:     return { W: 1080, H: 1920, stageH: 640 };
  }
}

/**
 * editorState 크기 필드를 출력 px basis 로 정규화(멱등) — **웹 presets.ts normalizeEditorCoords 미러.**
 * coordBasis:"output" 이면 그대로(웹이 이미 올려 보냈다). 아니면(옛 저장분·factory 시드 = 스테이지 px)
 * 모든 크기(제목·채널·요소·외곽선)를 ×(H/stageH) 해 출력 px 로 올린다. 위치(%)·시각(초)·자막(%높이)은
 * 해상도 독립이라 건드리지 않는다. **결과 무회귀**: 옛 렌더가 size×scale 로 굽던 출력 px 와 정확히 같다.
 * ⚠️ 계수 H/stageH 는 웹 outScale(aspect)=outputHeight/designStageH 와 1:1 이어야 한다.
 */
function normalizeEditorCoords(es: any, aspect: string): any {
  if (!es || typeof es !== "object") return es;
  if (es.coordBasis === "output") return es;
  const { H, stageH } = renderDims(aspect);
  const f = H / stageH;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v * f : v);
  return {
    ...es,
    coordBasis: "output",
    titleLines: Array.isArray(es.titleLines)
      ? es.titleLines.map((l: any) => ({
          ...l,
          size: typeof l?.size === "number" && l.size > 0 ? l.size * f : l?.size,
          ...(l?.stroke && typeof l.stroke.width === "number"
            ? { stroke: { ...l.stroke, width: l.stroke.width * f } }
            : {}),
        }))
      : es.titleLines,
    channelLabelSize: num(es.channelLabelSize),
    channelIconSize: num(es.channelIconSize),
    channelExtraLines: Array.isArray(es.channelExtraLines)
      ? es.channelExtraLines.map((l: any) => ({
          ...l,
          size: typeof l?.size === "number" && l.size > 0 ? l.size * f : l?.size,
        }))
      : es.channelExtraLines,
    elements: Array.isArray(es.elements)
      ? es.elements.map((e: any) => ({
          ...e,
          size: typeof e?.size === "number" && e.size > 0 ? e.size * f : e?.size,
        }))
      : es.elements,
  };
}

// ── F3: per-destination render presets ────────────────────────────────────────
//
// The render-side mirror of core/channels.py CHANNEL_PRESETS. That table ranks candidates
// per destination (scoring only); this one decides what the encoder actually emits. The two
// must agree — a candidate scored as 네이버 TV (16:9, up to 180s) that rendered as a 60s 9:16
// short would make the whole (candidate × destination) matrix a lie. Keep maxSec/aspect in
// sync with core/channels.py when either moves.
const RENDER_PRESETS: Record<string, { label: string; aspect: string; maxSec: number }> = {
  youtube_shorts:  { label: "YouTube Shorts",   aspect: "9:16", maxSec: 60 },
  instagram_reels: { label: "Instagram Reels",  aspect: "9:16", maxSec: 90 },
  naver_tv:        { label: "네이버 TV (가로 VOD)", aspect: "16:9", maxSec: 180 },
};

/**
 * clip.aspectRatio / editorState.aspect 는 에디터 어휘(5-값 enum: "16:9", "9:16-letterbox",
 * "9:16-crop-full", "9:16-crop-main", "9:16-crop-sub" — constants.ts ASPECT_RATIOS /
 * aspect-presets.ts)를 쓴다. renderDims 는 이 enum 을 그대로 받아 W/H 를 낸다.
 *
 * ⚠️ 예전엔 여기서 `9:16*` 를 전부 bare "9:16" 으로 뭉갰다 — 그 결과 letterbox·crop-main·crop-sub 가
 * 렌더에서 구분되지 않았다. 이제 **알려진 enum 은 그대로 통과**시켜 5값이 각기 다르게 렌더된다.
 * 구형 저장분의 bare "9:16"(fit/bgType 로 채움 결정) 과 정사각/피드(1:1·4:5) 는 그대로 둔다.
 */
function normalizeAspect(aspectRatio: unknown): string | null {
  const s = String(aspectRatio ?? "").trim();
  if (!s) return null;
  // 5-값 enum 은 verbatim 통과 (crop-main/crop-sub/letterbox/crop-full 이 각기 렌더되게).
  if (s === "9:16-letterbox" || s === "9:16-crop-full" || s === "9:16-crop-main" || s === "9:16-crop-sub") return s;
  if (s === "9:16-crop") return "9:16-crop-main"; // 레거시 별칭
  if (s === "16:9") return "16:9";
  if (s === "9:16") return "9:16"; // 구형 editorState — 채움은 fit/bgType 폴백
  if (s === "1:1" || s === "4:5") return s;
  // 알 수 없는 9:16*/16:9* 변형 → bare 폴백(크래시 방지).
  if (s.startsWith("9:16")) return "9:16";
  if (s.startsWith("16:9")) return "16:9";
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

/**
 * ASS Fontsize 는 CSS font-size 와 **같은 숫자가 아니다.**
 *
 * libass 는 VSFilter 호환으로 폰트를 `FT_SIZE_REQUEST_TYPE_REAL_DIM` 으로 요청한다 —
 * Fontsize 가 em 이 아니라 **글자 셀 높이**(OS/2 usWinAscent+usWinDescent)가 된다. 그래서
 * 미리보기(CSS px = em)와 같은 숫자를 넣으면 렌더 글자만 계통적으로 작게 나온다.
 * 실측 (assets/fonts/Pretendard-{Bold,ExtraBold,Black}.otf — 3종 동일):
 *   upem 2048 · winAscent 1949 + winDescent 494 = 2443 → em = fs × 2048/2443 = 0.838·fs
 * 즉 CSS px 를 그대로 쓰면 **16% 작다**. 반대로 곱해서 넣는다.
 * (폰트를 바꾸면 이 상수도 다시 재야 한다 — 값은 폰트 메트릭에서 나온다.)
 */
const ASS_FS_PER_CSS_PX = 2443 / 2048;
/** 미리보기 CSS px(출력 해상도 환산) → ASS Fontsize. */
function assFs(cssPx: number): number {
  return Math.max(12, Math.round(cssPx * ASS_FS_PER_CSS_PX));
}

/**
 * Pretendard 문자 폭 근사(em 배수) — 서버가 미리보기와 **같은 자리에서** 줄을 접기 위한 것.
 * 실측 advance(Pretendard-ExtraBold.otf): 한글 0.864 · 한자 1.0 · 대문자 0.74~0.89 ·
 * 소문자 0.27~0.61 · 숫자 0.68 · 공백 0.224 · 마침표류 0.29. 클래스 평균으로 뭉갠다 —
 * 목표는 픽셀 정확도가 아니라 "미리보기와 같은 단어에서 접히는가" 다.
 */
function charWidthEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (ch === " ") return 0.224;
  if (c >= 0xac00 && c <= 0xd7a3) return 0.864;   // 한글 음절
  if (c >= 0x3131 && c <= 0x318e) return 0.864;   // 한글 자모
  if (c >= 0x4e00 && c <= 0x9fff) return 1.0;     // 한자
  if (c >= 0x3000 && c <= 0x30ff) return 0.94;    // 일본어·전각 구두점
  if (c >= 0xff01 && c <= 0xff60) return 1.0;     // 전각
  if (c >= 0x41 && c <= 0x5a) return 0.76;        // A-Z
  if (c >= 0x61 && c <= 0x7a) return 0.55;        // a-z
  if (c >= 0x30 && c <= 0x39) return 0.68;        // 0-9
  if (".,·:;!'|".includes(ch)) return 0.3;
  if (c < 0x80) return 0.5;
  return 0.9;
}
function textWidthPx(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of String(text ?? "")) em += charWidthEm(ch);
  return em * fontPx;
}
/** 한글·한자·전각은 글자 사이에서도 접힌다(브라우저 기본과 동일). */
function isWideBreakable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3131 && c <= 0x318e) ||
    (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff01 && c <= 0xff60);
}
/**
 * CSS 자동 줄바꿈 재현 — 미리보기는 블록 폭에서 접히는데 ASS 는 `WrapStyle: 2`(줄바꿈 없음)라
 * 긴 제목이 **화면 밖으로 나갔다**(2026-08-12 실측). 여기서 미리 접어 넣는다.
 * 브라우저 기본과 같은 그리디 규칙: 공백에서 접고, 한글·한자는 글자 사이에서도 접는다.
 */
function wrapTextToWidth(text: string, maxPx: number, fontPx: number): string[] {
  const src = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!src || !(maxPx > 0) || !(fontPx > 0)) return src ? [src] : [];
  // 토큰 = 공백 · 전각 1글자 · 라틴 단어(끊지 않는다)
  const tokens: string[] = [];
  let buf = "";
  for (const ch of src) {
    if (ch === " " || isWideBreakable(ch)) {
      if (buf) { tokens.push(buf); buf = ""; }
      tokens.push(ch);
    } else buf += ch;
  }
  if (buf) tokens.push(buf);

  const lines: string[] = [];
  let line = "";
  let w = 0;
  for (const tk of tokens) {
    const tw = textWidthPx(tk, fontPx);
    if (tk === " ") {
      if (!line) continue;            // 줄머리 공백은 버린다 (CSS 와 동일)
      line += tk; w += tw; continue;
    }
    if (line && w + tw > maxPx) {
      lines.push(line.trimEnd());
      line = tk; w = tw;
    } else { line += tk; w += tw; }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.length ? lines : [src];
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
// 자막 조각 타입·끊기 규칙은 caption-chunk.ts 가 정본(순수 함수라 단위 테스트가 붙는다).
type CaptionWord = CaptionWordT;
type Caption = CaptionT;

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
    // 세그먼트가 윈도 경계를 걸치면 **텍스트도 노출 구간에 맞춰 자른다.** 시간(rs·re)만 자르고
    // 전체 문장을 남기면(옛 동작), 2.5초 문장이 클립엔 0.4초만 들어와도 자막은 24자 통짜라
    // chunkCaption 의 최소노출 병합에 뭉쳐 렌더가 3줄로 구웠다(사용자 2026-08-21 · 첫 프레임).
    // words 는 이미 아래에서 윈도로 잘리는데 text 만 안 잘린 게 원인. 발화 속도가 대체로 고르므로
    // 앞/뒤에서 잘려 나간 시간 비율만큼 어절 토큰을 버린다(공백 경계라 한글 깨짐 없이 안전).
    let capText = text;
    const segDur = en - st;
    if (segDur > 0.05 && (st < winStart - 0.05 || en > winEnd + 0.05)) {
      const toks = text.split(/\s+/).filter(Boolean);
      if (toks.length > 1) {
        const headCut = Math.max(0, winStart - st) / segDur;   // 앞에서 잘린 비율
        const tailCut = Math.max(0, en - winEnd) / segDur;     // 뒤에서 잘린 비율
        const from = Math.floor(toks.length * headCut);
        const to = Math.ceil(toks.length * (1 - tailCut));
        const kept = toks.slice(from, Math.max(from + 1, to));
        if (kept.length) capText = kept.join(" ");
      }
    }
    const cap: Caption = { start: rs, end: re, text: capText };
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
  // ⚠️ time 이 유한한 키프레임만 쓴다. NaN/undefined time 이 섞이면 정렬·보간이 깨져
  //    \pos(NaN,NaN)·\fscxNaN 이 ASS 에 박혀 그 오버레이 번인이 통째로 망가진다.
  //    웹 sampleKeyframes 는 이미 이렇게 거른다(presets.ts) — 서버도 맞춘다.
  const sorted = [...kfs].filter((k) => Number.isFinite(k?.time)).sort((a, b) => a.time - b.time);
  const prop = (key: "x" | "y" | "scale" | "opacity" | "rotation"): number | undefined => {
    // NaN 은 typeof 로 number 라 통과한다 — isFinite 로 걸러야 실제 유효값만 남는다.
    const pts = sorted.filter((k) => Number.isFinite(k[key] as number));
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

/**
 * 설계 스테이지 px → 출력 px 배율 (= 마이그레이션 계수 = H/stageH).
 *
 * ⚠️ **저장 크기(line.size 등)엔 곱하지 않는다** — 그건 이미 출력 px(normalizeEditorCoords 정규화).
 * 오직 고정 설계 상수(그림자 offset·패딩·gap·박스 폰트)와 미설정 기본값을 출력 px 로 올릴 때만 쓴다.
 * 예전엔 es.stagePx(에디터 실측)를 봤지만, 스테이지가 출력 해상도로 통일되며 폐기했다(웹 미전송).
 */
function constScale(H: number, stageH: number): number {
  return H / stageH;
}

/**
 * 채널 뱃지 배치 — 미리보기(editor-preview.tsx)의 흐름 배치를 서버가 그대로 재현한다.
 *
 *   가로(기본): [아이콘][gap 8px][이름 + 부가줄]  행 전체를 가운데, 상단이 channelY
 *   세로:       [아이콘] gap 4px [이름 + 부가줄]  열 전체를 가운데
 *
 * 아이콘은 ASS 가 아니라 ffmpeg overlay 로 얹히므로 **좌표를 두 곳에서 따로 계산하면 반드시
 * 어긋난다** — 여기 한 군데서 만들어 양쪽에 나눠 준다.
 * `channelIconY` 가 명시된 상태(방송 템플릿 시드)는 아이콘을 흐름에서 빼고 그 자리에 고정한다.
 */
type BadgeLine = { text: string; x: number; y: number; an: number; px: number; dim?: boolean };
type BadgeLayout = { lines: BadgeLine[]; icon: { x: number; y: number } | null };
function channelBadgeLayout(
  es: any, W: number, H: number, scale: number, icon: { w: number; h: number } | null,
): BadgeLayout | null {
  const name = String(es?.channelName ?? "").trim();
  if (!es?.showChannel || !name) return null;
  // channelLabelSize 는 출력 px(정규화됨) — 그대로 쓰고, 미설정 기본값 14·클램프 범위 8..64 만
  // scale(설계 px→출력 px) 배한다(웹 editor-preview 와 동일 basis).
  const labelPx = Math.max(8 * scale, Math.min(64 * scale, Number(es.channelLabelSize) > 0 ? Number(es.channelLabelSize) : 14 * scale));
  const chY = ((Number(es.channelY) || 82) / 100) * H;
  const LEADING = 1.25; // leading-tight
  const extras = (Array.isArray(es.channelExtraLines) ? es.channelExtraLines : [])
    .map((l: any) => ({ text: String(l?.text ?? "").trim(), size: Number(l?.size) }))
    .filter((l: any) => l.text.length > 0)
    .map((l: any) => {
      // l.size 는 출력 px. 미설정이면 라벨의 0.75. 클램프·marginedTop 상수만 scale 배.
      const sizeOut = l.size > 0 ? l.size : labelPx * 0.75;
      const px = Math.max(6 * scale, Math.min(48 * scale, sizeOut));
      return { text: l.text, px, marginTop: Math.max(1 * scale, px * 0.2) };
    });
  const textH = labelPx * LEADING + extras.reduce((s: number, e: any) => s + e.marginTop + e.px * LEADING, 0);
  const textW = Math.max(textWidthPx(name, labelPx), ...extras.map((e: any) => textWidthPx(e.text, e.px)));

  const vertical = String(es.channelLayout ?? "horizontal") === "vertical";
  const gap = (vertical ? 4 : 8) * scale; // web gap-1 / gap-2
  const flowIcon = icon && !(Number(es.channelIconY) > 0) ? icon : null;
  let textLeft = (W - textW) / 2;
  let textTop = chY;
  let iconPos: { x: number; y: number } | null = null;
  if (flowIcon && !vertical) {
    const rowW = flowIcon.w + gap + textW;
    const rowH = Math.max(flowIcon.h, textH);
    const left = (W - rowW) / 2;
    iconPos = { x: left, y: chY + (rowH - flowIcon.h) / 2 };
    textLeft = left + flowIcon.w + gap;
    textTop = chY + (rowH - textH) / 2;
  } else if (flowIcon) {
    iconPos = { x: (W - flowIcon.w) / 2, y: chY };
    textTop = chY + flowIcon.h + gap;
  }
  // 텍스트 블록은 가로 배치에서 items-start(좌측 정렬), 세로 배치에서 items-center.
  const an = vertical ? 8 : 7;
  const x = vertical ? W / 2 : textLeft;
  const lines: BadgeLine[] = [{ text: name, x, y: textTop, an, px: labelPx }];
  let y = textTop + labelPx * LEADING;
  for (const e of extras) {
    y += e.marginTop;
    lines.push({ text: e.text, x, y, an, px: e.px, dim: true });
    y += e.px * LEADING;
  }
  return { lines, icon: iconPos };
}

// 제목 블록 기하 상수 — **미리보기(editor-preview.tsx)의 값과 1:1** 이어야 한다
// (overlay-parity.test.ts 가 강제). 미리보기 제목은 폭 86% 블록(padding 0 4px)이
// titleX% 를 중심으로 놓이고 좌/우 정렬은 그 블록 안에서만 움직인다.
const TITLE_BLOCK = 0.86;
const TITLE_PAD_PX = 4;

/** 제목 한 줄의 배치 결과 — ASS(buildEditorAss)와 canvas-PNG(buildStaticOverlayItems)가
 *  **같은 숫자**를 쓰도록 공유하는 정본. 좌표·크기는 출력 해상도(W×H) 기준 px. */
type TitleLineLayout = {
  t: any;
  text: string;
  align: "left" | "center" | "right";
  an: number;
  /** 앵커 x (align 에 따라 블록 좌/중앙/우). */
  bx: number;
  /** 줄 상단 y (윗줄들 높이 누적 포함). */
  by: number;
  /** nowrap+shrink-to-fit 후 폰트 px. */
  fitPx: number;
  /** 원본 색 (#rrggbb). ASS 는 hexToAss 로 변환, canvas 는 그대로. */
  colorHex: string;
  /** 키프레임·시간창 없는 완전 정적 줄인가 (= canvas-PNG 로 옮겨도 되는가). */
  isStatic: boolean;
};

/**
 * 제목 줄들의 배치 계산 — buildEditorAss 의 옛 인라인 루프를 추출한 **공유 정본**.
 * 여러 줄은 fitPx*1.15 만큼 세로로 쌓인다(윗줄 높이 누적). 빈 줄은 건너뛰고 누적도 안 한다.
 * ⚠️ 파리티 테스트가 이 안의 표현식(`align === "left" ? cx - half + pad ...`,
 *    `wrapTextToWidth(t.text, TITLE_BLOCK * W - 2 * pad, px)`)을 스캔한다 — 형태를 유지할 것.
 */
function layoutTitleLines(es: any, W: number, H: number, scale: number): TitleLineLayout[] {
  const out: TitleLineLayout[] = [];
  if (!es || typeof es !== "object") return out;
  let yOff = 0;
  for (const t of Array.isArray(es.titleLines) ? es.titleLines : []) {
    if (!t?.text?.trim()) continue;
    // t.size 는 출력 px(정규화됨) — 그대로. 미설정 기본값 30·최소 6 만 scale(설계 px→출력) 배.
    const px = Math.max(6 * scale, Number(t.size) > 0 ? Number(t.size) : 30 * scale);
    const align = es.titleAlign === "left" ? "left" : es.titleAlign === "right" ? "right" : "center";
    const an = align === "left" ? 7 : align === "right" ? 9 : 8;
    const cx = ((es.titleX ?? 50) / 100) * W;         // 블록 중심
    const half = (TITLE_BLOCK * W) / 2;
    const pad = TITLE_PAD_PX * scale;
    const bx = align === "left" ? cx - half + pad : align === "right" ? cx + half - pad : cx;
    const by0 = ((es.titleY ?? 11) / 100) * H + yOff; // 기본값은 웹 EMPTY_STATE 와 같은 11
    const blockW = TITLE_BLOCK * W - 2 * pad;
    // 제목 줄은 재접지 않는다(D) — wrapTextToWidth 로 넘침만 측정하고, 접는 대신 폰트를 줄여
    // 한 줄에 맞춘다(nowrap + shrink-to-fit). 미리보기(whiteSpace:nowrap)와 줄 수가 항상 일치.
    const rows = wrapTextToWidth(t.text, TITLE_BLOCK * W - 2 * pad, px);
    const full = textWidthPx(t.text, px);
    const fitPx = rows.length > 1 && full > blockW ? Math.max(6, px * (blockW / full)) : px;
    const adv = Math.round(fitPx * 1.15);             // CSS line-height: 1.15
    const isStatic = !(Array.isArray(t.keyframes) && t.keyframes.length) && t.startSec == null && t.endSec == null;
    out.push({ t, text: t.text, align, an, bx, by: by0, fitPx, colorHex: t.color ?? "#FFFFFF", isStatic });
    yOff += adv;
  }
  return out;
}

/**
 * 정적 오버레이 canvas-PNG 의 그리기 목록 — 제목(완전 정적 줄) + 채널명/부가줄.
 * 좌표·크기는 layoutTitleLines / channelBadgeLayout 이 계산한 **ASS 와 같은 숫자**를 쓴다
 * (구조적 파리티). 채널 아이콘·시간박스·요소·자막은 여기 없다 — 각각 별도 overlay / ASS 로 남는다.
 *
 * 색·그림자·웨이트는 **미리보기(editor-preview.tsx)를 정본**으로 맞춘다(에디터가 이 PNG 를
 * 그대로 `<img>` 로 보여주므로). 그림자 offset/blur 는 미리보기 CSS(스테이지 px)를 scale 배해
 * 출력 해상도로 올린다 — `<img>` 가 다시 스테이지 크기로 줄어들면 CSS 와 같은 시각이 된다.
 */
function buildStaticOverlayItems(
  es: any, W: number, H: number, scale: number, iconBox: { w: number; h: number } | null,
): OverlayTextItem[] {
  const items: OverlayTextItem[] = [];
  if (!es || typeof es !== "object") return items;
  // 제목 — 미리보기 fontWeight:800 + textShadow "0 2px 6px rgba(0,0,0,.5)".
  // 줄별 글꼴(font)·외곽선(stroke)은 미리보기(editor-preview.tsx)를 정본으로 그대로 실어 보낸다.
  // 외곽선 폭은 모델이 미리보기 px 이라 scale 배해 출력 해상도로 올린다(그림자 offset 과 같은 규칙).
  for (const L of layoutTitleLines(es, W, H, scale)) {
    if (!L.isStatic) continue; // 애니메이션/시간창 있는 줄은 ASS 가 굽는다(PNG 는 정적만).
    const st = L.t?.stroke;
    const stroke =
      st && typeof st.width === "number" && st.width > 0 && typeof st.color === "string"
        ? { color: st.color, width: st.width } // stroke.width 는 출력 px(정규화됨) — scale 불필요
        : undefined;
    items.push({
      group: "title",
      text: L.text, x: L.bx, y: L.by, align: L.align, baseline: "top",
      fontPx: L.fitPx, weight: 800, font: typeof L.t?.font === "string" ? L.t.font : undefined,
      color: L.colorHex, opacity: 1,
      shadow: { offsetY: 2 * scale, blur: 6 * scale, color: "rgba(0,0,0,0.5)" },
      stroke,
    });
  }
  // 채널명 + 부가줄 — 미리보기: 이름 font-semibold(≈700 스냅)·부가줄 font-medium(≈700)/white-80.
  // textShadow "0 1px 3px rgba(0,0,0,.6)". an=7(가로,좌상단)/8(세로,상단중앙) → align 좌/중앙.
  const badge = channelBadgeLayout(es, W, H, scale, iconBox);
  for (const line of badge?.lines ?? []) {
    items.push({
      group: "channel",
      text: line.text, x: line.x, y: line.y,
      align: line.an === 8 ? "center" : "left", baseline: "top",
      fontPx: line.px, weight: 700, color: "#FFFFFF", opacity: line.dim ? 0.8 : 1,
      shadow: { offsetY: 1 * scale, blur: 3 * scale, color: "rgba(0,0,0,0.6)" },
    });
  }
  return items;
}

function buildEditorAss(
  es: any,
  W: number,
  H: number,
  stageH: number,
  durSec: number,
  captions?: Caption[],
  options: {
    include?: "all" | "decorations" | "captions";
    /** Render-relative windows in which decorative events may appear. */
    visibleIntervals?: Array<{ start: number; end: number }>;
    /** 실제로 얹힐 채널 아이콘의 출력 px 크기 — 가로 배치의 행 중앙정렬 계산에 쓴다. */
    channelIcon?: { w: number; h: number } | null;
    /** true 면 **완전 정적 제목 줄·채널명 텍스트를 ASS 에서 생략**한다 — 그건 canvas-PNG
     *  (buildStaticOverlayItems)로 합성되기 때문. 애니메이션/시간창 제목·요소·시간박스·자막은
     *  그대로 ASS. false(기본)면 종전대로 전부 ASS 로 굽는다(무회귀·PNG 실패 시 폴백). */
    staticToPng?: boolean;
  } = {},
): string | null {
  const scale = constScale(H, stageH);
  const decorationEv: string[] = [];
  const captionEv: string[] = [];
  const includeDecorations = options.include !== "captions";
  const includeCaptions = options.include !== "decorations";
  const visibleIntervals = Array.isArray(options.visibleIntervals)
    ? options.visibleIntervals
      .filter((x) => Number.isFinite(x?.start) && Number.isFinite(x?.end) && x.end > x.start)
      .map((x) => ({ start: Math.max(0, x.start), end: Math.min(durSec, x.end) }))
      .filter((x) => x.end > x.start + 0.001)
    : [{ start: 0, end: durSec }];
  // Overlay show-windows (startSec/endSec) are segment-relative (0 at the adopted segment
  // start); the render window starts at trimIn, so subtract it to get render-relative time.
  // Keyframe times are ALREADY render-relative (localT = segT − trimIn), so they need no shift.
  const trimIn = Number(es?.trimIn ?? 0);
  const pushDecor = (vs: number, ve: number, line: (start: number, end: number) => string) => {
    if (!includeDecorations) return;
    for (const visible of visibleIntervals) {
      const start = Math.max(vs, visible.start);
      const finish = Math.min(ve, visible.end);
      if (finish > start + 0.001) decorationEv.push(line(start, finish));
    }
  };
  const putWin = (an: number, x: number, y: number, fs: number, color: string, bord: number, bordColor: string, text: string, vs: number, ve: number, extra = "") =>
    pushDecor(vs, ve, (start, finish) =>
      `Dialogue: 0,${assTime(start)},${assTime(finish)},Default,,0,0,0,,{\\an${an}\\pos(${Math.round(x)},${Math.round(y)})\\fs${fs}\\c${color}\\b1\\bord${bord}\\3c${bordColor}\\shad1${extra}}${assEscape(text)}`,
    );
  const put = (an: number, x: number, y: number, fs: number, color: string, bord: number, bordColor: string, text: string) =>
    putWin(an, x, y, fs, color, bord, bordColor, text, 0, durSec);
  // Visible [start,end] render-relative window for an overlay; null if it never shows.
  const winFor = (o: { startSec?: number; endSec?: number }): [number, number] | null => {
    const vs = Math.max(0, o.startSec != null ? o.startSec - trimIn : 0);
    const ve = Math.min(durSec, o.endSec != null ? o.endSec - trimIn : durSec);
    return ve > vs + 0.02 ? [vs, ve] : null;
  };
  const SAMPLE_STEP = 0.1; // 10 fps keyframe sampling — smooth enough, cheap for libass

  // staticToPng: 완전 정적 제목 줄·채널명 텍스트는 canvas-PNG 로 옮겼으니 ASS 에서 뺀다
  // (이중 그리기 방지). 애니메이션/시간창 제목·요소·시간박스·자막은 그대로 ASS.
  const staticToPng = options.staticToPng === true;
  if (es && typeof es === "object") {
    // 제목 줄 배치는 layoutTitleLines(공유 정본)에서 온다 — canvas-PNG 와 같은 숫자.
    for (const L of layoutTitleLines(es, W, H, scale)) {
      // 완전 정적 줄은 PNG 가 굽는다(staticToPng). 애니메이션/시간창 줄만 ASS.
      if (staticToPng && L.isStatic) continue;
      const t = L.t;
      const an = L.an;
      const bx = L.bx;
      const by0 = L.by;
      const fitPx = L.fitPx;
      const color = hexToAss(L.colorHex);
      const fs = assFs(fitPx);
      const win = winFor(t);
      if (win) {
        const kfs: KfPoint[] = Array.isArray(t.keyframes) ? t.keyframes : [];
        const by = by0;
        if (kfs.length) {
          // Title-line keyframe x/y are OFFSETS from the layout (cqw/cqh = % of stage).
          for (let s = win[0]; s < win[1] - 1e-6; s += SAMPLE_STEP) {
            const k = sampleKf(kfs, s);
            // CSS transform 은 글자 상자 **중심**을 원점으로 돌리고 키운다. ASS 는 \an 앵커
            // (제목=상단중앙) 기준이라, 회전 원점을 \org 로 중심에 맞추고 확대분의 절반을
            // 위로 되돌려야 미리보기와 같은 자리에서 자란다.
            const orgY = Math.round(by + ((k.y ?? 0) / 100) * H + fitPx / 2);
            const orgX = Math.round(bx + ((k.x ?? 0) / 100) * W);
            const grow = (k.scale ?? 1) - 1;
            const yFix = grow * fitPx / 2;
            // 좌/우 정렬은 가로도 한쪽으로만 자란다(중앙정렬은 대칭이라 보정 불필요).
            const xFix = an === 8 ? 0 : (an === 7 ? -1 : 1) * grow * textWidthPx(t.text, fitPx) / 2;
            const extra = `\\fscx${Math.round(k.scale * 100)}\\fscy${Math.round(k.scale * 100)}${assAlpha(k.opacity)}\\frz${(-k.rotation).toFixed(1)}\\org(${orgX},${orgY})`;
            putWin(an, bx + ((k.x ?? 0) / 100) * W + xFix, by + ((k.y ?? 0) / 100) * H - yFix, fs, color, 2, "&H00000000&", t.text, s, Math.min(win[1], s + SAMPLE_STEP), extra);
          }
        } else {
          putWin(an, bx, by, fs, color, 2, "&H00000000&", t.text, win[0], win[1]);
        }
      }
    }
    // 채널 뱃지 — 이름 + 부가줄(channelExtraLines). 부가줄은 예전엔 미리보기에만 있고
    // 서버가 아예 안 구워서 **결과물에서 통째로 증발**했다(소비처 미도달).
    // 채널명은 그대로 — 예전엔 "▶ " 를 앞에 굽었는데 지저분해서 뺐다(사용자 2026-08-12).
    // staticToPng 면 채널명/부가줄은 canvas-PNG 가 그리므로 ASS 에선 건너뛴다(아이콘·시간박스는 별도).
    if (!staticToPng) {
      const badge = channelBadgeLayout(es, W, H, scale, options.channelIcon ?? null);
      for (const line of badge?.lines ?? []) {
        // 부가줄은 미리보기가 text-white/80 (font-medium) — 알파 &H33 로 맞춘다.
        put(line.an, line.x, line.y, assFs(line.px), line.dim ? "&H33FFFFFF&" : "&H00FFFFFF&",
          2, "&H00000000&", line.text);
      }
    }
    // 방영시간 박스 라벨 (broadcast-standard) — 파란 박스 + 흰 텍스트. BoxLabel 스타일은
    // BorderStyle=3(박스)이고 박스 색은 인라인 \3c 로 지정한다.
    const boxText = String((es as any).channelBoxText ?? "").trim();
    if (es.showChannel && boxText) {
      const boxY = Math.round(((Number((es as any).channelBoxY) || 86.5) / 100) * H);
      const boxColor = hexToAss(String((es as any).channelBoxColor || "#3D7BD9"));
      const fs = assFs(22 * scale);
      pushDecor(0, durSec, (start, finish) =>
        `Dialogue: 0,${assTime(start)},${assTime(finish)},BoxLabel,,0,0,0,,` +
        `{\\an8\\pos(${Math.round(0.5 * W)},${boxY})\\fs${fs}\\3c${boxColor}\\4c${boxColor}}${assEscape(boxText)}`,
      );
    }
    for (const el of Array.isArray(es.elements) ? es.elements : []) {
      if (!el?.text?.trim()) continue;
      // el.size 는 출력 px(정규화됨) — 그대로. 미설정 기본값(arrow 40 / 기타 14)만 scale 배.
      const fs = assFs(Number(el.size) > 0 ? Number(el.size) : (el.type === "arrow" ? 40 : 14) * scale);
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
  if (capOn && includeCaptions) {
    const capHi = hexToAss((es && typeof es === "object" && es.highlightColor) || "#FFD400");
    // Keyword tokens sweep to a distinct colour; default = the highlight colour (so it's a
    // no-op unless the operator picks one), matching CapCut/Opus keyword emphasis.
    const capKey = hexToAss((es && typeof es === "object" && es.keywordColor) || (es && typeof es === "object" && es.highlightColor) || "#FFD400");
    // 자막 색 오버라이드(captionColor) — 자동배포 규칙의 subtitleColor 가 여기로 온다. 있으면
    // 자막 기본색을 이 색으로 바꾼다(미리보기 template-preview 의 subtitleColor 와 1:1). 없으면
    // 기존 흰색. 카라오케 base·비카라오케 문장 모두 같은 base 색을 쓴다.
    const capColorOverride = es && typeof es === "object"
      && typeof (es as any).captionColor === "string" && /^#[0-9a-fA-F]{6}$/.test((es as any).captionColor)
      ? hexToAss((es as any).captionColor) : null;
    const white = capColorOverride ?? "&H00FFFFFF&";
    // 인라인 색 태그 — 비카라오케 문장에 얹는다. **별도 변수로 뺀다**: push() 안에 중첩 백틱이
    // 생기면 overlay-parity 스캔이 자막 이벤트를 못 센다(정규식이 `Dialogue:[^`]*` 로 잡는다).
    const capColorInline = capColorOverride ? `\\1c${capColorOverride}` : "";
    // 화면 단위로 끊는다 — STT 세그먼트 한 덩어리(40~60자)가 통째로 뜨면 쇼츠에선 화면 절반이
    // 자막이 된다. 미리보기(editor-shell captionText)가 **같은 함수·같은 상한**으로 끊어 보여준다.
    const capMaxChars = captionMaxCharsOf(es);
    const capChunks = (Array.isArray(captions) ? captions : []).flatMap((c) => chunkCaption(c, capMaxChars));
    for (const cap of capChunks) {
      const text = String(cap.text ?? "").trim();
      if (!text || !(cap.end > cap.start)) continue;
      // ⚠️ 카라오케(단어별 하이라이트)는 **명시적으로 켤 때만** 굽는다(karaoke === true).
      //
      // 예전엔 기본이 ON 이었다(karaoke !== false). 게다가 whisper STT 의 실제 word timing 이
      // 있으면 karaoke 설정과 무관하게 단어별로 구웠다. 그런데 미리보기는 **절대** 단어별
      // 하이라이트를 안 그린다(세그먼트 통짜) — 한국 방송은 word-by-word 를 안 쓴다는 확정
      // 방침이다(2026-07-24). 그래서 기본 클립·옛 저장분에서 미리보기엔 없던 노란 단어 스윕이
      // 결과물에만 나타났다. 미리보기=렌더를 위해 명시 opt-in 으로 바꾼다.
      const karaokeOn = es && typeof es === "object" && (es as any).karaoke === true;
      const words = karaokeOn
        ? (Array.isArray(cap.words) && cap.words.length ? cap.words : synthesizeWords(text, cap.start, cap.end))
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
          // \q1 = 그리디 자동 줄바꿈. 스크립트 전역은 WrapStyle 2(줄바꿈 없음)라, 이게 없으면
          // 긴 문장이 미리보기에선 접히고 렌더에선 화면 밖으로 뻗는다.
          captionEv.push(`Dialogue: 0,${assTime(prev)},${assTime(lineEnd)},Caption,,0,0,0,,{\\q1\\1c${white}}${parts.join(" ")}`);
          prev = we;
        });
      } else {
        // 비카라오케 문장 — 색 오버라이드가 있으면 인라인 \1c(capColorInline)로 얹는다(스타일 PrimaryColour 위에).
        captionEv.push(`Dialogue: 0,${assTime(cap.start)},${assTime(cap.end)},Caption,,0,0,0,,{\\q1${capColorInline}}${assEscape(text)}`);
      }
    }
  }

  const ev = [...decorationEv, ...captionEv];
  if (!ev.length) return null;
  // 자막 세로 위치 — editorState.captionY(% · 하단 기준 · \an2)가 있으면 그걸, 없으면 기본 26%.
  // 자동배포 규칙의 subtitleY 가 여기로 온다(factory.autoEditorState). 미리보기 SUBTITLE_DEFAULTS.y
  // 와 CAPTION_MV_PCT 가 같아야 결과물 자막이 편집 화면과 같은 높이에 박힌다(파리티 테스트가 강제).
  const captionYPct = es && typeof es === "object" && Number.isFinite((es as any).captionY)
    ? Number((es as any).captionY) : CAPTION_MV_PCT;
  const capMV = Math.round((H * captionYPct) / 100);
  const capStyle = (es && typeof es === "object" && es.captionStyle) || "korean_pop";
  // 자막 크기 오버라이드(captionSize · % · 화면 높이 기준) — 있으면 그걸, 없으면 스타일 기본(CAPTION_PCT).
  const capSizePct = es && typeof es === "object" && Number.isFinite((es as any).captionSize) && Number((es as any).captionSize) > 0
    ? Number((es as any).captionSize) : undefined;
  // 자막 좌우 여백은 미리보기 컨테이너(px-6 = 스테이지 24px)와 같게 — 이 폭에서 \q1 이 접는다.
  const capMH = Math.max(8, Math.round(24 * scale));
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    // Pretendard ExtraBold — TVING 풍 헤드라인(사용자 확정 2026-08-12). 이미지에 폰트가
    // 없으면 libass 가 fontconfig 폴백(Noto)으로 조용히 대체하므로 Dockerfile 의
    // assets/fonts COPY + fc-cache 와 세트다.
    `Style: Default,Pretendard ExtraBold,48,&H00FFFFFF,&H00000000,&H00000000,1,1,2,1,5,20,20,20,1\n` +
    // 방영시간 박스 라벨 — BorderStyle=3(불투명 박스), Outline=박스 패딩. 박스 색은 인라인 \3c.
    `Style: BoxLabel,Pretendard ExtraBold,48,&H00FFFFFF,&H00D97B3D,&H00D97B3D,1,3,14,0,5,20,20,20,1\n` +
    captionAssStyle(capStyle, H, capMV, capMH, capSizePct) + "\n\n" +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    ev.join("\n") + "\n"
  );
}

/**
 * 훅 프리롤(첫 3초)에 화면 상단으로 크게 굽는 **훅 캡션** ASS. 편집자가 고친 hookCaption
 * (editorState) 을 시청자 잡는 한 줄로 보여준다(사용자 2026-08-20). 본문 자막과 별개 — 프리롤
 * 입력([0:v]) 체인에만 ass= 로 적용된다(ffmpeg renderShortWithPreroll / renderDynamicShortWithPreroll).
 * 폰트·색·외곽선은 본문 Default 스타일과 같은 계열(Pretendard ExtraBold · 흰 글자 + 검은 외곽).
 */
function buildHookCaptionAss(caption: string, W: number, H: number, durSec: number): string {
  const fs2 = Math.round(H * 0.072);              // 큰 훅 헤드라인 (출력 px)
  const outline = Math.max(3, Math.round(H * 0.005));
  const mv = Math.round(H * 0.12);                // an8(상단 중앙) 기준 위에서 12%
  const mh = Math.round(W * 0.08);                // 좌우 여백 = 줄바꿈 폭
  const dur = Math.max(0.3, durSec);
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Hook,Pretendard ExtraBold,${fs2},&H00FFFFFF,&H00000000,&H80000000,1,1,${outline},3,8,${mh},${mh},${mv},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    `Dialogue: 0,${assTime(0)},${assTime(dur)},Hook,,0,0,0,,{\\fad(120,0)}${assEscape(caption)}\n`
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
/**
 * 자막 크기는 **미리보기 표(editor-preview.tsx::captionStyleClasses)의 cqh 값이 정본**이다.
 * cqh = 스테이지 높이 % 이고 PlayResY = 출력 높이라, 같은 % 를 그대로 쓰면 1:1 로 맞는다.
 * 예전엔 기준 4.2% × 스타일 배율(0.91~1.10)로 따로 계산해서 최대 0.9% 어긋났다 —
 * 값을 두 군데서 굴리면 언젠가 갈라진다. 여기 표는 웹 표와 숫자가 같아야 한다.
 */
const CAPTION_PCT: Record<string, number> = {
  news: 4.2, clean: 3.9, yellow_pop: 4.4, cyan_neon: 4.3, pink_bubble: 3.9,
  outline_bold: 4.6, shadow_soft: 3.9, highlight_bar: 4.1, typewriter: 3.8, korean_pop: 4.4,
};

/**
 * 자막 기본 세로 위치(% · 화면 하단 기준 · \an2 MarginV). 자동배포 미리보기의
 * SUBTITLE_DEFAULTS.y(template-preview.tsx)와 **1:1** 이어야 한다 — overlay-parity.test.ts 가 강제.
 */
// 26% (사용자 확정 2026-08-24). SUBTITLE_DEFAULTS.y·편집기 미리보기 폴백도 같이 26.
const CAPTION_MV_PCT = 26;

function captionAssStyle(style: string, H: number, mv: number, mh: number, sizePct?: number): string {
  // 웨이트도 미리보기와 맞춘다 — 설치 폰트는 Bold(700)·ExtraBold(800)·Black(900) 3종이라
  // font-extrabold 는 "Pretendard ExtraBold", font-black 은 "Pretendard Black" 를 지정해야
  // 한 단계 얇게 나가지 않는다(가족명 실측: Pretendard / Pretendard ExtraBold / Pretendard Black).
  const font = "Pretendard";
  const xbold = "Pretendard ExtraBold";
  const black = "Pretendard Black";
  // 크기 오버라이드(sizePct · % · 화면 높이 기준)가 있으면 그걸, 없으면 스타일 기본표(CAPTION_PCT).
  const pct = Number.isFinite(sizePct) && Number(sizePct) > 0 ? Number(sizePct) : (CAPTION_PCT[style] ?? CAPTION_PCT.korean_pop);
  const fs = assFs((H * pct) / 100);
  // ASS 필드: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold,
  //          BorderStyle(1=outline+shadow, 3=box), Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  // 색은 &HAABBGGRR (Alpha·B·G·R). 프리뷰(editor-preview.tsx:captionStyleClasses)와 시각 매칭.
  switch (style) {
    case "news":
      // 뉴스: 흰 텍스트 + 반투명 검은 박스 (프리뷰 rounded bg-black/70 · font-bold)
      return `Style: Caption,${font},${fs},&H00FFFFFF,&H00000000,&HA0000000,1,3,0,0,2,${mh},${mh},${mv},1`;
    case "clean":
      // 클린: 흰 텍스트 + 얇은 그림자 (프리뷰 textShadow 0 1px 3px · font-semibold)
      return `Style: Caption,${font},${fs},&H00FFFFFF,&H00000000,&H00000000,1,1,1,0,2,${mh},${mh},${mv},1`;
    case "yellow_pop":
      // 노란 팝: 노랑 #FFD400 (BGR &H0000D4FF) + 검정 스트로크 + 그림자 (font-extrabold)
      return `Style: Caption,${xbold},${fs},&H0000D4FF,&H00000000,&H80000000,1,1,4,2,2,${mh},${mh},${mv},1`;
    case "cyan_neon":
      // 시안 네온: 시안 #00E5FF (BGR &H00FFE500) + 시안 아웃라인 (네온 그로우 근사 · font-extrabold)
      return `Style: Caption,${xbold},${fs},&H00FFE500,&H00CC8500,&H00000000,1,1,3,0,2,${mh},${mh},${mv},1`;
    case "pink_bubble":
      // 핑크 버블: 흰 텍스트 + 핑크 박스 #EC4899 (BGR &H009948EC · font-bold)
      return `Style: Caption,${font},${fs},&H00FFFFFF,&H00000000,&HD09948EC,1,3,0,0,2,${mh},${mh},${mv},1`;
    case "outline_bold":
      // 굵은 아웃라인만: 프리뷰가 transparent + 2px 흰 stroke → 검정 fill + 굵은 흰 스트로크(근사 · font-black)
      return `Style: Caption,${black},${fs},&H00000000,&H00FFFFFF,&H00000000,1,1,5,0,2,${mh},${mh},${mv},1`;
    case "shadow_soft":
      // 부드러운 그림자: 흰 텍스트 + 큰 부드러운 그림자 (프리뷰 0 2px 12px · font-medium)
      return `Style: Caption,${font},${fs},&H00FFFFFF,&H00000000,&H80000000,0,1,0,4,2,${mh},${mh},${mv},1`;
    case "highlight_bar":
      // 형광펜: 검정 텍스트 + 노랑 박스 #FFE066 (BGR &H0066E0FF · font-bold)
      return `Style: Caption,${font},${fs},&H00000000,&H00000000,&H0066E0FF,1,3,0,0,2,${mh},${mh},${mv},1`;
    case "typewriter":
      // 타자기: 흰 텍스트 + 검정 박스 + 자간 넓게. ⚠️ Courier New 는 렌더 이미지에 없어
      // fontconfig 폴백(DejaVu 계열)으로 나간다 — 미리보기(ui-monospace)와 서체가 다르다.
      return `Style: Caption,Courier New,${fs},&H00FFFFFF,&H00000000,&HFF000000,1,3,0,0,2,${mh},${mh},${mv},1`;
    case "korean_pop":
    default:
      // 예능 팝 (기본): 흰 텍스트 + 두꺼운 검정 스트로크 + 그림자 (font-extrabold)
      return `Style: Caption,${xbold},${fs},&H00FFFFFF,&H00000000,&H80000000,1,1,4,2,2,${mh},${mh},${mv},1`;
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
  /** Validated compact AI plan; omitted for the legacy basic Fit render. */
  reframePlan?: ReframePlan | null;
  /** 첫 3초 hook 프리롤 (편집자가 "첫 3초 훅" 토글 ON + clip.hookTimeSec 있을 때만). */
  hookPreroll?: { startTime: number; durationSec: number; hasAudio?: boolean; caption?: string; captionAssPath?: string | null } | null;
}): Promise<
  | { clipMediaId: string; clipStored: string; thumbStored: string | null;
      cmeta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean } }
  | null
> {
  const { master, episodeId, startTime, endTime, title } = opts;
  const aspect = opts.aspect ?? opts.editorState?.aspect ?? "9:16";
  // editorState 크기를 출력 px basis 로 정규화(옛 저장분·factory 시드 = 스테이지 px · 마커 없음).
  // 이후 모든 렌더 경로(아이콘·배지·제목·요소)가 출력 px 를 그대로 쓴다(scale 은 상수·기본값 전용).
  const editorState = normalizeEditorCoords(opts.editorState, aspect);
  const masterObjPath = parseObjectPath(master.path);
  if (!(await fileExists(masterObjPath))) return null;

  const tmpDir = path.resolve("/tmp/stepd-clips");
  fs.mkdirSync(tmpDir, { recursive: true });
  const clipMediaId = newId("m");
  const clipObjPath = clipPath(clipMediaId);
  const tmpPath = path.join(tmpDir, `${clipMediaId}.mp4`);
  const thumbTmp = path.join(tmpDir, `${clipMediaId}.jpg`);
  const assTmp = path.join(tmpDir, `${clipMediaId}.ass`);
  const captionAssTmp = path.join(tmpDir, `${clipMediaId}_captions.ass`);
  const decorationAssTmp = path.join(tmpDir, `${clipMediaId}_decor.ass`);
  const iconRawTmp = path.join(tmpDir, `${clipMediaId}_icon_raw`);
  const iconTmp = path.join(tmpDir, `${clipMediaId}_icon.png`);
  const overlayPngTmp = path.join(tmpDir, `${clipMediaId}_overlay.png`);

  const { W, H, stageH } = renderDims(aspect);
  const dynamicReframe = opts.reframePlan?.mode === "ai_multi";
  let ass: string | null = null;
  let captionAss: string | null = null;
  let decorationAss: string | null = null;

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
  const hookCaptionAssTmp = path.join(tmpDir, `${clipMediaId}_hook.ass`);
  let hookPreroll = opts.hookPreroll && opts.hookPreroll.durationSec > 0 ? opts.hookPreroll : null;
  // 훅 캡션(편집자가 고친 hookCaption)을 프리롤 화면 상단에 크게 굽는다 — ASS 로 만들어 넘긴다.
  // 실패해도 프리롤(영상+TTS)은 그대로 나간다(자막만 생략).
  if (hookPreroll?.caption && hookPreroll.caption.trim()) {
    try {
      fs.writeFileSync(
        hookCaptionAssTmp,
        buildHookCaptionAss(hookPreroll.caption.trim(), W, H, hookPreroll.durationSec),
        "utf-8",
      );
      hookPreroll = { ...hookPreroll, captionAssPath: hookCaptionAssTmp };
    } catch (e) {
      console.warn("[render] 훅 캡션 ASS 실패(자막 생략):", String(e).slice(0, 120));
    }
  }

  // 하단 브랜딩 아이콘 — **프로그램에서 미리 설정**한 이미지(brandIconDataUrl, 사용자 결정
  // 2026-08-12)를 원형으로 잘라 채널명 위에 얹는다. 없으면 조용히 생략(텍스트 브랜딩만).
  // hookPreroll 경로는 배지 미지원이라 프리롤일 땐 넘기지 않는다.
  let badge: { path: string; y: number; h: number; x?: number } | null = null;
  /** 실제로 얹힐 아이콘 크기 — ASS(이름 위치)와 overlay(아이콘 위치)가 **같은 값**을 봐야 한다. */
  let iconBox: { w: number; h: number } | null = null;
  if (editorState?.showChannel && !editorState?.channelIconOff && episodeId && !hookPreroll) {
    try {
      // 아이콘 소스 우선순위: 클립별 업로드(에디터 channelIconDataUrl) > 프로그램 기본
      // (프로그램 설정의 brandIconDataUrl — 사용자 결정 2026-08-12 "아이콘은 프로그램에서 미리").
      let iconSrc = String(editorState?.channelIconDataUrl ?? "");
      if (!/^data:image\//i.test(iconSrc)) {
        const ep = await getEntity<Record<string, unknown>>("episode", episodeId);
        const prog = ep?.programId
          ? await getEntity<Record<string, unknown>>("program", String(ep.programId)) : null;
        iconSrc = String(prog?.brandIconDataUrl ?? "");
      }
      const m = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(iconSrc);
      if (m) {
        fs.writeFileSync(iconRawTmp, Buffer.from(m[1], "base64"));
        const scale = constScale(H, stageH);
        // channelIconSize 는 **높이(px, 에디터 기준)** — 가로 워드마크도 세로 아이콘도
        // 높이로 통일해야 크기가 폭주하지 않는다 (2026-08-12 데모에서 정사각 로고가
        // 폭 기준 519px 로 부풀어 시간 박스를 덮었다).
        const iconH = Math.round(Number(editorState?.channelIconSize) > 0
          ? Number(editorState.channelIconSize) : 40 * scale); // 출력 px(정규화) · 기본값만 scale
        // 모양: circle 이면 원형 크롭, 그 외(square 등)는 원본 비율 그대로 — 프로그램
        // 로고(가로 워드마크)를 원으로 자르면 깨지기 때문 (broadcast-standard).
        const shape = String(editorState?.channelIconShape ?? "circle");
        let badgePath = iconRawTmp;
        if (shape === "circle") { await circleCrop(iconRawTmp, iconTmp, iconH); badgePath = iconTmp; }
        // 실제로 얹힐 **폭**을 잰다 — 가로 배치에서 이름을 얼마나 밀지가 여기서 정해진다.
        // (ffmpeg 은 scale=-1:h 로 높이만 맞추므로 폭은 원본 비율에서 나온다.)
        const dim = await probe(badgePath).catch(() => null);
        const iconW = dim?.width && dim?.height
          ? Math.max(1, Math.round(iconH * (dim.width / dim.height))) : iconH;
        // 배치: 미리보기와 같은 흐름(아이콘+이름 한 행)으로 놓는다. channelIconY 가 명시된
        // 템플릿 시드는 그 자리를 존중해 종전대로 독립 배치(그때는 이름도 화면 중앙).
        iconBox = { w: iconW, h: iconH };
        const iconYPct = Number(editorState?.channelIconY);
        const laid = channelBadgeLayout(editorState, W, H, scale, iconBox);
        const chY = ((Number(editorState?.channelY) || 82) / 100) * H;
        const y = iconYPct > 0
          ? Math.round((iconYPct / 100) * H)
          : Math.round(laid?.icon?.y ?? chY - iconH - 28);
        const x = iconYPct > 0 || !laid?.icon ? undefined : Math.round(laid.icon.x);
        badge = { path: badgePath, h: iconH, y, ...(x != null ? { x } : {}) };
      }
    } catch (e) {
      console.warn("[render] 브랜딩 아이콘 준비 실패(생략):", String(e).slice(0, 120));
    }
  }

  // 정적 오버레이 canvas-PNG (AENA 방식 · 구조적 WYSIWYG) — **basic 단일입력 경로에서만.**
  // 제목(완전 정적 줄)·채널명 텍스트를 투명 PNG 로 그려 ffmpeg overlay 로 합성하고, ASS 에선
  // 그 항목을 뺀다(staticToPng). canvas 미지원/실패·그릴 항목 없음이면 overlayPngPath=null →
  // staticToPng=false 로 폴백해 종전대로 ASS 가 전부 굽는다(무회귀 안전장치).
  // AI(reframe)·훅 프리롤 경로는 입력 구성이 달라 아직 PNG 를 안 쓴다(전부 ASS 유지).
  let overlayPngPath: string | null = null;
  if (!dynamicReframe && !hookPreroll) {
    try {
      const scale = constScale(H, stageH);
      const items = buildStaticOverlayItems(editorState, W, H, scale, iconBox);
      if (items.length && (await overlayCanvasAvailable())) {
        const buf = await renderTextLayerPng({ width: W, height: H, items });
        if (buf && buf.length) {
          fs.writeFileSync(overlayPngTmp, buf);
          overlayPngPath = overlayPngTmp;
        }
      }
    } catch (e) {
      console.warn("[render] 정적 오버레이 PNG 실패(ASS 폴백):", String(e).slice(0, 120));
      overlayPngPath = null;
    }
  }
  const overlayPngActive = overlayPngPath != null;

  // ASS 는 **아이콘 크기를 잰 뒤에** 만든다 — 가로 배치에서 채널명 x 가 아이콘 폭에 걸려
  // 있어서, 순서가 바뀌면 이름과 아이콘이 서로 다른 기준으로 놓인다.
  if (dynamicReframe) {
    const fitIntervals = fitIntervalsForPlan(opts.reframePlan!, startTime, endTime);
    captionAss = buildEditorAss(
      editorState, W, H, stageH, endTime - startTime, opts.captions,
      { include: "captions", channelIcon: iconBox },
    );
    decorationAss = buildEditorAss(
      editorState, W, H, stageH, endTime - startTime, opts.captions,
      { include: "decorations", visibleIntervals: fitIntervals, channelIcon: iconBox },
    );
    if (captionAss) fs.writeFileSync(captionAssTmp, captionAss, "utf-8");
    if (decorationAss) fs.writeFileSync(decorationAssTmp, decorationAss, "utf-8");
  } else {
    ass = buildEditorAss(editorState, W, H, stageH, endTime - startTime, opts.captions,
      { channelIcon: iconBox, staticToPng: overlayPngActive });
    if (ass) fs.writeFileSync(assTmp, ass, "utf-8");
  }

  try {
    if (!dynamicReframe && !ass && !overlayPngActive && !videoFilters && !audioFilter && speed === 1 && aspect === "16:9" && !hookPreroll) {
      // Fast path only when there's genuinely nothing to bake (no ASS overlays, no static
      // overlay PNG, no grade, no volume change, no speed change, native 16:9, no hook
      // preroll). Any edit — including a canvas-PNG static overlay — routes through renderShort.
      await trimEncode(srcPath, startTime, endTime, tmpPath);
    } else {
      // 채움/크롭 결정 — **종횡비 enum(aspect) 이 정본.** aspect-presets.ts 프리셋 하나가
      // contain(레터박스)·cover(꽉채우기)·rect(밴드 크롭)를 결정한다. 프레임·AI 경로가 없을 때만 적용.
      //   letterbox → fit:contain + 검정 pad(bgColor=state.bg) · blur 는 letterbox 하위옵션만
      //   crop-full → fit:cover · crop-main/sub → cropRect(사각형+검정 pad)
      // 구형 저장분(bare "9:16"/1:1/4:5, 프리셋 없음)은 예전 fit/bgType 폴백을 그대로 써서 무회귀.
      const aspectPreset = getAspectPreset(aspect);
      const bgColor = typeof editorState?.bg === "string" ? editorState.bg : undefined;
      let fit: "contain" | "cover";
      let bgType: "solid" | "blur" | "image";
      let cropRect: { x: number; y: number; w: number; h: number } | null = null;
      if (aspectPreset) {
        if (aspectPreset.fill === "rect") {
          cropRect = aspectPreset.rect ?? null;
          fit = "contain"; bgType = "solid"; // cropRect 있으면 renderShort 가 fit/bgType 무시
        } else if (aspectPreset.fill === "cover") {
          fit = "cover"; bgType = "solid";
        } else {
          // 레터박스 — 검정 pad 기본, blur 는 여백 채움 하위옵션(비율 축과 직교).
          fit = "contain";
          bgType = aspectPreset.blurCapable && editorState?.bgType === "blur" ? "blur" : "solid";
        }
      } else {
        // 구형 bare "9:16"/1:1/4:5 — 예전 렌더 동작 유지(무회귀). image 는 solid 로 폴백.
        fit = editorState?.fit === "cover" ? "cover" : "contain";
        bgType = (editorState?.bgType === "solid" || editorState?.bgType === "image"
          ? editorState.bgType : "blur") as "solid" | "blur" | "image";
      }
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
        assPath: dynamicReframe ? null : ass ? assTmp : null,
        captionAssPath: captionAss ? captionAssTmp : null,
        decorationAssPath: decorationAss ? decorationAssTmp : null,
        // 정적 오버레이 PNG — renderShort 의 basic 경로가 overlay=0:0 으로 합성한다(ASS 대신).
        overlayPngPath,
        reframePlan: opts.reframePlan ?? null,
        videoFilters, audioFilter, speed,
        bgType, bgColor, fit, cropRect, frame,
        hookPreroll,
        badge,
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
    try { fs.unlinkSync(captionAssTmp); } catch {}
    try { fs.unlinkSync(decorationAssTmp); } catch {}
    try { fs.unlinkSync(iconRawTmp); } catch {}
    try { fs.unlinkSync(iconTmp); } catch {}
  }
}

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

/**
 * 감사·요청자 표기용 행위자. **세션이 있으면 그 이메일이 정본** — 클라이언트가 보낸 actor 는
 * 위조 가능하므로 세션을 우선한다. 세션이 없는 자세에서만 클라이언트 값으로 폴백한다(없으면 "").
 */
function sessionActor(c: Context<AppEnv>, fallback: unknown): string {
  return c.get("user")?.email || readActor(fallback);
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

// 순방 주기(ms) — 화면의 "다음 확인 예정" 이 마지막 순방 시각에 이걸 더해 추정한다. 워커의
// CYCLE_EVERY_MS 와 **같은 env·같은 기본값**(10분)을 읽어야 화면이 실제 주기와 안 갈라진다.
// 0 이면 주기 순방이 꺼진 것(수동 "지금 확인" 만) — 화면이 다음 예정 표시를 숨긴다.
const AUTOMATION_CYCLE_MS = Number(process.env.AUTOMATION_CYCLE_MS ?? 10 * 60 * 1000);

app.get("/api/automation", async (c) => {
  const [rules, runs, holds, paused, balance, autoTopupAlert, lastCycleAt, notifyEmail] = await Promise.all([
    listAutomationRules(),
    listRuleRuns(50),
    openHolds(),
    getAutomationSetting(PAUSE_KEY),
    creditBalance(),
    getAutoTopupAlert(),
    getAutomationSetting(LAST_CYCLE_KEY),
    getAutomationSetting(NOTIFY_EMAIL_KEY),
  ]);
  const plan = planCycle({ paused: paused === "true", rules: rules as any });
  // 규칙×채널별 오늘 게시 수 — 순방이 한도 판정에 쓰는 publishedTodayKst 그대로.
  // 화면의 "오늘 2/3" 표기가 이 필드를 읽는다(없으면 UI 가 그 줄을 숨긴다 — 생산자가
  // 빠지면 죽은 기능이 되는 걸 검증에서 한 번 잡았다).
  const rulesWithToday = await Promise.all(
    (rules as any[]).map(async (rule) => {
      const chans: { platform: string; accountId: string }[] =
        rule.channels?.length ? rule.channels : [{ platform: rule.platform, accountId: rule.accountId }];
      const publishedToday: Record<string, number> = {};
      for (const ch of chans) {
        const key = `${ch.platform}:${ch.accountId}`;
        // 채널 단위 집계 — 순방의 할당량 판정과 **같은 함수**를 써야 화면 숫자와 실제
        // 남은 건수가 갈라지지 않는다.
        publishedToday[key] = await publishedTodayKst(key);
      }
      // 월 예상 발행 건수 — **순방 판정과 같은 함수**에서 낸다(monthlyPublishEstimate).
      // 화면이 따로 계산하면 "월 66건" 이라 적어 놓고 실제로는 다른 수가 나가고, 그게 곧
      // 청구 예상과 어긋난다.
      return { ...rule, publishedToday, estimate: monthlyPublishEstimate(rule as any) };
    }),
  );
  return c.json({
    rules: rulesWithToday, runs, holds,
    paused: paused === "true",
    // ── 상태 헤더(자동배포 대시보드)의 생산자 ──────────────────────────────────
    // 잔액 — 화면이 "켜짐 / 크레딧 소진" 을 가른다(idleReason 만으론 0 인지 규칙이 없는 건지
    // 구분이 흐리다). 이 워크스페이스 자기 값이라 노출해도 교차 유출이 아니다.
    credit: balance,
    // 마지막 순방 시각(순방 심박 · runAutomationCycle 이 매번 찍는다) + 주기(ms). 화면이
    // "마지막 확인 N분 전 · 다음 예정 ~M분 후" 를 그린다. 아직 한 번도 안 돌았으면 null.
    lastCycleAt: lastCycleAt ?? null,
    cycleEveryMs: AUTOMATION_CYCLE_MS,
    // 순방(runAutomationCycle)이 크레딧 부족으로 정지 중이면 화면도 같은 사유를 보여야
    // 한다 — 규칙이 멀쩡한데 아무것도 안 나가는 상태를 사용자가 추리하게 두지 않는다.
    idleReason: balance <= 0 ? CREDIT_IDLE_REASON : plan.idleReason,
    // "크레딧 부족" 바로 옆에 **왜 자동 충전이 그걸 못 메웠는지**를 같이 준다. 이게 없으면
    // 사용자는 잔액이 0 인 것만 보고 카드 문제(한도초과·해지·상한 도달)를 추리해야 한다 —
    // 자동 충전 실패는 무인 경로라 사용자가 볼 자리가 애초에 없었다. 조치가 필요한 실패일
    // 때만 값이 있다(정상 사유는 credits.ts 심각도 표에서 걸러진다).
    autoTopupAlert,
    // 채널별 실업로드 스위치 — 게이트 경고 배너·"기록만" 배지의 생산자. 플랫폼 키 단독
    // (계정 무관 env 스위치라 계정별로 다를 수 없다).
    gates: {
      youtube: youtubeUploadEnabled(),
      navertv: naverUploadEnabled(),
      naverclip: naverUploadEnabled(),
      tiktok: tiktokUploadEnabled(),
      instagram: instagramUploadEnabled(),
      facebook: facebookUploadEnabled(),
    },
    options: { mediaKinds: RULE_MEDIA_KINDS, criteria: RULE_CRITERIA, gatePolicies: GATE_POLICIES },
    // 자동배포 완료 알림을 받을 담당자 이메일 — 워커의 실업로드 성공 지점(publish-notify.ts)이
    // 같은 키를 읽는다. 비어 있으면 알림 없음.
    notifyEmail: (notifyEmail ?? "").trim(),
  });
});

/**
 * 자동배포 완료 알림 담당자 이메일 저장. 빈 문자열 = 알림 끔(행 삭제 대신 빈 값 —
 * getAutoTopupAlert 와 같은 이유로 DELETE 경합을 피한다). 형식이 아니면 400.
 */
app.post("/api/automation/notify-email", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "invalid_email", message: "이메일 형식이 아닙니다." }, 400);
  }
  await setAutomationSetting(NOTIFY_EMAIL_KEY, email);
  return c.json({ ok: true, notifyEmail: email });
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
  // 기준 미지정이면 **매체별 기본값**을 쓴다 (2026-08-17 사용자 결정: "점수 기준으로 top3").
  // 근거는 실측이다 — 32.4분 회차 쇼츠 20편의 score100 이 42.1~72.6 이라 `score80` 규칙은
  // **한 건도 안 내보낸다**(클립은 81~83 이라 통과한다). 점수의 45%를 차지하는 신호축이
  // 회차 내 백분위라 평균이 0.5 근처로 눌리는 구조 때문이고, 훅·완결은 이미 0.92/1.00 이라
  // 더 올릴 여지가 없다. 규칙은 켜져 있는데 아무것도 안 나가는 상태가 이 리포 최빈
  // 실패모드라, 쇼츠 기본을 top3(회차당 상위 3건)로 둔다. 명시 지정은 그대로 존중한다.
  // 2026-08-26: 점수 하한 축을 없앴다 — 채택은 항상 "점수 순 상위, 회차당 상한까지" 하나다.
  // 화면은 이제 criterion 을 보내지 않고, **레거시 값(score80·score85)이 와도 400 이 아니라
  // 정규화**한다 — 저장돼 있던 계획을 편집만 해도 못 저장하게 되는 상황을 막는다.
  const criterion: RuleCriterion = "top3";
  if (!isGatePolicy(body.gatePolicy)) return c.json({ error: "invalid gatePolicy" }, 400);
  // 채택 형태 — 수동 채택 다이얼로그와 같은 값 체계(orientation·reframe). 틀린 값은 조용히
  // 버리지 않고 400 — "저장은 됐는데 반영이 안 된다"(이 리포 최빈 실패모드)의 입구를 막는다.
  if (body.orientation != null && !isRuleOrientation(body.orientation)) {
    return c.json({ error: "invalid orientation" }, 400);
  }
  if (body.reframe != null && !isRuleReframe(body.reframe)) {
    return c.json({ error: "invalid reframe" }, 400);
  }
  // 수동 다이얼로그는 세로형일 때만 리프레임을 묻는다(가로는 크롭이 없어 오선택 방지) —
  // 규칙도 같은 제약. 여기서 안 막으면 "AI 켰는데 영영 안 돈다"가 침묵 속에 저장된다.
  if (body.reframe === "ai" && body.orientation !== "portrait") {
    return c.json({ error: "AI 리프레임은 세로(portrait) 방향에서만 선택할 수 있습니다." }, 400);
  }
  // 썸네일 방식(0041) — 'ai'(서사+인물 누끼 생성) | 'frame'(실제 프레임+자막).
  if (body.thumbnailMode != null && !isRuleThumbnailMode(body.thumbnailMode)) {
    return c.json({ error: "invalid thumbnailMode" }, 400);
  }

  const row = {
    id: typeof body.id === "string" && body.id ? body.id : newId("ar"),
    programId, platform, accountId,
    mediaKind: body.mediaKind, criterion, gatePolicy: body.gatePolicy,
    window: typeof body.window === "string" ? body.window.trim() || "수시" : "수시",
    enabled: body.enabled !== false,
    // 렌더 템플릿 — 자동배포 화면에서 선택. 빈 값이면 프로그램 장르 자동 선택.
    ...(typeof body.templateId === "string" && body.templateId.trim()
      ? { templateId: body.templateId.trim() } : {}),
    // 위치 미세조정 — 숫자 필드만 통과 (자동배포 화면 슬라이더). 자막 오버레이(위치·크기·색·
    // on/off)도 **이 layout JSONB 안에** 함께 담는다 — automation_rule 에 자막 전용 컬럼을 새로
    // 두지 않고(마이그레이션 없이) 라운드트립시킨다. 순방은 rule.layout 에서 이 값을 읽어 렌더에 건다.
    ...((() => {
      const l = body.layout as Record<string, unknown> | undefined;
      if (!l || typeof l !== "object") return {};
      const num = (k: string) => (typeof l[k] === "number" && Number.isFinite(l[k]) ? { [k]: l[k] } : {});
      const layout: Record<string, number | string | boolean> = {
        ...num("titleY"), ...num("channelIconY"), ...num("channelBoxY"), ...num("channelIconSize"),
        // 제목 강조색(#RRGGBB) — 화면·api 타입·시드(factory titleAccent)는 다 있는데 여기만
        // 빠져 있어서 색 변경이 조용히 유실됐다(2026-08-25 점검). 저장이 곧 반영의 관문이다.
        ...(typeof l.titleColor === "string" && /^#[0-9a-fA-F]{6}$/.test(l.titleColor) ? { titleColor: l.titleColor } : {}),
        // 자막 — 위치·크기(숫자) · 색(#RRGGBB) · on/off(불리언).
        ...num("subtitleY"), ...num("subtitleSize"),
        ...(typeof l.subtitleColor === "string" && /^#[0-9a-fA-F]{6}$/.test(l.subtitleColor) ? { subtitleColor: l.subtitleColor } : {}),
        ...(typeof l.subtitles === "boolean" ? { subtitles: l.subtitles } : {}),
        // 요소 표시 플래그 — 미지정 = 표시. false 인 것만 의미가 있지만 true 도 라운드트립시킨다.
        ...(typeof l.title === "boolean" ? { title: l.title } : {}),
        ...(typeof l.logo === "boolean" ? { logo: l.logo } : {}),
        ...(typeof l.timebox === "boolean" ? { timebox: l.timebox } : {}),
      };
      return Object.keys(layout).length ? { layout } : {};
    })()),
    // 다중 프로그램·채널 (2026-08-12) — 단수 컬럼(programId·platform·accountId)은 첫
    // 항목으로 유지한다(UNIQUE 기준·구버전 호환). 배열이 정본.
    ...(Array.isArray(body.programIds) && body.programIds.length
      ? { programIds: (body.programIds as unknown[]).map(String).filter(Boolean) } : {}),
    ...(Array.isArray(body.channels) && (body.channels as unknown[]).length
      ? {
          channels: (body.channels as { platform?: unknown; accountId?: unknown }[])
            .map((ch) => ({ platform: String(ch.platform ?? "").trim(), accountId: String(ch.accountId ?? "").trim() }))
            .filter((ch) => ch.platform && ch.accountId),
        } : {}),
    // 하루 할당량(채널당)·활동 시간창(KST 시각)
    ...(Number.isFinite(body.dailyQuota) && Number(body.dailyQuota) > 0
      ? { dailyQuota: Math.min(50, Math.round(Number(body.dailyQuota))) } : {}),
    ...(Number.isFinite(body.activeStart) ? { activeStart: Math.max(0, Math.min(23, Math.round(Number(body.activeStart)))) } : {}),
    ...(Number.isFinite(body.activeEnd) ? { activeEnd: Math.max(0, Math.min(24, Math.round(Number(body.activeEnd)))) } : {}),
    // 발행 요일·발행 시각 슬롯(0042). **정규화는 automation.ts 한 곳에서** — 화면이 보낸 값을
    // 그대로 저장하면 순방의 판정과 화면의 월 예상 건수가 다른 값을 보게 된다.
    // 빈 배열은 미지정(= 매일 / 슬롯 없음)과 같게 null 로 떨어뜨린다.
    ...(Array.isArray(body.weekdays)
      ? { weekdays: ruleWeekdays({ weekdays: body.weekdays as number[] }) } : {}),
    ...(Array.isArray(body.slots)
      ? { slots: ruleSlots({ slots: body.slots as RuleSlotInput[] }) } : {}),
    // 채택 형태(0038) — 순방(automation-cycle)이 수동 채택과 같은 매핑으로 소비한다.
    ...(isRuleOrientation(body.orientation) ? { orientation: body.orientation } : {}),
    ...(isRuleReframe(body.reframe) ? { reframe: body.reframe } : {}),
    // 썸네일 방식(0041). 미지정이면 순방이 frame 으로 본다 — ai 는 등록 출연자 사진이
    // 있어야 해서, 기본으로 두면 캐스트 미등록 회차가 통째로 썸네일 없이 나간다.
    ...(isRuleThumbnailMode(body.thumbnailMode) ? { thumbnailMode: body.thumbnailMode } : {}),
  };
  // 동시에 두 요청이 같은 빈 채널을 읽고 각각 저장하는 틈도 닫는다. 잠금 안에서 다시 읽고
  // 저장하므로 뒤 요청은 앞 요청의 규칙을 본 뒤 409가 된다.
  return withTenantLock(`automation-rule-channels:${currentTenantId()}`, async () => {
    // 한 채널은 자동배포 하나에만 속한다. 화면 선택 잠금은 안내일 뿐이고, 외부 API/AENA가
    // 직접 호출해도 우회하지 못하도록 저장 직전 서버에서 다시 검사한다. 수정 중인 자기 규칙은
    // 제외하므로 기존 채널을 유지하거나 채널 일부를 빼는 갱신은 정상 동작한다.
    const existingRules = await listAutomationRules();
    const requestedChannels = row.channels?.length
      ? row.channels
      : [{ platform: row.platform, accountId: row.accountId }];
    const channelConflicts = findAutomationChannelConflicts(
      existingRules as any,
      requestedChannels,
      typeof body.id === "string" ? body.id : undefined,
    );
    if (channelConflicts.length > 0) {
      return c.json({
        code: "automation_channel_in_use",
        error: "선택한 채널은 이미 다른 자동배포에서 사용 중입니다. 기존 자동배포에서 채널을 빼거나 설정을 삭제한 뒤 다시 선택해 주세요.",
        conflicts: channelConflicts,
      }, 409);
    }
    // id 가 온 저장은 **갱신**이다 — 자연키 upsert 로 흘리면 첫 채널이 바뀌었을 때 새 규칙이
    // 생기고 구 규칙이 살아남아 이중 커버(한도 2배·뺀 채널로 계속 게시)가 된다.
    if (typeof body.id === "string" && body.id) {
      try {
        const updated = await updateAutomationRuleById(row as Parameters<typeof updateAutomationRuleById>[0]);
        if (updated) {
          return c.json({
            rule: row,
            state: initialRuleState(platform, row.enabled),
            notice: ruleCreatedNotice(platform),
          });
        }
        // id 를 줬는데 규칙이 없다(그새 삭제됨) — 새로 만드는 아래 경로로 진행.
      } catch (e: any) {
        if (String(e?.code) === "23505") {
          return c.json({
            error: "duplicate_rule",
            message: "같은 프로그램·채널 조합의 다른 자동배포 계획이 이미 있습니다 — 그 계획을 수정하거나 삭제하세요.",
          }, 409);
        }
        throw e;
      }
    }
    // 캐스트 이유는 updateAutomationRuleById 호출부와 같다 — row.layout 에 자막 색·on/off 같은
    // 문자/불리언이 섞여 AutomationRuleRow.layout(숫자 맵) 과 정확히 안 맞지만, layout 은 JSONB 라
    // 런타임엔 무엇이든 담긴다.
    await upsertAutomationRule(row as Parameters<typeof upsertAutomationRule>[0]);
    return c.json({
      rule: row,
      state: initialRuleState(platform, row.enabled),
      // ⚑ 기록만 하는 채널은 만들 때 그 사실을 말해야 한다(F6).
      notice: ruleCreatedNotice(platform),
    });
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

/**
 * 승인 대기 건 **거부** — 이 (규칙·영상)은 나가지 않는다(사용자 2026-08-21).
 *
 * 승인(release)과 대칭이되 **반대**다: 승인은 다음 순방에 다시 잡혀 게시되고, 거부는 순방이
 * 재선정도 게시도 하지 않고 건너뛴다(db rejectHold · automation-cycle isRejectedHold). 거부는
 * released_at 을 건드리지 않으므로 approve_first 게이트가 뚫려 되레 게시되는 사고가 없다.
 */
app.post("/api/automation/holds/reject", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const ruleId = typeof body.ruleId === "string" ? body.ruleId : "";
  const clipId = typeof body.clipId === "string" ? body.clipId : "";
  const actor = typeof body.actor === "string" ? body.actor.trim() : "";
  if (!ruleId || !clipId) return c.json({ error: "ruleId · clipId 가 필요합니다." }, 400);
  if (!actor) return c.json({ error: "actor required — 거부는 사람이 합니다." }, 400);

  const ok = await rejectHold(ruleId, clipId, actor);
  if (ok) {
    await appendRuleRun({ ruleId, clipId, result: "skipped", detail: `거부 · ${actor}` });
  }
  return c.json({ ok, notice: ok ? "거부했습니다 — 이 영상은 이 자동배포 계획으로 나가지 않습니다." : "이미 처리된 건입니다." });
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

// ── 저장 카드(빌링키) ─────────────────────────────────────────────────────────
// 매번 카드를 다시 넣지 않고 버튼 한 번으로 충전한다.
// 카드 번호는 브라우저 → 포트원으로 직접 가고 우리 서버엔 오지 않는다. 우리가 받는 건
// 빌링키 문자열뿐이지만, 그게 곧 "이 카드로 긁을 권한"이라 회사 스코프 안에서만 다룬다.

/** 카드 등록 준비 — 브라우저 SDK 에 넘길 값. 설정·필수정보가 없으면 창을 아예 안 띄운다. */
app.post("/api/billing/card/prepare", async (c) => {
  // **결제수단은 owner/admin 만 만진다.** member 는 분석을 돌리는 사람이지 회사 카드를
  // 등록·해지하거나 돈을 쓰는 사람이 아니다. 안 막으면 초대받은 외주 편집자가 회사 카드를
  // 등록하고 긁을 수 있다. (고객사 서버 키는 `billing:write` 를 통과한 경우만 — requireCardActor)
  requireCardActor(c);
  const cfg = billingConfig();
  if (!cfg.ok) return c.json({ error: "billing_unconfigured", message: cfg.message }, 503);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  // 저장된 카드의 구매자 정보를 **폴백**으로 쓴다 — 카드 변경(재등록) 때 사람이 3종을
  // 다시 타이핑하지 않아도 되게. 같은 폴백이 POST /api/credits/topup/card 에는 이미 있었고
  // 여기만 빠져 있었다: 그래서 서버가 전화번호를 갖고 있는데도 '카드 변경' 이 400 이었다.
  // 바디가 우선이다(사용자가 화면에서 고친 값이 정본).
  const saved = await getBillingCard();
  const who = checkCustomer({
    fullName: String(body.fullName ?? "").trim() || saved?.buyerName || "",
    email: String(body.email ?? "").trim() || saved?.buyerEmail || "",
    phoneNumber: String(body.phoneNumber ?? "").trim() || saved?.buyerPhone || "",
  });
  if (!who.ok) return c.json({ error: "customer_required", message: who.message, missing: who.missing }, 400);

  const tenantId = currentTenantId();
  const issueId = issueIdFor(tenantId, crypto.randomBytes(6).toString("hex"));
  return c.json({
    storeId: cfg.config.storeId,
    channelKey: cfg.config.channelKey,
    // KG이니시스는 CARD 고정 · issueId/issueName 필수.
    billingKeyMethod: "CARD",
    issueId,
    issueName: "STEP-D 크레딧 결제수단",
    customer: who.customer,
  });
});

/** 발급된 빌링키 저장. 회사당 한 장 — 다시 등록하면 덮어쓴다. */
app.post("/api/billing/card", async (c) => {
  const actor = requireCardActor(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const billingKey = String(body.billingKey ?? "").trim();
  if (!billingKey) return c.json({ error: "billing_key_required" }, 400);

  // 카드 표시정보(브랜드·마스킹 끝자리)는 포트원 빌링키 조회로 채운다 — 브라우저 SDK 응답엔
  // 카드번호가 없기 때문. 조회가 실패해도 카드 저장은 막지 않는다(표시만 못 할 뿐).
  let display: { brand: string | null; last4: string | null } = { brand: null, last4: null };
  try {
    display = extractCardDisplay(await getBillingKeyInfo(billingKey));
  } catch (e) {
    console.warn("[billing] 빌링키 카드정보 조회 실패(무시):", e instanceof Error ? e.message : e);
  }

  // 구매자 3종은 **저장 시 필수**다 — 빌링키 결제의 customer 필수값(이니시스)이라, 여기서
  // 안 받아두면 결제 때 보낼 값이 없어 저장 카드가 긁히지 않는 장식이 된다(2026-08-14 실측).
  //
  // ⚠️ 폴백은 **prepare 와 대칭**이어야 한다(2026-08-26). 예전엔 여기만 저장값 폴백이 없어서,
  // 바디를 비운 호출자(고객사 `billing:write` 키 등)는 prepare 는 폴백으로 통과해 **PG 에서
  // 빌링키가 실제로 발급된 뒤** 이 저장이 400 으로 떨어졌다 — 카드사에는 정기결제가 걸렸는데
  // 우리 DB 에는 없는 **고아 빌링키**가 남는다. 두 라우트가 같은 입력을 같게 봐야 그 틈이 없다.
  const savedBuyer = await getBillingCard();
  const buyerBody = (body.buyer ?? {}) as Record<string, unknown>;
  const who = checkCustomer({
    fullName: String(buyerBody.fullName ?? "").trim() || savedBuyer?.buyerName || "",
    email: String(buyerBody.email ?? "").trim() || savedBuyer?.buyerEmail || "",
    phoneNumber: String(buyerBody.phoneNumber ?? "").trim() || savedBuyer?.buyerPhone || "",
  });
  if (!who.ok) return c.json({ error: "customer_required", message: who.message, missing: who.missing }, 400);

  const card = await saveBillingCard({
    billingKey,
    // 포트원 조회값 우선, 없으면 클라이언트가 보낸 값 폴백.
    cardBrand: display.brand ?? (String(body.cardBrand ?? "").trim() || null),
    cardLast4: display.last4 ?? (String(body.cardLast4 ?? "").replace(/\D/g, "").slice(-4) || null),
    issuedBy: actor,
    buyer: who.customer,
  });
  // 카드 재등록이 곧 조치다 — 옛 실패 사유(해지된 카드·구매자 정보 없음·승인 거절)를 지운다.
  // 안 지우면 조치한 뒤에도 경고가 남아 화면이 거짓말한다(그 다음부터 아무도 경고를 안 본다).
  await clearAutoTopupAlert("card-register");
  return c.json({
    ok: true,
    card: {
      label: cardLabel(card.cardBrand, card.cardLast4),
      brand: card.cardBrand,
      last4: card.cardLast4,
      createdAt: card.createdAt,
    },
  });
});

app.get("/api/billing/card", async (c) => {
  let card = await getBillingCard();
  // 저장 시점에 표시정보를 못 채운 기존 카드는 여기서 한 번 백필한다(재등록 없이 번호가 뜨게).
  // 실패해도 조회는 정상 응답한다 — 표시정보가 없을 뿐이다.
  if (card?.billingKey && !card.revokedAt && !card.cardLast4) {
    try {
      const d = extractCardDisplay(await getBillingKeyInfo(card.billingKey));
      if (d.last4 || d.brand) {
        await updateBillingCardDisplay(d.brand, d.last4);
        card = { ...card, cardBrand: d.brand, cardLast4: d.last4 };
      }
    } catch (e) {
      console.warn("[billing] 카드 표시정보 백필 실패(무시):", e instanceof Error ? e.message : e);
    }
  }
  const cfg = billingConfig();
  // 저장된 구매자 3종을 **카드 관리 권한이 있는 행위자에게만** 내려준다 (2026-08-26).
  //
  // 왜 필요한가: 카드 등록/변경 화면이 이 값을 프리필한다. 예전엔 응답에 buyer 가 없어서,
  // 이미 카드를 등록해 서버가 전화번호를 갖고 있어도 '카드 변경' 을 누르면 빈 칸에서
  // 다시 시작했고 — 전화번호 입력란이 그 화면에 없어서 — 400 으로 막혔다(ENA 실측).
  // 왜 권한을 보나: 전화번호는 개인정보다. member 는 카드를 만질 수 없으니(requireCardActor)
  // 프리필도 필요 없다. 판정이 던지지 않게 감싼다 — 조회 자체는 누구에게나 200 이어야 한다
  // (화면이 "결제 수단 없음" 과 "권한 없음" 을 구분해 그린다).
  let canSeeBuyer = false;
  try { requireCardActor(c); canSeeBuyer = true; } catch { canSeeBuyer = false; }
  return c.json({
    // 빌링키 자체는 절대 내보내지 않는다 — 화면이 알 필요가 없다.
    registered: Boolean(card?.billingKey && !card.revokedAt),
    label: card ? cardLabel(card.cardBrand, card.cardLast4) : null,
    // 카드 모양 UI 재료 — 브랜드 + 마스킹 끝 4자리. 카드번호 원본은 애초에 없다.
    brand: card?.cardBrand ?? null,
    last4: card?.cardLast4 ?? null,
    createdAt: card?.createdAt ?? null,
    available: cfg.ok,
    unavailableReason: cfg.ok ? null : cfg.message,
    buyer: canSeeBuyer && card
      ? {
          fullName: card.buyerName ?? "",
          email: card.buyerEmail ?? "",
          phoneNumber: card.buyerPhone ?? "",
        }
      : null,
  });
});

app.delete("/api/billing/card", async (c) => {
  requireManager(c);
  await revokeBillingCard();
  // 카드 삭제가 곧 **자동 결제 중단**이다(2026-08-26 고정 정책 — 별도 on/off 가 없다).
  // 남은 옛 경고는 이미 없는 카드를 가리켜 화면이 거짓말한다: 지운 자리에서 함께 지운다.
  await clearAutoTopupAlert("card-delete");
  return c.json({ ok: true });
});

/**
 * 저장 카드로 충전. **서버가 직접 긁는다** — 결제창이 없다.
 *
 * 금액은 서버가 계산한다(클라이언트가 보낸 금액을 쓰면 1원에 10만 크레딧을 산다).
 * 승인 응답을 대조한 뒤에만 원장에 올린다 — 웹훅 경로와 같은 원칙이다.
 */
app.post("/api/credits/topup/card", async (c) => {
  // 저장 카드는 결제창도 인증도 없이 바로 긁힌다 — 누를 수 있는 사람을 좁혀야 한다.
  const manager = requireManager(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const check = buildTopup(body.credits);
  if (!check.ok) return c.json({ error: "bad_request", message: check.reason }, 400);

  // 멱등키는 **브라우저가 만들고 성공할 때까지 재사용한다** — 더블클릭·네트워크 재시도가
  // 같은 키로 오면 같은 paymentId 가 되어, 이미 긁힌 주문을 다시 긁지 않는다.
  // 키가 없으면 그 보호가 성립하지 않으므로 요청 자체를 받지 않는다.
  // 정제(strip)하면 서로 다른 키가 같은 paymentId 로 접힐 수 있다('a!b'와 'a?b') — 형식이
  // 틀리면 고쳐주지 말고 거절한다. 'auto' 시작은 자동 충전 슬롯(autoTopupNonce)과 같은
  // paymentId 네임스페이스라 예약어다.
  const idem = String(body.idempotencyKey ?? "");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(idem) || /^auto/i.test(idem)) {
    return c.json({ error: "bad_request", message: "idempotencyKey 형식이 올바르지 않습니다 (영숫자·-·_ 8~40자, 'auto' 시작 금지)." }, 400);
  }

  const card = await getBillingCard();
  const blocked = cardBlockReason(card);
  if (blocked) return c.json({ error: "no_card", message: blocked }, 409);

  // 빌링키 결제의 customer 필수 3종(이니시스). 카드에 저장된 값이 정본이고, 0037 이전
  // 등록 카드(저장분 없음)는 충전 화면의 구매자 입력으로 폴백한다 — 그마저 없으면 400.
  const storedBuyer = card?.buyerName && card?.buyerEmail && card?.buyerPhone
    ? { fullName: card.buyerName, email: card.buyerEmail, phoneNumber: card.buyerPhone }
    : null;
  const bodyBuyer = checkCustomer((body.buyer ?? {}) as Record<string, unknown>);
  const customer = storedBuyer ?? (bodyBuyer.ok ? bodyBuyer.customer : null);
  if (!customer) {
    return c.json({
      error: "customer_required",
      message: "결제에 구매자 정보(이름·이메일·휴대폰)가 필요합니다 — 충전 화면에서 입력해 주세요.",
    }, 400);
  }

  const tenantId = currentTenantId();
  const actor = manager.email;

  // 동시 클릭 둘이 나란히 들어와도 잠금 안에서 한 명씩 — 먼저 끝난 쪽이 paid 를 찍으면
  // 뒤따르는 쪽은 아래 getTopup 조회에서 걸려 카드를 다시 긁지 않는다.
  return await withTenantLock(`card-topup:${tenantId}`, async () => {
    // ⚠️ **실패로 닫힌 paymentId 는 재사용할 수 없다** — 포트원이 그 id 로는 새 결제를
    // 거부한다. 한도초과처럼 흔한 거절 뒤 사용자가 한도를 풀고 같은 금액으로 다시 눌러도
    // 계속 실패하는 함정이었다(브라우저 요청 키는 sessionStorage 에 그대로 남는다).
    // 같은 요청 키를 유지하되 슬롯을 한 칸씩 민다 — 자동 충전이 이미 쓰는 방법이다.
    let paymentId = cardTopupPaymentId(tenantId, idem);
    let existing = await getTopup(paymentId);
    for (let slot = 2; existing?.status === "failed" && slot <= 20; slot++) {
      paymentId = cardTopupPaymentId(tenantId, `${idem}#${slot}`);
      existing = await getTopup(paymentId);
    }
    // 같은 멱등키가 **다른 금액**으로 오면(실패 후 금액 바꿔 재클릭) 어느 쪽도 진실이 아니다 —
    // 옛 주문 재사용도, 새 금액 결제도 하지 않고 거절한다. 통과시키면 credit_topup 행과 실제
    // 결제액이 어긋나 웹훅 정산이 '금액 불일치' 데드엔드에 빠진다.
    if (existing && (existing.credits !== check.credits || existing.amountKrw !== check.amountKrw)) {
      return c.json({
        error: "idempotency_mismatch",
        message: `이 요청 키는 다른 금액(${existing.credits}크레딧)의 주문에 이미 사용됐습니다 — 화면을 새로고침한 뒤 다시 시도하세요.`,
      }, 409);
    }
    if (existing?.status === "paid") {
      // 같은 멱등키로 이미 성공한 요청 — 결제를 반복하지 않고 그 결과를 그대로 돌려준다.
      const balance = await creditBalance();
      return c.json({
        ok: true, duplicate: true, paymentId,
        credits: existing.credits, amountKrw: existing.amountKrw, balance,
      });
    }
    if (!existing) {
      // 주문을 먼저 만든다 — 승인 응답을 못 받아도 "긁혔을 수 있는 건"이 기록으로 남는다.
      // (재시도라 이미 있으면 그대로 쓴다 — payment_id 가 PK 라 다시 넣으면 터진다.)
      await createTopup({ paymentId, credits: check.credits, amountKrw: check.amountKrw, status: "pending", requestedBy: actor });
    }

    try {
      await chargeWithBillingKey({
        paymentId,
        billingKey: card!.billingKey!,
        orderName: `STEP-D 크레딧 ${check.credits}개`,
        amountKrw: check.amountKrw,
        customer,
      });
    } catch (e: any) {
      // "이미 결제됨"은 실패가 아니라 **우리가 응답을 놓친 성공**이다(pending 재시도 경로).
      // failed 로 닫으면 사용자가 새 키로 재결제해 진짜 이중 청구가 된다.
      const alreadyPaid = /ALREADY[_ ]?PAID/i.test(
        JSON.stringify((e as { body?: unknown })?.body ?? "") + String(e?.message ?? ""));
      if (alreadyPaid) {
        console.warn(`[billing] 카드충전 already-paid ${paymentId} — 아래 재조회로 정산 시도`);
      } else {
        // 우리가 만든 "포트원 POST … 실패 (400)" 을 그대로 보여주면 사용자가 할 수 있는 게
        // 없다 — 진짜 거절 사유(한도초과·정지)는 응답 body 의 pgMessage 다. 자동 충전과
        // **같은 함수**를 써서 두 경로의 문구가 갈라지지 않게 한다.
        // 원문은 여기 로그에만 남긴다(declineMessage 는 사람 말만 돌려준다).
        console.warn(`[billing] 카드충전 거절 ${paymentId}:`, e?.message ?? e);
        await markTopupPaid(paymentId, "failed");
        return c.json({ error: "charge_failed", message: declineMessage(e) }, 402);
      }
    }

    // 동기 빌링키 응답엔 status·amount 가 **없다**(성공 시 { payment: { pgTxId, paidAt } } 뿐 —
    // @portone/server-sdk 타입으로 확인). 그 응답을 대조하면 모든 성공 결제가 '미확인'이 된다.
    // 결제 직후 단건 조회(GET /payments — 여긴 status·amount 가 있다)로 재확인한다.
    // 조회가 일시 실패하면 '미확인' → pending 유지, 웹훅이 정산한다.
    let verdict: { ok: true } | { ok: false; message: string };
    try {
      verdict = verifyCharge({ response: await getPayment(paymentId), expectedKrw: check.amountKrw });
    } catch {
      verdict = { ok: false, message: "결제 상태 조회가 일시적으로 실패했습니다." };
    }
    if (verdict.ok && !storedBuyer) {
      // 0037 이전 카드 백필 — 화면 입력값으로 결제가 실제 성공했으니 그 값을 카드에 남긴다.
      // 이게 있어야 자동충전(화면 입력이 없는 경로)도 이 카드로 결제할 수 있다.
      await updateBillingCardBuyer(customer).catch(() => {});
    }
    if (!verdict.ok) {
      // failed 로 찍지 않는다 — 응답 모양이 어긋났을 뿐 **돈은 나갔을 수 있다.**
      // pending 으로 두면 포트원 웹훅(실제 승인 사실)이 정산한다. 여기서 failed 로 닫으면
      // 로그가 "안 긁힘" 이라고 거짓말하고, 사용자는 재결제해 이중 청구가 된다.
      // 원문(결제사 상태값이 들어 있다)은 로그에만 — 자동 충전의 같은 상태(unverified)와
      // 같은 어휘로 사용자에게 말한다. 두 경로가 다른 말을 하면 같은 사건이 달라 보인다.
      console.warn(`[billing] 카드충전 확인 보류 ${paymentId}: ${verdict.message} — 웹훅 정산 대기`);
      return c.json({
        error: "charge_unverified",
        message: "결제 확인 중입니다 — 확인되면 크레딧이 자동으로 올라갑니다."
          + " 잠시 후 잔액을 확인해 주세요. 확인될 때까지 다시 결제하지 마세요.",
      }, 409);
    }

    // ⚠️ 순서가 중요하다: **원장이 먼저**다.
    // 원장 insert 는 `dedupe_key` 로 멱등이라 몇 번 불려도 안전하지만, 상태를 먼저 'paid' 로
    // 찍고 그 사이에서 던지면 재시도가 `settleTopup` 의 'paid' 가드에 막혀 **크레딧이 영구히
    // 사라진다**. 크레딧을 주는 쪽을 먼저 확정하고, 상태는 그 사실의 표시로만 쓴다.
    const credited = await addCreditEntry({
      delta: check.credits,
      reason: "topup",
      paymentId,
      amountKrw: check.amountKrw,
      note: "저장 카드 결제",
      actor,
      dedupeKey: topupDedupeKey(paymentId),
    });
    await markTopupPaid(paymentId, "paid");
    // 인보이스 메일 — 이 호출이 실제로 적립한 경우만(웹훅이 먼저 정산했으면 거기서 보냈다).
    if (credited) void sendInvoiceEmail(paymentId, tenantId);
    // 직접 충전 성공도 **조치**다 — no_buyer_info 힌트가 "직접 충전 1회로 채워집니다"(위
    // updateBillingCardBuyer 백필) 라고 안내하고, 상한 도달 힌트도 "지금 필요하면 직접
    // 충전하세요" 라고 안내한다. 안내한 대로 했는데 경고가 그대로면 화면이 거짓말한다.
    await clearAutoTopupAlert("manual-topup");
    const balance = await creditBalance();
    return c.json({ ok: true, paymentId, credits: check.credits, amountKrw: check.amountKrw, balance });
  });
});

// ── 자동 결제 정책 — **고정이다. 워크스페이스별 설정이 없다** (2026-08-26 사용자 확정) ──
//
// "잔액이 소진되면 5,000크레딧(₩300,000)을 자동 결제한다." 값은 credits.ts FIXED_AUTO_TOPUP
// 한 곳에서만 나온다 — 화면·서버·메일이 다른 금액을 말하면 그게 곧 결제 분쟁이다.
// 켜짐 여부는 저장된 on/off 가 아니라 **쓸 수 있는 카드가 있는가** 다: 등록이 곧 동의라서
// "카드는 있는데 자동 결제는 꺼져 있다" 라는 상태 자체를 두지 않는다.

app.get("/api/credits/auto-topup", async (c) => {
  // 조회는 막지 않는다 — 자동 결제가 도는지/금액이 얼마인지는 member 도 봐야 한다.
  const blocked = cardBlock(await getBillingCard());
  const policy = fixedAutoTopupPolicy(!blocked);
  return c.json({
    policy: { ...policy, updatedAt: null, updatedBy: "" },
    // 정책이 고정이라는 사실 자체를 화면에 알린다 — 설정 UI 를 못 찾는 게 아니라 없는 것이다.
    fixed: true,
    // 꺼져 있으면 **왜** 꺼져 있는지(=카드가 없다/해지됐다). 화면이 조치를 안내한다.
    disabledReason: blocked ? blocked.reason : null,
  });
});

app.put("/api/credits/auto-topup", async (c) => {
  // 설정이 사라졌다는 사실을 **정직하게** 알린다. 200 으로 받아 무시하면 화면은 저장된 줄
  // 알고 다른 값을 보여준다 — 돈이 나가는 설정에서 그 불일치는 그대로 분쟁이 된다.
  requireCardActor(c);
  return c.json({
    error: "policy_fixed",
    message: `자동 결제는 고정 정책입니다 — 잔액이 소진되면 ${FIXED_AUTO_TOPUP.topupCredits.toLocaleString("ko-KR")}크레딧을 자동 결제합니다. 중단하려면 결제 수단(카드)을 삭제하세요.`,
  }, 409);
});

/** 지금 바로 자동 충전 판정을 실행한다(설정 테스트용). 조건 안 맞으면 charged:false + 사유. */
app.post("/api/credits/auto-topup/run", async (c) => {
  requireManager(c);
  const result = await maybeAutoTopup();
  const balance = await creditBalance();
  return c.json({ ...result, balance });
});

app.get("/api/credits", async (c) => {
  // "user" 스코프 — PG 취소·실패 이벤트의 delta 0 운영 기록은 사용자 결제 내역이 아니다.
  const [balance, ledger, autoTopupAlert, monthUsage, notifyEmails] = await Promise.all([
    creditBalance(), listCreditLedger(50, "user"), getAutoTopupAlert(),
    monthUsageCredits(), getBillingNotifyEmails(),
  ]);
  return c.json({
    balance,
    unit: CREDIT_UNIT_LABEL,
    priceKrw: creditPriceKrw(),
    ledger,
    // 자동 충전이 조치 필요 사유로 실패 중이면 여기서도 보여준다 — /api/automation 은
    // "왜 안 나가지"를 묻는 자리고, 여기는 실제로 조치(카드 재등록·상한 조정)하는 자리다.
    autoTopupAlert,
    // 이번 달(KST) 사용량 — 결제 화면 게이지의 생산자. 원장 슬라이스로 화면이 더하면 빠진다.
    monthUsage,
    // 결제 알림 수신자(인보이스·자동 결제 실패 메일) — B2B 담당자 여러 명.
    notifyEmails,
  });
});

/**
 * 결제 알림 수신자 저장 — 인보이스(결제 완료)와 자동 결제 실패 메일이 이 목록으로 나간다.
 * 빈 배열 = 추가 수신자 없음(결제창 이메일 1순위는 그대로다). 결제 설정이라 관리자만.
 */
app.post("/api/billing/notify-emails", async (c) => {
  // 내부 토큰(운영 배선)도 허용 — 카드 등록과 달리 알림 수신자 목록은 결제 실행 권한이
  // 아니라서 위험 성격이 다르다. 사람 경로는 기존 그대로 관리자만(requireCardActor).
  if (currentContext()?.via !== "internal") requireCardActor(c);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const raw: unknown[] = Array.isArray(body.emails) ? body.emails : [];
  const emails: string[] = [...new Set(raw.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (emails.length > 5) {
    return c.json({ error: "too_many", message: "알림 수신자는 5명까지 등록할 수 있습니다." }, 400);
  }
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) return c.json({ error: "invalid_email", message: `이메일 형식이 아닙니다: ${bad}` }, 400);
  await setBillingNotifyEmails(emails);
  return c.json({ ok: true, notifyEmails: emails });
});

/**
 * 인보이스 목록 — **결제 완료된 충전 건이 곧 인보이스다.** 별도 표 없이 credit_topup 에서
 * 결정적으로 만든다(번호 = 결제일 + paymentId 꼬리). PDF 는 브라우저가 이 데이터로 그린다 —
 * 서버가 PDF 를 저장하지 않으므로 "문서와 원장이 어긋나는" 상태가 애초에 없다.
 *
 * 금액은 부가세 포함 총액이다(단가 정책). 공급가액·세액은 총액에서 역산해 내려준다 —
 * 화면·PDF 가 제각기 계산해 1원씩 어긋나는 일을 막는다.
 */
app.get("/api/credits/invoices", async (c) => {
  const rows = await listPaidTopups(100);
  // 빌더는 invoice.ts 하나다 — 이메일 발송과 화면이 같은 번호·역산 값을 쓴다.
  return c.json({
    invoices: rows.map(invoiceFromTopup),
    supplier: supplierFromEnv(),
    buyer: await buyerFor(currentTenantId()),
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
  const actor = sessionActor(c, body.actor) || "unknown";
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
      // 빌링키 결제 응답과 조회 응답의 래핑 차이를 한 곳(unwrapPayment)에서 흡수한다.
      const p = unwrapPayment(await getPayment(paymentId));
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
      // HTTP 코드가 곧 재전송 신호다 — 포트원은 2xx 가 아니면 지수 백오프로 **재전송**한다.
      // 일괄 200 이면 재전송이 영영 안 온다. 그래서 "나중에 다시 보면 결과가 달라질 수 있는"
      // 실패만 503 으로 돌려 재전송을 살리고, 다시 봐도 같은 실패는 200 으로 닫는다.
      const st = String(payment?.status ?? "").toUpperCase();
      if (!payment) {
        // 결제 조회 실패(네트워크·포트원 일시 장애) — 다음 재전송 때는 성공할 수 있다.
        return c.json({ ok: false, retry: true, reason: settle.reason }, 503);
      }
      // V2 단건 조회의 대기 상태 리터럴은 PAY_PENDING 이다 — PENDING 만 보면 이 분기가
      // 죽은 코드가 된다. 혹시 모를 표기 변형까지 셋 다 잡는다.
      if (st === "READY" || st === "PENDING" || st === "PAY_PENDING") {
        // 아직 결제 진행 중 — 곧 PAID 로 바뀔 수 있다. 지금 200 으로 닫으면 그 전이를 놓친다.
        return c.json({ ok: false, retry: true, reason: settle.reason }, 503);
      }
      if (st === "PAID" && order && order.status !== "paid") {
        // 돈은 나갔는데 금액이 주문과 다르다 — 재전송으로 해결될 문제가 아니라 사람 문제다
        // (결제창 파라미터 조작 또는 우리 계산 버그). 알람 대상으로 크게 남기고 200 으로 닫는다.
        console.error(`[billing] ⚠ 금액 불일치 ${paymentId}: ${settle.reason} — 수동 확인 필요`);
        return c.json({ ok: true, credited: false, reason: settle.reason });
      }
      // 이미 처리된 충전 · 우리 주문 아님 · FAILED/CANCELLED 확정 — 몇 번을 다시 봐도 같다.
      return c.json({ ok: true, credited: false, reason: settle.reason });
    }

    // ⚠️ **원장이 먼저다.** 예전에는 `markTopupPaid` 를 먼저 부르고 0행이면
    // `"이미 처리됨"` 으로 끝냈는데, 카드 결제 라우트가 타임아웃으로 주문을 'failed' 로
    // 찍어둔 경우 여기서 0행이 나와 **돈은 나갔는데 크레딧은 없는 채로 200 을 돌려주고**
    // 포트원의 재시도까지 멈췄다. 로그는 "이미 처리됨" 이라 사고가 보이지도 않았다.
    //
    // 멱등은 `dedupe_key` 가 책임진다(addCreditEntry 는 ON CONFLICT DO NOTHING).
    // 상태 갱신은 그 사실의 표시일 뿐이라 뒤에 온다.
    const credited = await addCreditEntry({
      delta: settle.credits,
      reason: "topup",
      paymentId,
      amountKrw: order?.amountKrw ?? null,
      note: `포트원 결제 ${paymentId}`,
      actor: "portone-webhook",
      dedupeKey: topupDedupeKey(paymentId),
    });
    await markTopupPaid(paymentId, "paid");

    if (!credited) {
      // 원장에 이미 있다 = 진짜 중복 웹훅. 이건 정상이고, 크레딧은 이미 들어가 있다.
      console.log(`[billing] 중복 웹훅 ${paymentId} — 원장에 이미 있음(크레딧 유지)`);
      return c.json({ ok: true, credited: false, reason: "이미 적립된 결제입니다(중복 웹훅)." });
    }
    console.log(`[billing] 충전 완료 ${paymentId} · +${settle.credits} 크레딧`);
    // 인보이스 메일 — 적립이 실제로 일어났을 때만(credited). 실패해도 응답을 막지 않는다.
    void sendInvoiceEmail(paymentId, owner);
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
    // 공개 유예(분) — 0 도 유효한 값(즉시 공개)이라 `in body` 로 존재 여부를 먼저 본다.
    // num() 은 0 을 fallback 으로 되돌려서 여기 못 쓴다.
    publishDelayMin: "publishDelayMin" in body
      ? normalizePublishDelayMin(body.publishDelayMin)
      : (existing?.publishDelayMin ?? base.publishDelayMin),
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

  // 규칙은 다듬는 도구지 배포의 전제 조건이 아니다 (2026-08-13: "규칙 없으면 배포 자체가
  // 안 됨" 해소). 연결돼 있는데 규칙이 없는 채널은 역할 기본값(main)으로 합성해 내려보낸다 —
  // isDefault 표식으로 화면이 "기본 규칙"임을 밝힐 수 있다. 저장된 규칙에는 손대지 않는다.
  const rules: (ChannelRuleRow & { isDefault?: boolean })[] = await listChannelRules();
  const have = new Set(rules.map((r) => `${r.platform}:${r.accountId}`));
  const addDefault = (platform: string, accountId: string, label: string) => {
    if (!accountId || have.has(`${platform}:${accountId}`)) return;
    have.add(`${platform}:${accountId}`);
    rules.push({ platform, accountId, label: label || accountId, ...defaultRuleFor("main", platform), isDefault: true });
  };
  const [ytChannels, metaAccounts, igAccounts, ttAccounts] = await Promise.all([
    listYouTubeChannels().catch(() => []),
    listMetaAccounts().catch(() => []),
    listInstagramAccounts().catch(() => []),
    listTikTokAccounts().catch(() => []),
  ]);
  // YouTube 는 업로드 가능한 채널만 — 게시 스코프 없는 채널을 보여 주면 고르고 나서 409 를 본다.
  for (const ch of ytChannels) if (youtubeCanPublish(ch)) addDefault("youtube", ch.channelId, ch.channelName);
  // 나머지 플랫폼은 상태 기록만 하므로(스텁) **살아 있는 연결만** 보여 준다.
  // `!== "disabled"` 는 이 세 테이블에 disabled 값 자체가 없어 항상 통과였다 —
  // 연동해제(disconnected) 계정이 배포 후보로 계속 노출됐다. active 만 허용한다.
  for (const a of metaAccounts) if (a.status === "active") addDefault("facebook", a.pageId, a.pageName);
  for (const a of igAccounts) if (a.status === "active") addDefault("instagram", a.igUserId, a.username);
  // 라벨은 채널 핸들(@username) 우선 — display_name 은 실명이라 채널 구분이 안 된다.
  for (const a of ttAccounts) if (a.status === "active") addDefault("tiktok", a.openId, a.username ? `@${a.username}` : (a.displayName || a.openId));
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
  const actor = sessionActor(c, body.actor);
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
  const actor = sessionActor(c, body.actor);
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
  const actor = sessionActor(c, c.req.query("actor"));
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
  const actor = sessionActor(c, body.actor);
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

  // 채택 시 사람이 고른 방향(가로/세로). 없으면 예전처럼 rec.kind 로 기본값을 잡는다(하위호환).
  // AI 리프레임 여부는 세로형일 때만 의미가 있고, 클립 생성 뒤 프론트가 /clips/:id/reframe 로
  // 켠다(basicReframeState 로 만들어 두고, 세로+AI 면 그 라우트가 ai_multi 로 전환·큐잉).
  const body = await c.req.json<{ orientation?: string }>().catch(() => ({} as { orientation?: string }));
  const aspectRatio = body.orientation === "portrait" ? "9:16-crop-main"
    : body.orientation === "landscape" ? "16:9"
    : (rec.kind === "short" ? "9:16-crop-main" : "16:9");

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
    // 둘째 줄 강조색 이름(blue|red|yellow|green). 에디터가 hex 로 풀어 초기 오버레이에 쓴다.
    titleLine2Color: rec.titleLine2Color,
    // 첫 3초 hook intro (2026-08-02 · docs/plans/shorts-hook-intro-3sec.md). 에디터의 "첫 3초 훅"
    // 토글(editorState.hookOn)이 켜지면 /export 가 hookTimeSec 지점을 프리롤로 붙인다. 없으면 미동작.
    hookQuote: rec.hookQuote,
    hookTimeSec: rec.hookTimeSec,
    hookIntroCaption: rec.hookIntroCaption,
    clipType: rec.kind === "short" ? "T6" : "TZ",
    targetAge: episode?.targetAge ?? 0,
    aspectRatio,
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
    beatIds: Array.isArray(rec.beatIds) ? rec.beatIds : [],
    reframe: basicReframeState(),
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
  // 채널별 업로드 메타를 **채택 시점에 미리** 만들어 둔다.
  //
  // 실무 동선이 이유다: 운영자는 채택 → 편집 → 발행으로 가는데, 발행 모달에서야 문구를
  // 만들면 채널마다 몇 초씩 기다려야 하고 여러 건을 몰아 발행할 때 그만큼 곱해진다.
  // 미리 만들어 두면 모달은 빈칸 없이 열리고 사람은 고치기만 하면 된다.
  //
  // ⚠️ 채택 응답을 붙잡지 않는다 — 생성이 느리거나 실패해도 채택 자체는 성공해야 한다.
  //    실패하면 발행 화면의 "메타 생성" 버튼으로 다시 만들 수 있다.
  void enqueue("clip.metadata", { clipId }, { dedupeKey: `clip.metadata:${clipId}` })
    .catch((e) => console.error(`[adopt] 메타데이터 잡 큐잉 실패 ${clipId}:`, e));

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
/** 업로드 가능한 YouTube 채널인가 — eligibility 목록·발행 대상 해석이 같은 기준을 쓴다. */
function youtubeCanPublish(ch: YouTubeChannel): boolean {
  return ch.status !== "revoked" && Boolean(ch.refreshToken) &&
    (ch.scope ?? "").split(" ").includes(YT_UPLOAD_SCOPE);
}

async function resolveYouTubePublishChannel(explicitId?: string): Promise<YouTubeChannel | null> {
  const channels = await listYouTubeChannels();
  if (explicitId) {
    const ch = channels.find((c) => c.channelId === explicitId);
    return ch && youtubeCanPublish(ch) ? ch : null;
  }
  const eligible = channels.filter(youtubeCanPublish);
  // Exactly one publish channel is the common case (single operator channel). With several,
  // require an explicit id rather than guessing which one the operator meant.
  return eligible.length === 1 ? eligible[0] : null;
}

app.post("/api/distributions/publish", async (c) => {
  const actor = requirePublisher(c);
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
    /** 네이버: 어느 계정으로 올릴지. 다계정에서는 필수 — 추론하지 않는다. */
    naverAccountId?: string;
    /** 네이버: 발행 시점 설명. 클립은 10자 이상이어야 등록 자체가 된다. */
    description?: string;
    /** 네이버: 카테고리 1차·2차. 둘 다 있어야 등록된다. */
    naverCategory?: { primary?: string; secondary?: string };
    /** TikTok: 어느 계정 받은함에 초안을 넣을지 (게이트 ON 일 때만 의미). 추론하지 않는다. */
    tiktokOpenId?: string;
    /** Instagram: 어느 IG 비즈니스 계정으로 올릴지 (게이트 ON 일 때만). 추론하지 않는다. */
    igUserId?: string;
    /** Facebook: 어느 Meta 페이지로 올릴지 (게이트 ON 일 때만). 추론하지 않는다. */
    metaPageId?: string;
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
      actor,
      origin: "manual",
    });
    return c.json({ ok: true, ...outcome });
  }

  // ── 네이버 TV·클립 ─────────────────────────────────────────────────────────
  // YouTube 와 같은 축(실업로드)이지만 막히는 지점이 다르다. **부작용 전에** 전부 거른다 —
  // 클립이 'pending' 으로 남았는데 워커에서 실패하는 것보다, 아예 안 받는 게 낫다.
  if (isNaverChannel(b.channel)) {
    if (!naverUploadEnabled()) {
      return c.json({ error: "naver_upload_disabled", message: NAVER_DISABLED_MESSAGE }, 409);
    }
    const accounts = await listNaverAccounts();
    const usable = accounts.filter((a) => a.status !== "disabled");
    if (usable.length === 0) {
      return c.json({
        error: "no_naver_account",
        message: "연결된 네이버 계정이 없습니다 — 배포채널 화면에서 계정을 추가하고 로그인하세요.",
      }, 409);
    }
    // 계정이 하나뿐이면 그걸 쓴다. 둘 이상이면 **고르게 한다** — 아무거나 집으면
    // 다른 고객사 채널로 나갈 수 있다.
    const account = b.naverAccountId
      ? usable.find((a) => a.id === b.naverAccountId)
      : (usable.length === 1 ? usable[0] : undefined);
    if (!account) {
      return c.json({
        error: b.naverAccountId ? "naver_account_not_found" : "naver_account_required",
        message: b.naverAccountId
          ? "지정한 네이버 계정을 찾을 수 없거나 비활성입니다."
          : "네이버 계정이 여러 개입니다 — 어느 계정으로 올릴지 선택하세요.",
        accounts: usable.map((a) => ({ id: a.id, label: a.label, target: a.target })),
      }, 409);
    }
    // 계정마다 올릴 수 있는 곳이 정해져 있다(clip 전용 계정에 TV 를 밀면 그냥 실패한다).
    const want = NAVER_CHANNELS[b.channel];
    if (account.target !== "both" && account.target !== want) {
      return c.json({
        error: "naver_target_mismatch",
        message: `'${account.label}' 계정은 ${account.target === "tv" ? "네이버 TV" : "네이버 클립"} 전용입니다.`,
      }, 409);
    }
    // 클립은 설명이 10자 미만이면 등록 버튼 자체가 막힌다(2026-08-11 실측).
    // 워커까지 갔다가 실패하면 원인이 안 보여서, 받을 때 거른다.
    const desc = b.description?.trim();
    if (b.channel === "naverclip" && (!desc || desc.length < DESC_MIN)) {
      return c.json({
        error: "description_too_short",
        message: `네이버 클립은 설명이 ${DESC_MIN}자 이상이어야 합니다.`,
      }, 400);
    }
    const cat = b.naverCategory?.primary && b.naverCategory?.secondary
      ? { primary: String(b.naverCategory.primary), secondary: String(b.naverCategory.secondary) }
      : undefined;

    const outcome = await dispatchPublish({
      clipIds: b.clipIds, channel: b.channel,
      scheduled: b.scheduled, reserveDate: b.reserveDate,
      naverAccountId: account.id, description: desc, naverCategory: cat,
      actor,
      origin: "manual",
    });
    return c.json({ ok: true, naverAccount: { id: account.id, label: account.label }, ...outcome });
  }

  // ── TikTok — 게이트 ON 이면 받은함 드래프트 실업로드, OFF 면 아래 record 경로 그대로 ──
  // 계정은 여기서 확정한다(네이버와 같은 이유) — 추론으로 다른 계정 받은함에 초안이 가면
  // 안 된다. 규칙(eligibility)의 tiktok accountId 와 같은 식별자(openId)를 쓴다.
  if (b.channel === "tiktok" && tiktokUploadEnabled()) {
    // video.upload 없이(스코프 확장 전에) 연결된 토큰은 inbox init 에서 scope_not_authorized
    // 로 전건 실패한다 — 여기서 걸러 클립별 failed 대신 409 한 번으로 알린다. 재연동이 해법.
    const usable = (await listTikTokAccounts())
      .filter((a) => a.status === "active" && a.refreshToken
        && (a.scope ?? "").includes("video.upload"));
    const account = b.tiktokOpenId
      ? usable.find((a) => a.openId === b.tiktokOpenId)
      : (usable.length === 1 ? usable[0] : undefined);
    if (!account) {
      return c.json({
        error: b.tiktokOpenId ? "tiktok_account_not_found"
          : usable.length ? "tiktok_account_required" : "no_tiktok_account",
        message: b.tiktokOpenId
          ? "지정한 TikTok 계정을 찾을 수 없거나 재연결이 필요합니다."
          : usable.length
            ? "TikTok 계정이 여러 개입니다 — 어느 계정 받은함으로 보낼지 선택하세요."
            : "업로드 가능한 TikTok 계정이 없습니다 — video.upload 권한이 없는 옛 연결이면 배포채널에서 연동해제 후 재연결하세요.",
        accounts: usable.map((a) => ({
          openId: a.openId, label: a.username ? `@${a.username}` : a.displayName,
        })),
      }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: b.clipIds, channel: "tiktok",
      // 예약(reserveDate)은 넘기지 않는다 — 초안은 예약 게시가 없다. 최종 게시는
      // 크리에이터가 앱에서 직접 한다.
      tiktokOpenId: account.openId,
      actor,
      origin: "manual",
    });
    return c.json({ ok: true, tiktokAccount: { openId: account.openId }, ...outcome });
  }

  // ── Instagram — 게이트 ON 이면 릴 실업로드(우리쪽 발사·예약은 지연). 계정 확정(추론 금지). ──
  if (b.channel === "instagram" && instagramUploadEnabled()) {
    const usable = (await listInstagramAccounts()).filter((a) => a.status !== "disconnected" && a.accessToken);
    const account = b.igUserId
      ? usable.find((a) => a.igUserId === b.igUserId)
      : (usable.length === 1 ? usable[0] : undefined);
    if (!account) {
      return c.json({
        error: b.igUserId ? "instagram_account_not_found" : usable.length ? "instagram_account_required" : "no_instagram_account",
        message: b.igUserId ? "지정한 Instagram 계정을 찾을 수 없거나 재연결이 필요합니다."
          : usable.length ? "Instagram 계정이 여러 개입니다 — 어느 계정으로 올릴지 선택하세요."
          : "연결된 Instagram 비즈니스 계정이 없습니다 — 배포채널에서 연결하세요.",
        accounts: usable.map((a) => ({ igUserId: a.igUserId, label: a.username ? `@${a.username}` : a.name })),
      }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: b.clipIds, channel: "instagram",
      scheduled: b.scheduled, reserveDate: b.reserveDate,
      igUserId: account.igUserId,
      actor, origin: "manual",
    });
    return c.json({ ok: true, instagramAccount: { igUserId: account.igUserId }, ...outcome });
  }

  // ── Facebook — 게이트 ON 이면 릴 실업로드(네이티브 예약). 페이지 확정(추론 금지). ──
  if (b.channel === "facebook" && facebookUploadEnabled()) {
    const usable = (await listMetaAccounts()).filter((a) => a.pageAccessToken);
    const account = b.metaPageId
      ? usable.find((a) => a.pageId === b.metaPageId)
      : (usable.length === 1 ? usable[0] : undefined);
    if (!account) {
      return c.json({
        error: b.metaPageId ? "facebook_page_not_found" : usable.length ? "facebook_page_required" : "no_facebook_page",
        message: b.metaPageId ? "지정한 Facebook 페이지를 찾을 수 없습니다."
          : usable.length ? "Facebook 페이지가 여러 개입니다 — 어느 페이지로 올릴지 선택하세요."
          : "연결된 Facebook 페이지가 없습니다 — 배포채널에서 연결하세요.",
        accounts: usable.map((a) => ({ pageId: a.pageId, label: a.pageName })),
      }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: b.clipIds, channel: "facebook",
      scheduled: b.scheduled, reserveDate: b.reserveDate,
      metaPageId: account.pageId,
      actor, origin: "manual",
    });
    return c.json({ ok: true, facebookPage: { pageId: account.pageId }, ...outcome });
  }

  // 게이트 OFF 라 '기록만' 남기는 경로(tiktok·instagram·facebook 기본값)도 **어느 계정에
  // 기록했는지**는 남겨야 한다. 정체성 없는 행은 자동 순방이 "모든 계정으로 이미 나갔다"로
  // 보수 판정해, 그 클립을 그 플랫폼에서 **영원히 건너뛴다**(로그도 안 남는다).
  const requested = { tiktokOpenId: b.tiktokOpenId, igUserId: b.igUserId, metaPageId: b.metaPageId };
  const recordedAccount = await (async () => {
    try {
      if (b.channel === "tiktok") {
        const list = (await listTikTokAccounts()).filter((a) => a.status === "active");
        const a = requested.tiktokOpenId ? list.find((x) => x.openId === requested.tiktokOpenId) : (list.length === 1 ? list[0] : undefined);
        return a ? { tiktokOpenId: a.openId } : {};
      }
      if (b.channel === "instagram") {
        const list = (await listInstagramAccounts()).filter((a) => a.status !== "disconnected");
        const a = requested.igUserId ? list.find((x) => x.igUserId === requested.igUserId) : (list.length === 1 ? list[0] : undefined);
        return a ? { igUserId: a.igUserId } : {};
      }
      if (b.channel === "facebook") {
        const list = await listMetaAccounts();
        const a = requested.metaPageId ? list.find((x) => x.pageId === requested.metaPageId) : (list.length === 1 ? list[0] : undefined);
        return a ? { metaPageId: a.pageId } : {};
      }
    } catch { /* 계정 조회 실패는 기록을 막을 이유가 아니다 */ }
    return {};
  })();

  const outcome = await dispatchPublish({
    clipIds: b.clipIds, channel: b.channel,
    scheduled: b.scheduled, reserveDate: b.reserveDate,
    ...recordedAccount,
    actor,
    origin: "manual",
  });
  return c.json({ ok: true, ...outcome });
});

// ── retry a failed distribution ───────────────────────────────────────────────
app.post("/api/distributions/retry", async (c) => {
  const actor = requirePublisher(c);
  const b = await c.req.json<{ clipId: string; channel: string }>().catch(() => null);
  if (!b || !b.clipId || !b.channel) {
    return c.json({ error: "bad_request", message: "clipId와 channel이 필요합니다." }, 400);
  }
  const clip = await getEntity<any>("clip", b.clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  // 이미 발행된 건 재발행하지 않는다 — 재업로드는 **중복 공개**를 만든다(감사 #1 · 사용자 방향
  // 2026-08-24 "발행됐으면 제목 수정만"). 실패 행이 하나도 없는데 발행된 행이 있으면 되돌릴 게
  // 없다 → 제목/메타 수정(POST /api/distributions/update-metadata)으로 가라고 막는다.
  {
    const chRows = (clip.distributions ?? []).filter((d: any) => d.channel === b.channel);
    const hasFailed = chRows.some((d: any) => d.status === "failed");
    const hasPublished = chRows.some((d: any) =>
      d.externalId || d.status === "published" || d.status === "scheduled");
    if (!hasFailed && hasPublished) {
      return c.json({ error: "already_published",
        message: "이미 발행된 항목입니다. 재발행 대신 제목·메타 수정을 사용하세요." }, 409);
    }
  }

  // 재시도도 같은 관문을 지난다 — 안 그러면 /retry 가 게이트를 우회하는 뒷문이 된다.
  // **자동 재시도가 아니다.** 사람이 로그 행의 버튼을 눌러야 여기 온다(F4-4 ⊘).
  if (b.channel === "youtube") {
    if (!youtubeUploadEnabled()) {
      console.warn(`[publish/retry] blocked: YouTube 실업로드 비활성 (clip=${b.clipId})`);
      return c.json({ error: UPLOAD_DISABLED_CODE, message: UPLOAD_DISABLED_MESSAGE }, 409);
    }
    // 다계정 행이 생기면서 "첫 youtube 행"은 성공한 계정일 수 있다 — 그걸 집으면 성공분을
    // pending 으로 되돌려 같은 계정에 중복 업로드된다. 실패한 행을 우선 집는다.
    const ytRows = (clip.distributions ?? []).filter((d: any) => d.channel === "youtube");
    const prev = ytRows.find((d: any) => d.status === "failed") ?? ytRows[0];
    // 되살릴 행이 이미 발행됐으면(externalId 보유) 재업로드 = 중복 공개다. 막고 메타 수정으로.
    if (prev?.externalId) {
      return c.json({ error: "already_published",
        message: "이미 발행된 유튜브 영상입니다. 재발행 대신 제목 수정을 사용하세요." }, 409);
    }
    const target = await resolveYouTubePublishChannel(prev?.youtubeChannelId);
    if (!target) {
      return c.json({ error: "no_publish_channel", message: "재시도할 YouTube 채널을 찾을 수 없습니다." }, 409);
    }
    const outcome = await dispatchPublish({
      clipIds: [b.clipId], channel: "youtube",
      // 예약이 있던 건은 예약도 함께 살린다 — reserveDate 만 넘기고 scheduled 를 빼면
      // dispatch 가 즉시 업로드로 처리해 행의 예약 표기와 실제 동작이 어긋난다.
      reserveDate: prev?.reserveDate,
      scheduled: Boolean(prev?.reserveDate),
      youtubeChannelId: target.channelId,
      // 공개범위도 함께 살린다 — 안 넘기면 워커 폴백으로 떨어져 unlisted/private 의도
      // 콘텐츠가 재시도 한 번에 전체공개로 승격됐다(2026-08-25 전면 체크 major).
      // 행에 privacy 가 없는 구 기록은 자동 경로 기본과 같은 unlisted 로 — 전체공개는
      // 사람이 정하는 일이다(automation-cycle 의 같은 원칙 주석 참조).
      privacy: (["public", "unlisted", "private"] as const).find((p) => p === prev?.privacy) ?? "unlisted",
      actor,
      origin: "retry",
    });
    return c.json({ ok: true, ...outcome });
  }

  // TikTok 재시도 — 실패한 행의 openId 로 **같은 계정에** 다시 보낸다. 정체성 없이 넘기면
  // dispatchPublish 가 record 로 강등해 재시도가 조용히 기록으로 둔갑한다.
  if (b.channel === "tiktok" && tiktokUploadEnabled()) {
    const ttRows = (clip.distributions ?? []).filter((d: any) => d.channel === "tiktok");
    // 실패한 행이 있을 때만 — published 행의 openId 까지 집으면 "성공한 클립 재시도" 가
    // 같은 받은함에 중복 초안을 쌓는다 (queue dedupe 는 done 이후를 못 막는다).
    const prev = ttRows.find((d: any) => d.status === "failed" && d.tiktokOpenId);
    if (prev?.tiktokOpenId) {
      const outcome = await dispatchPublish({
        clipIds: [b.clipId], channel: "tiktok",
        tiktokOpenId: String(prev.tiktokOpenId),
        actor,
        origin: "retry",
      });
      return c.json({ ok: true, ...outcome });
    }
    // openId 없는 구 기록(record 시절)은 아래 일반 경로로 — 기록만 갱신된다.
  }

  // Instagram 재시도 — 실패한 행의 igUserId 로 **같은 계정에** 다시(추론 금지). 게이트 ON 일 때만.
  // 정체성 없이 넘기면 dispatchPublish 가 record 로 강등해 재시도가 조용히 기록으로 둔갑한다.
  if (b.channel === "instagram" && instagramUploadEnabled()) {
    const rows = (clip.distributions ?? []).filter((d: any) => d.channel === "instagram");
    const prev = rows.find((d: any) => d.status === "failed" && d.igUserId);
    if (prev?.igUserId) {
      const outcome = await dispatchPublish({
        clipIds: [b.clipId], channel: "instagram",
        igUserId: String(prev.igUserId),
        // 예약이 있던 건은 예약도 함께 살린다 — 안 넘기면 그 자리에서 **즉시 공개 게시**되고,
        // 행에는 옛 reserveDate 가 남아 화면만 '예약' 으로 보인다(엠바고 사고).
        reserveDate: prev.reserveDate, scheduled: Boolean(prev.reserveDate),
        actor, origin: "retry",
      });
      return c.json({ ok: true, ...outcome });
    }
    // igUserId 없는 옛 기록은 아래 일반 경로로.
  }

  // Facebook 재시도 — 실패한 행의 metaPageId 로 같은 페이지에 다시. 게이트 ON 일 때만.
  if (b.channel === "facebook" && facebookUploadEnabled()) {
    const rows = (clip.distributions ?? []).filter((d: any) => d.channel === "facebook");
    const prev = rows.find((d: any) => d.status === "failed" && d.metaPageId);
    if (prev?.metaPageId) {
      const outcome = await dispatchPublish({
        clipIds: [b.clipId], channel: "facebook",
        metaPageId: String(prev.metaPageId),
        // 예약 복원(위 Instagram 과 같은 이유) — FB 는 안 넘기면 video_state 가 PUBLISHED 로
        // 나가 예약이 통째로 사라진다.
        reserveDate: prev.reserveDate, scheduled: Boolean(prev.reserveDate),
        actor, origin: "retry",
      });
      return c.json({ ok: true, ...outcome });
    }
  }

  // 네이버 재시도 — 실패한 행의 naverAccountId 로 같은 계정에 다시(설명은 있으면 재사용,
  // 없으면 워커가 클립 메타로 폴백). 다계정에서 계정 없이 재시도하면 엉뚱한 세션으로 나간다.
  if (b.channel === "naverclip" || b.channel === "navertv") {
    const rows = (clip.distributions ?? []).filter((d: any) => d.channel === b.channel);
    const prev = rows.find((d: any) => d.status === "failed" && d.naverAccountId);
    if (prev?.naverAccountId) {
      const outcome = await dispatchPublish({
        clipIds: [b.clipId], channel: b.channel,
        naverAccountId: String(prev.naverAccountId),
        ...(prev.description ? { description: String(prev.description) } : {}),
        actor, origin: "retry",
      });
      return c.json({ ok: true, ...outcome });
    }
  }

  // 연타 가드 — 실패 행 없이 진행 중(pending)·예약·게시됨 행만 있으면 **일반 경로로 떨어지지
  // 않는다.** 일반 경로는 계정 정체성 없는 dispatch 라 TikTok·IG·FB 를 '기록됨' 으로 강등해
  // 그 행을 덮어쓴다 — 업로드가 도는 사이 재시도를 한 번 더 누르자 pending 행이 recorded 로
  // 둔갑해 화면이 거짓말을 했다(2026-08-26 실측 · 틱톡 다이렉트 게시 테스트).
  {
    const chRows = (clip.distributions ?? []).filter((d: any) => d.channel === b.channel);
    const busy = chRows.find((d: any) =>
      d.status === "pending" || d.status === "scheduled" || d.status === "published");
    if (busy && !chRows.some((d: any) => d.status === "failed")) {
      return c.json({
        ok: false, error: "retry_not_needed",
        message: busy.status === "pending"
          ? "이미 업로드가 진행 중입니다 — 잠시 후 결과가 반영됩니다."
          : "이미 게시·예약된 클립입니다 — 재시도가 필요 없습니다.",
      }, 409);
    }
  }

  const outcome = await dispatchPublish({
    clipIds: [b.clipId], channel: b.channel,
    actor,
    origin: "retry",
  });
  return c.json({ ok: true, ...outcome });
});

// ── 이미 발행된 영상의 제목·메타를 라이브에 반영 (재발행 아님) ───────────────────
//
// 발행된 건은 재업로드하면 중복 공개가 되니(감사 #1), 재발행 대신 여기로 온다. videos.update
// (part=snippet)로 **기존 영상만** 고친다 — 새 영상이 안 생긴다. 워커(youtube 레인)가 채널 토큰을
// 쥐므로 여기선 잡만 큐잉한다. 지금은 YouTube 만(네이버=API 없음, Meta/TikTok=게시 후 편집 제약).
// 트리거는 **명시적**이다(사용자 방향 2026-08-24) — 메타 저장(PATCH)만으론 라이브가 안 바뀐다.
app.post("/api/distributions/update-metadata", async (c) => {
  const actor = requirePublisher(c);
  const b = await c.req.json<{ clipId: string; channel?: string }>().catch(() => null);
  if (!b || !b.clipId) {
    return c.json({ error: "bad_request", message: "clipId가 필요합니다." }, 400);
  }
  const channel = String(b.channel ?? "youtube");
  if (channel !== "youtube") {
    return c.json({ error: "unsupported_channel",
      message: "라이브 제목/메타 반영은 현재 YouTube만 지원합니다." }, 400);
  }
  if (!youtubeUploadEnabled()) {
    return c.json({ error: UPLOAD_DISABLED_CODE, message: UPLOAD_DISABLED_MESSAGE }, 409);
  }
  const clip = await getEntity<any>("clip", b.clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);

  const row = (clip.distributions ?? []).find((d: any) => d.channel === "youtube" && d.externalId);
  if (!row?.externalId) {
    return c.json({ error: "not_published",
      message: "발행된 YouTube 영상이 없습니다 — 먼저 발행하세요." }, 409);
  }
  // dedupeKey 에 videoId 포함 — 같은 영상에 대한 반영이 겹쳐도 하나만 돈다(핸들러가 실행 시점의
  // 최신 channelMeta 를 읽으므로, 중복 요청이 dedupe 돼도 최신 제목이 반영된다).
  const jobId = await enqueue(
    "distribution.updatemeta",
    { clipId: b.clipId, channel: "youtube", actor },
    { dedupeKey: `distribution.updatemeta:${b.clipId}:${row.externalId}` },
  );
  return c.json({ ok: true, clipId: b.clipId, videoId: row.externalId, jobId });
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

// ── AI dynamic 9:16 reframing ────────────────────────────────────────────────
// GET is read-only: it reports stale when planner inputs changed, but never starts work.
// POST is the sole state transition so the editor can debounce trim changes and explicitly
// retry a failed model run. Queue ownership is claimed atomically in PostgreSQL.
app.get("/api/clips/:id/reframe", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  return c.json({ clipId, reframe: effectiveReframeState(clip) });
});

// ── 세로 4택 비교 (vertical-candidates-v1 · reframe-compare-viewer-plan §4) ──────
//
// 정식 clip.reframe 상태와 **분리**된 비교 전용 축이다. compareId = 요청 시점의
// reframeFingerprint — 같은 입력 재요청은 기존 산출물을 그대로 돌려주는 멱등 캐시다.
// 산출물 존재 판정은 index.json 하나로 한다(워커가 마지막에 올리는 완료 신호).

/** 비교 작업 생성. 이미 산출물이 있으면 큐잉 없이 ready 를 돌려준다. */
app.post("/api/clips/:id/reframe/candidates", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const mediaId = typeof clip.sourceMediaId === "string" ? clip.sourceMediaId : "";
  if (!mediaId) {
    return c.json({ error: "source_media_missing", message: "비교할 원본 영상이 없습니다." }, 409);
  }
  let compareId: string;
  try {
    compareId = reframeFingerprint(clip);
  } catch (error) {
    return c.json({
      error: "invalid_reframe_input",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }

  const prefix = compareArtifactPrefix(mediaId, clipId, compareId);
  if (await fileExists(`${prefix}/index.json`).catch(() => false)) {
    return c.json({ clipId, compareId, status: "ready", reused: true });
  }
  const jobId = await enqueue("reframe.compare", { clipId, compareId }, {
    dedupeKey: `reframe.compare:${clipId}:${compareId}`,
  });
  return c.json({ clipId, compareId, status: "queued", jobId, reused: false });
});

/** 비교 상태·산출물 조회 — ready 면 manifest + 후보 plan 전체를 함께 준다. */
app.get("/api/clips/:id/reframe/candidates/:compareId", async (c) => {
  const clipId = c.req.param("id");
  const compareId = c.req.param("compareId");
  if (!COMPARE_ID_RE.test(compareId)) return c.json({ error: "invalid compareId" }, 400);
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const mediaId = typeof clip.sourceMediaId === "string" ? clip.sourceMediaId : "";
  if (!mediaId) return c.json({ error: "source_media_missing" }, 409);

  const prefix = compareArtifactPrefix(mediaId, clipId, compareId);
  if (await fileExists(`${prefix}/index.json`).catch(() => false)) {
    const manifest = JSON.parse((await readFile(`${prefix}/index.json`)).toString("utf8"));
    const candidates = JSON.parse((await readFile(`${prefix}/candidates.json`)).toString("utf8"));
    const base = `/api/clips/${clipId}/reframe/candidates/${compareId}/file`;
    return c.json({
      clipId,
      compareId,
      status: "ready",
      manifest,
      candidates,
      // 뷰어가 그대로 <img>/<video> 에 꽂을 수 있는 스트리밍 URL — GCS 를 직접 노출하지 않는다.
      urls: {
        proxy: `${base}/proxy.mp4`,
        frames: (Array.isArray(manifest.frames) ? manifest.frames : [])
          .map((name: string) => `${base}/${name}`),
      },
    });
  }

  // 산출물이 아직 없다 — 큐의 잡 상태를 그대로 비춘다(pending/running/failed).
  const { rows } = await getPool().query<{ status: string; error: string | null }>(
    `SELECT status, error FROM job_queue
      WHERE dedupekey = $1 ORDER BY createdat DESC LIMIT 1`,
    [`reframe.compare:${clipId}:${compareId}`],
  );
  const job = rows[0];
  if (!job) return c.json({ clipId, compareId, status: "not_found" }, 404);
  return c.json({
    clipId,
    compareId,
    status: job.status === "failed" ? "failed" : job.status === "running" ? "running" : "queued",
    ...(job.status === "failed" && job.error ? { error: String(job.error).slice(0, 300) } : {}),
  });
});

/** 비교 산출물 파일 스트리밍 — 화이트리스트 파일명만(경로 탈출 원천 차단). */
app.get("/api/clips/:id/reframe/candidates/:compareId/file/:name", async (c) => {
  const clipId = c.req.param("id");
  const compareId = c.req.param("compareId");
  const name = c.req.param("name");
  if (!COMPARE_ID_RE.test(compareId) || !COMPARE_FILE_RE.test(name)) {
    return c.json({ error: "not found" }, 404);
  }
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const mediaId = typeof clip.sourceMediaId === "string" ? clip.sourceMediaId : "";
  if (!mediaId) return c.json({ error: "source_media_missing" }, 409);
  const objPath = `${compareArtifactPrefix(mediaId, clipId, compareId)}/${name}`;
  if (!(await fileExists(objPath).catch(() => false))) return c.json({ error: "not found" }, 404);
  const body = await readFile(objPath);
  const type = name.endsWith(".mp4") ? "video/mp4"
    : name.endsWith(".jpg") ? "image/jpeg"
    : "application/json";
  return c.body(body, 200, {
    "Content-Type": type,
    // compareId(입력 지문)가 경로에 박혀 있어 내용이 불변 — 뷰어 왕복을 캐시로 줄인다.
    "Cache-Control": "private, max-age=3600",
  });
});

// ── 리프레임 라벨 — 비교 뷰어의 "이 장면은 이 레이아웃" 1클릭 정답 수집(계획 §5) ──
// append 전용. context 는 클라이언트가 보낸 그 순간의 후보 스냅샷을 그대로 보존한다 —
// 서버가 다시 계산하지 않는 이유: 라벨은 "사람이 그때 화면에서 본 것" 의 기록이다.

const REFRAME_LAYOUT_IDS = new Set([
  "9:16-letterbox", "9:16-crop-sub", "9:16-crop-main", "9:16-crop-full",
]);

app.post("/api/clips/:id/reframe/labels", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);
  const compareId = String(body.compareId ?? "");
  if (!COMPARE_ID_RE.test(compareId)) return c.json({ error: "invalid compareId" }, 400);
  const chosen = String(body.chosen ?? "");
  if (!REFRAME_LAYOUT_IDS.has(chosen)) return c.json({ error: "invalid layout" }, 400);
  const machine = typeof body.machine === "string" && REFRAME_LAYOUT_IDS.has(body.machine)
    ? body.machine : null;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
  await recordReframeLabel({
    clipId,
    compareId,
    beatId: typeof body.beatId === "string" || typeof body.beatId === "number" ? String(body.beatId) : null,
    segStart: num(body.segStart),
    segEnd: num(body.segEnd),
    atSec: num(body.atSec),
    chosen,
    machine,
    // 스냅샷은 크기만 상한(라벨 1건이 행 하나를 MB 로 만들지 않게) — 내용은 검증하지 않는다.
    context: body.context && JSON.stringify(body.context).length < 32_000 ? body.context : null,
    note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    createdAt: Date.now(),
  });
  return c.json({ ok: true });
});

/** 이 클립·비교의 라벨 목록 — 뷰어가 "어느 구간을 이미 라벨했나" 표시에 쓴다. */
app.get("/api/clips/:id/reframe/labels", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const compareId = c.req.query("compareId") || undefined;
  if (compareId && !COMPARE_ID_RE.test(compareId)) return c.json({ error: "invalid compareId" }, 400);
  const ctx = currentContext();
  const rows = await listReframeLabels({
    clipId, compareId,
    // RLS 없는 테이블 — 테넌트 컨텍스트면 그 스코프로 명시 필터(횡단 스코프는 필터 없음).
    tenantId: typeof ctx?.scope === "string" ? ctx.scope : undefined,
  });
  return c.json({ rows });
});

/**
 * 라벨 전체 내보내기 — 평가 통계·가중치 조정의 원자료. 측정 결과 분석은 md 문서로 한다는
 * 원칙(계획 §9)의 원천 데이터가 이것이다. json(콘솔) · `?format=jsonl`(분석). `?tenant=`·`?limit=`.
 */
app.get("/api/superadmin/reframe-labels", async (c) => {
  const actor = requireSuperadmin(c);
  const tenantId = c.req.query("tenant") || undefined;
  await audit(actor, { action: "reframe-labels.view", targetTenant: tenantId ?? null }, clientIp(c));
  const limit = Math.min(50000, Math.max(1, Number(c.req.query("limit")) || 5000));
  const rows = await runAsSystem(() => listReframeLabels({ tenantId, limit }));
  if (c.req.query("format") === "jsonl") {
    return c.body(rows.map((r) => JSON.stringify(r)).join("\n"), 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  }
  return c.json({ rows });
});

app.post("/api/clips/:id/reframe", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const body = await c.req.json<{ mode?: unknown; retry?: unknown }>()
    .catch(() => ({} as { mode?: unknown; retry?: unknown }));
  if (body.mode !== "basic" && body.mode !== "ai_multi") {
    return c.json({ error: "invalid_reframe_mode", message: "mode must be basic or ai_multi" }, 400);
  }

  if (body.mode === "basic") {
    if (clip.reframe && typeof clip.reframe === "object") {
      const current = clip.reframe as Partial<ClipReframeState>;
      if (current.mode === "basic" && current.status === "idle") {
        return c.json({ clipId, reframe: current, reused: true, queued: false });
      }
    }
    const reframe = basicReframeState();
    const restoreAspect = clip.reframe && typeof clip.reframe === "object" &&
      typeof (clip.reframe as Partial<ClipReframeState>).basicAspectRatio === "string"
      ? (clip.reframe as ClipReframeState).basicAspectRatio
      : undefined;
    await setClipReframe(clipId, reframe, restoreAspect);
    return c.json({ clipId, reframe, reused: false, queued: false });
  }

  if (typeof clip.sourceMediaId !== "string" || !clip.sourceMediaId) {
    return c.json({ error: "source_media_missing", message: "AI 리프레임 원본 영상이 없습니다." }, 409);
  }
  let inputFingerprint: string;
  try {
    inputFingerprint = reframeFingerprint(clip);
  } catch (error) {
    return c.json({
      error: "invalid_reframe_input",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }

  const stored = clip.reframe && typeof clip.reframe === "object"
    ? clip.reframe as ClipReframeState
    : null;
  if (stored?.mode === "ai_multi" && stored.inputFingerprint === inputFingerprint) {
    if (stored.status === "ready" || stored.status === "queued" || stored.status === "running") {
      return c.json({ clipId, reframe: stored, reused: true, queued: false });
    }
    if (stored.status === "failed" && body.retry !== true) {
      return c.json({
        error: "reframe_retry_required",
        code: "reframe_retry_required",
        message: "AI 리프레임 분석에 실패했습니다. retry=true로 다시 시도해 주세요.",
        clipId,
        reframe: stored,
      }, 409);
    }
  }

  const requestedAt = Date.now();
  const requestId = newId("rr");
  const queuedState: ClipReframeState = {
    mode: "ai_multi",
    status: "queued",
    timeBase: "master_absolute",
    revision: requestedAt,
    inputFingerprint,
    requestId,
    jobId: null,
    requestedAt,
    updatedAt: requestedAt,
    error: null,
    basicAspectRatio: stored?.mode === "ai_multi" && typeof stored.basicAspectRatio === "string"
      ? stored.basicAspectRatio
      : typeof clip.aspectRatio === "string" ? clip.aspectRatio : undefined,
  };
  const claimed = await tryQueueClipReframe(
    clipId,
    inputFingerprint,
    queuedState,
    body.retry === true,
  );
  if (!claimed) {
    const latest = await getEntity<Record<string, unknown>>("clip", clipId);
    if (!latest) return c.json({ error: "clip not found" }, 404);
    const reframe = effectiveReframeState(latest);
    if (reframe.status === "failed" && body.retry !== true) {
      return c.json({
        error: "reframe_retry_required", code: "reframe_retry_required",
        message: "AI 리프레임 분석에 실패했습니다. retry=true로 다시 시도해 주세요.",
        clipId, reframe,
      }, 409);
    }
    return c.json({ clipId, reframe, reused: true, queued: false });
  }

  // The editor may have committed a new master-absolute trim between the route's first read
  // and the atomic queue claim. Do not enqueue a plan for the previous range in that case.
  let claimedFingerprint = "";
  try { claimedFingerprint = reframeFingerprint(claimed); } catch { /* stale below */ }
  if (claimedFingerprint !== inputFingerprint) {
    const at = Date.now();
    const stale: ClipReframeState = {
      ...queuedState,
      status: "stale",
      revision: at,
      updatedAt: at,
    };
    await compareAndSetClipReframe(clipId, inputFingerprint, requestId, stale);
    return c.json({ clipId, reframe: stale, reused: false, queued: false });
  }

  try {
    const jobId = await enqueue(
      "clip.reframe",
      { clipId, inputFingerprint, requestId },
      { dedupeKey: `clip.reframe:${clipId}:${requestId}` },
    );
    if (!jobId) throw new Error("reframe queue insert conflicted");
    const withJob: ClipReframeState = {
      ...queuedState,
      jobId,
      revision: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = await compareAndSetClipReframe(clipId, inputFingerprint, requestId, withJob);
    if (!updated) {
      // Basic mode or a new trim won a race after enqueue. The queued job is harmless (its
      // CAS will fail), and the response must reflect the state that actually won.
      const latest = await getEntity<Record<string, unknown>>("clip", clipId);
      const reframe = latest ? effectiveReframeState(latest) : withJob;
      return c.json({ clipId, reframe, reused: true, queued: false });
    }
    const reframe = updated.reframe && typeof updated.reframe === "object"
      ? updated.reframe as ClipReframeState
      : withJob;
    return c.json({ clipId, reframe, reused: false, queued: true }, 202);
  } catch (error) {
    const at = Date.now();
    const failed: ClipReframeState = {
      ...queuedState,
      status: "failed",
      revision: at,
      updatedAt: at,
      error: {
        code: "queue_failed",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
        at,
      },
    };
    const updated = await compareAndSetClipReframe(clipId, inputFingerprint, requestId, failed);
    const latest = updated ?? await getEntity<Record<string, unknown>>("clip", clipId);
    const responseState = latest ? effectiveReframeState(latest) : failed;
    return c.json({
      error: "reframe_queue_failed", code: "reframe_queue_failed",
      message: "AI 리프레임 작업을 큐에 넣지 못했습니다.", clipId, reframe: responseState,
    }, 503);
  }
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
  const patch: Record<string, unknown> = { editorState: body.editorState };
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
  const nextForFingerprint = { ...clip, ...patch };
  let nextFingerprint = "";
  try {
    nextFingerprint = reframeFingerprint(nextForFingerprint);
  } catch {
    // Invalid legacy clips cannot have a valid AI plan. The atomic helper still marks any
    // existing AI state stale because an empty fingerprint cannot match a real one.
  }
  await patchClipEditorAtomic(clipId, patch, nextFingerprint);

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

  // 프로그램별 운영자 커스텀 제목 지시(program.titlePrompt) — episode→program 조인으로 로드.
  // 재생성 버튼을 누를 때마다 자동으로 붙는 지시라, 요청 본문의 일회성 extra 와 별개다.
  const epForPrompt = clip.episodeId ? await getEntity<any>("episode", clip.episodeId) : null;
  const programForPrompt = epForPrompt?.programId
    ? await getEntity<any>("program", epForPrompt.programId)
    : null;
  const programTitlePrompt = typeof programForPrompt?.titlePrompt === "string"
    ? programForPrompt.titlePrompt.trim()
    : "";

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));
  if (!(end > start)) {
    return c.json({
      error: "invalid_segment",
      message: "클립 구간이 비어 있습니다 — 트림을 확인해 주세요.",
    }, 400);
  }

  // 소스 미디어의 자막(마스터 절대 초) → 현재 세그먼트 창으로 windowCaptions rebase.
  // 자막이 없으면 제목 근거가 없어 재생성 의미가 없음 → 409.
  const resolved = clip.sourceMediaId
    ? await resolveTranscript(clip.sourceMediaId)
    : { segments: [] as unknown[], updatedAt: 0, source: "none" as const };
  const captions = windowCaptions(resolved.segments, start, end);
  if (captions.length === 0) {
    return c.json({
      error: "no_captions",
      message: "이 구간에 자막(대사)이 없어 제목을 만들 근거가 없습니다.",
    }, 409);
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
  // 프로그램별 운영자 지시는 기본 톤 위에 얹는 상시 규칙, 일회성 extra 는 그보다도 우선.
  const programBlock = programTitlePrompt
    ? `\n\n## 프로그램별 운영자 지시\n${programTitlePrompt.slice(0, 1000)}\n` +
      "(위 지시는 이 프로그램 운영자가 직접 입력했다. 기본 톤·금지 규칙은 유지한 채 추가로 반영하라.)"
    : "";
  const extraBlock = extra
    ? `\n\n[사용자 추가 요청 — 위 규칙과 충돌하면 사용자 요청을 우선]\n${extra}`
    : "";
  const prompt =
    `${systemBase}${programBlock}${extraBlock}\n\n` +
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
      // finishReason 이 MAX_TOKENS 면 thinking 이 예산을 먹은 것이다(gemini.ts 주석 참고).
      console.error(`[regenerate-titles] empty result — finishReason=${res.finishReason ?? "?"} raw:`,
        res.text?.slice(0, 500));
      return c.json({
        error: "no_titles_generated",
        // ⚠️ **message 가 없으면 이 error 코드가 그대로 화면에 뜬다.** 웹 json() 은
        // message → nested.message → error 순으로 폴백하는데(api.ts), message 를 빼면
        // 사용자가 "no titles generated" 라는 영어 코드를 본다(2026-08-20 사용자 지적).
        // 코드는 기계용, message 는 사람용 — 둘 다 준다.
        message: "제목을 만들지 못했습니다 — 지시를 조금 더 구체적으로 적고 다시 눌러 보세요.",
        rawText: res.text?.slice(0, 500) ?? "",
        parsedShape: typeof parsed === "object" && parsed ? Object.keys(parsed) : [],
      }, 502);
    }
    return c.json({ titles });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[regenerate-titles] failed:", msg);
    // 예외 원문(영어·기술적)을 message 로 그대로 내보내면 화면에 스택 문구가 뜬다 —
    // 사람용 문장은 message, 원문은 detail 로 나눈다(원인 추적은 로그·detail 로).
    return c.json({
      error: "generation_failed",
      message: "제목 생성에 실패했습니다 — 잠시 후 다시 시도해 주세요.",
      detail: msg.slice(0, 300),
    }, 502);
  }
});

// ── 업로드 메타데이터 AI 자동 생성 — YouTube 업로드용 title/description/tags를 자막 근거로 생성.
//    저장 X. 프론트 MetadataButton의 '생성' 버튼이 호출 → 결과를 state.uploadMeta에 얹는다. ──
/**
 * 사람이 고친 채널 메타를 저장한다.
 *
 * `edited: true` 를 붙여 두면 재생성이 그 채널을 덮지 않는다 — 운영자가 다듬어 놓은 문구가
 * 자동 생성 한 번에 날아가면 아무도 이 기능을 안 쓴다.
 *
 * 저장 시점에 규격을 다시 본다. 화면에서 이미 보여주지만, 화면만 믿으면 API 로 들어오는
 * 값이 그대로 발행 경로까지 간다.
 */
app.patch("/api/clips/:id/metadata/:channel", async (c) => {
  const clipId = c.req.param("id");
  const channel = c.req.param("channel") as MetaChannel;
  if (!META_CHANNELS.includes(channel)) {
    return c.json({ error: "unknown_channel", message: `알 수 없는 채널: ${channel}` }, 400);
  }
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);

  const b = await c.req.json<{ title?: string; description?: string; tags?: string[] }>()
    .catch(() => null);
  if (!b) return c.json({ error: "bad_request", message: "본문이 올바르지 않습니다." }, 400);

  const spec = CHANNEL_SPECS[channel];
  const next = {
    channel,
    // 제목 필드가 없는 채널에 제목을 저장하지 않는다 — 저장되면 발행 때 어디론가 새어 나간다.
    title: spec.titleMax === null ? null : String(b.title ?? "").trim(),
    description: String(b.description ?? "").trim(),
    tags: Array.isArray(b.tags)
      ? [...new Set(b.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean))]
          .slice(0, spec.tagsMax)
      : [],
    needsCategory: spec.needsCategory,
    problems: validateForChannel({ title: b.title ?? null, description: b.description ?? "" }, channel),
    edited: true,
    editedAt: Date.now(),
  };

  await putEntity("clip", clipId, {
    ...clip,
    channelMeta: { ...(clip.channelMeta ?? {}), [channel]: next },
  });

  // 학습 데이터 — **AI 원본 → 사용자 최종** 을 저장 시점마다 남긴다(사용자 2026-08-21: "나중에
  // 학습할 때 필요한 데이터"). best-effort: 기록이 깨져도 저장은 성공시킨다(핵심은 사용자 저장).
  try {
    const prev = (clip.channelMeta?.[channel] ?? null) as any;   // 이번 저장 직전 값 = 사용자가 본 것
    const base = (clip.channelMetaBase ?? null) as any;          // 폴백: 채널무관 AI 바탕
    const wasAi = !prev?.edited;   // 이 채널이 이전에 수정 안 됨 → prev 가 AI 값 그대로(순수 페어)
    // program/genre 맥락 — 회사·장르별 취향 분리에 쓴다. 없어도 페어는 남긴다(best-effort).
    let programId: string | null = null, genre: string | null = null;
    try {
      const ep = clip.episodeId ? await getEntity<any>("episode", clip.episodeId) : null;
      const prog = ep?.programId ? await getEntity<any>("program", ep.programId) : null;
      programId = prog?.id ?? null;
      genre = prog?.pipelineGenre ?? prog?.section ?? null;
    } catch { /* 맥락 조회 실패는 무시 */ }
    const editor = c.get("user")?.email ?? null;
    const now = Date.now();
    const fieldsOf = (m: any) => ({
      title: m?.title == null ? "" : String(m.title),
      description: m?.description == null ? "" : String(m.description),
      tags: Array.isArray(m?.tags) ? m.tags.join(", ") : "",
    });
    const before = fieldsOf(prev ?? base);
    const after = fieldsOf(next);
    const edits = (["title", "description", "tags"] as const)
      .filter((f) => after[f] && after[f] !== before[f])   // 실제로 바뀐 필드만
      .map((f) => ({
        clipId, programId, genre, channel, field: f,
        aiOriginal: before[f], userFinal: after[f], wasAi, editor, createdAt: now,
      }));
    if (edits.length) await recordMetadataEdits(edits);
  } catch (e) {
    console.warn("[metadata-edit-log] 기록 실패(저장은 성공):", e instanceof Error ? e.message : e);
  }

  return c.json({ channel, meta: next });
});

/**
 * 채널별 업로드 메타데이터 생성.
 *
 * 예전에는 **원본 자막 40줄만** 다시 읽어 문구 한 벌을 만들고, 그걸 모든 채널에 그대로 썼다.
 * 두 가지가 잘못이었다:
 *  - 파이프라인이 이미 비싸게 만들어 둔 것(분석 제목·요약·훅 대사·등장 인물)을 안 썼다.
 *  - 채널 규격이 서로 다른데(네이버 클립은 제목 필드가 없고 설명 10자↑·카테고리 필수)
 *    한 벌을 공유해서, 발행 시점에 사람이 손으로 메웠다.
 *
 * 지금은 **바탕 한 벌을 LLM 으로 만들고, 채널 맞춤은 결정론으로** 한다(clip-metadata.ts).
 * 채널 수만큼 LLM 을 부르면 6배 비싸지고 채널 간 내용이 달라져 검토가 불가능해진다.
 */
app.post("/api/clips/:id/generate-metadata", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));

  // 프로그램·회차 맥락. 인물 이름은 **등록 캐스트가 정본**이라 여기서 가져온다.
  const episode = clip.episodeId ? await getEntity<any>("episode", clip.episodeId) : null;
  const program = episode?.programId ? await getEntity<any>("program", episode.programId) : null;
  const cast = Array.isArray(program?.cast) ? program.cast.map((x: any) => String(x?.name ?? x)).filter(Boolean) : [];

  // 추천에서 승계된 재료가 있으면 그게 가장 좋다 — 훅 대사·인물은 분석이 이미 뽑아 뒀다.
  const rec = clip.sourceRecommendationId
    ? await getEntity<any>("recommendation", clip.sourceRecommendationId)
    : null;

  // 자막은 **보조**다. 없어도 진행한다(대사 없는 리액션 클립도 메타가 필요하다).
  let captions: string[] = [];
  if (clip.sourceMediaId && end > start) {
    const resolved = await resolveTranscript(clip.sourceMediaId).catch(() => null);
    if (resolved) {
      captions = windowCaptions(resolved.segments, start, end)
        .slice(0, 40)
        .map((cp: any) => `[${cp.start.toFixed(1)}s] ${String(cp.text).slice(0, 180)}`);
    }
  }

  // 쇼츠(9:16)면 해시태그·태그를 넓게(핵심+인접 확장) 뽑고 제목·설명에 #Shorts 를 보장한다
  // — 유튜브 추천 유입축(사용자 2026-08-21). aspectRatio 없으면 쇼츠로 본다(자동배포 기본 산출물).
  const isShortClip = String(clip.aspectRatio ?? "9:16").startsWith("9:16");

  const prompt = buildMetadataPrompt({
    program: program?.title ?? clip.programTitle,
    episode: episode?.title ?? (episode?.episodeNumber ? `${episode.episodeNumber}화` : undefined),
    genre: program?.pipelineGenre ?? program?.section,
    cast,
    people: Array.isArray(rec?.people) ? rec.people : (Array.isArray(clip.people) ? clip.people : []),
    workingTitle: rec?.title ?? clip.title,
    summary: clip.synopsis ?? rec?.editNote,
    hookQuote: rec?.hookQuote ?? clip.hookQuote,
    hookType: rec?.hook,
    captions,
    durationSec: end > start ? end - start : clip.durationSec,
    // 프로그램별 운영자 커스텀 제목 지시 — PATCH /api/programs/:id 로 저장된 것.
    titlePrompt: typeof program?.titlePrompt === "string" ? program.titlePrompt : undefined,
    isShort: isShortClip,
    // 커머스 게이트가 켜졌을 때만 상품 쿼리를 같이 뽑는다 — **같은 호출**이라 추가 원가가 없다.
    // 꺼져 있으면 프롬프트가 종전과 완전히 동일하다(메타 품질에 영향 없음).
    wantProductQueries: commerceLinksEnabled(),
  });

  try {
    // ⚠️ schema 를 넘기지 않는다(AENA 결론) — 잘렸을 때 부분 복구가 가능해야 한다.
    //    temperature 는 낮게: 사실을 다루는 작업이라 실행마다 달라질 이유가 없다.
    //    thinking:false — JSON 을 뽑는 호출이라 추론이 예산만 먹는다. schema 가 없으면
    //    gemini.ts 기본이 thinking ON 이므로 여기선 명시해야 한다(2026-08-20).
    const res = await geminiGenerate(prompt, { temperature: 0.4, maxOutputTokens: 2048, thinking: false });
    const parsed = parseJsonLoose(res.text) as Record<string, unknown>;
    const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
    const baseMeta = {
      title: String(parsed.title ?? "").trim(),
      description: String(parsed.description ?? "").trim(),
      tags: asList(parsed.tags),
      hashtags: asList(parsed.hashtags),
    };
    if (!baseMeta.title && !baseMeta.description) {
      console.error("[generate-metadata] 빈 결과 — raw:", res.text?.slice(0, 500));
      return c.json({
        error: "empty_metadata",
        message: "모델이 빈 결과를 돌려줬습니다. 다시 시도해 주세요.",
        rawText: res.text?.slice(0, 500) ?? "",
      }, 502);
    }

    // 채널 규칙(titlePrefix·hashtagTemplate)을 여기서 **드디어** 쓴다 — 그동안 입력만 받고
    // 읽는 코드가 없었다.
    const rules = await listChannelRules().catch(() => []);
    const vars = {
      program: program?.title ?? clip.programTitle,
      episode: episode?.title ?? (episode?.episodeNumber ? `${episode.episodeNumber}화` : undefined),
    };
    // isShortClip(위에서 계산)이 제목·설명 #Shorts 보장에도 쓰인다(clip-metadata SHORTS_TAG).
    const byChannel: Record<string, unknown> = {};
    for (const ch of META_CHANNELS) {
      const rule = rules.find((r: any) => r.platform === ch && r.enabled !== false);
      byChannel[ch] = normalizeForChannel(baseMeta, ch, rule ?? {}, vars, isShortClip);
    }

    // 사람이 고친 값을 덮지 않는다 — `edited` 가 붙은 채널은 그대로 둔다.
    const prev = (clip.channelMeta ?? {}) as Record<string, any>;
    for (const ch of Object.keys(byChannel)) {
      if (prev[ch]?.edited) byChannel[ch] = prev[ch];
    }

    // 커머스 — 게이트가 켜졌을 때만. 같은 응답에 실려 온 상품 쿼리를 클립에 붙이고
    // 발급 잡을 큐잉한다. **이미 발급된 링크는 살린다** — 메타를 다시 만든다고 브라우저를
    // 한 번 더 태울 이유가 없다. 다만 쿼리 목록에서 빠진 상품의 링크는 버린다(장면과
    // 무관해진 상품이 설명란에 남는 게 더 나쁘다).
    const commerce = commerceLinksEnabled()
      ? (() => {
          const queries = parseProductQueries(parsed.productQueries);
          const keep = new Set(queries.map((q) => q.query.toLowerCase()));
          const prevLinks = Array.isArray((clip.commerce as any)?.links) ? (clip.commerce as any).links : [];
          return {
            queries,
            links: prevLinks.filter((l: any) => keep.has(String(l?.query ?? "").toLowerCase())),
            updatedAt: Date.now(),
          };
        })()
      : clip.commerce;

    await putEntity("clip", clipId, {
      ...clip,
      channelMeta: byChannel,
      channelMetaBase: baseMeta,
      channelMetaAt: Date.now(),
      ...(commerce ? { commerce } : {}),
    });

    // 발급 잡은 **머신 전용 레인**(commerce)이 집는다 — 로그인된 브라우저가 있는 PC 만
    // 처리할 수 있다. 게이트가 꺼져 있으면 큐잉 자체를 안 한다.
    //
    // ⚠️ **계정이 없으면 큐잉도 하지 않는다.** 어차피 워커가 계정을 못 찾아 아무것도 안 하는데,
    //    그 워커(윈도우2)가 안 떠 있으면 잡이 pending 으로 조용히 쌓인다 — 이 리포의 전형적
    //    실패 모드다. 할 수 없는 일은 큐에 넣지 않는다. 쿼리는 이미 클립에 저장돼 있으므로,
    //    나중에 계정을 등록하고 /commerce 에서 "발급" 을 누르면 그때 처리된다.
    if (commerceLinksEnabled() && (commerce as any)?.queries?.length) {
      const acct = await getCommerceAccount("coupang").catch(() => undefined);
      if (acct && acct.status !== "disabled") {
        void enqueue("commerce.link", { clipId }, { dedupeKey: `commerce.link:${clipId}` })
          .catch((e) => console.warn("[generate-metadata] commerce.link 큐잉 실패:", e));
      } else {
        console.log(`[generate-metadata] ${clipId}: 상품 쿼리 ${(commerce as any).queries.length}건 저장 — ` +
          "쿠팡파트너스 계정 미등록이라 발급은 보류합니다(/commerce 에서 계정 등록 후 발급).");
      }
    }

    return c.json({ base: baseMeta, channels: byChannel, commerce: commerce ?? undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-metadata] 실패:", msg);
    return c.json({ error: "generation_failed", message: msg.slice(0, 300) }, 502);
  }
});

// ── 커머스 제휴 링크 검토 ─────────────────────────────────────────────────────
//
// **이 세 라우트가 "우리가 조절한다"의 실체다.** 파이프라인은 상품을 찾아 링크까지 발급해
// 두지만, 그건 전부 `pending` 이라 설명란에 안 나간다. 사람이 여기서 보고 승인한 것만 나간다.
// 자동화가 노동을 지고 판단은 사람이 하는 경계 — 방송사 채널에 엉뚱한 상품이 걸리는 사고를
// 구조적으로 막는다.

/** 이 클립의 상품·링크·대체 후보 + **실제 설명란 미리보기**. 검토 화면이 읽는 것. */
app.get("/api/clips/:id/commerce", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);

  const links = usableLinks(clip.commerce?.links, Number.MAX_SAFE_INTEGER);
  const base = String(clip.channelMeta?.youtube?.description ?? clip.synopsis ?? "");
  return c.json({
    enabled: commerceLinksEnabled(),
    queries: clip.commerce?.queries ?? [],
    links,
    candidates: clip.commerce?.candidates ?? {},
    linkedAt: clip.commerce?.linkedAt ?? null,
    // 승인한 것만 반영된 **실제 발행 문구**. 화면이 따로 조립하면 서버와 다른 말을 하게 된다.
    preview: withCommerceLinks(base, clip.commerce?.links, "youtube"),
    // 게이트가 꺼져 있으면 승인해도 안 나간다 — 화면이 그걸 말할 수 있게 함께 알린다.
    note: commerceLinksEnabled() ? null : "커머스 링크 기능이 꺼져 있어 승인해도 발행에 반영되지 않습니다.",
  });
});

/** 승인·거절. **여기를 통과한 것만** 발행 설명란에 나간다. */
app.patch("/api/clips/:id/commerce", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);

  const b = await c.req.json<{ decisions?: { url?: string; status?: string }[] }>().catch(() => null);
  if (!b || !Array.isArray(b.decisions)) {
    return c.json({ error: "bad_request", message: "decisions 배열이 필요합니다." }, 400);
  }
  const wanted = new Map<string, string>();
  for (const d of b.decisions) {
    if (d?.url) wanted.set(String(d.url), normalizeStatus(d.status));
  }

  const actor = c.get("user")?.email ?? null;
  const now = Date.now();
  const links = usableLinks(clip.commerce?.links, Number.MAX_SAFE_INTEGER).map((l) =>
    wanted.has(l.url)
      ? { ...l, status: wanted.get(l.url) as any, decidedBy: actor ?? l.decidedBy, decidedAt: now }
      : l,
  );
  // 승인 개수 상한은 조립 단계(withCommerceLinks)가 지킨다 — 여기서 막으면 사람이 이유를
  // 모른 채 저장이 실패한다. 대신 미리보기로 무엇이 실제로 나가는지 보여준다.
  await putEntity("clip", clipId, {
    ...clip,
    commerce: { ...(clip.commerce ?? {}), links, reviewedAt: now, reviewedBy: actor },
  });

  const base = String(clip.channelMeta?.youtube?.description ?? clip.synopsis ?? "");
  return c.json({ links, preview: withCommerceLinks(base, links, "youtube") });
});

/**
 * 링크 발급을 다시 돌린다. 두 가지 용도:
 *  - 인자 없음: 아직 링크가 없는 쿼리에 대해 발급 (처음 실패했거나 브라우저가 꺼져 있었을 때)
 *  - `pick`: 검토 화면에서 **다른 후보로 교체** — 그 상품으로 링크를 새로 받아 승인 상태로 바꾼다
 */
app.post("/api/clips/:id/commerce/issue", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);
  if (!commerceLinksEnabled()) {
    return c.json({
      error: "commerce_disabled",
      message: "커머스 링크 기능이 꺼져 있습니다 (COMMERCE_LINKS_ENABLED 미설정). 발급하지 않았습니다.",
    }, 409);
  }

  const b = await c.req.json<{ pick?: { query?: string; productId?: number } }>().catch(() => null);
  const pick = b?.pick?.query && b?.pick?.productId
    ? { query: String(b.pick.query), productId: Number(b.pick.productId) }
    : undefined;

  // dedupeKey 를 교체 대상까지 포함해 만든다 — 서로 다른 교체 요청이 하나로 합쳐지면 안 된다.
  const dedupeKey = pick
    ? `commerce.link:${clipId}:${pick.query}:${pick.productId}`
    : `commerce.link:${clipId}`;
  const jobId = await enqueue("commerce.link", { clipId, ...(pick ? { pick } : {}) }, { dedupeKey });
  return c.json({ jobId, queued: true });
});

// ── 커머스 계정 (회사마다 자기 법인 파트너스 계정) ──────────────────────────────
//
// 커미션 정산이 **계정 단위**라 회사마다 계정이 달라야 한다. 한 계정에 subId 로 가르면
// 실적 보고서만 갈리고 돈은 그 계정 하나로 들어와 우리가 지급대행이 된다.
// 계정이 없으면 발급을 **안 한다** — 공용 계정으로 대신 발급하면 수익이 엉뚱한 회사로 간다.

/** 이 워크스페이스의 계정. 세션 값은 절대 나가지 않는다 — 있다/없다·갱신시각만. */
app.get("/api/commerce/account", async (c) => {
  const acct = await getCommerceAccount("coupang");
  return c.json({
    account: acct ?? null,
    sessionKeyReady: commerceSessionStoreReady(),
    enabled: commerceLinksEnabled(),
  });
});

/** 계정 등록·수정(라벨·상태). 자격증명은 여기로 안 들어온다 — 세션은 아래 전용 라우트로만. */
app.put("/api/commerce/account", async (c) => {
  requireManager(c);
  const b = await c.req.json<{ label?: string; status?: string }>().catch(() => null);
  const label = String(b?.label ?? "").trim();
  if (!label) return c.json({ error: "bad_request", message: "label 이 필요합니다." }, 400);
  const existing = await getCommerceAccount("coupang");
  const status = ["active", "disabled", "session_expired"].includes(String(b?.status))
    ? (b!.status as any) : (existing?.status ?? "active");
  await upsertCommerceAccount({
    id: existing?.id ?? newId("cma"),
    provider: "coupang",
    label,
    status,
    createdAt: existing?.createdAt ?? Date.now(),
  });
  return c.json({ account: await getCommerceAccount("coupang") });
});

/**
 * 로그인 세션 등록 — `commerce:login` 스크립트가 사람 로그인 뒤에 올린다.
 *
 * ⚠️ 이 값은 그 계정의 **전체 권한**이다(쿠키만 주입해도 로그인된다 · 2차인증 통과 상태).
 *    아이디·비번보다 즉시 쓸 수 있어 더 위험하다 — 관리자만, 그리고 키가 없으면 저장 거부.
 */
app.put("/api/commerce/account/session", async (c) => {
  requireManager(c);
  const acct = await getCommerceAccount("coupang");
  if (!acct) {
    return c.json({ error: "not_found", message: "먼저 계정을 등록하세요 (PUT /api/commerce/account)." }, 404);
  }
  if (!commerceSessionStoreReady()) {
    return c.json({
      error: "session_key_missing",
      message: "COMMERCE_SESSION_KEY 가 설정되지 않아 세션을 저장할 수 없습니다(평문 저장은 하지 않습니다).",
    }, 503);
  }
  const body = await c.req.json<{ storageState?: unknown }>().catch(() => null);
  const state = body?.storageState;
  if (!looksLikeStorageState(state)) {
    return c.json({ error: "invalid_storage_state", message: "cookies 배열이 있는 storageState JSON 이어야 합니다." }, 400);
  }
  await setCommerceSessionBlob(acct.id, sealCommerceSession(state));
  // 값은 절대 되돌려주지 않는다. 있다/없다만.
  return c.json({ ok: true, id: acct.id, status: "active", sessionUpdatedAt: Date.now() });
});

/** 세션 폐기(= 그 계정으로의 발급 중단). 계정 행은 남는다. */
app.delete("/api/commerce/account/session", async (c) => {
  requireManager(c);
  const acct = await getCommerceAccount("coupang");
  if (!acct) return c.json({ error: "not_found" }, 404);
  await markCommerceSessionExpired(acct.id);
  return c.json({ ok: true, id: acct.id, status: "session_expired" });
});

/**
 * 검토 대기 목록 — 클립 하나씩 들어가지 않고 **한 화면에서 훑을 수 있게.**
 * 실무 동선이 이유다: 회차 하나에 쇼츠가 여러 개고, 승인은 몰아서 하는 일이다.
 */
app.get("/api/commerce/review", async (c) => {
  const clips = await listEntities<any>("clip");
  const rows = clips
    .map((clip) => {
      const links = usableLinks(clip.commerce?.links, Number.MAX_SAFE_INTEGER);
      const queries = Array.isArray(clip.commerce?.queries) ? clip.commerce.queries.length : 0;
      // 링크가 아직 없어도 **상품을 찾아 둔 클립은 보여준다** — 안 그러면 "분석은 상품을
      // 찾았는데 화면엔 아무것도 없는" 상태가 되고, 계정 미등록·발급 실패를 눈치챌 수 없다.
      if (links.length === 0 && queries === 0) return null;
      return {
        queries,
        clipId: clip.id,
        clipTitle: clip.title ?? "무제 클립",
        episodeId: clip.episodeId ?? null,
        programTitle: clip.programTitle ?? null,
        status: clip.status ?? null,
        thumbUrl: clip.thumbUrl ?? null,
        pending: links.filter((l) => l.status === "pending").length,
        approved: links.filter((l) => l.status === "approved").length,
        rejected: links.filter((l) => l.status === "rejected").length,
        links,
      };
    })
    .filter(Boolean) as any[];
  // 검토가 필요한 것부터 — 대기 건수 많은 순, 그다음 최신순.
  rows.sort((a, b) => b.pending - a.pending || String(b.clipId).localeCompare(String(a.clipId)));
  const acct = await getCommerceAccount("coupang").catch(() => undefined);
  return c.json({
    enabled: commerceLinksEnabled(),
    /** 계정이 없으면 발급 자체가 보류된다 — 화면이 그 사실을 말할 수 있게 함께 준다. */
    accountReady: !!acct && acct.status === "active",
    total: rows.length,
    pendingClips: rows.filter((r) => r.pending > 0).length,
    /** 상품은 찾았는데 아직 링크가 없는 클립 — 발급이 안 돈 것이다(계정 미등록·워커 미가동). */
    awaitingIssue: rows.filter((r) => r.links.length === 0 && r.queries > 0).length,
    clips: rows,
  });
});

// 미디어(클립) 삭제 — 클립 엔티티 + 렌더 산출물 미디어를 정리한다. RLS 로 테넌트 스코프라
// 남의 워크스페이스 것은 못 지운다. ⚑ 이미 채널에 올라간 영상은 내려가지 않는다(automation
// rule 삭제와 같은 원칙) · 원본 마스터(sourceMediaId)는 다른 클립도 쓰므로 건드리지 않는다.
app.delete("/api/clips/:id", async (c) => {
  const id = c.req.param("id");
  const clip = await getEntity<any>("clip", id);
  if (!clip) return c.json({ ok: false, error: "clip_not_found", message: "미디어를 찾을 수 없습니다." }, 404);
  await deleteEntityRow("clip", id);
  if (clip.mediaId && clip.mediaId !== clip.sourceMediaId) {
    try { await deleteMediaData(clip.mediaId); }
    catch (e) { console.error("[clips delete] 렌더 미디어 정리 실패(계속):", e); }
  }
  return c.json({
    ok: true,
    notice: "미디어를 삭제했습니다. 이미 채널에 올라간 영상은 내려가지 않습니다 — 필요하면 채널에서 직접 내려야 합니다.",
  });
});

// 하이라이트 훅 재생성 — **숏폼(9:16) 전용.** 첫 3초 이탈 방지(시청자 잡기)라 롱폼 클립엔 안 쓴다.
// Gemini 가 클립 자막에서 가장 후킹되는 대사 1줄 + 어그로 자막을 뽑고, 시각은 전사에서 찾아 확정한다
// (지어내면 영상에 없는 말이 자막으로 나간다). 구 클립(hookTimeSec 없음)에 훅을 새로 만드는 경로이기도 하다.
app.post("/api/clips/:id/regenerate-hook", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip_not_found", message: "클립을 찾을 수 없습니다." }, 404);
  if (!String(clip.aspectRatio ?? "").startsWith("9:16")) {
    return c.json({ error: "not_short", message: "하이라이트 훅은 숏폼(9:16)에서만 씁니다." }, 400);
  }
  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + Number(clip.durationSec ?? 0));
  if (!(end > start)) return c.json({ error: "no_window", message: "클립 구간 정보가 없습니다." }, 400);

  let caps: { at: number; text: string }[] = [];
  if (clip.sourceMediaId) {
    const resolved = await resolveTranscript(clip.sourceMediaId).catch(() => null);
    if (resolved) {
      caps = windowCaptions(resolved.segments, start, end)
        .map((cp: any) => ({ at: Number(cp.start), text: String(cp.text ?? "").trim() }))
        .filter((cp) => Number.isFinite(cp.at) && cp.text);
    }
  }
  if (caps.length === 0) {
    return c.json({ error: "no_captions", message: "이 클립엔 대사가 거의 없어 훅을 만들 수 없습니다." }, 422);
  }

  const list = caps.map((cp, i) => `[${i}] (${(cp.at - start).toFixed(1)}s) ${cp.text.slice(0, 120)}`).join("\n");
  const prompt =
    "너는 숏폼(세로 영상) 편집자다. 아래는 한 쇼츠의 자막 목록(번호·시각·대사)이다.\n" +
    "쇼츠 맨 앞 3초에 붙일 **훅**을 고른다 — 시청자가 스크롤을 멈추게 하는 가장 강한 순간.\n" +
    "감정 폭발·반전·충격 고백·궁금증 유발이 강한 대사를 고른다. 앞쪽일수록 좋지만 약하면 뒤라도 센 걸 고른다.\n" +
    "\n아래 JSON 만 출력(설명·코드펜스 금지):\n" +
    '{"index": <대사 번호>, "caption": "<어그로 편집자막 20자 이내 · 충격 고백! 톤>"}\n' +
    "- index: 위 목록에서 고른 대사의 번호.\n" +
    "- caption: 그 순간을 파는 짧고 센 편집자막. 자막에 없는 사실은 만들지 마라.\n" +
    "\n[자막]\n" + list;

  try {
    // thinking:false — schema 없는 JSON 호출이라 gemini.ts 기본이 thinking ON 이다. 예산이
    // 256 이라 추론이 그걸 다 먹고 본문이 빈 채로 왔고, 아래 parseJsonLoose("") 가 {} 를
    // 돌려주는 바람에 idx 가 항상 0 으로 떨어졌다 — **오류 없이 늘 첫 대사를 훅으로 고르는**
    // 조용한 오답이었다(2026-08-20). 빈 응답을 오답으로 삼키지 않게 아래에서 막는다.
    const res = await geminiGenerate(prompt, { temperature: 0.5, maxOutputTokens: 256, thinking: false });
    if (!res.text.trim()) {
      console.error(`[regenerate-hook] 빈 응답 — finishReason=${res.finishReason ?? "?"}`);
      return c.json({
        error: "empty_response",
        message: "훅을 고르지 못했습니다 — 잠시 후 다시 시도해 주세요.",
      }, 502);
    }
    const parsed = parseJsonLoose(res.text) as Record<string, unknown>;
    let idx = Number(parsed.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= caps.length) idx = 0;
    const chosen = caps[idx];
    const hookTimeSec = Math.max(0, Math.round((chosen.at - start) * 100) / 100);
    const hookQuote = chosen.text.slice(0, 60);
    const hookIntroCaption = String(parsed.caption ?? "").trim().slice(0, 30) || hookQuote.slice(0, 20);
    await putEntity("clip", clipId, { ...clip, hookTimeSec, hookQuote, hookIntroCaption });
    return c.json({ ok: true, hookTimeSec, hookQuote, hookIntroCaption });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[regenerate-hook] 실패:", msg);
    return c.json({ error: "generation_failed", message: msg.slice(0, 300) }, 502);
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

  const reframe = effectiveReframeState(clip);
  let reframePlan: ReframePlan | null = null;
  if (reframe.mode === "ai_multi") {
    if (reframe.status !== "ready" || !reframe.plan || !reframe.planHash) {
      return c.json({
        error: "reframe_not_ready",
        code: "reframe_not_ready",
        message: reframe.status === "stale"
          ? "클립 구간이 바뀌어 AI 리프레임을 다시 분석해야 합니다."
          : "AI 리프레임 분석이 완료된 뒤 내보낼 수 있습니다.",
        reframe,
      }, 409);
    }
    try {
      reframePlan = normalizeReframePlan(reframe.plan, { start, end });
      if (reframePlanHash(reframePlan) !== reframe.planHash) {
        throw new Error("AI reframe plan hash does not match its validated content");
      }
    } catch (error) {
      return c.json({
        error: "reframe_plan_invalid",
        code: "reframe_plan_invalid",
        message: error instanceof Error ? error.message : String(error),
        reframe,
      }, 409);
    }
  }

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
  // 산수는 channel-rules.ts 의 순수 함수 하나(capRenderWindow)로 모았다 — 라우트 안에 있으면
  // DB 없이 부를 수가 없어 이 캡을 검증하는 테스트가 한 줄도 없었다(2026-08-25 사고의 배경).
  const spd = uniformSpeed(es);
  const cap = capRenderWindow(preset?.maxSec, renderStart, renderEnd, spd);
  const capped = cap.capped;
  renderEnd = cap.renderEnd;

  const allMedia = await listMedia();
  const master =
    (clip.sourceMediaId ? allMedia.find((m) => m.id === clip.sourceMediaId) : undefined) ??
    allMedia.find((m) => m.episodeId === clip.episodeId && m.role === "master");
  if (!master || !hasFfmpeg()) {
    return c.json({ error: "no master video or ffmpeg unavailable to render" }, 409);
  }

  // Aspect precedence: an explicit operator choice in the editor wins (they saw the frame and
  // decided); otherwise the destination preset; otherwise the clip's own adopted ratio. The
  // last step is what keeps a 16:9 highlight that was never opened in the editor out of a
  // 9:16 blur frame.
  // An AI Fill/Fit plan is defined in a vertical Shorts canvas. Do not trust a new web
  // client to have already changed editorState.aspect: old saved states and direct API
  // callers can still say 16:9, which would turn the dynamic plan into a landscape render.
  const aspect = reframePlan
    ? "9:16"
    : normalizeAspect(es?.aspect) ?? preset?.aspect ?? normalizeAspect(clip.aspectRatio) ?? "9:16";

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

  // The cache key describes the bytes actually rendered, not only the adopted outer range.
  // Destination caps, editor trim, word snapping and frame snapping all change these bounds.
  // Keep this after snapping; otherwise a cached basic render can be returned for a newly
  // generated AI plan (or a different snapped window) without running the dynamic renderer.
  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      sourceStart: start,
      sourceEnd: end,
      renderStart: snappedStart,
      renderEnd: snappedEnd,
      renderAspect: aspect,
      editorState: clip.editorState ?? null,
      captionsFp,
      preset: preset?.key ?? null,
      hookPreroll: hookPrerollReq
        ? { t: clip.hookTimeSec,
            // 내레이션 토글·문구가 바뀌면 결과물이 달라진다 — revision 에 넣어 캐시를 깬다.
            tts: (clip.editorState as any)?.hookTtsOn !== false,
            line: String((clip.editorState as any)?.hookCaption || clip.hookIntroCaption || clip.titleLine1 || clip.title || "") }
        : null,
      reframe: reframePlan
        ? { mode: "ai_multi", inputFingerprint: reframe.inputFingerprint, planHash: reframe.planHash }
        : { mode: "basic" },
    }))
    .digest("hex")
    .slice(0, 16);

  // Cache hit: identical effective decisions already rendered — don't re-encode.
  if (clip.rendered && clip.renderRevision === revision && clip.mediaId) {
    return c.json({ clipId, clip, cached: true, preset: preset?.key ?? null, capped, hookPreroll: hookPrerollReq });
  }

  // Spoken subtitles that fall inside the render window, rebased to 0.
  const captions = windowCaptions(transcript, snappedStart, snappedEnd);

  // 첫 3초 hook 프리롤 구간 계산 — hook 대사 절대 시각(= clip.startTime + hookTimeSec)에서 최대 3초.
  // 세그먼트([snappedStart, snappedEnd]) 안으로 클램프하고, 세그먼트가 3초보다 짧으면 그만큼 줄인다.
  // hookTimeSec 은 clip.startTime(=start) 기준 상대이므로 절대 = start + hookTimeSec.
  let hookPreroll:
    { startTime: number; durationSec: number; hasAudio?: boolean; caption?: string; ttsPath?: string | null } | null = null;
  if (hookPrerollReq) {
    const HOOK_MAX = 3.0;
    const hookAbs = start + Math.max(0, Number(clip.hookTimeSec));
    const preStart = Math.min(Math.max(snappedStart, hookAbs), Math.max(snappedStart, snappedEnd - 0.5));
    const preDur = Math.min(HOOK_MAX, Math.max(0.5, snappedEnd - preStart));
    if (preDur >= 0.5) {
      // 훅 문구 — **화면 자막 + TTS 내레이션이 함께 읽는 한 줄**. 편집자가 고친 hookCaption
      // (editorState) 우선, 없으면 어그로 카피(hookIntroCaption → 제목 첫 줄 → 제목).
      // 훅 구간의 실제 대사(hookQuote)는 그 자리에서 이미 들리므로 읽지 않는다 — 같은 말을
      // 두 번 하면 3초가 낭비된다. TTS 는 기본 ON(hookTtsOn:false 로 끔) · 합성 실패는 null 이라
      // 자막·프리롤은 그대로 나간다(TTS 만 생략).
      const wantTts = (clip.editorState as any)?.hookTtsOn !== false;
      const line = String(
        (clip.editorState as any)?.hookCaption || clip.hookIntroCaption || clip.titleLine1 || clip.title || "",
      ).trim();
      const ttsPath = wantTts && line ? await synthesizeHookNarration(line) : null;
      hookPreroll = {
        startTime: preStart, durationSec: Number(preDur.toFixed(3)),
        hasAudio: master.hasAudio === 1,
        ...(line ? { caption: line } : {}),
        ...(ttsPath ? { ttsPath } : {}),
      };
    }
  }

  const rendered = await renderClipMedia({
    master, episodeId: clip.episodeId,
    startTime: snappedStart, endTime: snappedEnd,
    title: clip.title, editorState: es, aspect, captions,
    hookPreroll,
    reframePlan,
  });
  if (!rendered) return c.json({ error: "render failed" }, 500);

  // Merge onto the LATEST row, not the pre-render snapshot: the render takes up to minutes,
  // and an editor save (PATCH /:id/editor) landing meanwhile must survive this write. If the
  // editorState did change, `revision` no longer matches it, so the cache check correctly
  // re-renders on the next export.
  const latest = (await getEntity<any>("clip", clipId)) ?? clip;
  const renderedAspectRatio = canonicalRenderedClipAspect(aspect, latest.aspectRatio);
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
    // Downstream `/media` short classification and publish guards read this field. Store
    // the aspect of the latest successful render in both directions: AI makes it vertical,
    // while a later basic 16:9 render must stop being classified as the older AI Short.
    ...(renderedAspectRatio ? { aspectRatio: renderedAspectRatio } : {}),
  };
  await putEntity("clip", clipId, next);
  return c.json({ clipId, clip: next, preset: preset?.key ?? null, capped, hookPreroll: !!hookPreroll });
});

// ── 정적 오버레이 PNG (에디터 WYSIWYG) ─────────────────────────────────────────
//
// 에디터가 제목·채널 텍스트를 CSS 로 근사하는 대신 **서버가 그린 실제 PNG** 를 `<img>` 로
// 보여주게 하는 엔드포인트(AENA 방식). content-hash 캐시 — 같은 입력이면 같은 hash 라
// debounce 재요청이 파일을 재생성하지 않는다. 렌더(renderClipMedia)와 **같은
// buildStaticOverlayItems** 를 써서 편집 화면과 결과물의 정적 오버레이가 구조적으로 일치한다.
//
// ⚠️ /tmp 는 Cloud Run 에서 tmpfs(RAM) 다 — 캐시가 무한히 쌓이면 OOM. 쓰기 전에 60분 지난
//    파일을 정리한다(best-effort). PNG 는 작고(투명·수십 KB) 에디터가 같은 hash 를 재사용한다.
const OVERLAY_CACHE_DIR = path.resolve("/tmp/stepd-overlay-cache");
function pruneOverlayCache(maxAgeMs = 60 * 60_000): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(OVERLAY_CACHE_DIR)) {
      const p = path.join(OVERLAY_CACHE_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* 경합 삭제 무시 */ }
    }
  } catch { /* 디렉토리 없음 등 무시 */ }
}

/**
 * 최종 렌더와 같은 우선순위로 채널 아이콘을 풀고, 실제 합성 크기를 구한다.
 * 이 폭이 channelBadgeLayout의 텍스트 x를 결정하므로 "아이콘은 비슷한데
 * 채널명만 밀림" 문제를 막으려면 미리보기가 최종과 같은 박스를 봐야 한다.
 */
async function previewChannelIconBox(
  es: any,
  clip: any,
  scale: number,
): Promise<{ w: number; h: number } | null> {
  if (!es?.showChannel || es?.channelIconOff || !clip?.episodeId) return null;
  let iconSrc = String(es?.channelIconDataUrl ?? "");
  if (!/^data:image\//i.test(iconSrc)) {
    const ep = await getEntity<Record<string, unknown>>("episode", String(clip.episodeId)).catch(() => null);
    const prog = ep?.programId
      ? await getEntity<Record<string, unknown>>("program", String(ep.programId)).catch(() => null)
      : null;
    iconSrc = String(prog?.brandIconDataUrl ?? "");
  }
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(iconSrc);
  if (!m) return null;
  const iconH = Math.round(Number(es?.channelIconSize) > 0 ? Number(es.channelIconSize) : 40 * scale);
  if (String(es?.channelIconShape ?? "circle") === "circle") return { w: iconH, h: iconH };
  const dim = await measureOverlayImage(Buffer.from(m[1], "base64"));
  const iconW = dim?.width && dim?.height
    ? Math.max(1, Math.round(iconH * (dim.width / dim.height)))
    : iconH;
  return { w: iconW, h: iconH };
}

/** 에디터 미리보기용 정적 오버레이 아이템 — 최종 렌더와 같은 iconBox를 쓴다. */
async function overlayPreviewItems(
  es: any,
  aspect: string,
  clip: any,
  layer?: "title" | "channel",
): Promise<{ W: number; H: number; items: OverlayTextItem[] }> {
  const { W, H, stageH } = renderDims(aspect);
  // 크기를 출력 px 로 정규화(웹이 coordBasis:"output" 로 보내면 no-op · DB 옛 상태면 여기서 올린다).
  es = normalizeEditorCoords(es, aspect);
  const scale = constScale(H, stageH);
  // 제목만 바꾸는 타이핑 요청에서는 회차·프로그램 조인과 이미지 디코딩을 하지 않는다.
  const iconBox = layer === "title" ? null : await previewChannelIconBox(es, clip, scale);
  return { W, H, items: buildStaticOverlayItems(es, W, H, scale, iconBox) };
}

app.post("/api/clips/:id/overlay-png", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const body = await c.req.json<{ editorState?: any; aspect?: string; layer?: "title" | "channel" }>().catch(() => ({} as any));
  const es = body.editorState ?? clip.editorState ?? {};
  const aspect = String(body.aspect ?? es?.aspect ?? clip.aspectRatio ?? "9:16");
  const preview = await overlayPreviewItems(es, aspect, clip, body.layer);
  const { W, H } = preview;
  // 제목과 채널을 별도 PNG로 요청하면 편집기가 현재 조작 중인 레이어만
  // 즉시 이동시킬 수 있다. layer 미지정은 기존 통합 PNG(최종 렌더와 동일)를 유지한다.
  const items = body.layer
    ? preview.items.filter((item) => item.group === body.layer)
    : preview.items;
  // 그릴 정적 오버레이가 없으면 hash:null — 에디터는 순수 CSS 로 남는다(무회귀).
  if (!items.length) return c.json({ hash: null, width: W, height: H });
  if (!(await overlayCanvasAvailable())) return c.json({ hash: null, width: W, height: H, canvas: false });

  const hash = crypto.createHash("sha1").update(JSON.stringify({ W, H, items })).digest("hex");
  fs.mkdirSync(OVERLAY_CACHE_DIR, { recursive: true });
  const pngPath = path.join(OVERLAY_CACHE_DIR, `${hash}.png`);
  if (!fs.existsSync(pngPath)) {
    pruneOverlayCache();
    const buf = await renderTextLayerPng({ width: W, height: H, items });
    if (!buf) return c.json({ hash: null, width: W, height: H, canvas: false });
    fs.writeFileSync(pngPath, buf);
  }
  return c.json({ hash, width: W, height: H, url: `/api/clips/${clipId}/overlay-png/${hash}` });
});

app.get("/api/clips/:id/overlay-png/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]{40}$/.test(hash)) return c.json({ error: "bad hash" }, 400);
  const pngPath = path.join(OVERLAY_CACHE_DIR, `${hash}.png`);
  if (!fs.existsSync(pngPath)) return c.json({ error: "not found" }, 404);
  const buf = fs.readFileSync(pngPath);
  // 해시가 내용 지문이라 영구 캐시 가능 — 내용이 바뀌면 hash 가 바뀐다(immutable).
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
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
export type ConsentMode = "analytics" | "publish" | "all";

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

// 계정 연결(단일 버튼) — 분석·수익 + 배포 스코프를 **한 번의 동의**로 받는다. 중복 스코프 제거.
const YT_ALL_SCOPES = [...new Set(`${YT_ANALYTICS_SCOPES} ${YT_PUBLISH_SCOPES}`.split(" "))].join(" ");

function scopesFor(mode: ConsentMode): string {
  return mode === "all" ? YT_ALL_SCOPES
    : mode === "publish" ? YT_PUBLISH_SCOPES
    : YT_ANALYTICS_SCOPES;
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

/**
 * OAuth 콜백 공통 껍데기 — state 를 검증하고 **발급 시점 워크스페이스로 컨텍스트를 고정**한다.
 *
 * 두 가지를 동시에 막는다.
 *  1. 남이 만든 콜백 URL (공격자 계정이 운영자 워크스페이스에 붙던 경로) — 우리가 발급한
 *     1회용 난수가 아니면 여기서 끝난다.
 *  2. 엉뚱한 워크스페이스 귀속 — 콜백은 **남의 브라우저에서 열릴 수 있다**(외부 채널 연결
 *     링크는 채널 주인이 연다). 쿠키를 믿으면 계정이 링크 발급자가 아닌 사람에게 붙는다.
 */
function oauthStateGuard(
  errorParam: string,
  fallbackReturn: string,
  handler: (c: Context, st: Record<string, any>) => Promise<any>,
) {
  return async (c: Context) => {
    const st = await consumeOAuthState(c.req.query("state"));
    if (!st.ok) {
      // 만료·위조·사용자 거부를 구분해서 알린다 — "다시 시도" 와 "새 링크를 요청" 은
      // 사용자가 해야 할 일이 다르다.
      const why = c.req.query("error") ? "access_denied"
        : st.reason === "expired" ? "state_expired" : "invalid_state";
      return c.redirect(`${fallbackReturn}?${errorParam}=${why}`);
    }
    const run = () => handler(c, st.data);
    return st.tenant ? runWithTenant({ scope: st.tenant, via: "web" }, run) : run();
  };
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

app.get("/api/youtube/auth", async (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
  const channelUrl = c.req.query("channel") ?? "";
  const mode: ConsentMode = c.req.query("mode") === "publish" ? "publish"
    : c.req.query("mode") === "all" ? "all" : "analytics";
  const returnTo = safeReturn(c.req.query("return"));
  const state = await issueOAuthState({ channel: channelUrl, mode, return: returnTo });
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
  // 이 링크는 **채널 주인에게 전달돼 며칠 뒤에 열린다** — 화면 즉시 연결과 같은 30분 TTL 을
  // 쓰면 동의를 다 마친 뒤에 튕긴다.
  const state = await issueOAuthState({
    channel: b?.channelUrl ?? "", mode: "publish", return: "/register",
    ...(extReturn ? { extReturn } : {}),
  }, HANDOFF_TTL_MS);
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

  // 잔액 없는 워크스페이스의 등록은 받지 않는다 — 다운로드·분석이 곧 원가다.
  // 러닝타임을 아직 모르므로 여기서는 0 판정만 하고, 정밀 게이트는 분석 직전에 선다.
  if ((await creditBalance()) <= 0) {
    return c.json({ error: "insufficient_credits", message: "크레딧 잔액이 없습니다. 충전 후 다시 시도해 주세요." }, 402);
  }

  // 같은 영상을 두 번 넣지 않는다 — 분석은 회당 ₩600 대다.
  // media 저장 경로 필드는 `path` — storedPath 는 존재하지 않는다 (factory.ts 와 같은 버그였음)
  const dup = (await listMedia()).find((m: any) => m.path === `youtube:${url}`);
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

const oauthCallback = oauthStateGuard("error", "/register", async (c, st: OAuthState) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
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
});

// The path registered in GCP. The bare /callback is kept so links already sent out
// (and the legacy client config) keep working.
app.get(OAUTH_CALLBACK_PATH, oauthCallback);
app.get("/api/youtube/callback", oauthCallback);

// ── Meta (Facebook Pages) OAuth ───────────────────────────────────────────────
// Facebook Page owner grants us their Pages. 1 DB row per Page, long-lived Page token.
// Instagram 은 여기서 다루지 않는다 — 2026-08-13 부터 별도 "Instagram API with
// Instagram Login" 흐름(/api/instagram/*)으로 분리했다. Facebook 로그인 방식은
// Page 에 IG 를 연결해 두는 전제가 필요해서, IG 는 IG 계정으로 직접 붙는 게 낫다.
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

app.get("/api/meta/auth", async (c) => {
  if (!META_APP_ID) return c.json({ error: "META_APP_ID not configured" }, 500);
  const returnTo = safeReturn(c.req.query("return"));
  const rerequest = c.req.query("rerequest") === "1";
  const state = await issueOAuthState({ return: returnTo });
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

const metaOauthCallback = oauthStateGuard("meta_error", "/publish-channels", async (c, st) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const returnTo = safeReturn(st.return);

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

    // 3. /me/accounts — Pages (Page tokens here are long-lived).
    //    instagram_business_account 필드는 더 이상 묻지 않는다 — instagram_basic 권한이
    //    scope 에서 빠졌으므로 요청하면 통째로 에러가 난다. IG 는 /api/instagram/* 로 붙는다.
    const accountsParams = new URLSearchParams({
      access_token: userToken,
      fields: "id,name,access_token,picture{data{url}}",
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
        // 재연결 upsert 가 옛 행의 IG 컬럼도 비운다 — 의도된 동작이다(분리 이후 이 흐름에
        // IG 가 남아 있으면 배포 규칙이 죽은 ID 를 계속 가리킨다).
        igUserId: null,
        igUsername: null,
        igProfilePictureUrl: null,
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
});
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

/** 연동해제 — 행은 남기고 토큰만 비운다. Meta 는 토큰 무효화 API 를 따로 부르지 않는다. */
app.post("/api/meta/accounts/:publicId/disconnect", async (c) => {
  await disconnectMetaAccount(c.req.param("publicId"));
  return c.json({ ok: true, status: "disconnected" });
});

app.delete("/api/meta/accounts/:publicId", async (c) => {
  const publicId = c.req.param("publicId");
  // 행을 지우기 전에 계정 ID 를 읽어 이 계정을 겨눈 채널 규칙도 지운다 —
  // 남기면 배포 순방이 존재하지 않는 계정을 계속 평가하는 고아 규칙이 된다.
  const acct = (await listMetaAccounts()).find((a) => a.publicId === publicId);
  if (acct) await deleteChannelRulesForAccount("facebook", acct.pageId);
  await deleteMetaAccount(publicId);
  return c.json({ ok: true });
});

// ── Instagram OAuth (Instagram API with Instagram Login) ─────────────────────
// Facebook Page 를 경유하지 않는다 — 운영자가 IG 계정으로 직접 로그인한다(비즈니스 로그인).
// developers.facebook.com > 앱 > Instagram > API setup with Instagram login 의
// "비즈니스 로그인 설정" 에 redirect URI 를 등록할 것. 앱 ID·시크릿도 **그 화면의
// Instagram 앱 ID/시크릿**이다 — Meta 앱 ID(META_APP_ID)와 다르다.
// 토큰: short-lived(1h) → long-lived(~60일). refresh 토큰이 따로 없고 같은 토큰을
// 24시간 이후~만료 전에 ig_refresh_token 으로 연장한다. 만료를 넘기면 재연결뿐.
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID ?? "";
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET ?? "";
const IG_OAUTH_DIALOG = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_BASE = "https://graph.instagram.com";
const IG_CALLBACK_PATH = "/api/instagram/oauth/callback";
// 콘솔에서 허용해 둔 권한만 요청한다 — 미허용 scope 가 섞이면 동의 화면에서 통째로 거부된다.
const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"].join(",");

function instagramRedirectUri(): string {
  const explicit = process.env.INSTAGRAM_REDIRECT_URI;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    return `https://stepd.stepai.kr/api/proxy${IG_CALLBACK_PATH}`;
  }
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${IG_CALLBACK_PATH}`;
}

app.get("/api/instagram/auth", async (c) => {
  if (!INSTAGRAM_APP_ID) return c.json({ error: "INSTAGRAM_APP_ID not configured" }, 500);
  const returnTo = safeReturn(c.req.query("return"));
  const state = await issueOAuthState({ return: returnTo });
  const params = new URLSearchParams({
    client_id: INSTAGRAM_APP_ID,
    redirect_uri: instagramRedirectUri(),
    response_type: "code",
    scope: IG_SCOPES,
    state,
  });
  return c.redirect(`${IG_OAUTH_DIALOG}?${params}`);
});

/**
 * 에러 문구에 섞여 들어온 액세스 토큰 값을 가린다 — 토큰 응답을 그대로 err.message 에
 * 담는 경로(unexpected token response 등)가 있어, 로그에 남기기 전에 반드시 거친다.
 */
function maskIgTokens(s: string): string {
  return s
    .replace(/("access_token"\s*:\s*")[^"]+(")/g, "$1***$2")
    .replace(/(access_token=)[^&\s"']+/g, "$1***");
}

const instagramOauthCallback = oauthStateGuard("ig_error", "/publish-channels", async (c, st) => {
  // Instagram 은 리다이렉트에 `#_` 를 붙여 보낸다 — code 끝에 딸려오면 교환이 실패한다.
  const code = c.req.query("code")?.replace(/#_$/, "");
  const error = c.req.query("error");
  const returnTo = safeReturn(st.return);

  if (error) return c.redirect(`${returnTo}?ig_error=access_denied`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
    return c.json({ error: "Instagram OAuth not configured" }, 500);
  }

  try {
    // 1. code → short-lived token (form POST — 쿼리스트링이 아니다)
    const tokenRes = await fetch(IG_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: instagramRedirectUri(),
        code,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
    // 문서상 flat 객체지만 data:[…] 로 감싸 오는 응답이 관측된 적 있다 — 둘 다 받는다.
    const tokenBody = (await tokenRes.json()) as any;
    const tok = Array.isArray(tokenBody?.data) ? tokenBody.data[0] : tokenBody;
    const shortToken: string | undefined = tok?.access_token;
    const igUserId = tok?.user_id != null ? String(tok.user_id) : "";
    if (!shortToken || !igUserId) {
      throw new Error(`unexpected token response: ${JSON.stringify(tokenBody).slice(0, 300)}`);
    }

    // 2. short-lived → long-lived (~60일)
    const exchangeParams = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: INSTAGRAM_APP_SECRET,
      access_token: shortToken,
    });
    const longRes = await fetch(`${IG_GRAPH_BASE}/access_token?${exchangeParams}`);
    if (!longRes.ok) throw new Error(`long-lived exchange failed: ${await longRes.text()}`);
    const longData = (await longRes.json()) as { access_token: string; expires_in?: number };
    const expiresAt = Date.now() + (longData.expires_in ?? 60 * 24 * 3600) * 1000;

    // 3. 프로필 — 카드에 보여줄 최소 정보
    const meParams = new URLSearchParams({
      fields: "user_id,username,name,profile_picture_url",
      access_token: longData.access_token,
    });
    const meRes = await fetch(`${IG_GRAPH_BASE}/v21.0/me?${meParams}`);
    if (!meRes.ok) throw new Error(`/me failed: ${await meRes.text()}`);
    const me = (await meRes.json()) as {
      user_id?: string | number; username?: string; name?: string; profile_picture_url?: string;
    };

    const account: InstagramAccount = {
      publicId: crypto.randomUUID(),
      igUserId,
      username: me.username ?? igUserId,
      name: me.name ?? null,
      profilePictureUrl: me.profile_picture_url ?? null,
      accessToken: longData.access_token,
      expiresAt,
      permissions: typeof tok?.permissions === "string"
        ? tok.permissions
        : Array.isArray(tok?.permissions) ? tok.permissions.join(",") : "",
      status: "active",
      connectedAt: Date.now(),
    };
    // upsert by igUserId — publicId only used on first insert
    await upsertInstagramAccount(account);

    return c.redirect(`${returnTo}?ig_success=1&ig_name=${encodeURIComponent(account.username)}`);
  } catch (err: any) {
    // err.message 에 토큰 응답 본문(access_token)이 실릴 수 있다 — 쿼리에 넣으면
    // 브라우저 히스토리·프록시·접근 로그로 샌다. 리다이렉트에는 일반 문구만 싣고,
    // 서버 로그에도 토큰 값은 마스킹해 남긴다.
    console.error("[instagram/oauth]", maskIgTokens(String(err?.message ?? err)));
    return c.redirect(`${returnTo}?ig_error=${encodeURIComponent("연결에 실패했습니다 — 다시 시도해 주세요.")}`);
  }
});
app.get(IG_CALLBACK_PATH, instagramOauthCallback);

app.get("/api/instagram/accounts", async (c) => {
  const accounts = await listInstagramAccounts();
  return c.json({
    accounts: accounts.map((a) => ({
      publicId: a.publicId,
      igUserId: a.igUserId,
      username: a.username,
      name: a.name,
      profilePictureUrl: a.profilePictureUrl,
      // 토큰은 내보내지 않는다. 만료는 화면이 "재연결 필요" 를 미리 보여줄 수 있게 준다.
      expiresAt: a.expiresAt,
      status: a.status,
      connectedAt: a.connectedAt,
    })),
  });
});

/** 연동해제 — 행은 남기고 토큰만 비운다 (meta/tiktok 과 같은 의미). */
app.post("/api/instagram/accounts/:publicId/disconnect", async (c) => {
  await disconnectInstagramAccount(c.req.param("publicId"));
  return c.json({ ok: true, status: "disconnected" });
});

app.delete("/api/instagram/accounts/:publicId", async (c) => {
  const publicId = c.req.param("publicId");
  // 계정을 지우면 그 계정을 겨눈 채널 규칙도 같이 — 고아 규칙 방지 (meta 삭제와 동일).
  const acct = (await listInstagramAccounts()).find((a) => a.publicId === publicId);
  if (acct) await deleteChannelRulesForAccount("instagram", acct.igUserId);
  await deleteInstagramAccount(publicId);
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
// 콘솔(Login Kit·Content Posting API → Scopes)에 전부 있어야 한다. 거부되면 콘솔부터.
// - user.info.profile: 채널 핸들(@username)용 (2026-08-13 — 실명만 떠서 채널 구분 불가 피드백)
// - video.upload: 받은함 드래프트 업로드용 (tiktok.ts). **이게 빠진 토큰은 게이트를 켜도
//   inbox init 에서 scope_not_authorized 로 전건 실패한다** — scope 없는 옛 연결은 재연동.
// - video.publish: 다이렉트 게시용 — **TIKTOK_DIRECT_POST 를 켰을 때만** 요청한다.
//   콘솔에 Direct Post 제품 + 심사 승인 전에 섞으면 동의화면이 통째로 깨진다(위와 같은 함정).
const TIKTOK_SCOPES = [
  "user.info.basic", "user.info.profile", "video.upload",
  ...(tiktokDirectPostEnabled() ? ["video.publish"] : []),
].join(",");

function tiktokRedirectUri(): string {
  const explicit = process.env.TIKTOK_REDIRECT_URI;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    return `https://stepd.stepai.kr/api/proxy${TIKTOK_CALLBACK_PATH}`;
  }
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${TIKTOK_CALLBACK_PATH}`;
}

app.get("/api/tiktok/auth", async (c) => {
  if (!TIKTOK_CLIENT_KEY) return c.json({ error: "TIKTOK_CLIENT_KEY not configured" }, 500);
  const returnTo = safeReturn(c.req.query("return"));
  // 예전엔 nonce 를 넣고도 콜백에서 **읽지 않아** 아무것도 막지 못했다. 이제 서버가 들고 있다.
  const state = await issueOAuthState({ return: returnTo });
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    redirect_uri: tiktokRedirectUri(),
    response_type: "code",
    scope: TIKTOK_SCOPES,
    state,
  });
  return c.redirect(`${TIKTOK_AUTH_URL}?${params}`);
});

const tiktokOauthCallback = oauthStateGuard("tiktok_error", "/publish-channels", async (c, st) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const returnTo = safeReturn(st.return);

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

    // 2. /v2/user/info/ — **부여된** scope 로 읽을 수 있는 필드만 요청한다.
    // username 은 user.info.profile 이 부여됐을 때만 — 없이 섞어 보내면 응답 전체가
    // scope_not_authorized 로 실패한다 (일부만 빠지는 게 아니다). 토큰 응답의 scope 가
    // 실제 부여분이므로 그걸 보고 가른다.
    const hasProfileScope = (tokenData.scope ?? "").includes("user.info.profile");
    const fields = hasProfileScope
      ? "open_id,union_id,avatar_url,display_name,username"
      : "open_id,union_id,avatar_url,display_name";
    const userRes = await fetch(
      `${TIKTOK_USER_INFO_URL}?fields=${fields}`,
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

    return c.redirect(`${returnTo}?tiktok_success=1&tiktok_name=${
      encodeURIComponent(account.username ? `@${account.username}` : account.displayName)}`);
  } catch (err: any) {
    console.error("[tiktok/oauth]", err);
    return c.redirect(`${returnTo}?tiktok_error=${encodeURIComponent(err.message ?? "unknown")}`);
  }
});
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

/** 연동해제 — 행은 남기고 토큰만 비운다. */
app.post("/api/tiktok/accounts/:publicId/disconnect", async (c) => {
  await disconnectTikTokAccount(c.req.param("publicId"));
  return c.json({ ok: true, status: "disconnected" });
});

app.delete("/api/tiktok/accounts/:publicId", async (c) => {
  const publicId = c.req.param("publicId");
  // 계정을 지우면 그 계정을 겨눈 채널 규칙도 같이 — 고아 규칙 방지 (meta 삭제와 동일).
  const acct = (await listTikTokAccounts()).find((a) => a.publicId === publicId);
  if (acct) await deleteChannelRulesForAccount("tiktok", acct.openId);
  await deleteTikTokAccount(publicId);
  return c.json({ ok: true });
});

/**
 * 네이버 로그인 도우미(exe) 다운로드 — 편집자가 pnpm 없이 세션을 등록하게 하는 도구.
 * 실물은 GCS `tools/stepd-naver-login.exe` (빌드: apps/server/scripts/naver-login-tool.mts
 * 머리의 bun 명령). 세션 로그인 사용자만 받게 둔다 — 공개 배포물이 아니다.
 */
/**
 * 로그인 도우미(exe) 다운로드.
 *
 * `?account=<naver_account.id>` 를 주면 **파일명에 그 계정 키를 실어** 내려준다
 * (`stepd-naver-login--nva_abc123.exe`). 도우미는 자기 실행파일 이름에서 그 키를 읽어
 * 계정을 자동 선택한다 — 계정이 둘 이상일 때 "어느 계정인가요?" 를 다시 묻지 않는다.
 *
 * ⚠️ 왜 파일명인가: exe 는 URL 파라미터를 못 받는다. 서버에 '로그인 대상' 상태를 따로 두는
 * 방법도 있지만(TTL·테이블·엔드포인트 추가), 파일 자체에 실으면 **받은 파일과 계정이 영구히
 * 묶인다** — 나중에 실행해도, 여러 개를 받아둬도 안 헷갈린다. 브라우저가 중복 이름에 `(1)` 을
 * 붙여도 키는 정규식으로 그대로 읽힌다.
 *
 * 계정 검증은 여기서 한다 — 없는/남의 계정 키가 파일명에 박히면 도우미가 엉뚱한 데 올린다.
 */
app.get("/api/naver/login-tool", async (c) => {
  const obj = "tools/stepd-naver-login.exe";
  if (!useGcs() || !(await fileExists(obj))) {
    return c.json({ error: "tool_not_uploaded", message: "도구가 아직 업로드되지 않았습니다 — 운영팀에 문의하세요." }, 404);
  }
  const accountId = (c.req.query("account") ?? "").trim();
  let name: string | undefined;
  if (accountId) {
    // getNaverAccount 은 RLS 스코프 안에서 도므로, 남의 워크스페이스 계정은 여기서 not_found 다.
    const acct = await getNaverAccount(accountId);
    if (!acct) return c.json({ error: "not_found", message: "계정을 찾을 수 없습니다." }, 404);
    name = `stepd-naver-login--${acct.accountKey}.exe`;
  }
  return c.redirect(await signedReadUrl(obj, 10 * 60_000, name));
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
  const channelId = c.req.param("channelId");
  // 채널을 지우면 그 채널을 겨눈 채널 규칙도 같이 — 고아 규칙 방지 (meta 삭제와 동일).
  await deleteChannelRulesForAccount("youtube", channelId);
  await deleteYouTubeChannel(channelId);
  return c.json({ ok: true });
});

/**
 * 연동해제 — 삭제와 다르다. Google 쪽 토큰을 revoke 하고(실패해도 진행 — 우리 쪽 토큰을
 * 비우는 것이 본질) 행은 남긴다. 애널리틱스 이력이 보존되고, 재연동하면 이어서 쓴다.
 * 토큰이 비면 배포 가능 판정(validateTargets · /api/factory/targets)에서 자동으로 빠진다.
 */
app.post("/api/youtube/channels/:channelId/disconnect", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);

  const token = ch.refreshToken ?? ch.accessToken;
  if (token) {
    // best-effort — 이미 revoke 됐거나 만료면 400 이 오지만, 목적은 우리 쪽 절단이다.
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch(() => null);
  }
  await disconnectYouTubeChannel(channelId);
  return c.json({ ok: true, status: "disconnected" });
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
      // **있다/없다 + 언제** 만 나간다. 세션 값은 어떤 경우에도 응답에 싣지 않는다.
      hasSession: a.sessionUpdatedAt != null,
      sessionUpdatedAt: a.sessionUpdatedAt,
      // 워커 PC 에서 실행할 명령을 그대로 준다 — 운영자가 옮겨 적다 틀리지 않게.
      loginCommand: `pnpm --filter @stepd/server naver:login --account ${a.accountKey}`,
    })),
    // 키가 없으면 세션 업로드가 503 이다. 화면이 "올려도 안 되는 버튼"을 띄우지 않게 미리 알려준다.
    sessionStoreReady: sessionStoreReady(),
  });
});

app.post("/api/naver/accounts", async (c) => {
  requireManager(c);
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
  requireManager(c);
  const id = c.req.param("id");
  const acct = await getNaverAccount(id);
  if (!acct) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{ status?: string; label?: string; target?: string }>().catch(() => null);
  const status = ["active", "session_expired", "disabled"].includes(String(b?.status))
    ? (String(b?.status) as "active" | "session_expired" | "disabled") : undefined;
  const target = ["clip", "tv", "both"].includes(String(b?.target))
    ? (String(b?.target) as "clip" | "tv" | "both") : undefined;
  const label = b?.label?.trim() || undefined;
  if (!status && !target && !label) {
    return c.json({ error: "nothing_to_update", message: "status·label·target 중 하나는 있어야 합니다." }, 400);
  }
  await markNaverAccount(id, { status, label, target });
  const after = await getNaverAccount(id);
  return c.json({ ok: true, id, status: after?.status, label: after?.label, target: after?.target });
});

/**
 * 계정 삭제. 세션도 같은 행이라 함께 사라진다.
 * ⚠️ 워커 PC 에 남은 로컬 세션 파일까지는 못 지운다 — 서버에서 닿지 않는 머신이다.
 */
app.delete("/api/naver/accounts/:id", async (c) => {
  requireManager(c);
  const id = c.req.param("id");
  const acct = await getNaverAccount(id);
  if (!acct) return c.json({ error: "not_found" }, 404);
  await deleteNaverAccount(id);
  return c.json({ ok: true, id });
});

/**
 * 세션 등록 — 운영자가 로그인해서 얻은 storageState 를 올린다.
 *
 * 사용자 관점에서는 **로그인 한 번이면 끝**이다: 계정 추가 → 로그인 → 여기로 세션이 올라오면
 * 워커가 어느 머신에서든 받아 쓴다. 윈도우2 앞에 갈 필요가 없어진다.
 *
 * ⚠️ 세션 쿠키는 그 계정의 전체 권한이다. 반드시 암호화해서 저장하고(NAVER_SESSION_KEY),
 *    키가 없으면 **거부한다** — 평문으로 조용히 저장되는 것보다 못 받는 게 낫다.
 */
app.put("/api/naver/accounts/:id/session", async (c) => {
  // ⚠️ 세션 blob 은 그 계정의 **전체 권한**이다(naver-session-store.ts 헤더 참고).
  //    아이디·비번보다 즉시 쓸 수 있어 더 위험하다 — 관리자만.
  requireManager(c);
  const acct = await getNaverAccount(c.req.param("id"));
  if (!acct) return c.json({ error: "not_found" }, 404);
  if (!sessionStoreReady()) {
    return c.json({
      error: "session_key_missing",
      message: "NAVER_SESSION_KEY 가 설정되지 않아 세션을 저장할 수 없습니다(평문 저장은 하지 않습니다).",
    }, 503);
  }
  const body = await c.req.json<{ storageState?: unknown }>().catch(() => null);
  const state = body?.storageState;
  if (!looksLikeStorageState(state)) {
    return c.json({ error: "invalid_storage_state", message: "cookies 배열이 있는 storageState JSON 이어야 합니다." }, 400);
  }
  await setNaverSessionBlob(acct.id, sealSession(state));
  // 값은 절대 되돌려주지 않는다. 있다/없다만.
  return c.json({ ok: true, id: acct.id, status: "active", sessionUpdatedAt: Date.now() });
});

app.delete("/api/naver/accounts/:id/session", async (c) => {
  requireManager(c);
  const acct = await getNaverAccount(c.req.param("id"));
  if (!acct) return c.json({ error: "not_found" }, 404);
  await clearNaverSessionBlob(acct.id);
  return c.json({ ok: true, id: acct.id, status: "session_expired" });
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
  // 대표 썸네일 = 학습 때 수집한 thumbs/ 원본. refs.json 의 2장이 "그 채널의 전형"이고,
  // 나머지는 수집 목록으로 함께 준다 — 화면이 학습 근거를 보여줄 수 있게.
  let refs: string[] = [];
  if (await fileExists(`${prefix}/refs.json`)) {
    try {
      const r = JSON.parse((await readFile(`${prefix}/refs.json`)).toString("utf-8"));
      if (Array.isArray(r?.refs)) refs = r.refs.map(String);
    } catch { /* refs 없이도 프로파일은 유효하다 */ }
  }
  const thumbs = (await listPrefix(`${prefix}/thumbs`))
    .map((o) => o.split("/").pop() ?? "")
    .filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n))
    .sort();
  return c.json({
    programId, title: data.title ?? "", aggregate: data.aggregate ?? null, prompt,
    refs, thumbs,
  });
});

/** 학습에 쓴 수집 썸네일 이미지 서빙 (위 라우트의 refs·thumbs 파일명을 넣는다). */
app.get("/api/programs/:id/thumbnail-style/thumbs/:name", async (c) => {
  const programId = c.req.param("id");
  const name = c.req.param("name").replace(/[^\w.-]/g, "");
  if (!name) return c.json({ error: "bad_name" }, 400);
  const objectPath = `${stylePrefix(programId)}/thumbs/${name}`;
  if (!(await fileExists(objectPath))) return c.json({ error: "not_found" }, 404);
  const buf = await readFile(objectPath);
  const ext = name.split(".").pop()?.toLowerCase() ?? "jpg";
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return new Response(buf, {
    headers: { "content-type": mime, "cache-control": "public, max-age=600" },
  });
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
  const body = await c.req
    .json<{ programId?: string; candidates?: number; mode?: string; caption?: string }>()
    .catch(() => null);
  const media = await getMedia(mediaId);
  if (!media) return c.json({ error: "media_not_found" }, 404);

  const programId = (body?.programId ?? (media as any).programId ?? "").trim();
  if (!programId) {
    return c.json({ error: "bad_request", message: "programId 가 필요합니다." }, 400);
  }
  const program = await getEntity<any>("program", programId);

  // 두 방식(사용자 확정 2026-08-16):
  //   ai    — 서사 기획 + 등록 인물 누끼로 모델이 그린다. 잘 나오지만 **인물 등록이 선행**.
  //   frame — 실제 영상 프레임 + 자막. 인물 등록이 필요 없고 얼굴이 원본 그대로다.
  const mode = body?.mode === "frame" ? "frame" : "ai";
  const jobId = await enqueue("thumbnail.generate", {
    mediaId, programId, title: program?.title ?? "",
    candidates: body?.candidates ?? 3,
    mode,
    ...(body?.caption ? { caption: String(body.caption).slice(0, 40) } : {}),
    // 방식이 다르면 산출물도 다르다 — 같은 회차라도 서로를 막지 않게 dedupe 키를 가른다.
  }, { dedupeKey: `thumbnail.generate:${mediaId}:${mode}` });
  return c.json({ ok: true, jobId, mode });
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
// **외부 서버가 부른다.** 인증은 테넌트 API 키(`Authorization: Bearer stepd_live_…`)가
// 전담한다 — resolveTenant 미들웨어가 키를 검증하고 테넌트 스코프(RLS)까지 세우므로,
// 이 라우트들에는 자체 인증이 없다. 구 x-factory-key(글로벌 단일 키)는 폐기했다:
// 테넌트 정체성이 없어 과금·격리가 불가능했고, 다테넌트 자세(AUTH_REQUIRED)에서는
// 미들웨어 단계에서 이미 401 이라 구조적으로 죽은 경로였다.

/** 브라우저에서 직접 부르는 경우 대비. 서버간 호출이면 안 쓰인다. */
const FACTORY_ALLOWED_ORIGIN = process.env.FACTORY_ALLOWED_ORIGIN ?? "";
app.options("/api/factory/*", (c) => {
  if (!FACTORY_ALLOWED_ORIGIN) return c.body(null, 204);
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": FACTORY_ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "content-type,authorization",
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
  // 잔액 0 이면 접수 자체를 거절한다 (402). 정밀 판정(길이 기반)은 공장이 분석을
  // 태우기 직전에 한 번 더 한다 — factory.ts advance() 의 creditBlocked.
  if ((await creditBalance()) <= 0) {
    return c.json({ error: "insufficient_credits", message: "크레딧 잔액이 없습니다. 충전 후 다시 시도해 주세요." }, 402);
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
  const channels = await listYouTubeChannels();
  return c.json({
    targets: channels.map((ch) => {
      const live = ch.status === "active" && Boolean(ch.refreshToken);
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
    sourceUrl: (media as any).path ?? mediaId,
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

/**
 * 이 워크스페이스의 공장 실행 목록.
 *
 * 없으면 **붙이는 쪽이 자기가 넣은 jobId 를 스스로 보관하고 있을 때만** 상태를 볼 수 있다.
 * 그래서 사람이 우리 웹에서 돌린 회차는 고객사 화면에 영영 안 나타난다 — "우리 시스템에서
 * 돌아가는 걸 고객사 화면으로 본다" 는 구도가 목록 하나가 없어서 성립하지 않았다.
 * (스모크 2026-08-12 미해결 #3 · aena 자동배포 화면용)
 *
 * **id 가 아니라 이름을 함께 준다.** 붙이는 쪽 화면에 `p_3f2a` 를 띄우면 실무자는 그게 어느
 * 프로그램인지 모른다. 프로그램명·회차명·채널명을 여기서 풀어서 내려보낸다.
 *
 * RLS 로 테넌트가 이미 스코프되므로 남의 잡은 애초에 조회되지 않는다.
 */
app.get("/api/factory/jobs", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
  // active = 아직 돌고 있는 것만, terminal = 끝난 것만, all = 전부(기본).
  const filter = String(c.req.query("state") ?? "all");

  const all = (await listEntities<any>("factoryJob"))
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  const filtered = all.filter((j) => {
    const done = TERMINAL_STATES.includes(j.state);
    return filter === "active" ? !done : filter === "terminal" ? done : true;
  });
  const page = filtered.slice(0, limit);

  // 이름 풀이는 **페이지 안의 것만** 조회한다 — 전량 조회하면 잡이 쌓일수록 느려진다.
  const channels = await listYouTubeChannels();
  const channelName = (id: string) =>
    channels.find((ch: any) => ch.channelId === id)?.channelName ?? null;

  const programIds = [...new Set(page.map((j) => j.programId).filter(Boolean))];
  const programs = new Map(await Promise.all(programIds.map(async (id: string) =>
    [id, await getEntity<any>("program", id).catch(() => null)] as const)));
  const episodeIds = [...new Set(page.map((j) => j.episodeId).filter(Boolean))];
  const episodes = new Map(await Promise.all(episodeIds.map(async (id: string) =>
    [id, await getEntity<any>("episode", id).catch(() => null)] as const)));

  const jobs = await Promise.all(page.map(async (job) => {
    const clips = (await Promise.all((job.clipIds ?? [])
      .map((id: string) => getEntity<any>("clip", id)))).filter(Boolean);
    // /jobs/:id 와 **같은 규칙으로 센다** — 두 응답의 숫자가 갈라지면 어느 쪽이 맞는지 알 수 없다.
    // 살아있는 clip 이 아니라 **clipIds 를 돈다**: 행이 사라진 클립도 "게시 안 됨"으로 세야
    // published + failed = clips 가 성립하고, 사라진 것이 조용히 빠지지 않는다.
    const counts = (job.clipIds ?? []).reduce(
      (acc: { clips: number; published: number; failed: number }, id: string) => {
        const cl = clips.find((x: any) => x?.id === id);
        const rows = (cl?.distributions ?? []).filter((d: any) => d.channel === "youtube");
        acc.clips += 1;
        if (rows.some((d: any) => d.status === "published" || d.status === "scheduled" || d.externalId)) acc.published += 1;
        else acc.failed += 1;
        return acc;
      }, { clips: 0, published: 0, failed: 0 });

    const ep = job.episodeId ? episodes.get(job.episodeId) : null;
    return {
      jobId: job.id,
      status: job.state,
      terminal: TERMINAL_STATES.includes(job.state),
      dryRun: Boolean(job.policy?.dryRun),
      programId: job.programId,
      programTitle: programs.get(job.programId)?.title ?? null,
      mediaId: job.mediaId ?? null,
      episodeId: job.episodeId ?? null,
      episodeTitle: (ep as any)?.title ?? null,
      targets: (job.targets ?? []).map((t: string) => {
        const channelId = t.startsWith("youtube:") ? t.slice("youtube:".length) : null;
        return { target: t, channelId, channelName: channelId ? channelName(channelId) : null };
      }),
      counts,
      stalledForMs: Math.max(0, Date.now() - Number(job.updatedAt ?? Date.now())),
      note: job.note ?? null,
      error: job.error ?? null,
      clips: clips.map((cl: any) => ({
        clipId: cl.id,
        title: cl.title ?? null,
        durationSec: cl.durationSec ?? null,
        rendered: Boolean(cl.rendered),
        distributions: (cl.distributions ?? []).map((d: any) => ({
          channel: d.channel, status: d.status, externalId: d.externalId ?? null,
        })),
      })),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }));

  return c.json({ jobs, total: filtered.length, limit, state: filter });
});

/** 폴링용 상태 조회. 웹훅은 후순위 — 내부 소비자라 폴링으로 시작한다. */
app.get("/api/factory/jobs/:id", async (c) => {
  const job = await getEntity<any>("factoryJob", c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);

  const clips = await Promise.all(
    (job.clipIds ?? []).map((id: string) => getEntity<any>("clip", id)));
  // 호출자가 폴링을 멈춰도 되는지, 몇 건이 실제로 나갔는지를 **응답만 보고** 알 수 있어야
  // 한다. 예전엔 status 만 있었고 그 status 는 업로드가 전멸해도 done 이었다.
  const counts = (job.clipIds ?? []).reduce(
    (acc: { clips: number; published: number; failed: number }, id: string) => {
      const cl = clips.find((x: any) => x?.id === id);
      const rows = (cl?.distributions ?? []).filter((d: any) => d.channel === "youtube");
      acc.clips += 1;
      if (rows.some((d: any) => d.status === "published" || d.status === "scheduled" || d.externalId)) acc.published += 1;
      else acc.failed += 1;
      return acc;
    }, { clips: 0, published: 0, failed: 0 });
  return c.json({
    jobId: job.id,
    status: job.state,
    /** 더 기다릴 필요가 없는 상태인가 — 폴링 종료 판단을 문자열 비교에 맡기지 않게. */
    terminal: TERMINAL_STATES.includes(job.state),
    counts,
    /** 이 상태로 머문 시간(ms) — 정체를 호출자도 볼 수 있게. */
    stalledForMs: Math.max(0, Date.now() - Number(job.updatedAt ?? Date.now())),
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

/**
 * 실패·보류된 공장 잡 재시도.
 *
 * 없으면 transient 실패(다운로드 한 번 실패·토큰 갱신 실패·일일 상한) 하나가 그 회차를
 * **영구 사망**시킨다. 같은 idempotencyKey 로 다시 부르면 실패한 잡을 그대로 202 로
 * 돌려주므로 재시도로 보이지도 않고, 새 키를 쓰면 같은 영상을 다시 분석해 원가가 두 번 난다.
 *
 * **이미 확보한 mediaId 를 그대로 재사용**해 분석부터 다시 하지 않는다(재과금 없음).
 * 종결이 아닌 잡은 건드리지 않는다 — 돌고 있는 것을 흔들면 중복 게시가 난다.
 */
app.post("/api/factory/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  const job = await getEntity<any>("factoryJob", id);
  if (!job) return c.json({ error: "not_found", message: "잡을 찾을 수 없습니다." }, 404);
  if (!["failed", "hold", "partial"].includes(String(job.state))) {
    return c.json({
      error: "not_retryable",
      message: `지금 상태(${job.state})는 재시도할 수 없습니다 — 실패·보류·부분성공만 가능합니다.`,
    }, 409);
  }
  // 어디부터 다시 시작할지: 미디어가 이미 있으면 분석 대기부터, 없으면 처음부터.
  // 클립까지 만들어졌으면 배포만 다시 태운다(렌더는 캐시가 있어 재인코딩되지 않는다).
  const resume = (job.clipIds ?? []).length ? "publishing"
    : job.episodeId ? "analyzing"
    : job.mediaId ? "analyzing" : "queued";
  const next = {
    ...job, state: resume, error: null,
    note: `재시도 (${job.state} → ${resume})`, updatedAt: Date.now(),
  };
  await putEntity("factoryJob", id, next);
  await enqueue("factory.orchestrate", { factoryJobId: id },
    { dedupeKey: `factory.orchestrate:${id}:retry:${Date.now()}` });
  return c.json({ ok: true, jobId: id, status: resume, resumedFrom: job.state }, 202);
});

/**
 * 큐 상태. 런북([docs/ops/runbook.md])의 1차 진단 도구다.
 *
 * 상태별 4개 정수만 주면 "pending 51" 까지만 알 수 있어, **레인 4개 중 어디가 막혔는지**를
 * 구분할 수 없다. 타입별 대기 건수와 가장 오래 기다린 잡의 나이를 함께 준다 —
 * 기존 키(pending/running/done/failed)는 그대로 두어 호출부를 깨지 않는다.
 */
app.get("/api/queue/stats", async (c) => {
  requireOpsOrInternal(c, currentContext()?.via);
  // 큐는 전 테넌트 횡단으로 세야 한다 — 요청자 스코프로 읽으면 멀티테넌트에서 자기 회사 잡만
  // 보여 백로그를 놓친다(RLS 는 job_queue 도 스코프한다). runAsSystem 으로 '*' 스코프.
  const [stats, byType, oldestMs] = await runAsSystem(() => Promise.all([
    queueStats(), pendingByType(), oldestPendingAgeMs(),
  ]));
  return c.json({ ...stats, pendingByType: byType, oldestPendingAgeMs: oldestMs });
});

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
  requireOpsOrInternal(c, currentContext()?.via);
  const project = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
  const zone = process.env.GEBD_VM_ZONE || "us-central1-b";
  const instance = process.env.GEBD_VM_NAME || "stepd-gebd-vm";

  // 대기 중인 gebd.detect 가 있는지 — 없으면 켜지 않는다 (VM 이 켜지면 시간당 과금이다).
  // 전 테넌트 횡단(runAsSystem) — 요청자 스코프면 다른 회사 잡을 못 세 VM 이 안 깨어난다.
  const { rows } = await runAsSystem(() => getPool().query(
    `SELECT COUNT(*)::int AS n FROM job_queue
      WHERE type = 'gebd.detect' AND status IN ('pending','running')`,
  ));
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
  requireOpsOrInternal(c, currentContext()?.via);
  const zone = process.env.WORKER_VM_ZONE || "asia-northeast3-c";
  const instance = process.env.WORKER_VM_NAME || "stepd-worker";
  // ⚠️ 예전 코드는 `queueStats().pending_by_type` 을 읽었는데 **그런 필드가 없다.**
  //    `undefined || {}` → `{}` → `typeof {} === "object"` 가 참 → 빈 객체를 순회 → pending 은
  //    영원히 0 → 이 라우트는 **항상 "no pending jobs"** 를 돌려줬다(폴백 else 는 도달 불가).
  //    주석에 "…라고 가정" 이라 적혀 있던 그 가정이 틀렸다. 이제 실제로 센다.
  //    GEBD 는 다른 VM 이 담당하므로 이 워커의 깨울 이유에서 제외한다.
  const perType = await runAsSystem(() => pendingByType());
  const excludedTypes = new Set(["gebd.detect", "naver.publish"]);
  const pending = Object.entries(perType)
    .filter(([t]) => !excludedTypes.has(t))
    .reduce((sum, [, n]) => sum + n, 0);
  if (pending === 0) {
    return c.json({ waked: false, reason: "no pending jobs", pending, perType });
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
  requireOpsAccess(c);   // 잡 페이로드·오류를 노출한다 — 인가 없이 열려 있던 라우트다.
  const limit = Number(c.req.query("limit")) || 100;
  const [jobs, stats] = await runAsSystem(() => Promise.all([listJobs(limit), queueStats()]));
  return c.json({ jobs, stats });
});

/**
 * Per-uploaded-video summary: analysis status + scene/shorts/cast counts + genre + error +
 * the episode's live pipeline stage/progress. One row per master media — the "what came out
 * of each upload, and what broke" table. Drill-down stays on GET /api/media/:id/analysis.
 */
app.get("/api/admin/media-analysis", async (c) => {
  requireOpsAccess(c);   // 미디어 제목·장르·파이프라인 단계를 노출한다 — 인가 없이 열려 있었다.
  // 바로 위 잡 표(/api/admin/jobs)는 runAsSystem 으로 **전 회사**를 보여주는데 여기만
  // 요청자 테넌트로 읽으면, 같은 화면에서 고객사 A 의 실패 잡은 보이는데 "그 업로드에서
  // 뭐가 나왔나" 표는 빈 줄이 된다 — 에러가 아니라 공백이라 "분석된 게 없다" 로 오독된다.
  const [media, summaries, episodes] = await runAsSystem(() => Promise.all([
    listMedia(),
    listContentAnalysisSummary(),
    listEntities<any>("episode"),
  ]));
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
