"use client";

/**
 * 푸터 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/components/layout/footer.tsx`).
 *
 * **클래스·문구는 한 글자도 안 바꿨다.** 바꾼 건 `<button>` 3개 → `<a>` 뿐이다.
 *
 * 왜 바꿔야 하는가: 원본은 목업이라 아무 데도 안 간다. 이 세 링크는 **TikTok·Meta 앱 심사
 * 요건**이라 실제로 열려야 한다(구 `app-shell.tsx` 주석에 같은 취지가 적혀 있었다).
 * `<button>` → `<a>` 는 기본 스타일이 다르지만, 여기 클래스가 색·크기·hover 를 전부
 * 명시하고 있어 **시각 변화는 0**이다(밑줄은 Tailwind preflight 가 이미 제거한다).
 */
import React from "react";

export function Footer() {
  return (
    <footer className="pt-2 border-t border-[var(--color-border-subtle)] text-[10.5px] text-[var(--color-text-muted)] flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <span>© 2026 STEP AI Inc.</span>
        <a href="/privacy" className="hover:text-[var(--color-text-secondary)] transition-colors cursor-pointer">
          개인정보처리방침
        </a>
        <a href="/terms" className="hover:text-[var(--color-text-secondary)] transition-colors cursor-pointer">
          서비스 이용약관
        </a>
        <a href="/data-deletion" className="hover:text-[var(--color-text-secondary)] transition-colors cursor-pointer">
          데이터 삭제 요청
        </a>
      </div>
    </footer>
  );
}
