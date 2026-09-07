/**
 * 배포 언어 규격 — 자막 폭·제목 폭·허용 글꼴·메타 생성 지시가 전부 여기서 나온다.
 *
 * 다국어 배포(2026-09-07 · 1차 베트남어)에서 언어마다 달라져야 하는 값이 네 곳에 흩어져
 * 있었다: `caption-chunk.ts` 의 한 화면 글자수, `factory.ts` 의 제목 줄바꿈·글꼴,
 * `clip-metadata.ts` 의 출력 언어, 그리고 썸네일 폰트. 표를 하나로 모아 두지 않으면
 * "자막은 베트남어인데 제목만 한국어 규격" 같은 어긋남이 반드시 생긴다.
 *
 * ## widthEm 은 짐작하지 말고 폰트에서 잰다
 *
 * 글자 하나의 평균 표시폭(em)이다. Pretendard-ExtraBold 의 `hmtx` 실측:
 *   한글 0.864 · 베트남어 소문자(성조) 0.585 · 라틴 소문자 0.552
 * 이 값이 틀리면 자막이 화면 밖으로 넘치거나(작게 잡음) 폭의 절반만 쓴다(크게 잡음).
 * 언어를 추가할 땐 `docs/plans/active/multilang-captions-plan.md` §9 의 방법으로 실측할 것.
 *
 * ## 글꼴은 **덮는 것만** 허용한다
 *
 * libass 는 글리프가 없으면 **오류 없이 다른 폰트로 조용히 대체한다.** 지마켓 산스는
 * 베트남어를 1% 밖에 안 덮어서, 기본값대로 두면 제목만 얇은 폴백 폰트로 발행된다
 * (실측: 같은 문서 §3.5-(4.5)). `allowFonts` 에 없는 id 는 `snapFont` 가 갈아끼운다.
 */

/** 카탈로그 글꼴 id — `ASS_FONT_BY_ID`(index.ts)·`FONT_FAMILIES`(overlay-canvas)와 같은 축. */
export type FontId = string;

export interface CaptionLang {
  /** BCP-47 기본 서브태그. 유튜브 캡션 트랙 `snippet.language` 에 그대로 쓴다. */
  code: string;
  nameKo: string;
  /** 그 언어 사람이 부르는 이름 — 프롬프트에 넣으면 모델이 언어를 덜 헷갈린다. */
  nameNative: string;
  /** 글자 하나의 평균 표시폭(em). 폰트 hmtx 실측값. */
  widthEm: number;
  /** 한 화면에 넣을 자막 글자수. 한국어 11자(=9.5em)와 **같은 폭**이 되도록 잡는다. */
  captionMaxChars: number;
  /** 메타 제목 상한(자). 한국어 40자와 같은 폭. */
  titleMaxChars: number;
  /** 영상 위 제목 한 줄 상한 / 두 줄로 접을 때의 예산 — `wrapAutoTitle` 이 쓴다. */
  titleWrapAt: number;
  titleWrapBudget: number;
  /**
   * 이 언어를 **완전히 덮는** 글꼴 id. 첫 번째가 기본 대체값이다.
   * 한글도 같이 덮어야 한다 — 프로그램명·등록 인물명은 번역하지 않고 원문으로 남는다.
   */
  allowFonts: FontId[];
  /** 썸네일 오버레이(Pillow)용 폰트 파일. Pillow 는 폴백을 안 해 두부(□)를 그대로 그린다. */
  thumbnailFont: string;
}

/** 한국어 — 기존 동작의 기준값. 여기 숫자를 바꾸면 기존 렌더가 바뀐다. */
const KO: CaptionLang = {
  code: "ko",
  nameKo: "한국어",
  nameNative: "한국어",
  widthEm: 0.864,
  captionMaxChars: 11,   // = CAPTION_CHUNK_MAX_CHARS (9.5em)
  titleMaxChars: 40,
  titleWrapAt: 14,
  titleWrapBudget: 16,
  allowFonts: [],        // 빈 배열 = 제한 없음 (모든 카탈로그 글꼴이 한글을 덮는다)
  thumbnailFont: "BlackHanSans-Regular.ttf",
};

/**
 * 베트남어. 성조가 이중으로 쌓이는 Latin Extended Additional(U+1EA0–1EF9)을 쓴다.
 * 번들 글꼴 11종 중 **Pretendard 와 Gothic A1 만** 이 구간을 덮는다(둘 다 한글도 100%).
 * 지마켓·검은고딕·주아는 0~1% 라 쓰면 깨진다.
 */
const VI: CaptionLang = {
  code: "vi",
  nameKo: "베트남어",
  nameNative: "Tiếng Việt",
  widthEm: 0.585,
  captionMaxChars: 16,   // 9.5em / 0.585 — 한국어 11자와 같은 폭
  titleMaxChars: 59,     // 40 × 0.864 / 0.585
  titleWrapAt: 21,       // 14 × 0.864 / 0.585
  titleWrapBudget: 24,
  allowFonts: ["pretendard", "gothica1"],
  thumbnailFont: "Pretendard-Bold.otf",
};

export const CAPTION_LANGS: Record<string, CaptionLang> = { ko: KO, vi: VI };

/** 기본(한국어). 언어 미지정·미지원 값은 전부 여기로 떨어진다 — 기존 동작이 그대로 유지된다. */
export const DEFAULT_LANG = KO;

/**
 * 언어 코드를 규격으로. **모르는 값은 조용히 한국어**로 떨어뜨린다.
 *
 * 오타(`"vn"`)나 빈 값의 실패 모드가 "한국어로 나감"이지 "깨진 자막으로 나감"이 아니게
 * 방향을 잡았다 — 업로드 게이트와 같은 원칙이다.
 */
export function langOf(code: string | null | undefined): CaptionLang {
  const key = String(code ?? "").trim().toLowerCase();
  return CAPTION_LANGS[key] ?? DEFAULT_LANG;
}

/** 한국어가 아닌가 — 다국어 경로를 탈지 판단하는 단일 술어. */
export function isForeign(lang: CaptionLang): boolean {
  return lang.code !== DEFAULT_LANG.code;
}

/**
 * 이 언어에서 쓸 수 있는 글꼴로 스냅한다.
 *
 * `allowFonts` 가 비어 있으면(한국어) 요청한 값을 그대로 통과시킨다. 그렇지 않으면
 * 목록에 있는 것만 통과하고, 없으면 **첫 번째 허용 글꼴**로 갈아끼운다.
 * 이걸 안 하면 libass 가 말없이 대체해 "글꼴을 안 바꿨는데 결과물이 다른" 상태가 된다.
 */
export function snapFont(fontId: string | null | undefined, lang: CaptionLang): string {
  const id = String(fontId ?? "").trim();
  if (lang.allowFonts.length === 0) return id;
  if (id && lang.allowFonts.includes(id)) return id;
  return lang.allowFonts[0];
}
