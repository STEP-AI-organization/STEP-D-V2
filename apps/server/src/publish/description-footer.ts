/**
 * 프로그램 단위 **배포 설명 고정 문구** (2026-09-15 · 사용자 요구 "생성되는 동적인 글 아래에
 * 고정글도 — 프로그램 단위로").
 *
 * 동적(AI 생성) 설명 **아래**, 커머스 블록(링크+대가성 문구) **위**에 붙는다:
 *
 *   [채널별 생성 설명 or synopsis]
 *
 *   [프로그램 고정 문구]           ← 이 모듈
 *
 *   [커머스 링크 + 대가성 문구]     ← commerce.ts (항상 맨 아래 유지)
 *
 * **발행 직전 조립**이다 — 저장된 설명 본문(channelMeta·uploadMeta)에 미리 굽지 않는다.
 * 이유는 커머스 블록과 같다(worker.ts metaForChannel 주석):
 *  ① 프로그램에서 문구를 바꾸면 **다음 발행부터 전부** 새 문구로 나간다(클립마다 재생성 불필요).
 *  ② 편집 화면 값에 넣으면 언젠가 사람이 지운다 — 고정글의 "고정"이 깨진다.
 * 소비처: worker.ts metaForChannel(유튜브·인스타·페북·네이버) + handleDistributionUpdateMeta
 * (발행 후 메타 수정 — 저장본이 metaForChannel 을 우회하므로 한 번 더 건다).
 * 틱톡은 다이렉트 게시가 title 한 칸뿐이라 제외(캡션에 여러 줄 고정글이 들어갈 자리가 없다).
 */
import { getEntity } from "../db-pg.ts";

/**
 * 설명에 고정 문구를 붙인다. **멱등** — 이미 들어 있으면 그대로 돌려준다
 * (updatemeta 재조립·naver 이중 적용 경로에서 두 번 붙지 않게 · withCommerceLinks 와 같은 규약).
 * footer 가 비면 원문 그대로 — 고정글 기능이 발행을 바꾸는 건 문구를 적은 프로그램뿐이다.
 */
export function withProgramFooter(description: string, footer: string | null | undefined): string {
  const base = String(description ?? "");
  const f = String(footer ?? "").trim();
  if (!f) return base;
  if (base.includes(f)) return base;
  return base.trim() ? `${base.trim()}\n\n${f}` : f;
}

/**
 * 클립 → 회차 → 프로그램의 고정 문구(descriptionFooter). 못 찾으면 "" —
 * 고정글 때문에 발행이 막히는 방향의 실패는 만들지 않는다(commerce ②와 같은 원칙).
 */
export async function programFooterForClip(clip: {
  episodeId?: unknown;
}): Promise<string> {
  try {
    const episodeId = String(clip?.episodeId ?? "");
    if (!episodeId) return "";
    const episode = await getEntity<{ programId?: unknown }>("episode", episodeId);
    const programId = String(episode?.programId ?? "");
    if (!programId) return "";
    const program = await getEntity<{ descriptionFooter?: unknown }>("program", programId);
    return String(program?.descriptionFooter ?? "").trim();
  } catch {
    return "";
  }
}
