/**
 * 네이버 전용 워커 런처.
 *
 *   pnpm --filter @stepd/server worker:naver
 *
 * 이 PC 는 **네이버 TV·클립 발행만** 담당한다. `WORKER_JOBS` 를 환경변수로 넘기는 방식은
 * 잊거나 오타냈을 때 조용히 "all" 워커가 되어 **남의 레인 잡을 집어 실패시킨다**
 * (실측 2026-08-11: 구버전 all 워커가 naver.publish 를 가로채 재시도만 쌓았고, 정작
 * naver 워커는 "큐 비었음" 을 봤다 — 원인 찾기가 오래 걸렸다).
 *
 * 그래서 레인을 코드에 못 박는다. env 로 뒤집을 수 없다.
 */
process.env.WORKER_JOBS = "naver";
await import("../src/worker.ts");
