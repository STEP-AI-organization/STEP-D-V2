import { uploadToNaver } from "../src/naver-tv.ts";
import path from "node:path"; import os from "node:os";
const t0 = Date.now();
const r = await uploadToNaver({
  target: "tv",
  videoPath: process.argv[2],
  title: "나는솔로 16기 하이라이트 — 이 표정 하나로",
  description: "댓글이 난리난 그 장면. 분위기가 완전히 뒤집혔습니다.",
  artifactDir: path.join(os.homedir(), ".stepd", "naver-artifacts"),
});
console.log(`소요 ${((Date.now()-t0)/1000).toFixed(1)}초`);
console.log(JSON.stringify(r, null, 1));
process.exit(0);
