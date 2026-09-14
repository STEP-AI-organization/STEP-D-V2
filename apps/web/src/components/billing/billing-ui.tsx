"use client";

/**
 * 결제 화면 공용 소컴포넌트 (2026-08-14 · Google AI Studio 결제 화면 구조).
 *
 * 이 디자인의 시그니처는 **카드 하단의 border-top + 중앙 정렬 + 액센트 텍스트 버튼**
 * (CardAction)이다 — 모든 카드가 "본문은 조용히, 행동은 하단 한 줄"로 끝난다.
 * 반복되는 카드 껍데기(BillingCard)와 다이얼로그(BillingDialog)도 여기 모은다.
 *
 * 오버레이·패널·헤더/본문/푸터 3단과 ESC 닫기는 리포의 공용 모달 관용구를 따른다.
 * 마크업은 디자이너 원본(credits MODAL 1·2)을 따른다 — 새 라이브러리는 쓰지 않는다.
 */
import { useEffect } from "react";
import { X } from "lucide-react";
import { MODAL_W } from "@/components/ui/tokens";

/**
 * 결제 화면 다이얼로그 껍데기. 오버레이 클릭·ESC·닫기 버튼으로 닫힌다 —
 * 단 `closeDisabled`(결제 진행 중 등)면 셋 다 막는다.
 */
export function BillingDialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  maxWidth = MODAL_W.lg,
  closeDisabled,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 하단 고정 영역 — 상단 보더로 분리된다. 결제 버튼처럼 "마지막 행동"이 들어간다. */
  footer?: React.ReactNode;
  /**
   * 패널 최대 폭(px). **디자이너 원본의 Tailwind 값과 같은 숫자를 쓴다** —
   * `max-w-md` 448 · `max-w-lg` 512 · `max-w-xl` 576 · `max-w-2xl` 672.
   *
   * 원본은 클래스로 잡는데 여기는 style 로 받으므로, 어림수(440·520·640)를 쓰면
   * 모달마다 8~64px 씩 어긋난다 — 실제로 그래서 "가로 너비가 약간 다르다" 는 지적이
   * 나왔다(2026-09-07). 새 다이얼로그를 넣을 때도 위 네 숫자 중에서 고를 것.
   */
  maxWidth?: number;
  /** 진행 중(결제 등)에는 닫기를 막는다 — 오버레이·ESC·버튼 공통. */
  closeDisabled?: boolean;
}) {
  // ESC 로 닫는다 — clip-detail.tsx 와 같은 window keydown 관용구.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeDisabled]);

  return (
    // 껍데기도 **디자이너 원본(credits MODAL 1·2)** 그대로. 2026-09-07 이전엔 여기만
    // 옛 시스템(`sd-modal`·`--sd-card`·`--sd-border`·`sd-serif`)이라, 내용은 새 디자인인데
    // 감싸는 창은 옛 디자인인 상태였다 — 같은 화면에서 디자인이 갈려 보이는 정체가 이거였다.
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 cursor-pointer"
      onClick={closeDisabled ? undefined : onClose}
    >
      <div
        className="w-full bg-[var(--color-bg-card)] border border-[var(--color-border-card)] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150 select-none text-xs cursor-default"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="p-4 px-6 border-b border-[var(--color-border-subtle)] flex items-center justify-between">
          <div className="space-y-0.5">
            <h2 className="text-base font-bold text-[var(--color-text-primary)]">{title}</h2>
            {subtitle && (
              <p className="text-xs text-[var(--color-text-muted)] font-medium">{subtitle}</p>
            )}
          </div>
          {/* 원본은 텍스트 "닫기" 가 아니라 X 아이콘 버튼이다. */}
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="닫기"
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-input)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-3">{children}</div>

        {footer && (
          <div className="p-4 px-6 border-t border-[var(--color-border-subtle)] flex flex-wrap items-center justify-end gap-2.5 bg-[var(--color-bg-card)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
