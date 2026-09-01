import type { Metadata } from "next";
import "./globals.css";
import { AppDataProvider } from "@/lib/data/store";
import { seedInitialData } from "@/lib/data/repository";
import { SessionProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/toast";
import { NativeTransferProvider } from "@/lib/native-transfers";

// 로컬 dev 전용 더미데이터. UI/흐름 작업 편의를 위해 항상 화면이 채워지도록 한다.
// process.env.NODE_ENV는 Next/webpack이 빌드시 인라인 치환 → production 번들에서는
// 아래 분기가 통째로 제거되고 mock 시드가 클라이언트 번들에 실려나가지 않는다.
// STEPD_LOCAL_DUMMY=0 으로 로컬에서도 명시적 off 가능.
const LOCAL_DUMMY =
  process.env.NODE_ENV !== "production" && process.env.STEPD_LOCAL_DUMMY !== "0";

export const metadata: Metadata = {
  title: "STEP D — 스튜디오",
  description: "STEP D 콘텐츠 제작·배포 스튜디오",
  // 아이콘은 파일 컨벤션(app/favicon.ico · app/icon.svg · app/apple-icon.png)으로
  // 모든 페이지에 자동 주입된다 — 앱 심사(TikTok/Meta)의 favicon 요건.
};

// Resolve theme before first paint to avoid a flash of the wrong theme.
// STEP D Review OS is a dark-first design, so default to dark when the user has
// no stored preference (the topbar toggle still lets them switch to light).
const themeInit = `(function(){try{var t=localStorage.getItem('stepd-theme');var d=t?t==='dark':true;if(d)document.documentElement.classList.add('dark');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <SessionProvider>
          <AppDataProvider initial={LOCAL_DUMMY ? seedInitialData() : undefined}>
            <ToastProvider>
              <NativeTransferProvider>{children}</NativeTransferProvider>
            </ToastProvider>
          </AppDataProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
