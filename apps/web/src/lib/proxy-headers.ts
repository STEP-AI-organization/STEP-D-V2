/**
 * **홉바이홉 헤더 — 프록시는 그대로 넘기면 안 된다** (RFC 7230 §6.1).
 *
 * 이걸 안 지우면 undici(Node fetch)가 요청을 만들지도 못하고 던진다. 실측(2026-08-28):
 *   transfer-encoding / keep-alive / upgrade → InvalidArgumentError(**UND_ERR_INVALID_ARG**)
 *   expect                                  → NotSupportedError
 * 프록시는 예외를 "fetch failed (UND_ERR_INVALID_ARG)" 로 감싸 보내므로, 화면엔
 * "삭제 실패 · fetch failed (UND_ERR_INVALID_ARG)" 처럼 원인과 무관해 보이는 문구로 나온다.
 *
 * 왜 간헐적이었나: 본문이 **청크 인코딩**으로 들어오는 요청만 걸린다. 브라우저가 길이를 아는
 * 본문은 content-length 로 오고(정상 통과), 길이를 모르거나 중간 경로가 청크로 바꾼 요청만
 * transfer-encoding: chunked 를 달고 함수까지 온다 — 그래서 "저장·삭제가 됐다 안 됐다" 였다.
 * 프로덕션 실측: 같은 URL 에 content-length 로 보내면 401(업스트림 도달), 청크로 보내면
 * 502 UND_ERR_INVALID_ARG(업스트림에 닿지도 못함).
 *
 * ⚠️ `connection` 은 여기 넣지 않는다 — 프록시가 곧바로 `close` 로 **덮어쓰는** 게 목적이다
 *    (freeze/thaw 된 함수가 죽은 소켓을 재사용해 ECONNRESET 나는 것을 막는 별개의 대책).
 * ⚠️ `content-length` 도 여기 없다 — 프록시가 본문을 버퍼로 다시 실어 undici 가 새로 계산한다.
 *    두 헤더 모두 프록시 쪽에서 따로 다룬다.
 */
export const HOP_BY_HOP = [
  "transfer-encoding", "keep-alive", "upgrade", "expect",
  "te", "trailer", "proxy-authenticate", "proxy-authorization",
];
