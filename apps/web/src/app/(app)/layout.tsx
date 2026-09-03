import { AuthGuard } from "@/components/shell/auth-guard";
import { ChatbotWidget } from "@/components/chatbot/chatbot-widget";
import { ThemeProvider } from "@/components/theme-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { LegacyFrame } from "@/components/layout/legacy-frame";

/**
 * `(app)` 그룹 셸 — 디자이너 산출물로 교체 (2026-09-03 · 이식 계획 P7).
 *
 * ## 스트랭글러 프레임
 * 화면 24개를 한 번에 못 옮기므로, **셸만 먼저** 디자이너 것으로 바꾸고 그 안에서
 * 화면을 하나씩 갈아끼운다.
 *
 *   이식된 화면  → 페이지가 `<Header>`·`<main>`·`<Footer>` 를 직접 그린다(디자이너 원문 구조)
 *   미이식 화면  → `LegacyFrame` 이 옛 상단바·배너·스크롤 컨테이너를 대신 씌운다
 *
 * 바깥 두 겹(`flex h-screen …` + `flex-1 flex flex-col …`)은 **디자이너 페이지의 래퍼와
 * 문자 단위로 같다**. 그래서 이식된 페이지는 자기 래퍼를 지우기만 하면 기하가 그대로 재현된다.
 *
 * ## `(app)` 에만 넣는다 — 루트로 올리지 않는다
 * 루트 레이아웃으로 올리면 `(editor)` 풀스크린 편집기에도 사이드바가 생긴다. 편집기는
 * 화면을 다 쓰는 작업 공간이라 셸이 붙으면 안 된다.
 *
 * ## CommandPalette 를 내렸다
 * 디자이너 헤더가 Ctrl+K 검색 모달을 들고 온다. 둘 다 두면 한 번 눌러 **모달이 두 개** 뜬다.
 * (테스트 참조 0건 확인 · 되살리려면 header.tsx 의 키 리스너를 먼저 뺄 것.)
 *
 * AppDataProvider 는 루트 레이아웃에 있다 — `(editor)` 그룹도 같은 스토어를 쓴다.
 */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      {/* ThemeProvider 는 사이드바의 Dark/Light 필이 요구한다. 첫 페인트 테마는 루트
          layout.tsx 의 무플래시 스크립트가 정한다 — 키·기본값이 같아 충돌하지 않는다. */}
      <ThemeProvider>
        <div className="sd-ui-font flex h-screen w-screen overflow-hidden bg-[var(--color-bg-dark)]">
          <Sidebar />

          {/* Right Content View Area */}
          <div className="flex-1 flex flex-col h-screen min-w-0 overflow-hidden">
            <LegacyFrame>{children}</LegacyFrame>
          </div>
        </div>
        {/* 도우미는 (app) 그룹에만. 풀스크린 편집기(editor)는 작업 화면이라 덮지 않는다. */}
        <ChatbotWidget />
      </ThemeProvider>
    </AuthGuard>
  );
}
