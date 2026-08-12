"use client";

/**
 * 서버에 못 붙었을 때 화면 위에 한 줄.
 *
 * ⚠️ 이게 없으면 **빈 화면이 거짓말을 한다.** 스토어는 서버 연결 실패 시 목 데이터로
 * 폴백하지 않고 빈 상태를 유지하는데(의도된 설계다), 화면은 그걸 "아직 데이터가 없네요" 로
 * 그린다. 로그인한 지 5초 된 사람과 백엔드가 죽은 상황이 **똑같이** 보인다.
 *
 * `apps/web/CLAUDE.md` 가 명시적으로 경고하는 상황이고, 스토어는 `serverConnected` 로
 * 이미 정확히 구분하고 있었다 — 소비하는 곳이 두 군데뿐이라 화면에 안 나왔을 뿐이다.
 *
 * `loading` 중에는 띄우지 않는다. 기동 직후 잠깐 false 인 구간을 장애로 보이게 하면
 * 배너가 늑대 소년이 된다.
 */
import { useAppData } from "@/lib/data/store";

export function ConnectionBanner() {
  const { serverConnected, loading } = useAppData();
  if (loading || serverConnected) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-2 text-[11.5px]"
      style={{
        background: "var(--sd-warn-bg, #fff4e5)",
        color: "var(--sd-warn-fg, #7a4a00)",
        borderBottom: "1px solid var(--sd-border)",
      }}
    >
      <b>서버에 연결할 수 없습니다.</b>
      <span>지금 보이는 목록이 비어 있는 것은 데이터가 없어서가 아닙니다 — 저장·배포도 되지 않습니다.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="underline underline-offset-2"
      >
        다시 시도
      </button>
    </div>
  );
}
