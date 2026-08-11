"use client";

/**
 * U7 · 배포 채널 (README §10 · FLOWS F4-2 의 데이터 소스).
 *
 * 여기서 정한 규칙이 배포 모달의 선택 가능 여부를 결정한다.
 * "채널마다 규칙이 다르고, 규칙은 선택 즉시 폼에 반영된다" 의 **왼쪽 절반**이다.
 *
 * 계정 연결(OAuth·토큰)은 /publish-channels 가 담당한다. 이 화면은 **운영 규칙**만 다룬다 —
 * 계정이 끊겨도 규칙은 남아 있어야 재연결 뒤 그대로 쓴다.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  deleteChannelRule,
  fetchChannelRules,
  fetchYouTubeChannels,
  saveChannelRule,
  type ChannelRole,
  type ChannelRule,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<ChannelRole, string> = {
  main: "본채널",
  sub: "서브채널",
  shorts_only: "숏폼 전용",
  affiliate: "계열 채널",
};

const PLATFORMS = [
  { key: "youtube", label: "YouTube", upload: true },
  { key: "instagram", label: "Instagram", upload: false },
  { key: "facebook", label: "Facebook", upload: false },
  { key: "tiktok", label: "TikTok", upload: false },
  { key: "smr", label: "SMR (포털 VOD)", upload: false },
];

export default function ChannelsPage() {
  const { toast } = useToast();
  const [rules, setRules] = useState<ChannelRule[]>([]);
  // **연결된 계정**과 **업로드 규칙**은 다른 것이다. 규칙만 보여주면 계정을 10개 연결해 두고도
  // "채널이 없다"고 보인다 — 실제로 그렇게 됐다(2026-08-11).
  const [accounts, setAccounts] = useState<YouTubeChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        fetchChannelRules(),
        fetchYouTubeChannels().catch(() => [] as YouTubeChannelInfo[]),
      ]);
      setRules(r);
      setAccounts(a);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byPlatform = useMemo(() => {
    const m = new Map<string, ChannelRule[]>();
    for (const r of rules) {
      const list = m.get(r.platform);
      if (list) list.push(r);
      else m.set(r.platform, [r]);
    }
    return m;
  }, [rules]);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          계정 연결(로그인·토큰)은{" "}
          <Link href="/publish-channels" className="underline" style={{ color: "var(--sd-accent)" }}>
            배포채널 연동
          </Link>
          에서. 여기서는 채널마다의 <b>업로드 규칙</b>을 정합니다.
        </p>
        <button type="button" className="sd-btn sd-btn-primary ml-auto" onClick={() => setAdding(true)}>
          ＋ 채널 규칙 추가
        </button>
      </div>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          규칙을 불러오지 못했습니다 ({error}).
        </div>
      )}

      {adding && (
        <RuleForm
          onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await load(); }}
        />
      )}

      {/* ── 연결된 계정 ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            연결된 계정
          </h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            OAuth 로 연결된 채널입니다. 여기에 <b>업로드 규칙</b>을 붙여야 배포 모달에서 고를 수 있습니다.
          </span>
        </div>

        {accounts.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            연결된 채널이 없습니다 —{" "}
            <Link href="/publish-channels" className="ml-1 underline" style={{ color: "var(--sd-accent)" }}>
              배포채널 연동
            </Link>
            에서 연결하세요
          </div>
        ) : (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {accounts.map((a) => {
              const rule = rules.find((r) => r.platform === "youtube" && r.accountId === a.channelId);
              return (
                <div key={a.channelId} className="sd-card flex items-center gap-2.5 p-2.5">
                  <span
                    className="grid size-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ background: "var(--sd-accent)" }}
                    aria-hidden
                  >
                    {a.channelName?.[0] ?? "?"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px]" style={{ color: "var(--sd-fg)" }}>{a.channelName}</div>
                    <div className="sd-mono truncate text-[10px]" style={{ color: "var(--sd-mut)" }}>
                      {a.channelId}
                    </div>
                  </div>
                  {rule ? (
                    <span className="sd-tag sd-tag--airing shrink-0">규칙 있음</span>
                  ) : (
                    // 규칙이 없으면 이 계정으로는 배포할 수 없다 — 그 사실과 해결 버튼을 같이 준다.
                    <button
                      type="button"
                      className="sd-btn shrink-0"
                      onClick={async () => {
                        try {
                          await saveChannelRule({
                            platform: "youtube",
                            accountId: a.channelId,
                            label: a.channelName || a.channelId,
                            role: "main",
                            maxSec: null,
                            aspect: "any",
                            titlePrefix: "",
                            hashtagTemplate: "",
                            tonePreset: "기본",
                            privacy: "public",
                            scheduleWindow: "",
                            enabled: true,
                          });
                          toast({ title: "규칙을 만들었습니다", description: `${a.channelName} — 아래에서 세부 규칙을 정하세요.`, tone: "done" });
                          await load();
                        } catch (err) {
                          toast({ title: "규칙 생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                        }
                      }}
                    >
                      ＋ 규칙 만들기
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {rules.length === 0 && !loading && !adding ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          등록된 채널 규칙이 없습니다 — 규칙이 없으면 배포 모달에서 고를 채널도 없습니다
        </div>
      ) : (
        PLATFORMS.filter((p) => byPlatform.has(p.key)).map((p) => (
          <section key={p.key} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
                {p.label}
              </h3>
              <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
                {p.upload ? "실제 파일이 업로드됩니다" : "파일이 올라가지 않습니다 — 우리 쪽 기록만 남고 게시는 앱에서 직접"}
              </span>
            </div>

            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
              {(byPlatform.get(p.key) ?? []).map((r) => (
                <ChannelCard
                  key={`${r.platform}:${r.accountId}`}
                  rule={r}
                  editing={editing === `${r.platform}:${r.accountId}`}
                  onEdit={() => setEditing(editing === `${r.platform}:${r.accountId}` ? null : `${r.platform}:${r.accountId}`)}
                  onSaved={async () => { setEditing(null); await load(); }}
                  onDeleted={async () => {
                    try {
                      await deleteChannelRule(r.platform, r.accountId);
                      toast({ title: "규칙을 지웠습니다", description: `${r.label} — 계정 연결은 그대로입니다.`, tone: "done" });
                    } catch (err) {
                      toast({ title: "규칙 삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                    } finally {
                      await load();
                    }
                  }}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function ChannelCard({
  rule,
  editing,
  onEdit,
  onSaved,
  onDeleted,
}: {
  rule: ChannelRule;
  editing: boolean;
  onEdit: () => void;
  onSaved: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  return (
    <div className="sd-card flex flex-col gap-2 p-3" style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>{rule.label}</span>
        <span className="sd-tag">{ROLE_LABEL[rule.role]}</span>
        {!rule.enabled && <span className="sd-tag sd-tag--ended">사용 중지</span>}
        <button type="button" className="sd-btn ml-auto" onClick={onEdit}>
          {editing ? "닫기" : "규칙 수정"}
        </button>
      </div>

      <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{rule.accountId}</div>

      {/* 업로드 규칙 표 — 배포 모달이 이걸 그대로 강제한다 */}
      <dl className="grid grid-cols-[86px_1fr] gap-x-2 gap-y-1 text-[11.5px]">
        <Row k="길이 상한" v={rule.maxSec == null ? "제한 없음" : `${rule.maxSec}초`} />
        <Row k="비율" v={rule.aspect === "any" ? "제한 없음" : rule.aspect} />
        <Row k="제목 접두" v={rule.titlePrefix || "—"} />
        <Row k="해시태그" v={rule.hashtagTemplate || "—"} />
        <Row k="말투" v={rule.tonePreset || "—"} />
        <Row k="공개 범위" v={{ public: "공개", unlisted: "일부 공개", private: "비공개" }[rule.privacy]} />
        <Row k="예약 시간대" v={rule.scheduleWindow || "—"} />
      </dl>

      {editing && <RuleForm initial={rule} onCancel={onEdit} onSaved={onSaved} onDelete={onDeleted} />}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: "var(--sd-mut)" }}>{k}</dt>
      <dd className="truncate" style={{ color: "var(--sd-fg)" }}>{v}</dd>
    </>
  );
}

/**
 * 규칙 폼. 새로 추가할 땐 플랫폼·계정 ID 를 먼저 받고(1단계) 규칙을 채운다(2단계).
 * 역할을 고르면 그 역할의 기본값이 들어오되, 이후 손댄 값이 이긴다.
 */
function RuleForm({
  initial,
  onCancel,
  onSaved,
  onDelete,
}: {
  initial?: ChannelRule;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const isNew = !initial;
  const [step, setStep] = useState<1 | 2>(isNew ? 1 : 2);
  const [busy, setBusy] = useState(false);
  const [touchedDefaults, setTouchedDefaults] = useState(false);

  const [r, setR] = useState<ChannelRule>(
    initial ?? {
      platform: "youtube",
      accountId: "",
      label: "",
      role: "main",
      maxSec: null,
      aspect: "any",
      titlePrefix: "",
      hashtagTemplate: "",
      tonePreset: "기본",
      privacy: "public",
      scheduleWindow: "",
      enabled: true,
    },
  );

  const set = (patch: Partial<ChannelRule>) => setR((prev) => ({ ...prev, ...patch }));

  /** 역할 변경 → 기본값 적용. 단, 사용자가 이미 손댔으면 덮지 않는다. */
  function pickRole(role: ChannelRole) {
    if (touchedDefaults) { set({ role }); return; }
    if (role === "shorts_only") set({ role, aspect: "9:16", maxSec: r.platform === "youtube" ? 60 : 90 });
    else if (r.platform === "smr") set({ role, aspect: "16:9", maxSec: 180 });
    else set({ role, aspect: "any", maxSec: null });
  }

  async function save() {
    if (!r.accountId.trim()) return;
    setBusy(true);
    try {
      await saveChannelRule({ ...r, accountId: r.accountId.trim(), label: r.label.trim() || r.accountId.trim() });
      await onSaved();
    } catch (err) {
      toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[5px] p-3"
      style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
    >
      {step === 1 ? (
        <>
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>1 / 2 · 어느 채널인가</div>
          <select value={r.platform} onChange={(e) => set({ platform: e.target.value })} className="sd-input w-full">
            {PLATFORMS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          <input
            value={r.accountId}
            onChange={(e) => set({ accountId: e.target.value })}
            placeholder="계정 ID (YouTube channelId · Meta page id …)"
            className="sd-input w-full"
          />
          <input
            value={r.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="표시 이름 (예: 본채널 · 쇼츠채널)"
            className="sd-input w-full"
          />
          <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
            계정 ID 는 <Link href="/publish-channels" className="underline">배포채널 연동</Link> 에서 확인할 수 있습니다.
            연결하지 않은 계정에도 규칙을 미리 만들어 둘 수 있지만, 실제 업로드는 연결된 뒤에만 됩니다.
          </p>
          <div className="flex gap-2">
            <button type="button" className="sd-btn" onClick={onCancel}>취소</button>
            <button
              type="button"
              className="sd-btn sd-btn-primary ml-auto"
              disabled={!r.accountId.trim()}
              onClick={() => setStep(2)}
            >
              다음
            </button>
          </div>
        </>
      ) : (
        <>
          {isNew && <div className="sd-eb" style={{ color: "var(--sd-label)" }}>2 / 2 · 업로드 규칙</div>}

          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(ROLE_LABEL) as ChannelRole[]).map((role) => (
              <button
                key={role}
                type="button"
                className={cn("sd-btn", r.role === role && "sd-btn--on")}
                onClick={() => pickRole(role)}
              >
                {ROLE_LABEL[role]}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="길이 상한(초) · 비우면 제한 없음">
              <input
                value={r.maxSec ?? ""}
                onChange={(e) => {
                  setTouchedDefaults(true);
                  const v = e.target.value.replace(/\D/g, "");
                  set({ maxSec: v === "" ? null : Number(v) });
                }}
                inputMode="numeric"
                className="sd-input w-full"
              />
            </Field>
            <Field label="비율">
              <select
                value={r.aspect}
                onChange={(e) => { setTouchedDefaults(true); set({ aspect: e.target.value as ChannelRule["aspect"] }); }}
                className="sd-input w-full"
              >
                <option value="any">제한 없음</option>
                <option value="9:16">9:16 (세로)</option>
                <option value="16:9">16:9 (가로)</option>
              </select>
            </Field>
          </div>

          <Field label="제목 접두사">
            <input value={r.titlePrefix} onChange={(e) => set({ titlePrefix: e.target.value })} placeholder="예: [예능]" className="sd-input w-full" />
          </Field>
          <Field label="해시태그 템플릿 · {program} {episode} 치환">
            <input value={r.hashtagTemplate} onChange={(e) => set({ hashtagTemplate: e.target.value })} placeholder="#{program} #{episode}회 #shorts" className="sd-input w-full" />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="말투 프리셋">
              <input value={r.tonePreset} onChange={(e) => set({ tonePreset: e.target.value })} className="sd-input w-full" />
            </Field>
            <Field label="공개 범위">
              <select value={r.privacy} onChange={(e) => set({ privacy: e.target.value as ChannelRule["privacy"] })} className="sd-input w-full">
                <option value="public">공개</option>
                <option value="unlisted">일부 공개</option>
                <option value="private">비공개</option>
              </select>
            </Field>
          </div>

          <Field label="예약 시간대 (자유 입력)">
            <input value={r.scheduleWindow} onChange={(e) => set({ scheduleWindow: e.target.value })} placeholder="예: 평일 19:00" className="sd-input w-full" />
          </Field>

          <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            이 채널로 배포 허용 (끄면 배포 모달에서 사유와 함께 선택 불가)
          </label>

          <div className="flex flex-wrap gap-2">
            {isNew ? (
              <button type="button" className="sd-btn" onClick={() => setStep(1)}>이전</button>
            ) : (
              <button type="button" className="sd-btn" onClick={onCancel}>취소</button>
            )}
            {onDelete && (
              <button type="button" className="sd-btn" disabled={busy} onClick={() => void onDelete()}>
                규칙 삭제
              </button>
            )}
            <button type="button" className="sd-btn sd-btn-primary ml-auto" disabled={busy} onClick={save}>
              저장
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{label}</div>
      {children}
    </div>
  );
}
