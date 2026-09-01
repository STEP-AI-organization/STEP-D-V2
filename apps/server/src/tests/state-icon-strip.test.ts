import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stripRedundantClipIcons, withImageFlags } from "../db-pg.ts";

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

// 호출자는 프로그램 **행** 이 아니라 아이콘 **맵** 을 넘긴다 — getState 가 응답용으로
// 아이콘을 빼 버린 배열을 그대로 넘겨 중복 제거가 통째로 죽었던 적이 있어(2026-09-01),
// 타입으로 그 실수를 막는다.
// 맵은 아이콘 **원문이 아니라 md5** 를 담는다 — 판정에 필요한 건 "같은가" 뿐이고,
// 원문을 실으면 방금 DB 에서 안 읽게 만든 base64 가 다시 Postgres→Node 를 건넌다.
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const ICONS = new Map<string, string>([["p1", md5(ICON)]]);   // p2 는 포스터만 — brandIcon 없음
const EPISODES = [{ id: "e1", programId: "p1" }, { id: "e2", programId: "p2" }];

const iconOf = (rows: unknown[]) =>
  (rows[0] as { editorState?: { channelIconDataUrl?: string } }).editorState?.channelIconDataUrl;

describe("/api/state — 중복 복사된 채널 아이콘만 뺀다", () => {
  it("프로그램 brandIcon 과 같으면 뺀다 (렌더가 폴백으로 같은 결과를 낸다)", () => {
    const out = stripRedundantClipIcons([withIcon(ICON)], ICONS, EPISODES);
    assert.equal(iconOf(out), undefined);
  });

  it("editorState 의 다른 값은 건드리지 않는다", () => {
    const out = stripRedundantClipIcons([withIcon(ICON, { channelName: "ENA" })], ICONS, EPISODES);
    assert.equal((out[0] as any).editorState.channelName, "ENA");
    assert.equal((out[0] as any).editorState.showChannel, true);
  });

  // ⚠️ 사람이 클립별로 고른 아이콘 — 지우면 그 선택이 사라진다(실측 STEPAI 7개).
  it("brandIcon 과 다르면 보존한다 — 사람이 고른 값이다", () => {
    const out = stripRedundantClipIcons([withIcon(OTHER)], ICONS, EPISODES);
    assert.equal(iconOf(out), OTHER);
  });

  // ⚠️ 렌더 폴백 체인에는 poster 가 없다. 빼면 발행 영상에서 아이콘이 사라진다.
  it("brandIcon 이 없는 프로그램(포스터 시드)은 보존한다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: "e2", editorState: { channelIconDataUrl: OTHER } })], ICONS, EPISODES);
    assert.equal(iconOf(out), OTHER);
  });

  // ⚠️ 렌더(renderClipMedia)와 미리보기는 **회차가 있을 때만** 돌고 프로그램을 회차 경유로만
  // 찾는다 — clip.programId 는 안 본다. 그래서 여기서 programId 로 빼면 그 아이콘을 되살릴
  // 주체가 아무도 없어 **발행 영상에서 사라진다.** 편집본 업로드는 회차가 안 잡히면
  // episodeId 가 빈 문자열이라 실제로 흔한 경우다.
  it("회차가 없으면 programId 가 같아도 **보존한다** — 렌더가 되살리지 못한다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: "", programId: "p1", editorState: { channelIconDataUrl: ICON } })],
      ICONS, EPISODES);
    assert.equal(iconOf(out), ICON);
  });

  it("프로그램을 못 찾으면 보존한다 — 모르면 안 지운다", () => {
    const out = stripRedundantClipIcons(
      [clip({ episodeId: "e_unknown", editorState: { channelIconDataUrl: ICON } })], ICONS, EPISODES);
    assert.equal(iconOf(out), ICON);
  });

  it("아이콘이 없는 클립·editorState 없는 클립은 그대로 통과한다", () => {
    const rows = [withIcon(undefined), clip({}), { id: "c9" }];
    const out = stripRedundantClipIcons(rows, ICONS, EPISODES);
    assert.equal(out.length, 3);
    assert.deepEqual(out[2], { id: "c9" });
  });

  it("brandIcon 을 가진 프로그램이 하나도 없으면 아무것도 안 건드린다", () => {
    const rows = [withIcon(ICON)];
    assert.equal(stripRedundantClipIcons(rows, new Map(), EPISODES)[0], rows[0]);
  });
});

/**
 * 프로그램 base64 이미지는 **DB 에서부터 안 읽는다**(`listProgramsForState` 의 jsonb `-`).
 * 실측(2026-08-31) ENA 기준 `/api/state` 1.73 MB 중 **1.33 MB(77%)** 가 포스터·쇼츠 아이콘이었고,
 * JS 에서만 걸러내면 응답은 줄어도 Postgres→Node 구간은 그대로 19 MB 를 실어 날랐다.
 *
 * 여기서 고정하는 건 SQL 이 뺀 자리에 붙이는 **플래그 모양**이다 — 화면이 이걸 보고
 * `/api/programs/:id/image/:kind` 를 걸지 플레이스홀더를 그릴지 정한다.
 */
describe("/api/state — 프로그램 이미지 자리에 있다/없다만 남긴다", () => {
  it("있으면 플래그를 붙인다", () => {
    const p = withImageFlags({ id: "p1", title: "x" }, true, true) as any;
    assert.equal(p.hasPosterImage, true);
    assert.equal(p.hasBrandIcon, true);
    assert.equal(p.title, "x", "다른 필드는 그대로여야 한다");
  });

  it("없으면 플래그를 **안 붙인다** — 'false' 와 '모른다' 를 섞지 않는다", () => {
    const p = withImageFlags({ id: "p" }, true, false) as any;
    assert.equal(p.hasPosterImage, true);
    assert.equal(p.hasBrandIcon, undefined);
  });

  it("둘 다 없으면 객체를 새로 만들지도 않는다", () => {
    const row = { id: "p", title: "x" };
    assert.equal(withImageFlags(row, false, false), row);
  });
});
