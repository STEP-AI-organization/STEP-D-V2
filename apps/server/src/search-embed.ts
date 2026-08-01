/**
 * 검색 쿼리 임베딩 — Vertex `text-multilingual-embedding-002` REST predict.
 *
 * 검색은 동기 쿼리라 워커 파이썬을 스폰하지 않고, Cloud Run 서비스 계정(ADC)으로 Vertex를
 * 직접 부른다. 인덱싱(문서 임베딩)은 core/index_segments.py(RETRIEVAL_DOCUMENT)가, 여기선
 * 쿼리 임베딩(RETRIEVAL_QUERY)만 — 비대칭 검색. 차원은 인덱스와 반드시 동일(768).
 *
 * 실패(자격증명 없음·호출 오류)하면 null을 돌려준다 — 라우트는 키워드 축(pg_trgm)만으로
 * 폴백한다. 한국어는 키워드 매칭이 강해서(설계 §4) 벡터 없이도 검색이 성립한다.
 */
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
const LOCATION = process.env.VERTEX_LOCATION || "asia-northeast3";
const MODEL = process.env.EMBED_MODEL || "text-multilingual-embedding-002";
const DIM = Number(process.env.EMBED_DIM || 768);

let auth: GoogleAuth | undefined;
function getAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}

let warned = false;

/** 쿼리 문자열 → 임베딩 벡터(길이 DIM). 실패 시 null. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const q = (text || "").trim();
  if (!q) return null;
  try {
    const token = await getAuth().getAccessToken();
    if (!token) throw new Error("no access token");
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ task_type: "RETRIEVAL_QUERY", content: q }],
        parameters: { outputDimensionality: DIM },
      }),
    });
    if (!res.ok) throw new Error(`vertex ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
    const values = data.predictions?.[0]?.embeddings?.values;
    return Array.isArray(values) && values.length ? values : null;
  } catch (e) {
    if (!warned) {
      console.warn(`[search-embed] 쿼리 임베딩 실패 → 키워드 축만 사용 (${String(e).slice(0, 160)})`);
      warned = true;
    }
    return null;
  }
}
