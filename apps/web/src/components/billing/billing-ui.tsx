"use client";

/**
 * 결제 화면 공용 소컴포넌트 (2026-08-14 · Google AI Studio 결제 화면 구조).
 *
 * 이 디자인의 시그니처는 **카드 하단의 border-top + 중앙 정렬 + 액센트 텍스트 버튼**
 * (CardAction)이다 — 모든 카드가 "본문은 조용히, 행동은 하단 한 줄"로 끝난다.
 * 반복되는 카드 껍데기(BillingCard)와 다이얼로그(BillingDialog)도 여기 모은다.
 *
 * 다이얼로그 관용구는 리포 기존 패턴을 그대로 따른다:
 *   - 오버레이·패널·헤더/본문/푸터 3단: components/publish/channel-rule-dialog.tsx
 *   - ESC 닫기(window keydown): components/media/clip-detail.tsx
 * 새 라이브러리 없이 sd-* 토큰만 쓴다.
 */
import { useEffect } from "react";

import { cn } from "@/lib/utils";

/** sd-card + 오버라인 제목 + 하단 액션 슬롯. 그리드에서 높이를 맞추려 flex-col 로 늘린다. */
export function BillingCard({
  title,
  children,
  action,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  /** 카드 하단 액션 — CardAction 을 넣는다. 없으면 하단 보더도 없다. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("sd-card flex flex-col overflow-hidden", className)}>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        {title && (
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>{title}</div>
        )}
        {children}
      </div>
      {action}
    </div>
  );
}

/** 카드 하단 액션 — 상단 보더로 본문과 분리된 중앙 정렬 액센트 텍스트 버튼. */
export function CardAction({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="w-full px-4 py-2.5 text-center text-[12px] font-medium transition-colors hover:bg-[var(--sd-accent-bg)] disabled:opacity-45 disabled:hover:bg-transparent"
      style={{ borderTop: "1px solid var(--sd-divider)", color: "var(--sd-accent)" }}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

/**
 * 결제 화면 다이얼로그 껍데기. 오버레이 클릭·ESC·닫기 버튼으로 닫힌다 —
 * 단 `closeDisabled`(결제 진행 중 등)면 셋 다 막는다(channel-rule-dialog 의 busy 관용구).
 */
export function BillingDialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  maxWidth = 520,
  closeDisabled,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 하단 고정 영역 — 상단 보더로 분리된다. 결제 버튼처럼 "마지막 행동"이 들어간다. */
  footer?: React.ReactNode;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={closeDisabled ? undefined : onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[88vh] w-full flex-col bg-white"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="flex items-start justify-between gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid var(--sd-border)" }}
        >
          <div>
            <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>{subtitle}</p>
            )}
          </div>
          <button type="button" className="sd-btn shrink-0" onClick={onClose} disabled={closeDisabled}>
            닫기
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">{children}</div>

        {footer && (
          <div
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            style={{ borderTop: "1px solid var(--sd-border)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
