/**
 * 렌더 전용 워커 런처.
 *
 *   pnpm --filter @stepd/server worker:render
 *
 * 이 PC 는 **클립 렌더(ffmpeg 인코딩)** 만 맡는다. 다른 레인의 이유(한국 IP·화면 있는 크롬)와
 * 달리 여기 이유는 **CPU** 다 — 렌더는 건당 50~90초로 이 리포에서 CPU 를 통째로 쓰는 유일한
 * 일이고, 그래서 클라우드 순방이 스스로를 `AUTOMATION_MAX_RENDERS_PER_TICK=8` 로 묶는다.
 * 노는 사무실 PC 가 당겨가면 그 상한이 풀린다.
 *
 * 레인을 코드에 박는 이유는 worker-naver.mts 와 같다 — env 로 넘기면 누가 지우거나 오타를
 * 내도 조용히 "all" 워커가 되어 **남의 전용 잡을 집어 실패시킨다.**
 *
 * ⚠️ 이 워커는 렌더를 직접 하지 않는다. **같은 PC 의 로컬 서버**(`RENDER_API_BASE`,
 *    기본 http://127.0.0.1:4100)의 `/api/clips/:id/export` 를 부른다. 렌더 로직(자막 ASS·
 *    훅 프리롤·오버레이 PNG·리프레임 플랜)이 그 라우트에 있고, 워커로 복제하면 두 벌이
 *    갈라져 "편집기 미리보기와 결과물이 다르다" 가 시작된다.
 *    그래서 이 PC 에는 **워커와 서버 두 프로세스**가 같이 떠 있어야 한다.
 */
process.env.WORKER_JOBS = "render";
// 로컬 서버를 기본값으로 둔다 — 안 그러면 apiBase() 폴백으로 **클라우드에 렌더를 시켜**
// 이 PC 를 쓰려던 목적이 조용히 사라진다(잡은 여기서 집는데 CPU 는 저기서 탄다).
if (!process.env.RENDER_API_BASE) process.env.RENDER_API_BASE = "http://127.0.0.1:4100";
await import("../src/worker.ts");
