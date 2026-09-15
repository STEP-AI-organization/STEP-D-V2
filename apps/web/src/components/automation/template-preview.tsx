"use client";

/**
 * 쇼츠 템플릿 9:16 미리보기 — 자동배포 화면(④ 고급 설정)의 소형 카드와 대형 다이얼로그가
 * **같은 렌더 코드**를 쓴다. 크기만 width prop 으로 갈린다(소형 120px 기본) — 작게/크게가
 * 서로 다른 그림을 그리면 "크게 보니 다르다"는 불신만 남는다.
 *
 * 좌표는 규칙에 저장되는 layout 과 같은 % 값을 그대로 그린다 — 서버 factory 렌더 기하의
 * UI 미러이므로 여기 수식을 바꾸면 실제 렌더와 어긋난다(page.tsx TEMPLATE_SEED_UI 주석 참조).
 */
import { useEffect, useState } from "react";
import type { FrameTemplate } from "@/lib/data/api";
import { ASPECT_PRESETS, getAspectPreset } from "@/lib/editor/aspect-presets";
import { FONT_FAMILY_OPTIONS, fontFamilyCss } from "@/lib/editor/presets";
// 세로 배치 후보는 순방 판정과 같은 목록(RULE_ASPECTS)에서 거른다 — 화면에 사본을 두지 않는다.
import { RULE_ASPECTS } from "@server-pure/pipeline/automation";

export type LayoutState = {
  titleY: number;
  channelIconY: number;
  channelBoxY: number;
  channelIconSize: number;
  /** 제목 강조색(#RRGGBB) — 렌더 titleLines 강조 줄 색과 같은 축(factory titleAccent). */
  titleColor: string;
  /** 자막 세로 위치(% · 화면 하단 기준 · 서버 렌더 capMV 와 같은 축). */
  subtitleY: number;
  /** 자막 글자 크기(% · 화면 높이 기준 · 서버 CAPTION_PCT 와 같은 축). */
  subtitleSize: number;
  /** 자막 색(#RRGGBB). */
  subtitleColor: string;
  /** 요소 표시 여부 — 미지정 = 표시(하위호환·구 규칙 그대로). 서버 렌더(factory)와 같은 축. */
  title?: boolean;
  logo?: boolean;
  timebox?: boolean;
  // ── 제목·자막 스타일 (2026-09-15 템플릿 설정 확장) ─────────────────────────────
  // 미지정 = 전부 기본(종전과 동일 렌더). 소비: factory.autoEditorState layoutOverride.
  /** 제목 글꼴(카탈로그 id · 서버 FONT_FAMILIES). 미지정 = 기본(지마켓 산스). */
  titleFont?: string;
  /** 제목 크기(% · 기본 100) — 시드 106/107px 출력값에 곱하는 배율(factory titleScale). */
  titleSize?: number;
  /** 제목 자간(출력 px · 기본 0 · 서버 es.titleSpacing → PNG letterSpacing / ASS \fsp). */
  titleSpacing?: number;
  /** 제목 행간(배수 · 기본 1.15 — 서버 layoutTitleLines 와 1:1). */
  titleLineHeight?: number;
  /** 제목 그림자 — 미지정 = 켬(종전과 동일). false 만 의미가 있다. */
  titleShadow?: boolean;
  /** 자막 글꼴(카탈로그 id). 미지정 = 기본(지마켓 산스 · 서버 captionAssStyle 기본). */
  captionFont?: string;
  /** 자막 자간(출력 px · es.captionSpacing → ASS \fsp). 기본 0. */
  subtitleSpacing?: number;
  /** 자막 그림자 — 미지정 = 켬(스타일 기본). false 면 ASS Shadow 0. */
  subtitleShadow?: boolean;
  // ── 자막 상세 (2026-09-15 · AENA 통합목업 "자막 스타일" 절) ────────────────────
  /** 자막 그림자 오프셋(출력 px · ASS \xshad·\yshad). 미지정 = 프리셋 깊이. */
  subtitleShadowX?: number;
  subtitleShadowY?: number;
  /** 자막 외곽선 — false 만 의미(끔 · ASS Outline 0). 미지정 = 프리셋 그대로. */
  subtitleStroke?: boolean;
  /** 자막 외곽선 색(#RRGGBB). 미지정 = 프리셋 색(보통 검정). */
  subtitleStrokeColor?: string;
  /** 자막 배경 박스(ASS BorderStyle 3) — true 일 때만 색·불투명도가 의미 있다. */
  subtitleBg?: boolean;
  subtitleBgColor?: string;
  /** 배경 불투명도(0~100 · 기본 60). */
  subtitleBgOpacity?: number;
  // ── 시간박스 스타일 (목업 "시간박스" 절) ──────────────────────────────────────
  /** 시간박스 글꼴(카탈로그 id). 미지정 = Pretendard(종전). */
  timeboxFont?: string;
  /** 시간박스 배경색(#RRGGBB · 기본 #3D7BD9). */
  timeboxColor?: string;
  /** 시간박스 크기(% · 기본 100). */
  timeboxSize?: number;
};

/**
 * 제목 스타일 기본값 — 서버 렌더 기본과 **1:1**. 크기 100% = factory 시드 106/107px 그대로 ·
 * 행간 1.15 = 서버 layoutTitleLines 기본 · 자간 0 · 그림자 켬(buildStaticOverlayItems 기본).
 */
export const TITLE_STYLE_DEFAULTS = { size: 100, spacing: 0, lineHeight: 1.15, shadow: true } as const;

/**
 * 배치 미니 도해 — **원본 그대로**(automation D:1020·1040·1061·1082 · page.tsx 에서 이동).
 * 프리셋 `rect` 환산 대신 원본 도해를 쓴다 — **프리셋 4종 고정** 전제가 붙는다.
 * `RULE_ASPECTS` 에 배치가 늘거나 `rect` 가 바뀌면 여기 도해도 같이 고쳐야 한다.
 */
const GLYPH_BOX = "w-6 h-8 rounded shrink-0 p-1 flex";
function AspectGlyph({ id }: { id: string }) {
  switch (id) {
    case "9:16-letterbox": // 세로 · 전체 담기 — 위·아래 레터박스 띠
      return (
        <div className={`${GLYPH_BOX} bg-indigo-950 flex-col items-center justify-between border border-indigo-700/50`}>
          <div className="w-full h-1 bg-[#1C60FF] rounded-xs" />
          <div className="w-full h-1 bg-[#1C60FF] rounded-xs" />
        </div>
      );
    case "9:16-crop-full": // 세로 · 꽉 채우기 — 여백 없이 꽉 참
      return (
        <div className={`${GLYPH_BOX} bg-stone-800 items-center justify-center border border-stone-700`}>
          <div className="w-full h-full bg-stone-600 rounded-xs" />
        </div>
      );
    case "9:16-crop-main": // 세로 · 위 자막띠 — 위 띠 1개
      return (
        <div className={`${GLYPH_BOX} bg-stone-900 flex-col justify-between border border-stone-700`}>
          <div className="w-full h-2 bg-stone-600 rounded-xs" />
        </div>
      );
    default: // 9:16-crop-sub — 세로 · 위아래 띠
      return (
        <div className={`${GLYPH_BOX} bg-stone-900 flex-col justify-between border border-stone-700`}>
          <div className="w-full h-1.5 bg-stone-600 rounded-xs" />
          <div className="w-full h-1.5 bg-stone-600 rounded-xs" />
        </div>
      );
  }
}

/**
 * 자막 오버레이 기본값 — 서버 렌더(index.ts buildEditorAss)의 자막 기본과 **1:1**.
 * y = 화면 하단 26%(= 서버 CAPTION_MV_PCT) · size = 화면 높이의 4.4%(= 서버 CAPTION_PCT.korean_pop)
 * · 색 = 흰색(= 렌더 korean_pop 기본색). overlay-parity.test.ts 가 이 값이 서버와 갈라지지 않게 강제한다.
 */
export const SUBTITLE_DEFAULTS = { y: 26, size: 4.4, color: "#FFFFFF" } as const;

/** 소형 카드 기준 폭 — 폰트·패딩은 이 폭 대비 비율로 스케일된다(레이아웃 %좌표는 불변). */
const BASE_W = 120;

export function TemplatePreview({ template, accent, layout, frameSrc, subtitlesOn = true, timeboxText, iconSrc, aspect, width = BASE_W }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
  /** 영상 영역 배경으로 깔 실제 샘플 프레임(사용자 최근 회차). 없으면 회색 그라디언트 폴백. */
  frameSrc?: string;
  /** 자막 오버레이 표시 여부 — 규칙의 자막 on/off 를 그대로 반영한다(꺼지면 자막이 사라진다). */
  subtitlesOn?: boolean;
  /** 시간박스 문구 — 실제 렌더는 프로그램 설정의 편성 문구(schedule)를 쓴다. 없으면 예시 표기. */
  timeboxText?: string;
  /** 로고 이미지 — 프로그램 설정의 쇼츠 아이콘(brandIconDataUrl). 실제 렌더의 아이콘 폴백과
      같은 소스라, 있으면 회색 자리표시 대신 진짜 로고가 보인다. 없으면 회색 박스 폴백. */
  iconSrc?: string;
  /**
   * 세로 영상 배치(aspect-presets 의 id). 주면 **영상 영역을 이 배치로 그린다** —
   * 배치를 바꿔도 미리보기가 그대로면 고르는 의미가 없다. 없으면 템플릿 meta 를 따른다.
   */
  aspect?: string;
  width?: number;
}) {
  const s = width / BASE_W;
  const boxH = width * 16 / 9; // 9:16 캔버스 높이(px) — 모든 글자 크기의 기준축
  // 영상 영역: 배치가 정해져 있으면 그것이 정본이다. 프리셋 기하(1080×1920)를 % 로 환산한다 —
  // 여기에 숫자를 따로 적으면 프리셋이 바뀔 때 미리보기만 옛 자리에 남는다.
  // 템플릿 meta 기본값({y:34.2,h:31.7})은 레터박스 한 가지뿐이던 시절의 값이라 같은 것을 가리킨다.
  const preset = getAspectPreset(aspect);
  const video = preset
    ? (preset.fill === "rect" && preset.rect
      ? { x: 0, y: (preset.rect.y / preset.canvasH) * 100, w: 100, h: (preset.rect.h / preset.canvasH) * 100 }
      : preset.fill === "cover"
        ? { x: 0, y: 0, w: 100, h: 100 }
        // contain — 16:9 원본이 폭에 맞으면 높이 607.5 → 세로 중앙 정렬(레터박스).
        : { x: 0, y: (100 - ((1080 * 9 / 16) / preset.canvasH) * 100) / 2, w: 100, h: ((1080 * 9 / 16) / preset.canvasH) * 100 })
    : (template?.video ?? { x: 0, y: 34.2, w: 100, h: 31.7 });
  const iconPct = (layout.channelIconSize * 3 / 1920) * 100; // px(에디터) → 출력높이 → %
  // 자막 글자 크기 = 화면 높이의 subtitleSize%. 서버 렌더의 fs = H·CAPTION_PCT/100 과 같은 축.
  const subFs = boxH * layout.subtitleSize / 100;
  // 제목·시간박스 글자도 **실렌더 출력 px 비율**로 그린다 — 예전엔 고정 7px 스케일이라
  // (화면 높이의 ~3.3%) 실렌더(첫 줄 106px/1920 = 5.5%)보다 40% 작게 보였고, 블록 윗변은
  // 같아도 글자 덩어리가 달라 "미리보기랑 위치가 다르다"는 체감을 만들었다(2026-08-25).
  // 크기 배율(titleSize% · factory titleScale 과 같은 클램프 50~200)을 곱한다.
  const titleScale = Math.min(2, Math.max(0.5, (layout.titleSize ?? TITLE_STYLE_DEFAULTS.size) / 100));
  const titleFs = (boxH * 106 / 1920) * titleScale; // factory 시드 첫 줄 106px 출력과 동일 비율
  // 자간은 출력 px(1920 높이 기준) 저장값을 미리보기 px 로 환산한다 — 렌더 \fsp·letterSpacing 미러.
  const titleSp = ((layout.titleSpacing ?? 0) / 1920) * boxH;
  const subSp = ((layout.subtitleSpacing ?? 0) / 1920) * boxH;
  const timeboxFs = boxH * 66 / 1920;     // 시간박스 22px(설계) × scale 3 = 66px 출력
  return (
    // 원본은 **테두리 없는** 검은 9:16 카드(`rounded-lg border-none`)다.
    // 옛 구현은 `rounded-md border` 라 어두운 배경에서 카드가 한 겹 더 있어 보였다.
    <div className="relative shrink-0 overflow-hidden rounded-lg border-none"
      style={{ width, aspectRatio: "9/16", background: "#000" }}>
      {/* 영상 영역 — 사용자의 최근 회차 프레임(있으면). 없으면 회색 그라디언트 폴백. */}
      <div className="absolute overflow-hidden" style={{
        left: `${video.x}%`, top: `${video.y}%`, width: `${video.w}%`, height: `${video.h}%`,
        ...(frameSrc
          ? { backgroundImage: `url(${frameSrc})`, backgroundSize: "cover", backgroundPosition: "center" }
          : { background: "linear-gradient(135deg,#2a3f4d,#1a2630)" }),
      }} />
      {/* 자막 오버레이 — 하단 기준(bottom) · 화면 높이 % 크기 · 색. 서버 렌더(index.ts capMV·\an2)와
          같은 축이라, 여기서 옮긴 위치·크기·색이 결과물 자막과 그대로 일치한다(파리티 테스트가 강제). */}
      {subtitlesOn && (
        <div className="absolute inset-x-0 text-center font-bold leading-tight"
          style={{
            bottom: `${layout.subtitleY}%`,
            fontSize: subFs, color: layout.subtitleColor,
            // 글꼴·자간·그림자 = 자막 스타일(2026-09-15). 기본은 지마켓 산스(서버 captionAssStyle
            // 기본)·자간 0·그림자 켬 — 종전 미리보기와 동일.
            fontFamily: fontFamilyCss(layout.captionFont) ?? "'GmarketSans', var(--font-sans)",
            ...(subSp ? { letterSpacing: subSp } : {}),
            // 그림자 X/Y(출력 px → 미리보기 px 환산 · ASS \xshad·\yshad 미러). 미지정 = 종전 고정값.
            ...(layout.subtitleShadow === false ? {} : {
              textShadow: (layout.subtitleShadowX ?? layout.subtitleShadowY) != null
                ? `${(((layout.subtitleShadowX ?? 0) / 1920) * boxH).toFixed(1)}px ${(((layout.subtitleShadowY ?? 2) / 1920) * boxH).toFixed(1)}px 3px rgba(0,0,0,.85)`
                : "0 1px 3px rgba(0,0,0,.85)",
            }),
            // 외곽선 — 끔이면 없음, 색만 정하면 그 색(폭은 프리셋 근사 1.4px). 렌더 OutlineColour 미러.
            ...(layout.subtitleStroke === false ? {}
              : layout.subtitleStrokeColor ? { WebkitTextStroke: `1.4px ${layout.subtitleStrokeColor}` } : {}),
          }}>
          {/* 배경 박스(ASS BorderStyle 3 미러) — 글자 덩어리에만 붙는다. 라운딩은 ASS 에 없어
              미리보기도 각지게 둔다(미리보기=결과물). */}
          <span style={{
            paddingInline: 6 * s,
            ...(layout.subtitleBg === true ? {
              background: `rgba(${parseInt((layout.subtitleBgColor ?? "#000000").slice(1, 3), 16)},${parseInt((layout.subtitleBgColor ?? "#000000").slice(3, 5), 16)},${parseInt((layout.subtitleBgColor ?? "#000000").slice(5, 7), 16)},${((layout.subtitleBgOpacity ?? 60) / 100).toFixed(2)})`,
              paddingBlock: 2 * s,
            } : {}),
          }}>
            예시 자막입니다
          </span>
        </div>
      )}
      {/* 제목 2줄 — 각 줄은 한 시각 줄로 고정(nowrap · D). 서버 렌더/에디터와 줄 수 일치.
          상단 앵커(top = titleY%) + 출력 px 비율 크기 + line-height 1.15 = ASS(an8 · adv 1.15)와 동형. */}
      {layout.title !== false && (
        <div className="absolute text-center font-extrabold"
          style={{
            top: `${layout.titleY}%`, left: 4 * s, right: 4 * s,
            // 행간(기본 1.15 = 서버 layoutTitleLines)·자간·그림자 = 제목 스타일(2026-09-15).
            fontSize: titleFs, lineHeight: layout.titleLineHeight ?? TITLE_STYLE_DEFAULTS.lineHeight,
            color: "#fff", whiteSpace: "nowrap",
            ...(titleSp ? { letterSpacing: titleSp } : {}),
            ...(layout.titleShadow === false ? {} : { textShadow: "0 2px 6px rgba(0,0,0,.5)" }),
            // 제목 글꼴 = 지마켓 산스(고객사 지정 2026-08-28) — factory.ts 가 titleLines 에
            // font:"gmarket" 을 심고 렌더는 그 파일로 굽는다. 미리보기도 같은 글꼴이어야
            // "미리보기와 결과물이 다르다" 가 안 생긴다. titleFont 를 고르면 그 글꼴로 그린다.
            fontFamily: fontFamilyCss(layout.titleFont) ?? "'GmarketSans', var(--font-sans)",
          }}>
          훅 첫 줄 텍스트
          <div style={{ color: layout.titleColor || accent }}>둘째 줄 강조</div>
        </div>
      )}
      {/* 로고 — 프로그램의 쇼츠 아이콘이 있으면 그대로 보여준다. 실렌더(index.ts)와 같은 규칙:
          크기 = 높이 기준, 폭은 이미지 비율을 따른다(가로 워드마크·세로 아이콘 모두 수용). */}
      {layout.logo !== false && (iconSrc ? (
        <img src={iconSrc} alt="쇼츠 아이콘"
          className="absolute left-1/2 max-w-[80%] -translate-x-1/2 object-contain"
          style={{ top: `${layout.channelIconY}%`, height: `${iconPct}%`, width: "auto" }} />
      ) : (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-sm"
          style={{ top: `${layout.channelIconY}%`, width: `${iconPct * 1.4}%`, height: `${iconPct}%`, background: "#666" }} />
      ))}
      {/* 시간 박스 — 문구는 프로그램 설정의 편성 문구(schedule). 미리보기에 프로그램 값이 오면 그걸 쓴다.
          상단 앵커(top = channelBoxY%)는 ASS \an8\pos 과 동형 · 크기는 출력 66px 비율. */}
      {layout.timebox !== false && (
        <div className="absolute left-1/2 -translate-x-1/2 text-center font-bold"
          style={{
            // 시간박스 스타일(2026-09-15 목업) — 글꼴·배경색·크기(%). 렌더 BoxLabel(\fn·\3c·\fs 배율) 미러.
            top: `${layout.channelBoxY}%`,
            fontSize: timeboxFs * Math.min(2, Math.max(0.5, (layout.timeboxSize ?? 100) / 100)),
            color: "#fff",
            background: layout.timeboxColor || "#3D7BD9",
            fontFamily: fontFamilyCss(layout.timeboxFont) ?? undefined,
            paddingInline: 4 * s, borderRadius: 2 * s, whiteSpace: "nowrap",
          }}>
          {timeboxText || "(수) 밤 10시 30분"}
        </div>
      )}
    </div>
  );
}

/**
 * 템플릿 설정 컨트롤 — 소형(고급 설정 옆)과 대형 다이얼로그가 같은 목록을 쓴다.
 * min/max 를 두 곳에 복제하면 한쪽만 고치게 된다.
 *
 * 2026-09-15 확장: 섹션 3개로 재편 — **위치 조절**(요소 표시 + 위치 슬라이더) ·
 * **제목 스타일**(폰트·강조색·크기%·자간·행간·그림자) · **자막 스타일**(폰트·글자색·
 * 크기·자간·그림자 — 자막 크기는 위치 조절에서 여기로 이동). 전부 rule.layout 으로
 * 라운드트립되고 factory.autoEditorState → 렌더가 같은 값을 굽는다.
 */
export function LayoutSliders({ layout, onChange, className, subtitlesOn, onSubtitlesChange }: {
  layout: LayoutState;
  onChange: (next: LayoutState) => void;
  className?: string;
  /** 자막 on/off — 규칙의 자막 토글과 **같은 상태**를 부모가 넘긴다(두 벌 금지). 없으면 자막 줄 숨김. */
  subtitlesOn?: boolean;
  onSubtitlesChange?: (on: boolean) => void;
}) {
  /** 원본 슬라이더는 채운 만큼 파랑이다(D:1361) — 값에서 비율을 직접 만든다. */
  const track = (v: number, min: number, max: number) =>
    `linear-gradient(to right, #1C60FF 0%, #1C60FF ${((v - min) / (max - min)) * 100}%, #E2E8F0 ${((v - min) / (max - min)) * 100}%, #E2E8F0 100%)`;

  /** 슬라이더 한 줄 — 옵셔널 키는 기본값(d)으로 그린다. 숫자 필드만 받는다(색·글꼴·불리언 제외). */
  type NumKey = "titleY" | "channelIconY" | "channelBoxY" | "channelIconSize" | "subtitleY"
    | "subtitleSize" | "titleSize" | "titleSpacing" | "titleLineHeight" | "subtitleSpacing"
    | "subtitleShadowX" | "subtitleShadowY" | "subtitleBgOpacity" | "timeboxSize";
  const slider = (
    label: string, key: NumKey, min: number, max: number, step: number,
    unit: string, digits: number, d?: number,
  ) => {
    const v = typeof layout[key] === "number" ? (layout[key] as number) : (d ?? 0);
    return (
      <div key={String(key)} className="space-y-0.5">
        <div className="flex justify-between text-[11px] text-[var(--color-text-muted)] font-semibold">
          <span>{label} {v.toFixed(digits)}{unit}</span>
        </div>
        <input
          type="range" min={min} max={max} step={step} value={v}
          onChange={(e) => onChange({ ...layout, [key]: Number(e.target.value) })}
          style={{ background: track(v, min, max), boxShadow: "none" }}
          className="w-full accent-[#1C60FF] cursor-pointer appearance-none border-none outline-none focus:outline-none h-1.5 rounded-full"
        />
      </div>
    );
  };

  /** 색 픽커 한 줄 (제목 강조색·자막 글자색). */
  const colorRow = (label: string, key: "titleColor" | "subtitleColor") => (
    <div key={key} className="flex items-center justify-between text-xs font-semibold">
      <span className="text-[var(--color-text-muted)] flex items-center gap-2">
        <span>{label}</span>
        <strong className="text-[var(--color-text-primary)] font-mono">{layout[key]}</strong>
      </span>
      <div className="relative">
        <input
          type="color" id={`layout-${key}`} value={layout[key]}
          onChange={(e) => onChange({ ...layout, [key]: e.target.value })}
          className="sr-only"
        />
        <label
          htmlFor={`layout-${key}`}
          aria-label={label}
          style={{ backgroundColor: layout[key] }}
          className="w-8 h-4 block rounded border border-white/20 cursor-pointer shadow-none"
        />
      </div>
    </div>
  );

  /** 글꼴 픽커 — 빈 값 = 기본(지마켓 산스 · 서버 렌더 기본과 동일). id 는 서버 카탈로그와 1:1. */
  const fontRow = (label: string, key: "titleFont" | "captionFont") => (
    <div key={key} className="space-y-1">
      <div className="text-[11px] text-[var(--color-text-muted)] font-semibold">{label}</div>
      <select
        value={layout[key] ?? ""}
        onChange={(e) => onChange({ ...layout, [key]: e.target.value || undefined })}
        aria-label={label}
        className="w-full h-8 px-2 rounded-lg bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] focus:outline-none transition-colors"
      >
        <option value="">기본 (지마켓 산스)</option>
        {FONT_FAMILY_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
    </div>
  );

  /** 그림자 체크박스 — 미지정 = 켬(렌더 기본). */
  const shadowRow = (key: "titleShadow" | "subtitleShadow") => (
    <label key={key} className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-[var(--color-text-primary)]">
      <input
        type="checkbox" checked={layout[key] !== false}
        onChange={(e) => onChange({ ...layout, [key]: e.target.checked ? undefined : false })}
        className="w-4 h-4 rounded accent-[#1C60FF]"
      />
      <span>그림자</span>
    </label>
  );

  const section = (title: string) => (
    <div className="pt-1 text-xs font-bold text-[var(--color-text-primary)] border-t border-[var(--color-border-subtle)]/60 mt-2 first:mt-0 first:border-t-0 first:pt-0">
      {title}
    </div>
  );

  return (
    <div className={className}>
      {/* ── 위치 조절 ─────────────────────────────────────────────── */}
      {section("위치 조절")}
      {/* Checkboxes Row — 요소 표시. 고객마다 로고·시간박스·제목·자막을 뺄 수 있다(2026-08-24).
          체크 해제 = 미리보기에서 즉시 사라지고, 저장 시 rule.layout 플래그로 렌더에도 빠진다. */}
      <div className="flex items-center gap-4 flex-wrap text-xs font-bold text-[var(--color-text-primary)]">
        {([["title", "제목"], ["logo", "로고"], ["timebox", "시간박스"]] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox" checked={layout[key] !== false}
              onChange={(e) => onChange({ ...layout, [key]: e.target.checked })}
              className="w-4 h-4 rounded text-[var(--text-accent)] accent-[#1C60FF]"
            />
            <span>{label}</span>
          </label>
        ))}
        {onSubtitlesChange && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox" checked={subtitlesOn !== false}
              onChange={(e) => onSubtitlesChange(e.target.checked)}
              className="w-4 h-4 rounded text-[var(--text-accent)] accent-[#1C60FF]"
            />
            <span>자막</span>
          </label>
        )}
      </div>

      <div className="space-y-2.5">
        {/* 위치·크기(px)는 서버 렌더와 같은 축이라 그대로 결과물에 반영된다. */}
        {slider("제목 위치", "titleY", 3, 30, 0.5, "%", 0)}
        {slider("로고 위치", "channelIconY", 60, 92, 0.5, "%", 0)}
        {slider("로고 크기", "channelIconSize", 20, 90, 0.5, "px", 0)}
        {slider("시간박스 위치", "channelBoxY", 62, 94, 0.5, "%", 0)}
        {slider("자막 위치", "subtitleY", 4, 40, 0.5, "%", 0)}
      </div>

      {/* ── 제목 스타일 ───────────────────────────────────────────── */}
      {section("제목 스타일")}
      <div className="space-y-2.5">
        {fontRow("폰트", "titleFont")}
        {/* 강조색 — 렌더 titleLines 강조 줄 색(편집기·factory titleAccent 와 같은 축). */}
        {colorRow("강조색", "titleColor")}
        {slider("제목 크기", "titleSize", 50, 200, 5, "%", 0, TITLE_STYLE_DEFAULTS.size)}
        {slider("자간", "titleSpacing", -10, 30, 0.5, "px", 0, TITLE_STYLE_DEFAULTS.spacing)}
        {slider("행간", "titleLineHeight", 0.8, 2, 0.05, "", 2, TITLE_STYLE_DEFAULTS.lineHeight)}
        {shadowRow("titleShadow")}
      </div>

      {/* ── 자막 스타일 ───────────────────────────────────────────── */}
      {section("자막 스타일")}
      <div className="space-y-2.5">
        {fontRow("폰트", "captionFont")}
        {/* 글자색은 서버 렌더의 captionColor 로 옮겨진다. */}
        {colorRow("글자색", "subtitleColor")}
        {slider("자막 크기", "subtitleSize", 2.5, 7, 0.1, "%", 1)}
        {slider("자간", "subtitleSpacing", -10, 30, 0.5, "px", 0, 0)}
        {shadowRow("subtitleShadow")}
        {/* 그림자 오프셋(출력 px · ASS \xshad·\yshad) — 그림자를 켠 상태에서만 의미가 있다.
            목업 "그림자 X 0px · Y 2px". '퍼짐'은 ASS 그림자에 없어 받지 않는다(스키마 주석). */}
        {layout.subtitleShadow !== false && (
          <>
            {slider("그림자 X", "subtitleShadowX", -10, 10, 1, "px", 0, 0)}
            {slider("그림자 Y", "subtitleShadowY", -10, 10, 1, "px", 0, 2)}
          </>
        )}
        {/* 외곽선 — 끔 + 색(목업 "외곽선 ✓ · 외곽선 색"). 폭은 스타일 프리셋이 정한다. */}
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-[var(--color-text-primary)]">
            <input
              type="checkbox" checked={layout.subtitleStroke !== false}
              onChange={(e) => onChange({ ...layout, subtitleStroke: e.target.checked ? undefined : false })}
              className="w-4 h-4 rounded accent-[#1C60FF]"
            />
            <span>외곽선</span>
          </label>
          {layout.subtitleStroke !== false && (
            <div className="relative flex items-center gap-2 text-xs font-semibold">
              <strong className="text-[var(--color-text-primary)] font-mono">{layout.subtitleStrokeColor ?? "#000000"}</strong>
              <input
                type="color" id="layout-subtitleStrokeColor" value={layout.subtitleStrokeColor ?? "#000000"}
                onChange={(e) => onChange({ ...layout, subtitleStrokeColor: e.target.value })}
                className="sr-only"
              />
              <label htmlFor="layout-subtitleStrokeColor" aria-label="외곽선 색"
                style={{ backgroundColor: layout.subtitleStrokeColor ?? "#000000" }}
                className="w-8 h-4 block rounded border border-white/20 cursor-pointer shadow-none" />
            </div>
          )}
        </div>
        {/* 배경 박스(ASS BorderStyle 3) — 색 + 불투명도. 라운딩은 ASS 에 없어 두지 않는다. */}
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-[var(--color-text-primary)]">
            <input
              type="checkbox" checked={layout.subtitleBg === true}
              onChange={(e) => onChange({ ...layout, subtitleBg: e.target.checked ? true : undefined })}
              className="w-4 h-4 rounded accent-[#1C60FF]"
            />
            <span>배경색</span>
          </label>
          {layout.subtitleBg === true && (
            <div className="relative flex items-center gap-2 text-xs font-semibold">
              <strong className="text-[var(--color-text-primary)] font-mono">{layout.subtitleBgColor ?? "#000000"}</strong>
              <input
                type="color" id="layout-subtitleBgColor" value={layout.subtitleBgColor ?? "#000000"}
                onChange={(e) => onChange({ ...layout, subtitleBgColor: e.target.value })}
                className="sr-only"
              />
              <label htmlFor="layout-subtitleBgColor" aria-label="배경색"
                style={{ backgroundColor: layout.subtitleBgColor ?? "#000000" }}
                className="w-8 h-4 block rounded border border-white/20 cursor-pointer shadow-none" />
            </div>
          )}
        </div>
        {layout.subtitleBg === true && slider("배경 투명도", "subtitleBgOpacity", 0, 100, 5, "%", 0, 60)}
      </div>

      {/* ── 시간박스 (목업 "시간박스" 절 · 2026-09-15) ─────────────────── */}
      {section("시간박스")}
      <div className="space-y-2.5">
        <div className="space-y-1">
          <div className="text-[11px] text-[var(--color-text-muted)] font-semibold">폰트</div>
          <select
            value={layout.timeboxFont ?? ""}
            onChange={(e) => onChange({ ...layout, timeboxFont: e.target.value || undefined })}
            aria-label="시간박스 폰트"
            className="w-full h-8 px-2 rounded-lg bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] focus:outline-none transition-colors"
          >
            <option value="">기본 (Pretendard)</option>
            {FONT_FAMILY_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between text-xs font-semibold">
          <span className="text-[var(--color-text-muted)] flex items-center gap-2">
            <span>배경색</span>
            <strong className="text-[var(--color-text-primary)] font-mono">{layout.timeboxColor ?? "#3D7BD9"}</strong>
          </span>
          <div className="relative">
            <input
              type="color" id="layout-timeboxColor" value={layout.timeboxColor ?? "#3D7BD9"}
              onChange={(e) => onChange({ ...layout, timeboxColor: e.target.value })}
              className="sr-only"
            />
            <label htmlFor="layout-timeboxColor" aria-label="시간박스 배경색"
              style={{ backgroundColor: layout.timeboxColor ?? "#3D7BD9" }}
              className="w-8 h-4 block rounded border border-white/20 cursor-pointer shadow-none" />
          </div>
        </div>
        {slider("크기", "timeboxSize", 50, 200, 5, "%", 0, 100)}
      </div>
    </div>
  );
}

/**
 * 템플릿 설정 다이얼로그 — 소형 카드가 실제 결과감을 못 준다는 피드백에서 나왔다.
 * 9:16 프리뷰를 뷰포트 높이 ~80% 로 키우고, 컨트롤을 옆에 둬 움직이면 즉시 반영된다
 * (부모 layout 상태를 그대로 공유 — 다이얼로그 전용 사본을 만들면 닫을 때 유실된다).
 * 관용구는 upload-video-dialog(오버레이 클릭 닫힘) + billing-ui(ESC window keydown).
 *
 * 2026-09-15: "템플릿 설정" 으로 승격 — 레이아웃(세로 영상 배치) 픽커가 고급 설정에서
 * 여기로 들어왔고(onAspectChange), 제목/자막 스타일 섹션(LayoutSliders)이 붙었다.
 */
export function TemplatePreviewDialog({ template, accent, layout, frameSrc, subtitlesOn = true, onSubtitlesChange, timeboxText, iconSrc, aspect, onAspectChange, aspectDisabled, onLayoutChange, onClose }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
  frameSrc?: string;
  subtitlesOn?: boolean;
  /** 자막 토글 콜백 — 부모(자동배포 화면)의 자막 상태를 그대로 조작한다. */
  onSubtitlesChange?: (on: boolean) => void;
  /** 시간박스 문구 — 선택한 프로그램의 편성 문구(schedule). 없으면 예시 표기. */
  timeboxText?: string;
  /** 로고 이미지 — 선택한 프로그램의 쇼츠 아이콘. TemplatePreview 로 그대로 전달. */
  iconSrc?: string;
  /** 세로 영상 배치 — 미리보기의 영상 영역을 이 배치로 그린다. */
  aspect?: string;
  /** 배치 변경 콜백 — 있으면 레이아웃 픽커 섹션을 그린다("" = 자동 · 영상 템플릿 기본). */
  onAspectChange?: (id: string) => void;
  /** 클립(가로) 전용 계획 등 배치가 무의미할 때 픽커를 흐리게 잠근다. */
  aspectDisabled?: boolean;
  onLayoutChange: (next: LayoutState) => void;
  onClose: () => void;
}) {
  // ESC 로 닫는다 — billing-ui·clip-detail 과 같은 window keydown 관용구.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 폰트 스케일이 px 기준이라 폭도 px 로 계산한다 — 뷰포트 높이 80% 의 9:16 실척.
  const [w, setW] = useState(320);
  useEffect(() => {
    const calc = () => setW(Math.round(Math.min(
      window.innerHeight * 0.8 * (9 / 16),
      window.innerWidth * 0.55, // 좁은 화면에서 슬라이더 자리 확보
    )));
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-xs" onClick={onClose} aria-hidden />
      <div
        className="relative flex max-h-[92vh] flex-wrap items-start gap-4 overflow-y-auto rounded-2xl border border-[var(--color-border-card)] bg-[var(--color-bg-card)] p-4 shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="템플릿 설정"
      >
        <TemplatePreview template={template} accent={accent} layout={layout} frameSrc={frameSrc} subtitlesOn={subtitlesOn} timeboxText={timeboxText} iconSrc={iconSrc} aspect={aspect} width={w} />
        {/* 컨트롤 컬럼은 **내용 높이**로 둔다. self-stretch 를 걸면 세로로 긴 9:16 프리뷰(≈800px)
            높이에 맞춰 늘어나고, mt-auto 닫기 버튼이 그 바닥까지 밀려 컨트롤과 버튼 사이에 거대한
            빈 공간이 생긴다(사용자 2026-08-21 "왜 이래 ㅋㅋ"). 프리뷰 위쪽에 정렬(items-start)해 붙인다.
            섹션이 늘어 프리뷰보다 길어질 수 있어 컬럼 자체 스크롤을 준다(프리뷰는 그대로 보인다). */}
        <div className="flex min-w-[240px] max-w-[340px] max-h-[84vh] flex-col gap-2 overflow-y-auto pr-1">
          <h2 className="text-base font-bold text-[var(--color-text-primary)]">
            템플릿 설정{template?.title || template?.name ? ` — ${template?.title || template?.name}` : ""}
          </h2>
          <p className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
            style={{ background: "var(--color-bg-input)", color: "var(--color-text-muted)" }}>
            여기서 저장한 값은 이 프로그램의 <b style={{ color: "var(--color-text-primary)" }}>모든 영상에 기본으로</b> 고정
            적용됩니다. 영상별 예외 수정은 배포 예정의 확인·수정(편집)에서 합니다. 미리보기는 실제 렌더와
            같은 좌표로 그립니다 — 움직이면 저장될 값이 그대로 바뀝니다.
          </p>

          {/* ── 레이아웃 (세로 영상 배치) — 편집기 프리셋과 같은 id·라벨(aspect-presets 정본). ── */}
          {onAspectChange && (
            <div className="space-y-1.5" style={aspectDisabled ? { opacity: 0.65, pointerEvents: "none" } : undefined}>
              <div className="text-xs font-bold text-[var(--color-text-primary)]">
                레이아웃 <span className="font-medium text-[var(--color-text-muted)]">영상 배치</span>
              </div>
              <button
                type="button"
                onClick={() => onAspectChange("")}
                className={`w-full rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors border ${
                  !aspect
                    ? "border-[#1C60FF] bg-[#1C60FF]/5 dark:bg-[#1C60FF]/10"
                    : "border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] hover:border-slate-400"
                }`}
              >
                <div className="font-bold text-[var(--color-text-primary)]">자동 (영상 템플릿 기본)</div>
                <div className="text-[var(--color-text-muted)]">템플릿이 정한 영상창 그대로</div>
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                {ASPECT_PRESETS.filter((p) => (RULE_ASPECTS as readonly string[]).includes(p.id)).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onAspectChange(p.id)}
                    className={`rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors border flex items-center gap-2 ${
                      aspect === p.id
                        ? "border-[#1C60FF] bg-[#1C60FF]/5 dark:bg-[#1C60FF]/10"
                        : "border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] hover:border-slate-400"
                    }`}
                  >
                    <AspectGlyph id={p.id} />
                    <div className="min-w-0">
                      <div className="font-bold text-[var(--color-text-primary)]">{p.label.replace(/^세로 · /, "")}</div>
                      <div className="text-[var(--color-text-muted)]">{p.hint}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <LayoutSliders layout={layout} onChange={onLayoutChange} className="space-y-3.5 text-[11px]"
            subtitlesOn={subtitlesOn} onSubtitlesChange={onSubtitlesChange} />
          <button
            type="button"
            onClick={onClose}
            className="mt-3 self-start px-3.5 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer transition-colors shadow-none"
          >
            닫기 (ESC)
          </button>
        </div>
      </div>
    </div>
  );
}
