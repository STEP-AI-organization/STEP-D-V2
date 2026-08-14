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
};

/** 소형 카드 기준 폭 — 폰트·패딩은 이 폭 대비 비율로 스케일된다(레이아웃 %좌표는 불변). */
const BASE_W = 120;

export function TemplatePreview({ template, accent, layout, width = BASE_W }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
  width?: number;
}) {
  const s = width / BASE_W;
  const video = template?.video ?? { x: 0, y: 34.2, w: 100, h: 31.7 };
  const iconPct = (layout.channelIconSize * 3 / 1920) * 100; // px(에디터) → 출력높이 → %
  return (
    <div className="relative shrink-0 overflow-hidden rounded-md border"
      style={{ width, aspectRatio: "9/16", background: "#000", borderColor: "var(--sd-border)" }}>
      {/* 영상 영역 */}
      <div className="absolute" style={{
        left: `${video.x}%`, top: `${video.y}%`, width: `${video.w}%`, height: `${video.h}%`,
        background: "linear-gradient(135deg,#2a3f4d,#1a2630)",
      }} />
      {/* 제목 2줄 */}
      <div className="absolute text-center font-bold leading-tight"
        style={{ top: `${layout.titleY}%`, left: 4 * s, right: 4 * s, fontSize: 7 * s, color: "#fff" }}>
        훅 첫 줄 텍스트
        <div style={{ color: accent }}>둘째 줄 강조</div>
      </div>
      {/* 로고 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-sm"
        style={{ top: `${layout.channelIconY}%`, width: `${iconPct * 1.4}%`, height: `${iconPct}%`, background: "#666" }} />
      {/* 시간 박스 */}
      <div className="absolute left-1/2 -translate-x-1/2 text-center font-bold"
        style={{
          top: `${layout.channelBoxY}%`, fontSize: 5.5 * s, color: "#fff", background: "#3D7BD9",
          paddingInline: 4 * s, borderRadius: 2 * s,
        }}>
        (수) 밤 10시 30분
      </div>
    </div>
  );
}

/**
 * 위치 조절 슬라이더 — 소형(고급 설정 옆)과 대형 다이얼로그가 같은 목록을 쓴다.
 * min/max 를 두 곳에 복제하면 한쪽만 고치게 된다.
 */
export function LayoutSliders({ layout, onChange, className }: {
  layout: LayoutState;
  onChange: (next: LayoutState) => void;
  className?: string;
}) {
  return (
    <div className={className} style={{ color: "var(--sd-fg-dim)" }}>
      {([
        ["제목 위치", "titleY", 3, 30],
        ["로고 위치", "channelIconY", 60, 92],
        ["시간박스 위치", "channelBoxY", 62, 94],
        ["로고 크기", "channelIconSize", 20, 90],
      ] as const).map(([label, key, min, max]) => (
        <label key={key} className="block">
          {label} <span className="opacity-70">{Math.round(layout[key])}{key === "channelIconSize" ? "px" : "%"}</span>
          <input
            type="range" min={min} max={max} step={0.5} value={layout[key]}
            onChange={(e) => onChange({ ...layout, [key]: Number(e.target.value) })}
            className="w-full"
          />
        </label>
      ))}
    </div>
  );
}

/**
 * 대형 미리보기 다이얼로그 — 소형 카드가 실제 결과감을 못 준다는 피드백에서 나왔다.
 * 9:16 프리뷰를 뷰포트 높이 ~80% 로 키우고, 슬라이더를 옆에 둬 움직이면 즉시 반영된다
 * (부모 layout 상태를 그대로 공유 — 다이얼로그 전용 사본을 만들면 닫을 때 유실된다).
 * 관용구는 upload-video-dialog(오버레이 클릭 닫힘) + billing-ui(ESC window keydown).
 */
export function TemplatePreviewDialog({ template, accent, layout, onLayoutChange, onClose }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
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
        className="sd-modal relative flex max-h-[92vh] flex-wrap items-start gap-4 overflow-y-auto bg-white p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="템플릿 대형 미리보기"
      >
        <TemplatePreview template={template} accent={accent} layout={layout} width={w} />
        <div className="flex min-w-[200px] max-w-[240px] flex-col gap-2 self-stretch">
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            {template?.title || template?.name || "템플릿 미리보기"}
          </h2>
          <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
            실제 렌더와 같은 % 좌표로 그립니다 — 슬라이더를 움직이면 저장될 위치가 그대로 바뀝니다.
          </p>
          <LayoutSliders layout={layout} onChange={onLayoutChange} className="space-y-2 text-[10.5px]" />
          <button type="button" className="sd-btn mt-auto self-start" onClick={onClose}>
            닫기 (ESC)
          </button>
        </div>
      </div>
    </div>
  );
}
