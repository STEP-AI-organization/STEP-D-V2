import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../api";

/**
 * 회사 id → 이름.
 *
 * **사람에게 의미 있는 건 이름이지 id 가 아니다.** 잡 목록·감사 로그·결제·사용자 표가
 * 전부 `tenant_id` 를 그대로 찍고 있었는데, 그러면 `1` 이나 `t_default` 를 보고 어느
 * 회사인지 알 수가 없다. 한때 이 문제를 "id 를 읽히게 만들자"로 풀려고 했는데
 * (이름에서 슬러그를 만들다 한글에서 깨졌다) 방향이 틀렸다 — **표가 이름을 보여주면 될 일**이다.
 *
 * 회사 목록은 어차피 한 번 부르므로 앱 전체에서 한 번만 받아 공유한다.
 */
const Ctx = createContext<{ names: Record<string, string>; reload: () => void }>({
  names: {},
  reload: () => {},
});

export function TenantNames({ children }: { children: React.ReactNode }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void api
      .tenants()
      .then((r) => {
        if (!alive) return;
        setNames(Object.fromEntries(r.tenants.map((t) => [t.id, t.name])));
      })
      // 이름을 못 받아도 표는 보여야 한다 — id 로 폴백한다.
      .catch(() => {});
    return () => { alive = false; };
  }, [tick]);

  return <Ctx.Provider value={{ names, reload: () => setTick((v) => v + 1) }}>{children}</Ctx.Provider>;
}

/**
 * 회사를 사람이 읽는 모양으로. 이름을 크게, id 는 작게 뒤에 붙인다 —
 * id 를 아주 숨기면 URL·로그와 대조할 수가 없다.
 */
export function TenantName({ id, plain }: { id: string | null | undefined; plain?: boolean }) {
  const { names } = useContext(Ctx);
  if (!id) return <span className="muted">—</span>;
  const name = names[id];
  if (plain) return <>{name ?? id}</>;
  return (
    <span title={id}>
      {name ?? <code>{id}</code>}
      {name && <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>#{id}</span>}
    </span>
  );
}

export function useTenantNames() {
  return useContext(Ctx);
}
