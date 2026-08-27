/**
 * 시각 표시의 단일 기준 — **서버가 KST 로 내보내고, 화면은 그대로 쓴다.**
 *
 * ## 무엇이 문제였나 (2026-08-27 실측)
 *
 * Cloud Run 은 UTC 로 돈다. `TIMESTAMPTZ` 컬럼을 node-pg 가 `Date` 로 주고, 그게 JSON 으로
 * 나가면서 `2026-08-27T05:56:23.330Z` 가 된다. 화면은 그 문자열을 잘라 쓴다
 * (`at.slice(0,16).replace("T"," ")`) — 그래서 **KST 14:56 인데 05:56 으로 보였다.** 9시간 밀린다.
 * 날짜만 쓰는 자리(`paidAt.slice(0,10)`)는 KST 00~09시 사이에 **하루가 밀린다** — 거래명세서
 * 결제일이 전날로 찍힌다는 뜻이다.
 *
 * ## 왜 화면이 아니라 여기서 고치나
 *
 * 표시 지점마다 고치면 새 화면이 생길 때마다 같은 실수가 반복된다(이미 대시보드·성과 화면만
 * 로컬 날짜 헬퍼를 따로 갖고 있었고 나머지는 안 그랬다). **서버가 정본을 내보내면 화면은
 * 아무것도 안 해도 맞는다.**
 *
 * ## 기록은 그대로다
 *
 * 저장은 건드리지 않는다 — DB 는 계속 `TIMESTAMPTZ`(절대 시각)로 남는다. 바뀌는 건 JS/JSON
 * 표현뿐이고, 오프셋 `+09:00` 을 달고 나가므로 **절대 시각 정보가 사라지지 않는다.**
 * "언제 무슨 영상이 배포됐고 언제 분석했나" 를 나중에 고객사가 요구해도 그대로 증명된다.
 * `new Date(값)` 도 정확히 같은 순간을 가리킨다.
 *
 * 부수 효과 하나가 더 좋다: 모든 값이 **같은 오프셋**이라 문자열 정렬이 곧 시간 정렬이다
 * (UTC 와 KST 가 섞이면 그게 깨진다).
 */

/** KST 벽시계 + 오프셋. 예: `2026-08-27T14:56:23+09:00` */
const KST_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul",
  year: "numeric", month: "2-digit", day: "2-digit",
  // ⚠️ h23 을 명시한다. hour12:false 만 쓰면 런타임에 따라 자정이 "24" 로 나온다.
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/**
 * Date → KST ISO 문자열(`+09:00` 포함).
 * 값이 없거나 유효하지 않으면 null — 예외로 쿼리를 죽이지 않는다.
 */
export function toKstIso(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  // sv-SE 는 "YYYY-MM-DD HH:MM:SS" 로 준다 — ISO 와 구분자만 다르다.
  return `${KST_FORMAT.format(d).replace(" ", "T")}+09:00`;
}

/** Postgres `TIMESTAMPTZ` 의 OID. `timestamp`(1114)·`date`(1082)는 건드리지 않는다 —
 *  날짜 전용 컬럼(예: 애널리틱스 일자)은 시간대 변환 대상이 아니다. */
export const TIMESTAMPTZ_OID = 1184;

/** node-pg 의 timestamptz 파서를 KST 문자열로 바꾼다. 기동 시 **한 번만** 부른다. */
export function installKstTimestampParser(types: {
  getTypeParser(oid: number): (value: string) => unknown;
  setTypeParser(oid: number, parser: (value: string) => unknown): void;
}): void {
  // 파싱 자체는 pg 기본 파서에 맡긴다 — `2026-08-27 05:56:23.33+00` 같은 포맷을 직접
  // 다루면 오프셋 표기(+00 / +00:00)에서 틀린다. 우리는 Date → 문자열만 담당한다.
  const base = types.getTypeParser(TIMESTAMPTZ_OID);
  types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => {
    const parsed = base(value) as Date | null;
    return parsed instanceof Date ? (toKstIso(parsed) ?? value) : parsed;
  });
}
