/**
 * **잡이 왜 실패했나** — 자유 문자열 `error` 를 원인 하나로 접는다.
 *
 * 왜 서버에 두나: 어드민 인박스가 "원인이 같은 건 한 줄로 묶는다". 이 분류를 프런트에 두면
 * 나중에 알림·리포트가 같은 규칙을 따로 갖게 되고, 그때부터 세 곳이 조금씩 갈린다.
 *
 * ── 규칙은 **실제로 나는 오류**에서 나왔다 (프로덕션 실측 2026-09-03, 실패 189건)
 *   187건  video.comments  `Comment threads failed (404): … "code": 404 …`
 *     1건  content.analyze `spawn …\\python ENOENT`
 *     1건  reframe.compare `ENOENT: no such file or directory, open '/tmp/…jpg'`
 *
 * ⚠️ 그래서 설계안이 예시로 든 표(quota·ffmpeg·credits·timeout)를 **그대로 쓰면 안 됐다.**
 *    그 넷은 지금 한 건도 안 난다 — 그것만 넣으면 189건 중 189건이 `unknown` 으로 떨어져
 *    "원인별로 묶는다" 는 기능이 첫날부터 무의미해진다. 실측 셋을 먼저 넣고, 예상 넷은
 *    **언젠가 날 것**이라 같이 넣었다(비용이 0 이라서).
 *
 * ⚠️ **`retryable: false` 가 이 파일의 값어치다.** 실패 187건이 전부 **5회(상한)까지 재시도**된
 *    상태다 — 댓글이 꺼진 영상은 100번을 눌러도 404 다. 사람이 "전부 재시도" 를 누르는 걸
 *    막지 못하면 유튜브 쿼터만 태운다(187건 × 4회 = 헛호출 748번이 이미 나갔다).
 */

export type JobCause =
  | "quota" | "not_found" | "auth" | "credits" | "timeout"
  | "ffmpeg" | "missing_file" | "config" | "vendor_5xx" | "unknown";

export type JobCauseInfo = {
  cause: JobCause;
  /** 인박스 그룹 머리글에 그대로 쓴다. */
  causeLabel: string;
  /** "그래서 뭘 하면 되나" — 한 줄. 없으면 사람이 원인을 보고도 다음 수를 모른다. */
  causeHint: string;
  /** false 면 UI 가 재시도 버튼을 숨긴다. 눌러 봐야 같은 실패다. */
  retryable: boolean;
};

/**
 * 위에서부터 **먼저 맞는 것**이 이긴다. 순서가 규칙의 일부다:
 *  · `spawn … ENOENT`(실행 파일 없음 = 설정)를 일반 `ENOENT`(임시 파일 없음)보다 **먼저** 본다.
 *  · 404 를 auth(401·403)보다 먼저 본다 — 유튜브는 비공개 영상에 404 를 준다.
 */
const RULES: Array<{ cause: JobCause; test: RegExp; label: string; hint: string; retryable: boolean }> = [
  {
    cause: "quota",
    test: /\b429\b|RESOURCE_EXHAUSTED|quotaExceeded|rateLimitExceeded|Too Many Requests/i,
    label: "API 쿼터 소진",
    hint: "쿼터가 회복된 뒤(보통 태평양 시간 자정) 한 번에 재시도하면 됩니다.",
    retryable: true,
  },
  {
    cause: "config",
    test: /spawn\s.*ENOENT|MODULE_NOT_FOUND|command not found|is not recognized/i,
    label: "실행 환경 설정",
    hint: "워커에 실행 파일·경로가 없습니다. 재시도가 아니라 워커 설정을 고쳐야 합니다.",
    retryable: false,
  },
  {
    cause: "not_found",
    test: /\b404\b|not ?found|does not exist|no longer available|has been removed/i,
    label: "대상이 없거나 접근할 수 없음 (404)",
    hint: "영상이 지워졌거나 댓글이 꺼져 있습니다. 재시도해도 같은 결과라 **제거**가 맞습니다.",
    retryable: false,
  },
  {
    cause: "auth",
    test: /\b40[13]\b|invalid_grant|unauthorized|PERMISSION_DENIED|insufficient authentication|revoked/i,
    label: "권한·인증 만료",
    hint: "채널 연결이 끊겼습니다. 고객이 다시 연동해야 풀립니다.",
    retryable: false,
  },
  {
    cause: "credits",
    test: /insufficient credits|크레딧|tenant suspended|정지된/i,
    label: "크레딧 부족·정지",
    hint: "충전하거나 정지를 풀어야 진행됩니다. 재시도만으로는 안 됩니다.",
    retryable: false,
  },
  {
    cause: "ffmpeg",
    test: /^ffmpeg exit|no such filter|Invalid argument.*ffmpeg|ffmpeg.*failed/i,
    label: "ffmpeg 실행 실패",
    hint: "필터·코덱이 워커 이미지에 없을 수 있습니다. 재배포 전에는 같은 실패입니다.",
    retryable: false,
  },
  {
    cause: "timeout",
    test: /ETIMEDOUT|ESOCKETTIMEDOUT|deadline|timed? ?out|DEADLINE_EXCEEDED/i,
    label: "시간 초과",
    hint: "일시적인 경우가 많습니다 — 그대로 재시도해 보세요.",
    retryable: true,
  },
  {
    cause: "vendor_5xx",
    test: /\b50[0234]\b|UNAVAILABLE|INTERNAL|Bad Gateway|Service Unavailable|ECONNRESET/i,
    label: "외부 서비스 일시 장애",
    hint: "상대 쪽 문제입니다. 잠시 뒤 재시도하면 대개 풀립니다.",
    retryable: true,
  },
  {
    cause: "missing_file",
    test: /ENOENT|no such file/i,
    label: "작업 파일 없음",
    hint: "임시 파일이 사라졌습니다(워커 재시작·정리). 재시도하면 처음부터 다시 만듭니다.",
    retryable: true,
  },
];

const UNKNOWN: JobCauseInfo = {
  cause: "unknown",
  causeLabel: "원인 미분류",
  causeHint: "오류 문구를 보고 판단해야 합니다. 자주 보이면 분류 규칙에 추가하세요.",
  retryable: true,
};

/**
 * 오류 문자열 → 원인. 오류가 비어 있으면(아직 안 끝난 잡) `unknown`.
 *
 * ⚠️ **모르는 건 재시도 가능으로 둔다.** 반대로 하면 분류가 못 따라간 새 오류를 사람이
 *    손도 못 대게 된다 — 분류기의 무지가 운영을 막으면 안 된다.
 */
export function classifyJobError(error: string | null | undefined): JobCauseInfo {
  const text = String(error ?? "").trim();
  if (!text) return UNKNOWN;
  for (const r of RULES) {
    if (r.test.test(text)) {
      return { cause: r.cause, causeLabel: r.label, causeHint: r.hint, retryable: r.retryable };
    }
  }
  return UNKNOWN;
}

/** 인박스가 그룹을 셀 때 쓰는 키 — 같은 원인이면 한 줄로 묶인다. */
export function causeKey(error: string | null | undefined): JobCause {
  return classifyJobError(error).cause;
}
