"use client";

/**
 * 테마 컨텍스트 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/components/theme-provider.tsx`).
 *
 * 디자이너 사이드바가 Dark/Light 필을 그리려고 `useTheme()` 을 필수로 요구한다.
 *
 * ## 우리 것과 이미 같다 — 그래서 충돌이 없다
 * 저장 키 `stepd-theme` · 기본값 다크 · `<html>` 에 `.dark` 토글 — 셋 다 우리
 * `layout.tsx` 의 무플래시 인라인 스크립트, `theme-toggle.tsx` 와 **완전히 동일**하다.
 * 그래서 인라인 스크립트는 **그대로 둔다**(첫 페인트 전에 테마를 정하는 건 그쪽 몫이다).
 *
 * ## 원본에 **더한** 것 하나 — 외부 변경 동기화
 * 원본은 마운트 때 한 번만 읽는다. 그런데 이식이 끝날 때까지는 **토글이 둘**이다:
 * 디자이너 사이드바와, 아직 안 옮긴 화면을 감싸는 레거시 Topbar 의 `ThemeToggle`.
 * 레거시 쪽으로 바꾸면 이 컨텍스트가 모른 채 남아 사이드바 라벨이 거짓말을 한다.
 * `MutationObserver` 로 `<html>` 의 class 를 지켜보고 따라간다 — **DOM 이 진실**이고
 * (CSS 가 그걸 보므로) 이건 표시를 진실에 맞추는 것이라 시각 변경이 아니다.
 * 이식이 끝나 토글이 하나만 남으면 이 옵저버는 지워도 된다.
 */
import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("stepd-theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      if (stored === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    } else {
      const isDark = document.documentElement.classList.contains("dark");
      setTheme(isDark ? "dark" : "light");
    }
  }, []);

  // 원본에 없는 부분 — 위 주석 참조. 다른 토글이 <html> 을 바꿔도 라벨이 따라간다.
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      setTheme(el.classList.contains("dark") ? "dark" : "light");
    });
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("stepd-theme", nextTheme);
    if (nextTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
