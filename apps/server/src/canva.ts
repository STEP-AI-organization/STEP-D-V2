/**
 * Canva Connect API — OAuth(PKCE) + 디자인 export.
 *
 * 용도는 하나다: **쇼츠 오버레이 템플릿을 PNG 로 꺼내오는 것.**
 * 캔바 autofill 은 텍스트·이미지 필드만 채우므로 영상은 못 꽂는다 — 합성은 우리 ffmpeg 몫이다.
 *
 * 이 계정은 Pro 라 `transparent_background: true` 가 된다(2026-08-10 실측). 무료 플랜이면
 * 거부되므로, 계정이 바뀌면 배경을 마젠타(#FF00FF)로 깔고 ffmpeg `colorkey` 로 뚫는 우회가 필요하다.
 *
 * 계정은 우리 것 하나뿐이라 토큰 테이블도 단일 행(id='default')이다.
 */
import { randomBytes, createHash } from "node:crypto";
import { getPool } from "./db-pg.ts";

const pool = () => getPool();

const AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const API_BASE = "https://api.canva.com/rest/v1";

/**
 * 필요한 스코프. **캔바 개발자 콘솔의 Scopes 탭과 정확히 일치해야 한다** —
 * 콘솔에서 안 켠 스코프를 여기서 요청하면 동의 화면이 거부되고, 반대로 여기서 빠뜨리면
 * 런타임에 `missing_scope` 로 죽는다.
 * brandtemplate:* 는 autofill(템플릿 텍스트를 API 로 채우기)용이다.
 */
const SCOPES = [
  "design:meta:read",
  "design:content:read",
  "design:content:write", // autofill 이 만든 디자인을 쓰려면 필요
  "asset:read",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
  "folder:read", // 템플릿을 폴더로 관리한다 — 폴더 안 디자인만 가져온다
  "asset:write", // 우리가 만든 프레임 PNG 를 캔바로 올린다
].join(" ");

const CLIENT_ID = process.env.CANVA_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET ?? "";

export const CANVA_CALLBACK_PATH = "/api/canva/oauth/callback";

export function canvaConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function redirectUri(): string {
  const base = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
  return `${base}${CANVA_CALLBACK_PATH}`;
}

// ── 토큰 저장 (단일 행) ─────────────────────────────────────────────────────────

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  await pool().query(`
    CREATE TABLE IF NOT EXISTS canva_auth (
      id            TEXT PRIMARY KEY,
      accessToken   TEXT NOT NULL,
      refreshToken  TEXT NOT NULL,
      expiresAt     BIGINT NOT NULL,
      connectedAt   BIGINT NOT NULL
    );
  `);
  // PKCE verifier 는 authorize→callback 사이에만 쓰는 일회성 값이다.
  await pool().query(`
    CREATE TABLE IF NOT EXISTS canva_pkce (
      state      TEXT PRIMARY KEY,
      verifier   TEXT NOT NULL,
      createdAt  BIGINT NOT NULL
    );
  `);
  ensured = true;
}

interface CanvaAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function loadAuth(): Promise<CanvaAuth | undefined> {
  await ensureTable();
  const { rows } = await pool().query(
    `SELECT accesstoken AS "accessToken", refreshtoken AS "refreshToken", expiresat AS "expiresAt"
       FROM canva_auth WHERE id = 'default'`,
  );
  const r = rows[0];
  return r ? { ...r, expiresAt: Number(r.expiresAt) } : undefined;
}

async function saveAuth(a: CanvaAuth): Promise<void> {
  await ensureTable();
  await pool().query(
    `INSERT INTO canva_auth (id, accessToken, refreshToken, expiresAt, connectedAt)
     VALUES ('default', $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       accessToken  = EXCLUDED.accessToken,
       refreshToken = EXCLUDED.refreshToken,
       expiresAt    = EXCLUDED.expiresAt`,
    [a.accessToken, a.refreshToken, a.expiresAt, Date.now()],
  );
}

export async function canvaConnected(): Promise<boolean> {
  return Boolean(await loadAuth());
}

export async function disconnectCanva(): Promise<void> {
  await ensureTable();
  await pool().query("DELETE FROM canva_auth WHERE id = 'default'");
}

// ── OAuth (PKCE 필수) ──────────────────────────────────────────────────────────

const b64url = (b: Buffer) => b.toString("base64url");

/** 동의 URL 발급. verifier 를 state 에 묶어 저장해둔다(콜백에서 되찾아야 함). */
export async function canvaAuthUrl(): Promise<string> {
  await ensureTable();
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  await pool().query(
    "INSERT INTO canva_pkce (state, verifier, createdAt) VALUES ($1, $2, $3)",
    [state, verifier, Date.now()],
  );
  // 10분 넘은 찌꺼기는 여기서 같이 치운다 — 별도 sweep 잡을 만들 만한 양이 아니다.
  await pool().query("DELETE FROM canva_pkce WHERE createdAt < $1", [Date.now() - 600_000]);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
}

async function tokenRequest(body: URLSearchParams) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(),
    },
    body,
  });
  if (!res.ok) throw new Error(`Canva token request failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

/** 콜백에서 호출. state 로 verifier 를 되찾아 교환하고 토큰을 저장한다. */
export async function canvaExchangeCode(code: string, state: string): Promise<void> {
  await ensureTable();
  const { rows } = await pool().query("SELECT verifier FROM canva_pkce WHERE state = $1", [state]);
  const verifier = rows[0]?.verifier as string | undefined;
  if (!verifier) throw new Error("Canva OAuth state not found or expired");
  await pool().query("DELETE FROM canva_pkce WHERE state = $1", [state]);

  const t = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  }));
  await saveAuth({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  });
}

/**
 * 유효한 access token 을 돌려준다. 만료 60초 전부터 미리 갱신한다.
 * 캔바 refresh token 은 **회전한다** — 갱신 응답의 새 refresh token 을 반드시 저장해야
 * 다음 갱신이 된다. 안 그러면 조용히 연결이 끊긴다.
 */
export async function canvaAccessToken(): Promise<string> {
  const auth = await loadAuth();
  if (!auth) throw new Error("canva_not_connected");
  if (Date.now() < auth.expiresAt - 60_000) return auth.accessToken;

  const t = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  }));
  const next: CanvaAuth = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  await saveAuth(next);
  return next.accessToken;
}

// ── Export ────────────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await canvaAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Canva API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface CanvaDesign {
  id: string;
  title?: string;
  thumbnail?: { url: string };
}

export async function listCanvaDesigns(): Promise<CanvaDesign[]> {
  const r = await api<{ items?: CanvaDesign[] }>("/designs");
  return r.items ?? [];
}

interface ExportJob {
  job: { id: string; status: "in_progress" | "success" | "failed"; urls?: string[]; error?: { message?: string } };
}

/**
 * 디자인 1페이지를 PNG 로 export 하고 다운로드 URL 을 돌려준다.
 *
 * export 는 **비동기 잡**이라 폴링해야 한다. 라우트 핸들러에서 직접 부르지 말고
 * 워커 잡에서 부를 것 — Cloud Run 요청 타임아웃에 걸린다.
 */
export async function exportDesignPng(
  designId: string,
  opts: { page?: number; width?: number; height?: number; timeoutMs?: number; transparent?: boolean } = {},
): Promise<string> {
  const { page = 1, width = 1080, height = 1920, timeoutMs = 120_000, transparent = true } = opts;

  const started = await api<ExportJob>("/exports", {
    method: "POST",
    body: JSON.stringify({
      design_id: designId,
      // 오버레이로 쓰려면 투명이 기본이다. 무료 플랜 계정에서는 이 필드 때문에 전체 요청이 거부된다.
      format: { type: "png", pages: [page], width, height, lossless: true,
                transparent_background: transparent },
    }),
  });

  const deadline = Date.now() + timeoutMs;
  let jobId = started.job.id;
  let job = started.job;
  while (job.status === "in_progress") {
    if (Date.now() > deadline) throw new Error(`Canva export timed out (job ${jobId})`);
    await new Promise((r) => setTimeout(r, 2000));
    job = (await api<ExportJob>(`/exports/${jobId}`)).job;
  }
  if (job.status !== "success" || !job.urls?.length) {
    throw new Error(`Canva export failed: ${job.error?.message ?? job.status}`);
  }
  // 다운로드 URL 은 만료된다(수십 분). 받은 즉시 GCS 로 넘길 것.
  return job.urls[0];
}

// ── Brand templates + Autofill (템플릿 텍스트를 API 로 채우기) ──────────────────

export interface BrandTemplate {
  id: string;
  title?: string;
  thumbnail?: { url: string };
}

export async function listBrandTemplates(): Promise<BrandTemplate[]> {
  const r = await api<{ items?: BrandTemplate[] }>("/brand-templates");
  return r.items ?? [];
}

/** 템플릿이 노출하는 autofill 필드 스키마. 비어 있으면 그 템플릿은 autofill 불가. */
export async function brandTemplateDataset(templateId: string): Promise<Record<string, unknown>> {
  const r = await api<{ dataset?: Record<string, unknown> }>(
    `/brand-templates/${templateId}/dataset`,
  );
  return r.dataset ?? {};
}

interface AutofillJob {
  job: {
    id: string;
    status: "in_progress" | "success" | "failed";
    result?: { design?: { id: string; url?: string } };
    error?: { message?: string };
  };
}

/**
 * 템플릿 필드를 채워 새 디자인을 만든다. `data` 는 필드명 → 값:
 *   { title: { type: "text", text: "오늘의 하이라이트" } }
 * export 와 마찬가지로 비동기 잡이라 폴링한다. 반환값은 새 디자인 id —
 * 그대로 `exportDesignPng()` 에 넘기면 PNG 가 나온다.
 */
export async function autofillDesign(
  templateId: string,
  data: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<string> {
  const started = await api<AutofillJob>("/autofills", {
    method: "POST",
    body: JSON.stringify({ brand_template_id: templateId, data }),
  });
  const deadline = Date.now() + timeoutMs;
  let job = started.job;
  while (job.status === "in_progress") {
    if (Date.now() > deadline) throw new Error(`Canva autofill timed out (job ${job.id})`);
    await new Promise((r) => setTimeout(r, 2000));
    job = (await api<AutofillJob>(`/autofills/${job.id}`)).job;
  }
  const designId = job.result?.design?.id;
  if (job.status !== "success" || !designId) {
    throw new Error(`Canva autofill failed: ${job.error?.message ?? job.status}`);
  }
  return designId;
}

// ── 폴더 ──────────────────────────────────────────────────────────────────────

export interface CanvaFolder {
  id: string;
  name?: string;
}

interface FolderItem {
  type: string;
  folder?: CanvaFolder;
  design?: CanvaDesign;
}

/** 루트 아래 폴더 목록. 템플릿 폴더를 이름으로 찾을 때 쓴다. */
export async function listCanvaFolders(parent = "root"): Promise<CanvaFolder[]> {
  const r = await api<{ items?: FolderItem[] }>(
    `/folders/${parent}/items?item_types=folder`,
  );
  return (r.items ?? []).map((i) => i.folder).filter((f): f is CanvaFolder => !!f);
}

/** 폴더 안 디자인만. 템플릿은 여기 담긴 것만 쓴다(리스트 전체를 훑지 않는다). */
export async function listDesignsInFolder(folderId: string): Promise<CanvaDesign[]> {
  const r = await api<{ items?: FolderItem[] }>(
    `/folders/${folderId}/items?item_types=design`,
  );
  return (r.items ?? []).map((i) => i.design).filter((d): d is CanvaDesign => !!d);
}

// ── 업로드 (우리 PNG → 캔바) ───────────────────────────────────────────────────

interface AssetUploadJob {
  job: { id: string; status: "in_progress" | "success" | "failed";
         asset?: { id: string }; error?: { message?: string } };
}

/**
 * 로컬 PNG 바이트를 캔바 에셋으로 올린다.
 *
 * MCP 의 upload-asset-from-url 과 달리 **공개 URL 이 필요 없다** — 바이너리를 직접 보낸다.
 * 내부 소재를 인터넷에 노출하지 않아도 된다는 뜻이라, 업로드는 반드시 이 경로로 할 것.
 * 이름은 헤더에 base64url 로 싣는다(한글 파일명이 헤더에서 깨지는 걸 피한다).
 */
export async function uploadAssetPng(
  bytes: Buffer,
  name: string,
  timeoutMs = 120_000,
): Promise<string> {
  const token = await canvaAccessToken();
  // 헤더 값은 JSON 문자열 그대로다. 통째로 base64 하면 "Invalid upload metadata header".
  // 안쪽 name_base64 만 base64url 이다 — 한글 이름이 헤더에서 깨지는 걸 피하려는 장치.
  const meta = JSON.stringify({ name_base64: Buffer.from(name, "utf-8").toString("base64url") });
  const res = await fetch(`${API_BASE}/asset-uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Asset-Upload-Metadata": meta,
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`Canva asset upload failed (${res.status}): ${await res.text()}`);

  let job = ((await res.json()) as AssetUploadJob).job;
  const deadline = Date.now() + timeoutMs;
  while (job.status === "in_progress") {
    if (Date.now() > deadline) throw new Error(`Canva asset upload timed out (job ${job.id})`);
    await new Promise((r) => setTimeout(r, 2000));
    job = (await api<AssetUploadJob>(`/asset-uploads/${job.id}`)).job;
  }
  const assetId = job.asset?.id;
  if (job.status !== "success" || !assetId) {
    throw new Error(`Canva asset upload failed: ${job.error?.message ?? job.status}`);
  }
  return assetId;
}

/**
 * 에셋 하나를 얹은 새 디자인을 만든다. 반환값은 디자인 id.
 *
 * ⚠️ 결과는 **납작한 이미지 한 장**이다. 캔바가 PNG 를 레이어로 되돌리지는 못한다 —
 * 캔바에서 텍스트를 다시 편집하려면 그 위에 텍스트 요소를 새로 얹어야 한다.
 */
export async function createDesignFromAsset(
  assetId: string,
  title: string,
  width = 1080,
  height = 1920,
): Promise<string> {
  const r = await api<{ design: { id: string } }>("/designs", {
    method: "POST",
    body: JSON.stringify({
      design_type: { type: "custom", width, height },
      asset_id: assetId,
      title,
    }),
  });
  return r.design.id;
}
