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
    // 2026-08-11 실측: tv.naver.com/studio 에는 업로드 폼이 없다. 루트로 들어가면
    // **자기 채널 대시보드로 자동 리다이렉트**되므로 채널ID를 몰라도 된다.
    uploadUrl: "https://creator.tv.naver.com/",
    // ⚠️ URL 로 성공을 판정하면 안 된다. 파일을 넣는 순간 이미 /content/video 로 이동해
    //    있어서, 저장을 누르지 않아도 URL 조건이 통과한다(실측: ok=true 인데 목록은 전부
    //    "초안" 이었다). TV 는 **상세 모달이 닫혔는가**로 본다.
    doneBy: "dialogClosed",
    /** 공개 여부가 필수라 안 고르면 "저장" 이 비활성이다. */
    visibilityRadio: { public: '[role="dialog"] label:has-text("공개")' },
    /** 진입 시 공지 모달이 떠 dimmed 레이어가 클릭을 전부 막는다 — 먼저 닫아야 한다. */
    closeDialogFirst: true,
    /** 대시보드의 "동영상 업로드" 를 눌러야 파일 input 이 살아난다. */
    openUploadButton: 'button:has-text("동영상 업로드")',
    sel: {
      fileInput: 'input[type="file"]',
      // 클립과 달리 **제목이 따로 있다**(0/120). 설명은 0/3,000.
      // ⚠️ 제목 input 에는 placeholder 가 없다 — "제목을 입력해 주세요."는 입력창 **아래**
      //    빨간 안내문이다. placeholder 로 잡으면 영원히 못 찾는다(실측).
      title: '[role="dialog"] input[class*="InputText_input_text"]',
      description: '[role="dialog"] textarea',
      tags: 'input[placeholder*="태그 입력"]',
      // 실측: 상세 패널 하단은 "취소 / 저장" 이다.
      submit: 'button:has-text("저장")',
    },
    filePickButton: 'button:has-text("파일 선택")',
  },
  clip: {
    label: "네이버 클립",
    channel: "naverclip",
    uploadUrl: "https://clipcreators.naver.com/web/upload",
    /** 업로드가 끝나면 업로드 페이지를 벗어난다. 목적지는 상황에 따라 다르다 —
     *  예약 발행은 `/web/draft/<id>`, 즉시 발행은 목록. 그래서 특정 경로를 기다리지 않고
     *  "업로드 페이지를 벗어났는가" 로 본다(2026-08-11 실측: /web/contents 를 기다렸다가
     *  10분 타임아웃 났다 — 실제 작업은 40초였다). */
    doneUrlHint: "",
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
  /** 등록 예약 — 이 시각에 자동 등록된다. 미지정이면 즉시 등록.
   *  **워커 PC 로컬시각(KST) 기준**으로 입력한다: 네이버 폼이 로컬시각을 받는다. */
  publishAt?: number;
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
/**
 * 카테고리 기본값. 프로그램별 사전등록이 붙기 전까지 임시로 쓴다
 * (2026-08-11 사용자 지시 — 1차·2차 모두 "엔터").
 */
export const DEFAULT_CATEGORY = { primary: "엔터", secondary: "엔터" } as const;

async function pickCategory(
  page: Page,
  cat?: { primary: string; secondary: string },
): Promise<void> {
  // hasText 는 부분일치라 "엔터" 가 "엔터테인먼트" 에도 걸린다 — 정확히 일치시킨다.
  const opt = (text: string) =>
    page.locator('[class*="Option"], [role="option"]')
      .filter({ hasText: new RegExp(`^\s*${text}\s*$`) }).first();

  // 트리거 잡는 법이 사이트마다 다르다:
  //  - 클립: `[class*="dropdownWrap"]` 두 개 (순서 0=1차, 1=2차)
  //  - TV  : 모달 안 버튼 라벨이 "1차 카테고리"/"2차 카테고리"
  // 선택 후 라벨이 고른 값으로 바뀌므로, 각 단계마다 그때그때 다시 찾는다.
  const wraps = page.locator('[class*="dropdownWrap"]');
  const useWraps = (await wraps.count().catch(() => 0)) >= 2;
  const trigger = (i: 0 | 1) =>
    useWraps
      ? wraps.nth(i).locator("button").first()
      : page.locator(`button:has-text("${i === 0 ? "1차" : "2차"} 카테고리")`).first();

  const want = cat ?? DEFAULT_CATEGORY;
  for (const [i, value] of [[0, want.primary], [1, want.secondary]] as const) {
    await trigger(i).click({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(700);
    await opt(value).click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
}

/**
 * 등록 예약 설정 (공개 설정 → "등록 예약" 체크 + 날짜/시/분).
 *
 * ⚠️ 컨트롤 타입 미검증이다. 화면상 chevron 이 붙은 걸로 보아 네이티브 <select> 가 아니라
 * 카테고리와 같은 커스텀 드롭다운일 가능성이 크다 — 그래서 selectOption 을 먼저 시도하고
 * 실패하면 클릭+옵션선택으로 폴백한다. 실패해도 던지지 않는다: 예약이 안 걸리면 **즉시
 * 등록**되므로, 조용히 지나가면 의도치 않게 바로 공개된다. 그래서 호출부가 결과를 본다.
 */
async function setSchedule(page: Page, when: Date): Promise<boolean> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${when.getFullYear()}.${pad(when.getMonth() + 1)}.${pad(when.getDate())}`;
  const hh = pad(when.getHours());
  const mm = pad(when.getMinutes());

  // 1) "등록 예약" 체크 (실측: 체크 자체는 잘 먹는다)
  try {
    const box = page.getByRole("checkbox", { name: "등록 예약" }).first();
    if (!(await box.isChecked().catch(() => false))) await box.check({ timeout: 10_000 });
  } catch {
    await page.locator('label:has-text("등록 예약")').first().click().catch(() => {});
  }
  await page.waitForTimeout(700);

  // 2) 날짜/시/분. ⚠️ 위치로 잡으면 안 된다 — `[class*="dropdown"]` nth(0) 은 **카테고리**
  //    드롭다운이라 실측에서 예약 대신 카테고리 목록이 열렸다. 현재 표시값의 패턴으로 잡는다:
  //    날짜는 YYYY.MM.DD, 시·분은 두 자리 숫자(DOM 순서로 시 → 분).
  const CTL = 'button, [role="combobox"]';
  const dateCtl = page.locator(CTL).filter({ hasText: /^\s*\d{4}\.\d{2}\.\d{2}\s*$/ }).first();
  const twoDigit = page.locator(CTL).filter({ hasText: /^\s*\d{2}\s*$/ });

  /**
   * 드롭다운을 열어 값을 고른다. 정확히 같은 항목이 없으면 **가장 가까운 숫자**로 간다 —
   * 분(minute)은 10분 단위 같은 눈금만 제공해서 임의 시각(:23)은 목록에 없다.
   */
  const choose = async (trigger: ReturnType<typeof page.locator>, value: string) => {
    if (!(await trigger.count().then((c) => c > 0).catch(() => false))) return false;
    await trigger.click().catch(() => {});
    await page.waitForTimeout(600);

    const opts = page.locator('[class*="Option"], [role="option"], li');
    const texts = (await opts.allTextContents().catch(() => [] as string[]))
      .map((t) => t.trim()).filter(Boolean);
    if (!texts.length) { await page.keyboard.press("Escape").catch(() => {}); return false; }

    let pick = texts.find((t) => t === value);
    if (!pick && /^\d+$/.test(value)) {
      const want = Number(value);
      const nums = texts.filter((t) => /^\d+$/.test(t));
      if (nums.length) {
        pick = nums.reduce((best, t) =>
          Math.abs(Number(t) - want) < Math.abs(Number(best) - want) ? t : best, nums[0]);
      }
    }
    if (!pick) { await page.keyboard.press("Escape").catch(() => {}); return false; }

    const ok = await opts.filter({ hasText: new RegExp("^\s*" + pick.replace(/\./g, "\.") + "\s*$") })
      .first().click({ timeout: 5000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(400);
    return ok;
  };

  await choose(dateCtl, ymd);
  await choose(twoDigit.nth(0), hh);
  await choose(twoDigit.nth(1), mm);

  // ⚠️ 클릭 성공 여부로 판정하면 안 된다. 이미 원하는 값이면 목록을 안 눌러도 되므로
  //    클릭은 false 인데 상태는 맞는 경우가 생긴다(실측: 날짜가 오늘이라 그랬다).
  //    **최종 표시값을 읽어서** 판정한다.
  const shown = async (loc: ReturnType<typeof page.locator>) =>
    (await loc.first().textContent().catch(() => ""))?.trim() ?? "";
  const gotDate = await shown(dateCtl);
  const gotHour = await shown(twoDigit.nth(0));
  const gotMin = await shown(twoDigit.nth(1));

  // 분은 눈금 단위라 정확히 못 맞출 수 있다 — 목표보다 이르지만 않으면 통과로 본다.
  const okDate = gotDate === ymd;
  const okHour = gotHour === hh;
  const okMin = /^\d+$/.test(gotMin) && Number(gotMin) >= Number(mm) - 30;
  if (!(okDate && okHour && okMin)) {
    console.error(`[naver] 예약 설정 확인 실패 — 원함 ${ymd} ${hh}:${mm} / 화면 ${gotDate} ${gotHour}:${gotMin}`);
    return false;
  }
  return true;
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

    // 네이버 TV: 진입 시 공지 모달이 떠 dimmed 레이어가 클릭을 전부 막는다(2026-08-11 실측).
    if ((T as { closeDialogFirst?: boolean }).closeDialogFirst) {
      for (let i = 0; i < 3; i++) {
        if (!(await page.locator('[role="dialog"]').count().catch(() => 0))) break;
        const ok = await page.locator('[role="dialog"] button:has-text("닫기"), [role="dialog"] button[aria-label="닫기"]')
          .first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
        if (!ok) await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(1_000);
      }
    }
    // 대시보드에서 "동영상 업로드" 를 눌러야 파일 input 이 살아난다.
    const openBtn = (T as { openUploadButton?: string }).openUploadButton;
    if (openBtn) {
      await page.locator(openBtn).first().click({ timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
    }

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

      // 등록 예약. 실패하면 **즉시 등록**되어 버리므로 그냥 넘어가지 않고 중단한다 —
      // "예약한 줄 알았는데 바로 공개된" 실패가 제일 나쁘다.
      if (input.publishAt) {
        const when = new Date(input.publishAt);
        if (!(await setSchedule(page, when))) {
          const p = await shot(page, artifactDir, `schedule-fail-${Date.now()}`);
          return { ok: false, error: "등록 예약 설정 실패 — 즉시 공개를 막기 위해 중단했습니다", screenshotPath: p };
        }
      }
    } else {
      await page.locator(SEL.title).first().fill(input.title);
      if (input.description) {
        await page.locator(SEL.description).first().fill(input.description).catch(() => {});
      }
    }
    // 카테고리 1차/2차는 **TV·클립 둘 다 필수**다(2026-08-11 실측).
    // 지정값이 없으면 DEFAULT_CATEGORY("엔터"/"엔터")로 간다.
    await pickCategory(page, input.category);

    // 태그: 클립은 자유 입력이 아니라 **고정 버튼 목록**(장소·쇼핑·게임 …)이라 임의 문자열을
    // 넣을 수 없다. 우리 tags 와 겹치는 버튼만 눌러준다.
    if (input.tags?.length) {
      for (const tag of input.tags.slice(0, 5)) {
        const btn = page.locator(SEL.tags).filter({ hasText: tag }).first();
        if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
      }
    }

    // 업로드 완료까지는 파일 크기에 비례해 오래 걸린다. 제출 버튼이 활성화될 때까지 기다린다.
    // TV: 공개 여부(필수)를 안 고르면 저장 버튼이 비활성이라 눌러도 아무 일이 없다.
    const vis = (T as { visibilityRadio?: { public: string } }).visibilityRadio;
    if (vis) {
      const label = input.publishAt ? "공개 예약" : "공개";
      await page.locator(`[role="dialog"] label:has-text("${label}")`).first()
        .click({ timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(600);
    }

    const draftSel = (T as { draftButton?: string }).draftButton;
    const submitSel = input.draftOnly && draftSel ? draftSel : SEL.submit;
    const submit = page.locator(submitSel).first();
    await submit.waitFor({ state: "visible", timeout });
    await submit.click();

    // 성공 판정: 업로드 페이지를 벗어나면 성공으로 본다. 토스트 문구는 개편마다 바뀌어 못 믿는다.
    if ((T as { doneBy?: string }).doneBy === "dialogClosed") {
      // 모달이 사라져야 저장된 것이다. 남아 있으면 필수값 미충족이거나 저장이 막힌 것 —
      // 성공으로 넘기면 목록에 "초안" 으로만 남는다(실측: 그렇게 4건이 쌓였다).
      const closed = await page.locator('[role="dialog"]')
        .first().waitFor({ state: "detached", timeout }).then(() => true).catch(() => false);
      if (!closed) {
        const p = await shot(page, artifactDir, `submit-stuck-${Date.now()}`);
        return { ok: false, error: "저장 후에도 상세 모달이 닫히지 않았습니다 — 필수값 미충족일 수 있습니다", screenshotPath: p };
      }
      return { ok: true, url: page.url() };
    }
    const done = (T as { doneUrlHint?: string }).doneUrlHint;
    await page.waitForURL(
      (u) => {
        const s = u.toString();
        return done ? s.includes(done) : (s !== T.uploadUrl && !s.startsWith(T.uploadUrl));
      },
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
