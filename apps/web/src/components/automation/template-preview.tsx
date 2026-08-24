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
};

/**
 * 자막 오버레이 기본값 — 서버 렌더(index.ts buildEditorAss)의 자막 기본과 **1:1**.
 * y = 화면 하단 26%(= 서버 CAPTION_MV_PCT) · size = 화면 높이의 4.4%(= 서버 CAPTION_PCT.korean_pop)
 * · 색 = 흰색(= 렌더 korean_pop 기본색). overlay-parity.test.ts 가 이 값이 서버와 갈라지지 않게 강제한다.
 */
export const SUBTITLE_DEFAULTS = { y: 26, size: 4.4, color: "#FFFFFF" } as const;

/** 소형 카드 기준 폭 — 폰트·패딩은 이 폭 대비 비율로 스케일된다(레이아웃 %좌표는 불변). */
const BASE_W = 120;

export function TemplatePreview({ template, accent, layout, frameSrc, subtitlesOn = true, timeboxText, width = BASE_W }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
  /** 영상 영역 배경으로 깔 실제 샘플 프레임(사용자 최근 회차). 없으면 회색 그라디언트 폴백. */
  frameSrc?: string;
  /** 자막 오버레이 표시 여부 — 규칙의 자막 on/off 를 그대로 반영한다(꺼지면 자막이 사라진다). */
  subtitlesOn?: boolean;
  /** 시간박스 문구 — 실제 렌더는 프로그램 설정의 편성 문구(schedule)를 쓴다. 없으면 예시 표기. */
  timeboxText?: string;
  width?: number;
}) {
  const s = width / BASE_W;
  const video = template?.video ?? { x: 0, y: 34.2, w: 100, h: 31.7 };
  const iconPct = (layout.channelIconSize * 3 / 1920) * 100; // px(에디터) → 출력높이 → %
  // 자막 글자 크기 = 화면 높이의 subtitleSize%. 9:16 이라 높이 = width·16/9 (px). 서버 렌더의
  // fs = H·CAPTION_PCT/100 과 같은 축 — % 값이 같으면 결과물 자막과 같은 크기로 보인다.
  const subFs = (width * 16 / 9) * layout.subtitleSize / 100;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-md border"
      style={{ width, aspectRatio: "9/16", background: "#000", borderColor: "var(--sd-border)" }}>
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
            textShadow: "0 1px 3px rgba(0,0,0,.85)", paddingInline: 6 * s,
          }}>
          예시 자막입니다
        </div>
      )}
      {/* 제목 2줄 — 각 줄은 한 시각 줄로 고정(nowrap · D). 서버 렌더/에디터와 줄 수 일치. */}
      {layout.title !== false && (
        <div className="absolute text-center font-bold leading-tight"
          style={{ top: `${layout.titleY}%`, left: 4 * s, right: 4 * s, fontSize: 7 * s, color: "#fff", whiteSpace: "nowrap" }}>
          훅 첫 줄 텍스트
          <div style={{ color: layout.titleColor || accent }}>둘째 줄 강조</div>
        </div>
      )}
      {/* 로고 */}
      {layout.logo !== false && (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-sm"
          style={{ top: `${layout.channelIconY}%`, width: `${iconPct * 1.4}%`, height: `${iconPct}%`, background: "#666" }} />
      )}
      {/* 시간 박스 — 문구는 프로그램 설정의 편성 문구(schedule). 미리보기에 프로그램 값이 오면 그걸 쓴다. */}
      {layout.timebox !== false && (
        <div className="absolute left-1/2 -translate-x-1/2 text-center font-bold"
          style={{
            top: `${layout.channelBoxY}%`, fontSize: 5.5 * s, color: "#fff", background: "#3D7BD9",
            paddingInline: 4 * s, borderRadius: 2 * s, whiteSpace: "nowrap",
          }}>
          {timeboxText || "(수) 밤 10시 30분"}
        </div>
      )}
    </div>
  );
}

/**
 * 위치 조절 슬라이더 — 소형(고급 설정 옆)과 대형 다이얼로그가 같은 목록을 쓴다.
 * min/max 를 두 곳에 복제하면 한쪽만 고치게 된다.
 */
export function LayoutSliders({ layout, onChange, className, subtitlesOn, onSubtitlesChange }: {
  layout: LayoutState;
  onChange: (next: LayoutState) => void;
  className?: string;
  /** 자막 on/off — 규칙의 자막 토글과 **같은 상태**를 부모가 넘긴다(두 벌 금지). 없으면 자막 줄 숨김. */
  subtitlesOn?: boolean;
  onSubtitlesChange?: (on: boolean) => void;
}) {
  return (
    <div className={className} style={{ color: "var(--sd-fg-dim)" }}>
      {/* 요소 표시 — 고객마다 로고·시간박스·제목·자막을 뺄 수 있다(사용자 2026-08-24).
          체크 해제 = 미리보기에서 즉시 사라지고, 저장 시 rule.layout 플래그로 렌더에도 빠진다. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pb-1">
        {([["title", "제목"], ["logo", "로고"], ["timebox", "시간박스"]] as const).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox" checked={layout[key] !== false}
              onChange={(e) => onChange({ ...layout, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        {onSubtitlesChange && (
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox" checked={subtitlesOn !== false}
              onChange={(e) => onSubtitlesChange(e.target.checked)}
            />
            자막
          </label>
        )}
      </div>
      {([
        // [라벨, 키, min, max, step, 단위, 소수자리]
        ["제목 위치", "titleY", 3, 30, 0.5, "%", 0],
        ["로고 위치", "channelIconY", 60, 92, 0.5, "%", 0],
        ["시간박스 위치", "channelBoxY", 62, 94, 0.5, "%", 0],
        ["로고 크기", "channelIconSize", 20, 90, 0.5, "px", 0],
        // 자막 — 위치(하단 기준 %)·크기(화면 높이 %). 서버 렌더와 같은 축이라 그대로 결과물에 반영된다.
        ["자막 위치", "subtitleY", 4, 40, 0.5, "%", 0],
        ["자막 크기", "subtitleSize", 2.5, 7, 0.1, "%", 1],
      ] as const).map(([label, key, min, max, step, unit, digits]) => (
        <label key={key} className="block">
          {label} <span className="opacity-70">{layout[key].toFixed(digits)}{unit}</span>
          <input
            type="range" min={min} max={max} step={step} value={layout[key]}
            onChange={(e) => onChange({ ...layout, [key]: Number(e.target.value) })}
            className="w-full"
          />
        </label>
      ))}
      {/* 제목 강조색 — 렌더 titleLines 강조 줄 색(편집기·factory titleAccent 와 같은 축). */}
      <label className="flex items-center gap-2">
        제목 색 <span className="opacity-70">{layout.titleColor}</span>
        <input
          type="color" value={layout.titleColor}
          onChange={(e) => onChange({ ...layout, titleColor: e.target.value })}
          className="ml-auto h-5 w-8 cursor-pointer"
        />
      </label>
      {/* 자막 색 — 슬라이더가 아니라 색상 선택. 서버 렌더의 captionColor(자막 색)로 옮겨진다. */}
      <label className="flex items-center gap-2">
        자막 색 <span className="opacity-70">{layout.subtitleColor}</span>
        <input
          type="color" value={layout.subtitleColor}
          onChange={(e) => onChange({ ...layout, subtitleColor: e.target.value })}
          className="ml-auto h-5 w-8 cursor-pointer"
        />
      </label>
    </div>
  );
}

/**
 * 대형 미리보기 다이얼로그 — 소형 카드가 실제 결과감을 못 준다는 피드백에서 나왔다.
 * 9:16 프리뷰를 뷰포트 높이 ~80% 로 키우고, 슬라이더를 옆에 둬 움직이면 즉시 반영된다
 * (부모 layout 상태를 그대로 공유 — 다이얼로그 전용 사본을 만들면 닫을 때 유실된다).
 * 관용구는 upload-video-dialog(오버레이 클릭 닫힘) + billing-ui(ESC window keydown).
 */
export function TemplatePreviewDialog({ template, accent, layout, frameSrc, subtitlesOn = true, onSubtitlesChange, timeboxText, onLayoutChange, onClose }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
  frameSrc?: string;
  subtitlesOn?: boolean;
  /** 자막 토글 콜백 — 부모(자동배포 화면)의 자막 상태를 그대로 조작한다. */
  onSubtitlesChange?: (on: boolean) => void;
  /** 시간박스 문구 — 선택한 프로그램의 편성 문구(schedule). 없으면 예시 표기. */
  timeboxText?: string;
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
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[92vh] flex-wrap items-start gap-4 overflow-y-auto bg-[var(--sd-card)] p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="템플릿 대형 미리보기"
      >
        <TemplatePreview template={template} accent={accent} layout={layout} frameSrc={frameSrc} subtitlesOn={subtitlesOn} timeboxText={timeboxText} width={w} />
        {/* 컨트롤 컬럼은 **내용 높이**로 둔다. self-stretch 를 걸면 세로로 긴 9:16 프리뷰(≈800px)
            높이에 맞춰 늘어나고, mt-auto 닫기 버튼이 그 바닥까지 밀려 컨트롤과 버튼 사이에 거대한
            빈 공간이 생긴다(사용자 2026-08-21 "왜 이래 ㅋㅋ"). 프리뷰 위쪽에 정렬(items-start)해 붙인다. */}
        <div className="flex min-w-[200px] max-w-[240px] flex-col gap-2">
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            {template?.title || template?.name || "템플릿 미리보기"}
          </h2>
          <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
            실제 렌더와 같은 % 좌표로 그립니다 — 슬라이더를 움직이면 저장될 위치가 그대로 바뀝니다.
          </p>
          <LayoutSliders layout={layout} onChange={onLayoutChange} className="space-y-2 text-[10.5px]"
            subtitlesOn={subtitlesOn} onSubtitlesChange={onSubtitlesChange} />
          <button type="button" className="sd-btn mt-3 self-start" onClick={onClose}>
            닫기 (ESC)
          </button>
        </div>
      </div>
    </div>
  );
}
