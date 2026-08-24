import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/api/:path*", destination: "/api/proxy/api/:path*" },
        // 랜딩 교체(다른 세션 2026-08-24): 정적 public/step-d-landing.html 로 /landing 을 서빙.
        // ⚠️ 이 rewrite 는 **활성 config 인 next.config.ts** 에 있어야 먹는다 — 예전엔 next.config.mjs
        //    에 넣어 뒀는데 Next 는 .ts 를 로드해서(프록시 rewrite 가 여기 있고 앱이 붙는 게 증거) 죽은
        //    설정이었다. .mjs 는 프록시가 없어 활성화되면 앱이 서버에 못 붙으므로 함께 삭제했다.
        { source: "/landing", destination: "/step-d-landing.html" },
      ],
    };
  },
};

export default nextConfig;
