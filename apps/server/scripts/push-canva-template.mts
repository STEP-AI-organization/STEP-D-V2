/**
 * 로컬 템플릿 프레임 → 캔바 디자인으로 올리기 (canva:sync 의 반대 방향).
 *
 *   pnpm --filter @stepd/server canva:push sns-card
 *
 * 우리가 만든 overlay.png 를 캔바에서도 편집·보관하고 싶을 때 쓴다.
 * 파이프라인에는 필요 없다 — 렌더는 로컬 PNG 로 충분하다.
 *
 * ⚠️ 올라가는 건 **납작한 이미지 한 장**이다. 캔바가 PNG 를 레이어로 되돌리지는 못한다.
 * 만들어진 디자인 id 는 meta.json 의 `canva_design_id` 에 기록해서, 다음 `canva:sync` 가
 * 같은 디렉토리로 찾아오게 한다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../src/db-pg.ts";
import { uploadAssetPng, createDesignFromAsset } from "../src/ai/canva.ts";

const name = process.argv[2];
if (!name) {
  console.error("사용: pnpm --filter @stepd/server canva:push <템플릿이름>");
  process.exit(1);
}

const dir = path.resolve(fileURLToPath(import.meta.url), "../../../../assets/shorts-template", name);
const png = path.join(dir, "overlay.png");
const metaPath = path.join(dir, "meta.json");
if (!fs.existsSync(png)) {
  console.error(`overlay.png 없음: ${png}`);
  process.exit(1);
}

await initDb();

const assetId = await uploadAssetPng(fs.readFileSync(png), `STEP D — ${name}`);
const designId = await createDesignFromAsset(assetId, `STEP D — ${name}`);
console.log(`asset  ${assetId}`);
console.log(`design ${designId}  https://www.canva.com/design/${designId}/edit`);

if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.canva_design_id = designId;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  console.log(`meta.json 의 canva_design_id 갱신`);
}

// 캔바에서 이 디자인을 "유튜브 쇼츠 템플릿" 폴더로 옮기는 건 사람이 해야 한다 —
// 폴더 이동은 folder:write 스코프가 필요하고, 지금은 요청하지 않는다.
console.log(`\n캔바에서 이 디자인을 '유튜브 쇼츠 템플릿' 폴더로 옮겨두면 canva:sync 대상이 된다.`);
process.exit(0);
