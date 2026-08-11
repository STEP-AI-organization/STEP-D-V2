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
    uploadUrl: "https://clipcreators.naver.com/web/upload",
    /** 업로드가 끝나면 목록으로 돌아간다 — 성공 판정에 쓴다. */
    doneUrlHint: "/web/contents",
    //
    // 2026-08-11 실측 (naver:probe clip <영상>). **2단계 구조다:**
    //   1단계 /web/upload  파일 드롭만 (숨은 input[type=file] + "파일 선택" 버튼)
    //   2단계 파일 투입 후  같은 URL 에서 메타데이터 폼이 렌더됨
    //
    // ⚠️ 클립에는 **제목 필드가 없다.** 설명(300자) 하나뿐이다 — YouTube 처럼
    //    title/description 을 나눠 넣을 수 없다. 우리 clip.title 을 설명 맨 앞에 넣는다.
    // ⚠️ 필수: 설명 · 커버 선택 · 카테고리(1차/2차). 카테고리는 사람이 정해야 한다.
    //
    // 클래스 해시(__bU_8J 등)는 배포마다 바뀌므로 접두사 매칭(^=)을 쓴다.
    sel: {
      fileInput: 'input[type="file"]',
      // 클립엔 제목 입력이 없다 — description 과 같은 요소를 가리켜 둔다(호출부 분기 최소화).
      title: 'textarea[class^="ClipDetailForm_textarea"], textarea[placeholder*="경험을 기록"]',
      description: 'textarea[class^="ClipDetailForm_textarea"], textarea[placeholder*="경험을 기록"]',
      tags: 'button[class^="ClipDetailForm_tagBtn"]',
      submit: 'button:has-text("등록")',
    },
    /** 발행 대신 임시저장 — 자동화 검증 단계에서 실제 공개를 피한다. */
    draftButton: 'button:has-text("임시저장")',
    /** 클립은 제목이 없다 — 호출부가 title 을 설명에 합쳐야 한다. */
    noTitleField: true,
    filePickButton: 'button:has-text("파일 선택")',
  },
} as const;

export type NaverTarget = keyof typeof NAVER_TARGETS;

/** 로그인 여부 판정 — 스튜디오에 들어갔을 때 로그인 화면으로 튕기면 세션 만료다. */
/** 클립 설명 길이(실측 2026-08-11). 최소 10자 미만이면 등록 자체가 막힌다. */
export const DESC_MAX = 300;
export const DESC_MIN = 10;

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
  /** true 면 "등록" 대신 "임시저장" 을 누른다 — 공개 없이 파이프라인을 검증할 때. */
  draftOnly?: boolean;
  /** 네이버 클립 필수 — 1차/2차 카테고리. 프로그램별로 사람이 미리 정해둔다.
   *  자동 판정하지 않는다: 틀린 분류로 발행되면 되돌리기가 번거롭다. */
  category?: { primary: string; secondary: string };
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

/**
 * 1차/2차 카테고리 선택. 둘 다 **필수**다(2026-08-11 실측 — 2차까지 안 고르면 등록 불가).
 *
 * 트리거를 문구로 잡으면 안 된다: 선택하고 나면 버튼 라벨이 "1차 카테고리" → 고른 값으로
 * 바뀐다. 그래서 dropdownWrap 순서(0=1차, 1=2차)로 잡는다. 옵션은 role=option 이 아니라
 * class*="Option" 이다 — li 로 폴백하면 사이드바 메뉴를 긁는다.
 */
async function pickCategory(page: Page, primary: string, secondary: string): Promise<void> {
  const wraps = page.locator('[class*="dropdownWrap"]');
  const opt = (text: string) =>
    page.locator('[class*="Option"]').filter({ hasText: text }).first();

  await wraps.nth(0).locator("button").first().click();
  await page.waitForTimeout(600);
  await opt(primary).click();
  await page.waitForTimeout(800);

  await wraps.nth(1).locator("button").first().click();
  await page.waitForTimeout(600);
  await opt(secondary).click();
  await page.waitForTimeout(400);
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

    // 파일 투입. 숨은 input 에 setInputFiles 로 직접 넣으면 SPA 가 change 이벤트를 못 받아
    // **조용히 1단계에 머무는** 경우가 있다(2026-08-11 실측 · 재현 불규칙). "파일 선택" 버튼을
    // 눌러 filechooser 로 넣는 쪽이 확실하고, 버튼이 없으면 input 직접 주입으로 폴백한다.
    const pickBtn = (T as { filePickButton?: string }).filePickButton;
    let attached = false;
    if (pickBtn) {
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15_000 }),
          page.locator(pickBtn).first().click(),
        ]);
        await chooser.setFiles(input.videoPath);
        attached = true;
      } catch { /* 폴백으로 넘어간다 */ }
    }
    if (!attached) await page.locator(SEL.fileInput).first().setInputFiles(input.videoPath);

    // 파일을 넣어야 메타데이터 폼이 렌더된다(클립은 같은 URL 에서 2단계로 전환). 업로드
    // 진행률이 도는 동안 DOM 이 계속 바뀌므로, 폼이 실제로 나타날 때까지 기다린다.
    await page.locator(SEL.description).first().waitFor({ state: "visible", timeout }).catch(() => {});

    if ((T as { noTitleField?: boolean }).noTitleField) {
      // 클립엔 제목 칸이 없다 — 설명 하나(300자)가 전부다.
      // 배포 시점에 사람이 설명을 넣었으면 **그것만** 쓴다. 제목을 앞에 덧붙이면 300자를
      // 잡아먹고 사람이 쓴 문구가 뒤에서 잘린다. 설명이 비었을 때만 제목으로 채운다.
      const body = (input.description?.trim() || input.title || "").slice(0, DESC_MAX);
      // 실측: 설명은 필수이고 **최소 10자**다. 짧으면 등록이 막히는데 명확한 에러가 없어
      // 원인을 못 찾는다 — 올리기 전에 여기서 거른다.
      if (body.length < DESC_MIN) {
        return { ok: false, error: `설명이 ${DESC_MIN}자 미만입니다(현재 ${body.length}자)` };
      }
      await page.locator(SEL.description).first().fill(body);

      // 카테고리 1차/2차도 필수. 없으면 등록을 눌러봐야 실패하므로 여기서 멈춘다.
      if (!input.category?.primary || !input.category?.secondary) {
        return { ok: false, error: "카테고리(1차/2차) 미지정 — 프로그램별로 미리 등록해야 합니다" };
      }
      await pickCategory(page, input.category.primary, input.category.secondary);
    } else {
      await page.locator(SEL.title).first().fill(input.title);
      if (input.description) {
        await page.locator(SEL.description).first().fill(input.description).catch(() => {});
      }
    }
    // 태그: 클립은 자유 입력이 아니라 **고정 버튼 목록**(장소·쇼핑·게임 …)이라 임의 문자열을
    // 넣을 수 없다. 우리 tags 와 겹치는 버튼만 눌러준다.
    if (input.tags?.length) {
      for (const tag of input.tags.slice(0, 5)) {
        const btn = page.locator(SEL.tags).filter({ hasText: tag }).first();
        if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
      }
    }

    // 업로드 완료까지는 파일 크기에 비례해 오래 걸린다. 제출 버튼이 활성화될 때까지 기다린다.
    const draftSel = (T as { draftButton?: string }).draftButton;
    const submitSel = input.draftOnly && draftSel ? draftSel : SEL.submit;
    const submit = page.locator(submitSel).first();
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
