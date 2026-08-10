import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * STEP D Admin — 정적 SPA. 프로덕션은 자체 Vercel 프로젝트(admin.stepd.stepai.kr)로 배포되고
 * `/api/*` 는 vercel.json 의 rewrite 로 Cloud Run 서버에 전달된다.
 *
 * **rewrite(서버측 프록시)여야 하는 이유**: 세션이 HttpOnly 쿠키라, 브라우저가 보기에
 * 같은 오리진이어야 쿠키가 실린다. 다른 호스트로 직접 fetch 하면 로그인이 성립하지 않는다.
 * 개발에서도 같은 경로를 로컬 서버로 프록시해, 앱 코드는 절대 API 호스트를 모른다.
 */
const SERVER = process.env.ADMIN_API_ORIGIN || "http://localhost:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4300,
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
