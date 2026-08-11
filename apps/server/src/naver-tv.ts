/**
 * 네이버 TV · 네이버 클립 업로드 — Playwright 브라우저 자동화.
 *
 * 네이버는 공개 업로드 API 가 없다. 파트너 계약(SMR) 경로가 열리기 전까지는 이게 유일하다.
 * **사무실 상시 PC 의 `naver` 레인 워커에서만 돈다** — Cloud Run 에서 돌리면 해외 IP 라
 * 로그인부터 막힌다. 세션은 [naver-session.ts] 참고.
 *
 * ⚠️ 셀렉터는 **미검증이다.** 네이버 스튜디오 DOM 을 실제로 열어보고 맞춘 게 아니라
 * 자리만 잡아둔 것이다. 1단계(로컬 headful 로 사람이 업로드 1건 성공)에서 확인하고 고쳐야
 * 한다. 그래서 셀렉터를 SEL 한 곳에 모아뒀다 — 개편 때도 여기만 고치면 된다.
 *
 * ⚠️ 약관: 본인 계정·본인 콘텐츠라도 자동화 도구는 제한될 수 있다. 계정 정지 리스크는
 * 기술이 아니라 사업 판단이다. 게이트가 기본 OFF 인 이유이기도 하다.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { loadNaverSession, saveNaverSession } from "./naver-session.ts";
import { assertNaverUploadEnabled } from "./naver-gate.ts";

const LOGIN_URL = "https://nid.naver.com/nidlogin.login";

/**
 * 업로드 대상. 네이버 TV 와 클립은 **다른 사이트**지만 같은 네이버 계정 세션을 쓴다
 * (NID 쿠키 하나로 둘 다 붙는다) — 그래서 storageState 는 한 벌만 관리한다.
 *
 * 셀렉터는 여기 한 곳에. 네이버 개편 시 이 블록만 고친다.
 * ⚠️ 전부 **미검증 추측**이다. headful 로 1건 성공시키면서 실제 DOM 에 맞춰야 한다.
 */
export const NAVER_TARGETS = {
  tv: {
    label: "네이버 TV",
    channel: "navertv",
    uploadUrl: "https://tv.naver.com/studio/upload",
    sel: {
      fileInput: 'input[type="file"]',
      title: 'input[name="title"], input[placeholder*="제목"]',
      description: 'textarea[name="description"], textarea[placeholder*="설명"]',
      tags: 'input[placeholder*="태그"]',
      submit: 'button[type="submit"], button:has-text("등록"), button:has-text("업로드")',
    },
  },
  clip: {
    label: "네이버 클립",
    channel: "naverclip",
    // 클립 크리에이터 스튜디오 — 세로(9:16) 숏폼 전용.
    // 목록(/web/contents/clips)이 아니라 **업로드 페이지로 직행**한다. 목록에서 시작하면
    // "업로드 버튼 찾기 → 모달 대기" 단계가 붙고, 그 단계가 개편에 제일 잘 깨진다.
    uploadUrl: "https://clipcreators.naver.com/web/upload",
    /** 업로드가 끝나면 목록으로 돌아간다 — 성공 판정에 쓴다. */
    doneUrlHint: "/web/contents",
    sel: {
      fileInput: 'input[type="file"]',
      title: 'input[placeholder*="제목"], textarea[placeholder*="제목"]',
      description: 'textarea[placeholder*="설명"], textarea[placeholder*="내용"]',
      tags: 'input[placeholder*="태그"], input[placeholder*="해시"]',
      submit: 'button:has-text("등록"), button:has-text("업로드"), button:has-text("발행"), button[type="submit"]',
    },
  },
} as const;

export type NaverTarget = keyof typeof NAVER_TARGETS;

/** 로그인 여부 판정 — 스튜디오에 들어갔을 때 로그인 화면으로 튕기면 세션 만료다. */
const LOGGED_OUT_HINT = 'form[name="frmNIDLogin"], input#id';

export interface NaverUploadInput {
  /** "tv" = 네이버 TV(가로 무관) · "clip" = 네이버 클립(세로 9:16 숏폼) */
  target: NaverTarget;
  videoPath: string;
  title: string;
  description?: string;
  tags?: string[];
  /** 실패 진단용 스크린샷을 남길 디렉토리. 미지정 시 임시 폴더. */
  artifactDir?: string;
  /** true 면 브라우저 창을 띄운다(로컬 디버깅). 워커에서는 false. */
  headful?: boolean;
  timeoutMs?: number;
}

export interface NaverUploadResult {
  ok: boolean;
  url?: string;
  /** 실패 시 진단 스크린샷 경로. 사람이 열어봐야 원인이 보인다. */
  screenshotPath?: string;
  error?: string;
}

export class NaverSessionExpiredError extends Error {
  constructor() {
    super("네이버 세션이 만료됐습니다 — 워커 PC 에서 `pnpm --filter @stepd/server naver:login` 을 다시 실행하세요.");
    this.name = "NaverSessionExpiredError";
  }
}

/** 저장된 세션으로 브라우저 컨텍스트를 연다. 세션이 없으면 던진다(업로드 시도 금지). */
export async function openNaverContext(headful = false): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const state = loadNaverSession();
  if (!state) throw new NaverSessionExpiredError();
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({
    storageState: state as any,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 900 },
  });
  return { browser, ctx };
}

async function shot(page: Page, dir: string, name: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

/**
 * 영상 1건 업로드. 성공하면 공개 URL(있으면)을 돌려준다.
 *
 * 실패는 **던지지 않고** `{ ok:false, screenshotPath }` 로 돌려준다 — 워커가 잡을 failed 로
 * 남기고 사람이 스크린샷을 보게 하는 게 재시도 폭주보다 낫다. 세션 만료만 예외로 던진다
 * (재시도해도 절대 안 되는 상태라 구분이 필요하다).
 */
export async function uploadToNaver(input: NaverUploadInput): Promise<NaverUploadResult> {
  const T = NAVER_TARGETS[input.target];
  const SEL = { ...T.sel, loggedOutHint: LOGGED_OUT_HINT };
  // 게이트를 업로드 **직전에** 다시 확인한다 — 라우트에서만 막으면 워커 경로가 뚫린다.
  assertNaverUploadEnabled();

  if (!fs.existsSync(input.videoPath)) {
    return { ok: false, error: `영상 파일 없음: ${input.videoPath}` };
  }
  const artifactDir = input.artifactDir ?? path.join(os.tmpdir(), "stepd-naver");
  const timeout = input.timeoutMs ?? 10 * 60_000;

  const { browser, ctx } = await openNaverContext(input.headful);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  try {
    await page.goto(T.uploadUrl, { waitUntil: "domcontentloaded" });

    // 세션 만료면 로그인 폼으로 튕긴다. 여기서 자동 로그인을 시도하지 않는다 —
    // 캡차·2차인증은 사람이 뚫어야 하고, 자동 시도는 계정 잠금만 부른다.
    if (await page.locator(SEL.loggedOutHint).first().isVisible().catch(() => false)) {
      throw new NaverSessionExpiredError();
    }

    await page.locator(SEL.fileInput).first().setInputFiles(input.videoPath);
    await page.locator(SEL.title).first().fill(input.title);
    if (input.description) {
      await page.locator(SEL.description).first().fill(input.description).catch(() => {});
    }
    if (input.tags?.length) {
      const t = page.locator(SEL.tags).first();
      if (await t.isVisible().catch(() => false)) {
        for (const tag of input.tags.slice(0, 10)) { await t.fill(tag); await t.press("Enter"); }
      }
    }

    // 업로드 완료까지는 파일 크기에 비례해 오래 걸린다. 제출 버튼이 활성화될 때까지 기다린다.
    const submit = page.locator(SEL.submit).first();
    await submit.waitFor({ state: "visible", timeout });
    await submit.click();

    // 성공 판정: 업로드 페이지를 벗어나면 성공으로 본다. 토스트 문구는 개편마다 바뀌어 못 믿는다.
    const done = (T as { doneUrlHint?: string }).doneUrlHint;
    await page.waitForURL(
      (u) => (done ? u.toString().includes(done) : u.toString() !== T.uploadUrl),
      { timeout },
    ).catch(() => {});
    const url = page.url();
    return { ok: true, url };
  } catch (e: any) {
    if (e instanceof NaverSessionExpiredError) {
      await shot(page, artifactDir, `session-expired-${Date.now()}`);
      throw e;
    }
    const screenshotPath = await shot(page, artifactDir, `fail-${Date.now()}`);
    return { ok: false, error: String(e?.message ?? e), screenshotPath };
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * 최초 1회 수동 로그인 — 브라우저를 띄우고 **사람이** 아이디/비번/2차인증을 넣는다.
 * 로그인이 끝나면 storageState 를 저장한다. 자격증명은 코드가 절대 만지지 않는다.
 */
export async function interactiveNaverLogin(waitMs = 5 * 60_000): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("브라우저에서 네이버 로그인을 완료하세요 (2차인증 포함). 완료되면 자동 저장됩니다.");
  // 로그인 성공 = nid 도메인을 벗어남. 못 감지해도 waitMs 뒤에 현재 상태를 저장한다.
  await page.waitForURL((u) => !u.toString().includes("nid.naver.com"), { timeout: waitMs })
    .catch(() => console.log("로그인 완료를 감지 못했습니다 — 현재 상태를 그대로 저장합니다."));
  // 로그인 후 두 사이트를 한 번씩 찍어 각 도메인 쿠키까지 세션에 담는다.
  for (const t of Object.values(NAVER_TARGETS)) {
    await page.goto(t.uploadUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  saveNaverSession(await ctx.storageState());
  console.log("세션 저장 완료.");
  await ctx.close();
  await browser.close();
}
