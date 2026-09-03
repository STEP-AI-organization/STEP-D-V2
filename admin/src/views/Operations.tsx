import { useMemo, useState } from "react";
import { api, type AdminJob } from "../api";
import { Panel, State, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

/**
 * 운영 인박스 — **원인이 같은 건 한 줄로 묶는다** (개선안 §1-1).
 *
 * 예전엔 실패 잡을 한 줄씩 표로 뿌렸다. 프로덕션 실측(2026-09-03) 실패 189건 중 **187건이
 * 같은 원인**(댓글 꺼진 영상 404)이었다 — 같은 줄을 187번 읽게 하는 화면이었다는 뜻이다.
 * 원인으로 묶으면 사람이 봐야 할 줄이 3줄로 준다.
 *
 * ⚠️ **분류는 서버가 한다**(`pipeline/job-cause.ts`). 여기서 정규식을 다시 짜면 알림·리포트와
 *    조금씩 갈린다 — 프런트는 `job.cause` 를 **읽기만** 한다.
 *
 * ⚠️ **`retryable:false` 면 재시도 버튼을 안 그린다.** 187건이 이미 5회(상한)까지 헛돌았다.
 *    버튼을 두면 사람이 "전부 재시도" 를 눌러 유튜브 쿼터만 태운다.
 */
type GroupBy = "cause" | "tenant";

export function Operations() {
  const [tenant, setTenant] = useState("");
  const [applied, setApplied] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("cause");
  const [working, setWorking] = useState<string | null>(null);
  const { data, busy, error, reload } = useLoad(() => api.jobs(applied || undefined), [applied]);

  // 완료된 건 인박스에 없다 — 여긴 **사람의 결정이 남은 것**만 모으는 자리다.
  const jobs = useMemo(() => (data?.jobs ?? []).filter((j) => j.status !== "done"), [data]);
  const failed = jobs.filter((j) => j.status === "failed").length;
  const running = jobs.filter((j) => j.status === "running").length;

  const groups = useMemo(() => groupJobs(jobs, groupBy), [jobs, groupBy]);

  async function retry(id: string) {
    try { await api.retryJob(id); await reload(); } catch (e) { alert(String(e)); }
  }
  async function remove(id: string) {
    if (!window.confirm("이 작업을 큐에서 제거할까요?")) return;
    try { await api.removeJob(id); await reload(); } catch (e) { alert(String(e)); }
  }
  /**
   * 벌크 재시도 — 서버에 벌크 라우트가 없어 **N번 부른다**(개선안 §2-4 는 아직 없음).
   * 그래서 ① 재시도 가능한 것만 보내고 ② 한 건이 실패해도 나머지를 계속한다.
   */
  async function retryAll(key: string, list: AdminJob[]) {
    const targets = list.filter((j) => j.status === "failed" && j.retryable);
    if (!targets.length) return;
    if (!window.confirm(`${targets.length}건을 재시도할까요?`)) return;
    setWorking(key);
    let ok = 0;
    const failedIds: string[] = [];
    for (const j of targets) {
      try { await api.retryJob(j.id); ok += 1; } catch { failedIds.push(j.id); }
    }
    setWorking(null);
    await reload();
    if (failedIds.length) alert(`${ok}건 재시도 · ${failedIds.length}건 실패`);
  }

  return <>
    <h1>운영 작업</h1>
    <p className="sub">완료 기록이 아니라 <b>사람의 결정이 남은 것</b>만 모읍니다. 원인이 같으면 한 줄로 묶습니다.</p>

    <div className="cards">
      <Metric k="실패" v={failed} bad />
      <Metric k="실행 중" v={running} />
      <Metric k="처리 필요" v={jobs.length} />
      <Metric k="원인 종류" v={groups.length} />
    </div>

    <Panel
      title="인박스"
      actions={<div className="row">
        <button data-active={groupBy === "cause"} onClick={() => setGroupBy("cause")}>원인별</button>
        <button data-active={groupBy === "tenant"} onClick={() => setGroupBy("tenant")}>회사별</button>
        <input
          placeholder="회사 ID" value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setApplied(tenant.trim()); }}
        />
        <button onClick={() => setApplied(tenant.trim())}>필터</button>
        <button onClick={reload}>새로고침</button>
      </div>}
    >
      <State busy={busy} error={error} empty={!jobs.length}>
        <div className="inbox">
          {groups.map((g) => (
            <div className="inbox-group" key={g.key}>
              <div className="inbox-head">
                <div>
                  <div className="inbox-title">
                    {groupBy === "cause" ? g.label : <TenantName id={g.key} />}
                    <span className="inbox-count">{g.jobs.length}건</span>
                    {/* 재시도해도 같은 실패인 묶음은 그렇게 말한다 — 안 적으면 계속 누른다. */}
                    {!g.retryable && <span className="tag">재시도 불가</span>}
                  </div>
                  {g.hint && <div className="inbox-hint">{g.hint}</div>}
                </div>
                <div className="spacer" />
                {g.retryable && g.jobs.some((j) => j.status === "failed") && (
                  <button
                    disabled={working === g.key}
                    onClick={() => void retryAll(g.key, g.jobs)}
                  >
                    {working === g.key ? "재시도 중…" : `${g.jobs.filter((j) => j.status === "failed").length}건 전부 재시도`}
                  </button>
                )}
              </div>

              <div className="inbox-rows">
                {g.jobs.map((j) => (
                  <div className="inbox-row" key={j.id}>
                    <div className="inbox-row-main">
                      <span className="mono">{j.type}</span>
                      <span className="muted"> · </span>
                      <TenantName id={j.tenantId} />
                      {groupBy === "tenant" && <span className="tag">{j.causeLabel}</span>}
                    </div>
                    <div className="inbox-row-meta muted">
                      {j.attempts}회 시도 · {when(j.updatedAt)}
                      {j.error && <> · <span className="wrap">{j.error.slice(0, 160)}</span></>}
                    </div>
                    <div className="row">
                      {/* 재시도 가능한 실패만 버튼을 준다. 실행 중인 건 건드리지 않는다. */}
                      {j.status === "failed" && j.retryable && (
                        <button onClick={() => void retry(j.id)}>재시도</button>
                      )}
                      {j.status !== "running" && (
                        <button className="danger" onClick={() => void remove(j.id)}>제거</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </State>
    </Panel>
  </>;
}

type Group = { key: string; label: string; hint: string; retryable: boolean; jobs: AdminJob[] };

/**
 * 묶기. 큰 묶음이 위로 온다 — 한 번에 정리되는 게 먼저 보여야 한다.
 *
 * ⚠️ 묶음의 `retryable` 은 **전부 재시도 가능할 때만** true 다. 하나라도 아니면 벌크 버튼을
 *    숨긴다 — 섞인 묶음에서 "전부 재시도" 를 누르면 안 되는 것까지 나간다.
 */
function groupJobs(jobs: AdminJob[], by: GroupBy): Group[] {
  const map = new Map<string, Group>();
  for (const j of jobs) {
    const key = by === "cause" ? (j.cause ?? "unknown") : (j.tenantId || "—");
    const g = map.get(key) ?? {
      key,
      label: by === "cause" ? (j.causeLabel || "원인 미분류") : key,
      hint: by === "cause" ? (j.causeHint || "") : "",
      retryable: true,
      jobs: [],
    };
    g.jobs.push(j);
    if (j.status === "failed" && !j.retryable) g.retryable = false;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.jobs.length - a.jobs.length);
}

function Metric({ k, v, bad }: { k: string; v: number; bad?: boolean }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v" style={bad && v > 0 ? { color: "var(--bad)" } : undefined}>
        {v.toLocaleString("ko-KR")}
      </div>
    </div>
  );
}
