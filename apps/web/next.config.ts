import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        // ⚠️ 여기에 `/api/:path*` → `/api/proxy/api/:path*` rewrite 를 **다시 넣지 말 것.**
        // 프론트는 NEXT_PUBLIC_API_URL=/api/proxy/api 로 **이미 `/api/proxy/api/*` 를 직접** 부른다.
        // 그 위에 이 rewrite 를 얹으면 `/api/proxy/api/state` 가 다시 매칭돼
        // `/api/proxy/api/proxy/api/state` 로 **이중 rewrite** → 프록시가 한 겹만 벗겨
        // `/api/proxy/api/state` 를 Cloud Run 에 보내 **404**(2026-08-24 실서비스 장애).
        // 프록시 라우팅은 오직 NEXT_PUBLIC_API_URL 이 한다.
        // 랜딩 교체(다른 세션 2026-08-24): 정적 public/step-d-landing.html 로 /landing 서빙.
        { source: "/landing", destination: "/step-d-landing.html" },
      ],
    };
  },
};

export default nextConfig;
