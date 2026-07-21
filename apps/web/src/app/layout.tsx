import type { Metadata } from "next";
import "./globals.css";
import { AppDataProvider } from "@/lib/data/store";
import { SessionProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "STEP D — 스튜디오",
  description: "STEP D 콘텐츠 제작·배포 스튜디오",
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
          <AppDataProvider>
            <ToastProvider>{children}</ToastProvider>
          </AppDataProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
