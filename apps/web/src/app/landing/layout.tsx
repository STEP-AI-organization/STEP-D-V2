import type { Metadata } from "next";

const TITLE = "STEP D ㅣ AI 기반 MEDIA OS";
const DESCRIPTION =
  "방송이 끝난 영상을 STEP D가 분석해 하이라이트·쇼츠·클립으로 만들고, 멀티채널 유통과 광고·커머스 수익화까지. 한국 미디어를 위한 AI 기반 MEDIA OS.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // 카카오톡·기타 SNS 링크 미리보기(Open Graph)
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "STEP D",
    url: "https://stepd.stepai.kr/landing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
