/** 네이버 클립 1건 실발행 테스트 (개발용). 등록 예약으로 걸어 즉시 공개를 피한다. */
import { uploadToNaver } from "../src/naver-tv.ts";
import path from "node:path"; import os from "node:os";
const video = process.argv[2];
const at = Date.now() + 2 * 60 * 60 * 1000; // 2시간 뒤
const t0 = Date.now();
const r = await uploadToNaver({
  target: "clip",
  videoPath: video,
  title: "나는솔로 16기 하이라이트",
  description: "댓글이 난리난 그 장면 — 이 표정 하나로 분위기가 완전히 뒤집혔습니다.",
  publishAt: at,
  artifactDir: path.join(os.homedir(), ".stepd", "naver-artifacts"),
});
console.log(`소요 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
console.log("예약시각:", new Date(at).toLocaleString("ko-KR"));
console.log(JSON.stringify(r, null, 1));
process.exit(0);
