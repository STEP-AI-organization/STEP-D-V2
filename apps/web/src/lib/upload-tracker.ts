/**
 * 진행 중인 업로드 추적 (FLOWS F1 — "모달을 닫아도 업로드는 계속된다").
 *
 * 업로드는 모달보다 오래 산다. 모달이 언마운트돼도 fetch/XHR 은 계속 도는데,
 * 탭 닫기 경고(beforeunload)를 모달 안에 두면 창을 닫는 순간 경고가 같이 사라져서
 * **새로고침 한 번에 몇 GB 짜리 업로드가 말없이 죽는다.** 그래서 경고를 여기로 옮긴다.
 *
 * 상태는 모듈 전역이다 — 화면 전환과 무관하게 살아 있어야 하기 때문이다.
 */

let inflight = 0;
const listeners = new Set<(n: number) => void>();

function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = "";
}

function notify() {
  for (const l of listeners) l(inflight);
}

/** 업로드 하나를 추적 대상에 넣는다. 성공/실패 어느 쪽이든 끝나면 자동으로 빠진다. */
export function trackUpload<T>(promise: Promise<T>): Promise<T> {
  if (typeof window !== "undefined" && inflight === 0) {
    window.addEventListener("beforeunload", onBeforeUnload);
  }
  inflight += 1;
  notify();
  return promise.finally(() => {
    inflight -= 1;
    if (typeof window !== "undefined" && inflight === 0) {
      window.removeEventListener("beforeunload", onBeforeUnload);
    }
    notify();
  });
}

export function inflightUploads(): number {
  return inflight;
}

/** 진행 중 업로드 수 구독 — 셸이 "업로드 N건 진행 중"을 띄울 때 쓴다. */
export function subscribeUploads(fn: (n: number) => void): () => void {
  listeners.add(fn);
  fn(inflight);
  return () => listeners.delete(fn);
}
