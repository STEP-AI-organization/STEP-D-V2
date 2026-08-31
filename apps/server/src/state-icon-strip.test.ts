import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripRedundantClipIcons, stripProgramImages } from "./db-pg.ts";

/**
 * `/api/state` 가 클립마다 복사된 채널 아이콘을 빼는 규칙.
 *
 * 실측(2026-08-31): ENA 워크스페이스의 `/api/state` 19.4 MB 중 **17.7 MB** 가 이 복사본이었다 —
 * 서로 다른 이미지는 2개인데 클립 51개에 장당 355 KB. 그런데 렌더가 이미
 * `program.brandIconDataUrl` 로 폴백하므로 그 복사는 처음부터 없어도 됐다.
 *
 * ⚠️ 여기서 잘못 빼면 **발행된 영상에서 아이콘이 사라진다.** 규칙이 좁아야 하는 이유다.
 */
const ICON = "data:image/png;base64,AAAA";
const OTHER = "data:image/png;base64,BBBB";

const clip = (o: Record<string, unknown>) => ({ id: "c1", episodeId: "e1", ...o });
const withIcon = (icon?: string, extra: Record<string, unknown> = {}) =>
  clip({ editorState: { showChannel: true, ...(icon ? { channelIconDataUrl: icon } : {}), ...extra } });

const PROGRAMS = [{ id: "p1", brandIconDataUrl: ICON }, { id: "p2", posterImageDataUrl: OTHER }];
const EPISODES = [{ id: "e1", programId: "p1" }, { id: "e2", programId: "p2" }];

const iconOf = (rows: unknown[]) =>
  (rows[0] as { editorState?: { channelIconDataUrl?: string } }).editorState?.channelIconDataUrl;

describe("/api/state — 중복 복사된 채널 아이콘만 뺀다", () => {
  it("프로그램 brandIcon 과 같으면 뺀다 (렌더가 폴백으로 같은 결과를 낸다)", () => {
    const out = stripRedundantClipIcons([withIcon(ICON)], PROGRAMS, EPISODES);
    assert.equal(iconOf(out), undefined);
  });

  it("editorState 의 다른 값은 건드리지 않는다", () => {
    const out = stripRedundantClipIcons([withIcon(ICON, { channelName: "ENA" })], PROGRAMS, EPISODES);
    assert.equal((out[0] as any).editorState.channelName, "ENA");
    assert.equal((out[0] as any).editorState.showChannel, true);
  });

  // ⚠️ 사람이 클립별로 고른 아이콘 — 지우면 그 선택이 사라진다(실측 STEPAI 7개).
  it("brandIcon 과 다르면 보존한다 — 사람이 고른 값이다", () => {
    const out = stripRedundantClipIcons([withIcon(OTHER)], PROGRAMS, EPISODES);
    assert.equal(iconOf(out), OTHER);
  });

  // ⚠️ 렌더 폴백 체인에는 poster 가 없다. 빼면 발행 영상에서 아이콘이 사라진다.
  it("brandIcon 이 없는 프로그램(포스터 시드)은 보존한다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: "e2", editorState: { channelIconDataUrl: OTHER } })], PROGRAMS, EPISODES);
    assert.equal(iconOf(out), OTHER);
  });

  it("회차가 없어도 clip.programId 로 프로그램을 찾는다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: undefined, programId: "p1", editorState: { channelIconDataUrl: ICON } })],
      PROGRAMS, EPISODES);
    assert.equal(iconOf(out), undefined);
  });

  it("프로그램을 못 찾으면 보존한다 — 모르면 안 지운다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: "e_unknown", editorState: { channelIconDataUrl: ICON } })], PROGRAMS, EPISODES);
    assert.equal(iconOf(out), ICON);
  });

  it("아이콘이 없는 클립·editorState 없는 클립은 그대로 통과한다", () => {
    const rows = [withIcon(undefined), clip({}), { id: "c9" }];
    const out = stripRedundantClipIcons(rows, PROGRAMS, EPISODES);
    assert.equal(out.length, 3);
    assert.deepEqual(out[2], { id: "c9" });
  });

  it("brandIcon 을 가진 프로그램이 하나도 없으면 아무것도 안 건드린다", () => {
    const rows = [withIcon(ICON)];
    assert.equal(stripRedundantClipIcons(rows, [{ id: "p2" }], EPISODES)[0], rows[0]);
  });
});

/**
 * 프로그램 base64 이미지도 `/api/state` 에서 뺀다 — 실측(2026-08-31) ENA 기준 1.73 MB 중
 * **1.33 MB(77%)** 가 포스터·쇼츠 아이콘이었다. 화면은 `/api/programs/:id/image/:kind` 로 받는다.
 *
 * ⚠️ **저장은 건드리지 않는다.** 렌더·팩토리는 DB 에서 직접 읽고(getEntity), 설정 화면은
 * `GET /api/programs/:id` 로 원본을 따로 받는다 — 안 그러면 빈 값을 저장해 이미지를 지운다.
 */
describe("/api/state — 프로그램 base64 이미지를 뺀다", () => {
  const POSTER = "data:image/png;base64,AAAA";
  const ICON = "data:image/png;base64,BBBB";

  it("두 필드를 빼고 있다/없다만 남긴다", () => {
    const [p] = stripProgramImages([
      { id: "p1", title: "x", posterImageDataUrl: POSTER, brandIconDataUrl: ICON },
    ]) as any[];
    assert.equal(p.posterImageDataUrl, undefined);
    assert.equal(p.brandIconDataUrl, undefined);
    assert.equal(p.hasPosterImage, true);
    assert.equal(p.hasBrandIcon, true);
    assert.equal(p.title, "x", "다른 필드는 그대로여야 한다");
  });

  it("한쪽만 있으면 그쪽 플래그만 선다", () => {
    const [a] = stripProgramImages([{ id: "p", posterImageDataUrl: POSTER }]) as any[];
    assert.equal(a.hasPosterImage, true);
    assert.equal(a.hasBrandIcon, undefined, "없는데 true 면 화면이 매번 404 를 때린다");
  });

  it("이미지가 없는 프로그램은 손대지 않는다", () => {
    const rows = [{ id: "p", title: "x" }];
    assert.equal(stripProgramImages(rows)[0], rows[0]);
  });

  // castPhotos 는 설정 화면과 얽힘이 커서 이번엔 안 뺐다 — 빼려면 그 화면을 같이 고쳐야 한다.
  it("castPhotos 는 아직 남긴다 (의도)", () => {
    const [p] = stripProgramImages([
      { id: "p", posterImageDataUrl: POSTER, castPhotos: { 홍길동: POSTER } },
    ]) as any[];
    assert.deepEqual(p.castPhotos, { 홍길동: POSTER });
  });
});
