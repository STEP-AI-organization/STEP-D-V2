import { useMemo, useState } from "react";
import { api, type AdminJob, type HarvestPending } from "../api";
import { Avatar, Panel, State, useLoad, when } from "./common";
import { TenantName, useTenantNames } from "./tenant-name";

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
  const { names } = useTenantNames();
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
   * 벌크 재시도 — **한 번의 호출**로 보낸다(§2-4). 예전엔 프런트가 N번 불렀는데, 그러면
   * 감사 로그에 같은 사유가 N줄로 쌓이고 중간에 실패하면 어디까지 됐는지 화면이 모른다.
   *
   * 서버가 재시도 불가한 건을 **걸러서 왜 걸렀는지** 돌려준다 — 조용히 빼면 사람은 다 된 줄 안다.
   */
  async function retryAll(key: string, list: AdminJob[]) {
    const targets = list.filter((j) => j.status === "failed" && j.retryable);
    if (!targets.length) return;
    if (!window.confirm(`${targets.length}건을 재시도할까요?`)) return;
    setWorking(key);
    try {
      const r = await api.retryJobs(targets.map((j) => j.id));
      if (r.skipped.length) {
        const NL = String.fromCharCode(10);
        alert(`${r.retried}건 재시도 · ${r.skipped.length}건 건너뜀${NL}${NL}`
          + r.skipped.slice(0, 5).map((x) => `· ${x.why}`).join(NL));
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
      await reload();
    }
  }

  return <>
    <h1>운영 작업</h1>
    <p className="sub">완료 기록이 아니라 <b>사람의 결정이 남은 것</b>만 모읍니다. 원인이 같으면 한 줄로 묶습니다.</p>

    {/* 승인 대기가 인박스 맨 위다 — 잡 실패와 달리 **아무도 재시도해 주지 않는다.**
        운영자가 누르기 전까지 그 고객사의 완전자동화는 통째로 멈춰 있다. */}
    <HarvestApprovals />


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
            <section className="ibox" key={g.key}>
              <div className="ibox-head">
                {/* 점 색이 곧 "누구 일인가" 다 — 빨강=재시도로 풀림, 주황=우리가 고쳐야 함,
                    회색=우리 일이 아님(충전·재연동·정리). */}
                <span className="ibox-dot" style={{ background: g.dot }} />
                <h2>{groupBy === "cause" ? g.label : <TenantName id={g.key} />}</h2>
                <span className="ibox-count">{g.jobs.length}건</span>
                <span className="ibox-note">{g.hint}</span>
                {g.retryable && g.jobs.some((j) => j.status === "failed") && (
                  <button
                    className="primary pill sm"
                    disabled={working === g.key}
                    onClick={(e) => { e.stopPropagation(); void retryAll(g.key, g.jobs); }}
                  >
                    {working === g.key
                      ? "재시도 중…"
                      : `${g.jobs.filter((j) => j.status === "failed").length}건 전부 재시도`}
                  </button>
                )}
              </div>

              {g.jobs.map((j) => (
                <div className="ibox-row" key={j.id}>
                  <Avatar id={j.tenantId} name={names[j.tenantId] ?? j.tenantId} size={26} />
                  <div className="ibox-main">
                    <div className="ibox-title">
                      <span className="mono">{j.type}</span>
                      <span className="muted"> · </span>
                      <TenantName id={j.tenantId} plain />
                    </div>
                    <div className="ibox-meta">
                      {j.attempts}회 시도 · {when(j.updatedAt)}
                      {j.error && ` · ${j.error.replace(/\s+/g, " ").slice(0, 120)}`}
                    </div>
                  </div>
                  {groupBy === "tenant" && <span className="tag">{j.causeLabel}</span>}
                  <div className="ibox-act">
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
            </section>
          ))}
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            완료된 잡·정상 회사는 여기 오지 않습니다 — 조치가 끝나면 줄이 사라지고, 사유는 감사 로그에 남습니다.
          </p>
        </div>
      </State>
    </Panel>
  </>;
}

type Group = { key: string; label: string; hint: string; retryable: boolean; dot: string; jobs: AdminJob[] };

/**
 * 묶음 점 색 = **누가 처리해야 하는가.**
 *   빨강  재시도하면 풀린다 (쿼터·시간초과·외부장애·임시파일)
 *   주황  우리가 고쳐야 한다 (ffmpeg·실행환경)
 *   회색  우리 일이 아니다 — 충전·재연동·정리 (크레딧·권한·404)
 * 심각도가 아니라 **다음 행동**으로 색을 나눈다. 빨강이 많은 게 나쁜 게 아니라, 회색이 쌓이는
 * 게 나쁘다(아무도 안 치운다는 뜻이라서).
 */
function causeDot(cause: string, retryable: boolean): string {
  if (cause === "ffmpeg" || cause === "config") return "#e37400";
  if (cause === "credits" || cause === "auth" || cause === "not_found") return "#5f6368";
  return retryable ? "#d93025" : "#5f6368";
}

/**
 * 묶기. 큰 묶음이 위로 온다 — 한 번에 정리되는 게 먼저 보여야 한다.
 *
 * ⚠️ 묶음의 `retryable` 은 **전부 재시도 가능할 때만** true 다. 하나라도 아니면 벌크 버튼을
 *    숨긴다 — 섞인 묶음에서 "전부 재시도" 를 누르면 안 되는 것까지 나간다.
 */
/**
 * 완전자동화 **수집 채널 승인** — 우리가 연결하지 않은 채널을 열어 주는 자리.
 *
 * ## 왜 어드민에 있나
 *
 * 고객사 화면에는 "승인 대기" 라고만 뜬다. 스스로 못 여는 이유는 이 문이 **저작권 판단**
 * 이기 때문이다 — 계약된 MCN·제작사 채널인지를 아는 것은 우리(STEPAI)이고, 그 판단을 한
 * 사람의 이름이 `approved_by` 와 감사 로그에 남아야 한다.
 *
 * ⚠️ **승인 전에 채널을 직접 열어 볼 것.** 승인하면 그 채널의 롱폼을 내려받아 숏폼으로
 * 만들어 **고객사 유튜브 채널에 올린다.** 남의 영상이면 저작권 사고다. 그래서 사유를
 * 4자 이상 받고(다른 회사 데이터라 `requireReason` 이 강제한다), 채널 링크를 같이 준다.
 *
 * 잡 실패와 달리 **아무도 재시도해 주지 않는다** — 누를 때까지 그 고객사의 완전자동화는
 * 통째로 멈춰 있다. 그래서 인박스 맨 위에 둔다.
 */
function HarvestApprovals() {
  const { names } = useTenantNames();
  const [working, setWorking] = useState<string | null>(null);
  const { data, busy, error, reload } = useLoad(() => api.harvestPending(), []);
  const rows = data?.sources ?? [];

  async function approve(row: HarvestPending) {
    const reason = window.prompt(
      `"${row.sourceChannelTitle}" 를 승인합니다.\n\n`
      + "승인하면 이 채널의 영상을 내려받아 숏폼으로 만들어 고객사 채널에 올립니다.\n"
      + "채널을 열어 확인하셨습니까? 승인 사유를 적어 주세요 (4자 이상 · 감사 로그에 남습니다).",
      "",
    );
    // 취소는 조용히 — 사유가 짧으면 서버가 400 으로 막는다(같은 잣대를 두 벌로 두지 않는다).
    if (reason === null) return;
    setWorking(row.id);
    try {
      const r = await api.approveHarvest(row.id, reason);
      alert(`승인했습니다 — ${r.approvedBy}`);
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  // 대기가 없으면 **아무것도 그리지 않는다.** 빈 패널은 인박스에서 잡음이다.
  if (!busy && !error && rows.length === 0) return null;

  return (
    <Panel
      title="수집 채널 승인 대기"
      actions={<button onClick={reload}>새로고침</button>}
    >
      <State busy={busy} error={error} empty={!rows.length}>
        <div className="inbox">
          <section className="ibox">
            <div className="ibox-head">
              <span className="ibox-dot" style={{ background: "#f59e0b" }} />
              <h2>운영자 승인이 필요합니다</h2>
              <span className="ibox-count">{rows.length}건</span>
              <span className="ibox-note">승인 전까지 그 회사의 완전자동화는 돌지 않습니다</span>
            </div>
            {rows.map((r) => (
              <div className="ibox-row" key={r.id}>
                <Avatar id={r.tenantId} name={names[r.tenantId] ?? r.tenantId} size={26} />
                <div className="ibox-main">
                  <div className="ibox-title">
                    {r.sourceChannelTitle || r.sourceChannelId}
                    <span className="muted"> · </span>
                    <TenantName id={r.tenantId} plain />
                  </div>
                  <div className="ibox-meta">
                    등록 {when(r.createdAt)} · <span className="mono">{r.sourceChannelId}</span>
                  </div>
                </div>
                <div className="ibox-act">
                  {/* 확인 없이 누르는 것을 막는 가장 싼 방법 — 채널을 먼저 열어 보게 한다. */}
                  <a href={r.channelUrl} target="_blank" rel="noreferrer">
                    <button>채널 열기</button>
                  </a>
                  <button
                    className="primary"
                    disabled={working === r.id}
                    onClick={() => void approve(r)}
                  >
                    {working === r.id ? "승인 중…" : "승인"}
                  </button>
                </div>
              </div>
            ))}
          </section>
        </div>
      </State>
    </Panel>
  );
}

function groupJobs(jobs: AdminJob[], by: GroupBy): Group[] {
  const map = new Map<string, Group>();
  for (const j of jobs) {
    const key = by === "cause" ? (j.cause ?? "unknown") : (j.tenantId || "—");
    const g = map.get(key) ?? {
      key,
      label: by === "cause" ? (j.causeLabel || "원인 미분류") : key,
      hint: by === "cause" ? (j.causeHint || "") : "",
      retryable: true,
      dot: causeDot(j.cause ?? "unknown", j.retryable !== false),
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
