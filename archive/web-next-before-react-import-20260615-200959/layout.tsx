import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viral Shorts MVP",
  description: "Cost-efficient AI shorts generation for long-form MP4 videos"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
