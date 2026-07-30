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

/** 기본 텍스트/추론 모델. 모든 stage 의 기본값. */
export const TEXT = process.env.GEMINI_MODEL || "gemini-3.1-flash";

/** Stage 별 오버라이드 · 없으면 TEXT 재사용. */
export const AUTOFILL = process.env.GEMINI_AUTOFILL_MODEL || TEXT;

/** 이미지 생성. */
export const IMAGE_FLASH = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
export const IMAGE_PRO = process.env.GEMINI_IMAGE_PRO_MODEL || "gemini-3-pro-image";
