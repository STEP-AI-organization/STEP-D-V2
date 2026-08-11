/**
 * ⚠️ **이 파일이 실제로 쓰이는 설정이다.** next.config.ts 도 같이 있지만 Next 의
 * CONFIG_FILES 순서가 `next.config.js → next.config.mjs → next.config.ts` 라
 * .mjs 가 .ts 를 가린다. 즉 .ts 안의 rewrite/reactStrictMode 는 적용되지 않는다.
 *
 * **.mjs 를 "중복이니까" 지우지 말 것.** 지우면 .ts 의
 *   `/api/:path*  →  /api/proxy/api/:path*`
 * rewrite 가 살아나는데, 프로덕션은 `NEXT_PUBLIC_API_URL=/api/proxy/api` 라 모든 호출이
 * 이미 /api/proxy/... 로 나간다. 그게 다시 rewrite 를 타면
 * `/api/proxy/api/proxy/api/state` 가 되어 업스트림에서 전부 404 난다(= 서버 미연결).
 * 되살리려면 프록시 경로를 먼저 제외하는 규칙과 함께 넣어야 한다.
 *
 * 라우트 정리 (2026-07-22): /os 폴더 삭제 후 /(app) 그룹의 실제 화면들을 그대로 사용.
 * 리다이렉트 없음 — 루트 /가 (app)/page.tsx를 서빙한다.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
