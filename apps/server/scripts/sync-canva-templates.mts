/**
 * 캔바 "유튜브 쇼츠 템플릿" 폴더 → assets/shorts-template/ 동기화.
 *
 *   pnpm --filter @stepd/server canva:sync
 *
 * 폴더 안 디자인만 가져온다. 전체 디자인 목록에는 pptx·작업문서가 섞여 있어서
 * 이름으로 거르는 건 신뢰할 수 없다 — 폴더가 유일한 기준이다.
 *
 * 디렉토리 이름은 **기존 meta.json 의 canva_design_id 로 매칭**한다. 매칭되는 게
 * 없으면 `canva-<designId>` 로 새로 만든다 (사람이 나중에 의미 있는 이름으로 rename;
 * meta.json 의 id 가 남아 있으므로 다음 동기화에서 다시 찾아간다).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../src/db-pg.ts";
import { listCanvaFolders, listDesignsInFolder, exportDesignPng } from "../src/canva.ts";

const FOLDER_NAME = process.env.CANVA_TEMPLATE_FOLDER ?? "유튜브 쇼츠 템플릿";
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../assets/shorts-template");

/** 이미 있는 템플릿 디렉토리를 designId → dir 로 색인한다. */
function existingDirs(): Map<string, string> {
  const m = new Map<string, string>();
  if (!fs.existsSync(ROOT)) return m;
  for (const name of fs.readdirSync(ROOT)) {
    const meta = path.join(ROOT, name, "meta.json");
    if (!fs.existsSync(meta)) continue;
    try {
      const id = JSON.parse(fs.readFileSync(meta, "utf-8")).canva_design_id;
      if (id) m.set(id, name);
    } catch { /* 깨진 meta.json 은 무시하고 새로 만든다 */ }
  }
  return m;
}

await initDb();

const folders = await listCanvaFolders();
const folder = folders.find((f) => f.name === FOLDER_NAME);
if (!folder) {
  console.error(`폴더 '${FOLDER_NAME}' 없음. 있는 폴더: ${folders.map((f) => f.name).join(", ")}`);
  process.exit(1);
}

const designs = await listDesignsInFolder(folder.id);
console.log(`${FOLDER_NAME} (${folder.id}) — 디자인 ${designs.length}개`);

const known = existingDirs();
for (const d of designs) {
  const dirName = known.get(d.id) ?? `canva-${d.id}`;
  const dir = path.join(ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });

  // 로컬에서 만든 프레임은 캔바 왕복본으로 덮지 않는다. 캔바는 디자인에 흰 배경을 깔아서
  // **영상 구멍(알파)을 메워버린다** — 덮으면 영상이 안 보이는 템플릿이 된다.
  // canva:push 로 올린 것도 캔바 쪽은 보관용일 뿐, 진짜는 로컬 생성기다.
  const metaPathGuard = path.join(dir, "meta.json");
  if (fs.existsSync(metaPathGuard)) {
    try {
      if (JSON.parse(fs.readFileSync(metaPathGuard, "utf-8")).source === "local") {
        console.log(`  = ${dirName}  (source=local — overlay.png 보존, 캔바본 무시)`);
        continue;
      }
    } catch { /* 깨진 meta.json 이면 아래 정상 경로로 */ }
  }

  try {
    const url = await exportDesignPng(d.id, { page: 1, width: 1080, height: 1920, transparent: true });
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync(path.join(dir, "overlay.png"), buf);

    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) {
      // 좌표는 사람이 채워야 한다 — 이미지를 보고 띠·영상 영역을 정하는 건 자동화 못 한다.
      fs.writeFileSync(metaPath, JSON.stringify({
        name: dirName,
        source: "canva",
        canva_design_id: d.id,
        canva_title: d.title ?? "",
        size: [1080, 1920],
        video: { x: 0, y: 0, w: 1080, h: 1920 },
        bands: [],
        text: [],
        overlay_regions: [],
        _todo: "video/bands/text 좌표를 overlay.png 보고 채울 것",
      }, null, 2) + "\n", "utf-8");
      console.log(`  + ${dirName}  ${(buf.length / 1024).toFixed(0)} KB  (meta.json 초안 생성 — 좌표 미기입)`);
    } else {
      console.log(`  ↻ ${dirName}  ${(buf.length / 1024).toFixed(0)} KB  (overlay.png 갱신, meta.json 유지)`);
    }
  } catch (e: any) {
    console.error(`  ! ${dirName}  실패: ${e.message}`);
  }
}
process.exit(0);
