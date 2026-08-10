import { redirect } from "next/navigation";

/**
 * 재설계 라우팅은 대시보드를 `/dashboard` 로 둔다 (README "Interactions & Behavior").
 * 루트는 그리로 보낸다 — 기존 북마크·링크가 죽지 않게.
 */
export default function Home() {
  redirect("/dashboard");
}
