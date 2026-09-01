/**
 * 썸네일 에셋(스타일 프로파일 · 출연자 사진 · 결과물)의 스토리지 배관.
 *
 * core/thumbnail 은 로컬 파일만 다룬다. 프로덕션은 GCS 라서, 워커가 잡을 잡을 때
 * 필요한 것만 디스크로 내려받고 → 파이썬을 돌리고 → 산출물을 다시 올린다.
 * content-pipeline.ts 가 미디어 파일에 대해 하는 것과 같은 패턴.
 *
 * 오브젝트 경로 규칙 (GCS·로컬 공통):
 *   thumbnail-assets/thumbnail-style/<programId>/...
 *   thumbnail-assets/cast/<programId>/<출연자명>/...
 *   thumbnails/<mediaId>/thumb_N.png
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileExists, listPrefix, readFile, uploadFile, useGcs } from "./storage-gcs.ts";

const ASSET_PREFIX = "thumbnail-assets";

export function stylePrefix(programId: string): string {
  return `${ASSET_PREFIX}/thumbnail-style/${programId}`;
}

export function castPrefix(programId: string): string {
  return `${ASSET_PREFIX}/cast/${programId}`;
}

export function thumbnailPrefix(mediaId: string): string {
  return `thumbnails/${mediaId}`;
}

/** 이 잡이 쓸 임시 에셋 루트. 파이썬에 THUMB_ASSETS_DIR 로 넘긴다. */
export function tempAssetRoot(tag: string): string {
  const dir = path.join(os.tmpdir(), "stepd-thumb-assets", tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * prefix 아래를 로컬로 내려받는다. 로컬 스토리지 모드면 이미 파일이 있으므로 복사만 한다.
 * 반환은 받은 파일 수 — 0이면 "등록/학습이 안 된 것"이라 호출부가 판단할 수 있다.
 */
export async function pullPrefix(prefix: string, destRoot: string): Promise<number> {
  const objects = await listPrefix(prefix);
  let n = 0;
  for (const obj of objects) {
    const rel = obj.slice(prefix.length).replace(/^\//, "");
    if (!rel) continue;
    const dest = path.join(destRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await readFile(obj));
    n += 1;
  }
  return n;
}

/** 로컬 디렉토리를 prefix 아래로 올린다. 반환은 올린 파일 수. */
export async function pushDir(localDir: string, prefix: string): Promise<number> {
  if (!fs.existsSync(localDir)) return 0;
  let n = 0;
  const walk = async (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const rel = path.relative(localDir, full).split(path.sep).join("/");
      await uploadFile(`${prefix}/${rel}`, full);
      n += 1;
    }
  };
  await walk(localDir);
  return n;
}

/**
 * 잡 실행용 에셋 준비 — 이 프로그램의 스타일 프로파일과 출연자 사진만 내려받는다.
 * 회차마다 전체 버킷을 뒤지지 않게 프로그램 단위로 좁힌다.
 */
export async function prepareProgramAssets(
  programId: string,
  tag: string,
): Promise<{ root: string; styleFiles: number; castFiles: number }> {
  const root = tempAssetRoot(tag);
  const styleDest = path.join(root, "thumbnail-style", programId);
  const castDest = path.join(root, "cast", programId);
  fs.mkdirSync(styleDest, { recursive: true });
  fs.mkdirSync(castDest, { recursive: true });

  const styleFiles = await pullPrefix(stylePrefix(programId), styleDest);
  const castFiles = await pullPrefix(castPrefix(programId), castDest);
  return { root, styleFiles, castFiles };
}

/** 스타일 학습 산출물 업로드 (thumbs 원본까지 — 참고 이미지로 다시 쓰기 때문). */
export async function publishStyleProfile(
  programId: string,
  localStyleDir: string,
): Promise<number> {
  return pushDir(localStyleDir, stylePrefix(programId));
}

/** 생성된 썸네일 업로드 → 저장 경로 목록. */
export async function publishThumbnails(
  mediaId: string,
  files: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const objectPath = `${thumbnailPrefix(mediaId)}/${path.basename(f)}`;
    out.push(await uploadFile(objectPath, f));
  }
  return out;
}

/** 프로그램에 스타일 프로파일이 있는가 (UI·라우트에서 상태 표시용). */
export async function hasStyleProfile(programId: string): Promise<boolean> {
  return fileExists(`${stylePrefix(programId)}/style_profile.json`);
}

export { useGcs };
