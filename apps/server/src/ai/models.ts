/**
 * STEP D · Gemini 모델 이름 중앙 관리 (single source of truth for Node/TS side).
 *
 * 미래 모델 업그레이드 시 이 파일 한 곳만 수정하면 apps/server/ 전체가 자동 반영.
 * core/ Python 은 별도의 `core/models.py` 를 참조 (같은 GEMINI_MODEL env 로 동기).
 *
 * 사용:
 *   import { TEXT } from "./models.ts";
 *   const resp = await client.generateContent({ model: TEXT, ... });
 */

/** 기본 텍스트/추론 모델. 모든 stage 의 기본값.
 * ⚠️ "gemini-3.1-flash" 는 존재하지 않는 이름이라 Vertex 가 404("Publisher model … was not
 * found") 로 죽었다(2026-08-18 편집기 메타데이터 생성 실패). asia-northeast3 실측 결과 이
 * 프로젝트에서 응답하는 건 gemini-2.5-flash 뿐(2.0-flash·2.5-flash-lite 는 404). 모델을 올릴
 * 때는 반드시 그 리전에서 200 인지 확인하고 바꿀 것. */
export const TEXT = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Stage 별 오버라이드 · 없으면 TEXT 재사용. */
export const AUTOFILL = process.env.GEMINI_AUTOFILL_MODEL || TEXT;

/**
 * 워크스페이스 도우미(챗봇·리포트 서술) 모델 — **flash-lite** (사용자 지정 2026-09-03).
 *
 * ⚠️ **리전이 세트다.** 위 TEXT 주석대로 asia-northeast3 에서는 flash-lite 가 404 라
 * (그 리전에서 응답하는 건 2.5-flash 뿐), 이 모델은 **global 엔드포인트**로 보내야 한다 —
 * core 의 장면이해가 이미 같은 조합(flash-lite + VERTEX_LOCATION=global)으로 돈다.
 * 모델만 바꾸고 리전을 그대로 두면 "Publisher model … was not found" 로 죽는다.
 *
 * 그래서 둘을 **한 자리에 붙여 둔다.** 하나만 고치면 나머지가 따라오지 않는 조합이라,
 * 떨어뜨려 두면 다음 사람이 반드시 한쪽만 바꾼다.
 */
export const SUPPORT = process.env.GEMINI_SUPPORT_MODEL || "gemini-2.5-flash-lite";
export const SUPPORT_LOCATION = process.env.GEMINI_SUPPORT_LOCATION || "global";

/** 이미지 생성 · OpenAI gpt-image-2 (2026-07-30 Gemini→OpenAI 전환).
 * 실제 이미지 생성은 core/ Python 파이프라인에서만 발생 (Node 서버는 이미지 gen 안 함).
 * 이 상수는 참조용 · 필요 시 서버 라우트에서 활용. */
export const IMAGE_FLASH = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
export const IMAGE_PRO = process.env.OPENAI_IMAGE_PRO_MODEL || "gpt-image-2";
