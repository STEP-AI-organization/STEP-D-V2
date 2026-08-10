/**
 * Canva Connect API — OAuth(PKCE) + 디자인 export.
 *
 * 용도는 하나다: **쇼츠 오버레이 템플릿을 PNG 로 꺼내오는 것.**
 * 캔바 autofill 은 텍스트·이미지 필드만 채우므로 영상은 못 꽂는다 — 합성은 우리 ffmpeg 몫이다.
 *
 * ⚠️ 무료 플랜은 `transparent_background: true` 를 거부한다. 그래서 템플릿 배경을
 * 마젠타(#FF00FF)로 깔고 일반 PNG 로 받은 뒤 ffmpeg `colorkey` 로 뚫는다.
 * 투명 PNG 를 쓰려고 하지 말 것 — 유료 플랜에서만 되고, 실패 모드가 "흰 배경이 클립을 전부 덮음"이다.
 *
 * 계정은 우리 것 하나뿐이라 토큰 테이블도 단일 행(id='default')이다.
 */
import { randomBytes, createHash } from "node:crypto";
import { getPool } from "./db-pg.ts";

const pool = () => getPool();

const AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const API_BASE = "https://api.canva.com/rest/v1";

/** 템플릿을 PNG 로 꺼내오는 데 필요한 최소 스코프. 더 달라고 하지 말 것. */
const SCOPES = ["design:meta:read", "design:content:read", "asset:read"].join(" ");

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
  opts: { page?: number; width?: number; height?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { page = 1, width = 1080, height = 1920, timeoutMs = 120_000 } = opts;

  const started = await api<ExportJob>("/exports", {
    method: "POST",
    body: JSON.stringify({
      design_id: designId,
      // transparent_background 는 넣지 않는다 — 무료 플랜에서 전체 요청이 거부된다.
      format: { type: "png", pages: [page], width, height, lossless: true },
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
