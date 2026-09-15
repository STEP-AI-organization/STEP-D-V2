/**
 * **채널 단위 배포 설명 고정 문구** (2026-09-15 · 사용자 결정 "프로그램이 아니라 채널에다가").
 *
 * 동적(AI 생성) 설명 **아래**, 커머스 블록(링크+대가성 문구) **위**에 붙는다:
 *
 *   [채널별 생성 설명 or synopsis]
 *
 *   [채널 고정 문구]               ← 이 모듈 (channel_rule.description_footer)
 *
 *   [커머스 링크 + 대가성 문구]     ← commerce.ts (항상 맨 아래 유지)
 *
 * 왜 **채널 단위**인가: 문구가 채널의 언어·플랫폼을 따른다 — 인도네시아어 채널엔
 * "AI 자동 번역 자막 안내"를 인니어로, 인스타그램은 짧은 버전, 틱톡은 캡션 꼬리표 한 줄
 * ("(Sub Indo/terjemahan AI)"). 같은 프로그램이라도 채널마다 다르다.
 *
 * **발행 직전 조립**이다 — 저장된 설명 본문(channelMeta·uploadMeta)에 미리 굽지 않는다.
 * 이유는 커머스 블록과 같다(worker.ts metaForChannel 주석):
 *  ① 채널 규칙에서 문구를 바꾸면 **다음 발행부터 전부** 새 문구로 나간다.
 *  ② 편집 화면 값에 넣으면 언젠가 사람이 지운다 — 고정글의 "고정"이 깨진다.
 * 소비처: worker.ts metaForChannel(유튜브·인스타·페북·네이버·틱톡 캡션) +
 * handleDistributionUpdateMeta(발행 후 메타 수정 — 저장본이 metaForChannel 을 우회하므로 한 번 더).
 */
import { getChannelRule } from "../db-pg.ts";

/**
 * 설명에 고정 문구를 붙인다. **멱등** — 이미 들어 있으면 그대로 돌려준다
 * (updatemeta 재조립·naver 이중 적용 경로에서 두 번 붙지 않게 · withCommerceLinks 와 같은 규약).
 * footer 가 비면 원문 그대로 — 문구를 안 적은 채널의 발행은 1바이트도 안 바뀐다.
 */
export function withDescriptionFooter(description: string, footer: string | null | undefined): string {
  const base = String(description ?? "");
  const f = String(footer ?? "").trim();
  if (!f) return base;
  if (base.includes(f)) return base;
  return base.trim() ? `${base.trim()}\n\n${f}` : f;
}

/**
 * 채널(platform + accountId)의 고정 문구. 규칙 없음·조회 실패는 "" —
 * 고정글 때문에 발행이 막히는 방향의 실패는 만들지 않는다(commerce ②와 같은 원칙).
 */
export async function channelDescriptionFooter(platform: string, accountId: string): Promise<string> {
  try {
    if (!platform || !accountId) return "";
    const rule = await getChannelRule(String(platform), String(accountId));
    return String(rule?.descriptionFooter ?? "").trim();
  } catch {
    return "";
  }
}
