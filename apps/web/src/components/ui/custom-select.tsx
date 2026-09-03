"use client";

/**
 * 셀렉트 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/components/ui/custom-select.tsx` 99줄).
 *
 * **클래스는 한 글자도 안 바꿨다 = 픽셀이 같다.** 더한 건 접근성 속성·키보드 조작뿐이고,
 * 전부 시각에 영향이 없다.
 *
 * ## 왜 base-ui 나 네이티브 `<select>` 로 바꾸지 않았나
 * 우리 리포에 base-ui import 는 **0건**이라 "우리 base-ui 프리미티브" 라는 건 존재하지 않는다.
 * base-ui `Select` 는 포털+앵커+충돌 회피라 팝업 폭·열림 방향·애니메이션이 달라지고,
 * 네이티브 `<select>` 는 알약형 트리거·파랑 링·선택항목 파랑 배경을 OS 렌더링으로 재현할 수 없다.
 * 둘 다 "디자인 그대로" 를 깬다.
 *
 * ## 더한 것 (원본에 없음)
 * - `role="listbox"`/`role="option"`·`aria-expanded`·`aria-haspopup`·`aria-selected`
 * - 키보드: ↑↓ 이동 · Enter/Space 선택 · Escape 닫기 · 닫을 때 트리거로 포커스 복귀
 *   원본은 마우스로만 쓸 수 있었다. 목업이라 그랬을 뿐, 폼 컨트롤이 키보드로 안 되면 못 쓴다.
 *
 * ⚠️ **미확인 결함:** 팝업이 `absolute` 라 조상의 `overflow-hidden` 에 잘릴 수 있다.
 * 이식된 화면의 `<main>` 이 대부분 `overflow-hidden` 이므로, 이 컴포넌트를 쓰는 화면을
 * 이식할 때마다 **실브라우저로 드롭다운을 열어 볼 것**.
 */
import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface CustomSelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  options: (string | CustomSelectOption)[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  dropdownClassName?: string;
  /** 접근성 이름 — 원본엔 없다. 라벨이 시각적으로만 붙어 있는 자리에서 쓴다. */
  ariaLabel?: string;
}

export function CustomSelect({
  options,
  value,
  onChange,
  placeholder = "선택하세요",
  className = "",
  triggerClassName,
  dropdownClassName,
  ariaLabel,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const formattedOptions: CustomSelectOption[] = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt,
  );

  const selectedOption = formattedOptions.find((opt) => opt.value === value);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 열 때 현재 선택 항목에 커서를 둔다 — 방향키가 항상 맨 위에서 시작하면 못 쓴다.
  useEffect(() => {
    if (!isOpen) return;
    const i = formattedOptions.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
  }, [isOpen, value, formattedOptions]);

  function close(focusTrigger = true) {
    setIsOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setIsOpen(true); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, formattedOptions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = formattedOptions[activeIndex];
      if (opt) { onChange(opt.value); close(); }
    }
  }

  return (
    <div ref={containerRef} className={`relative w-full text-sm select-none ${className}`} onKeyDown={onKeyDown}>
      {/* Select Trigger Box with right arrow padding pr-9 & ChevronDown Icon */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full border rounded-full px-3.5 py-2 pr-9 text-left font-medium flex items-center justify-between transition-all cursor-pointer ${
          triggerClassName ? triggerClassName : "bg-[var(--color-bg-card)] text-[var(--color-text-primary)] shadow-sm"
        } ${
          isOpen
            ? "border-[#1C60FF] ring-1 ring-[#1C60FF]"
            : "border-[var(--color-border-subtle)] hover:border-[var(--color-border-card)]"
        }`}
      >
        <span className="truncate">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-[var(--color-text-muted)] absolute right-3 top-1/2 -translate-y-1/2 transition-transform duration-200 pointer-events-none ${
            isOpen ? "rotate-180 text-[#1C60FF]" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu Popup with Rounding & STEP D Active Blue Style */}
      {isOpen && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 right-0 top-[calc(100%+4px)] z-50 bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 py-1 max-h-60 overflow-y-auto ${dropdownClassName ? dropdownClassName : "shadow-xl"}`}
        >
          {formattedOptions.map((opt, idx) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  onChange(opt.value);
                  close(false);
                }}
                className={`px-3.5 py-1.5 ${dropdownClassName?.includes("text-xs") || triggerClassName?.includes("text-xs") ? "text-xs" : "text-sm"} font-medium cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-[#1C60FF] text-white font-bold"
                    : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-input)]"
                }`}
              >
                {opt.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
