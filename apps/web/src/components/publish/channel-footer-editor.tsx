"use client";

/**
 * 채널별 **배포 설명 고정 문구** 편집기 — 발행 시점에 생성(동적) 설명 아래에 항상 붙는 고정글.
 *
 * 채널 단위인 이유(사용자 결정 2026-09-15): 문구가 채널의 언어·플랫폼을 따른다 — 인니어 채널엔
 * 자막 안내문을 인니어로, 인스타그램은 짧게, 틱톡은 캡션 꼬리표 한 줄. 저장은 channel_rule 로
 * 라운드트립하고(PUT /api/channel-rules), 서버가 발행 직전에 붙인다(publish/description-footer.ts) —
 * 편집 화면 설명 칸에는 안 보인다(지워질 수 없게 하는 구조 · 커머스 대가성 문구와 동일).
 *
 * ⚠️ 저장 시 **기존 규칙을 스프레드**한다 — PUT 라우트는 body 에 없는 role 을 "main" 으로
 * 되돌리므로(publish-channels 의 handlePrivacyChange 와 같은 함정), 부분 전송이 다른 설정을
 * 조용히 바꾼다. 그래서 규칙을 모르는 채로는 저장하지 않는다(selfLoad 가 먼저 읽는다).
 */
import { useEffect, useState } from "react";
import { BTN, BTN_PRIMARY } from "@/components/ui/tokens";
import {
  fetchChannelRules,
  saveChannelRule,
  type ChannelPublishTarget,
} from "@/lib/data/api";

export function ChannelFooterEditor({ platform, accountId, rule, onSaved, selfLoad }: {
  platform: string;
  accountId: string;
  /** 부모가 채널 규칙 맵을 들고 있으면 그대로 넘긴다(없는 규칙 = undefined). */
  rule?: ChannelPublishTarget;
  onSaved?: (rule: ChannelPublishTarget) => void;
  /** 부모가 규칙을 안 들고 있는 자리(네이버 섹션) — 마운트 시 직접 읽는다. */
  selfLoad?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<ChannelPublishTarget | undefined>(undefined);
  const effective = rule ?? loaded;
  const [text, setText] = useState(effective?.descriptionFooter ?? "");
  const [busy, setBusy] = useState(false);
  const savedText = (effective?.descriptionFooter ?? "").trim();

  useEffect(() => {
    if (!selfLoad) return;
    let alive = true;
    void fetchChannelRules()
      .then((rules) => {
        if (!alive) return;
        setLoaded(rules.find((r) => r.platform === platform && r.accountId === accountId));
      })
      .catch(() => { /* 규칙을 못 읽어도 화면은 산다 — 저장 시 신규 규칙으로 만든다 */ });
    return () => { alive = false; };
  }, [selfLoad, platform, accountId]);

  // 폴링·재로드로 규칙이 갈리면 닫혀 있을 때만 동기화 — 편집 중 입력을 덮지 않는다.
  useEffect(() => {
    if (!open) setText(effective?.descriptionFooter ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective?.descriptionFooter]);

  const save = async () => {
    setBusy(true);
    try {
      const next = await saveChannelRule(platform, accountId, {
        ...(effective ?? { label: accountId }),
        descriptionFooter: text.trim(),
      });
      setLoaded(next);
      onSaved?.(next);
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "고정 문구 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 px-3" onClick={(e) => e.stopPropagation()}>
      {!open ? (
        <button
          type="button"
          style={{ boxShadow: "none" }}
          onClick={() => setOpen(true)}
          className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] underline-offset-2 hover:underline cursor-pointer"
        >
          {savedText
            ? `설명 고정 문구 있음 · "${savedText.slice(0, 28)}${savedText.length > 28 ? "…" : ""}" 수정`
            : "+ 설명 고정 문구 (발행 설명 맨 아래에 항상 붙는 글)"}
        </button>
      ) : (
        <div className="mt-1 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)]/50 p-3 space-y-2">
          <div className="text-xs font-bold text-[var(--color-text-primary)]">설명 고정 문구</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={platform === "tiktok"
              ? "예: (Sub Indo/terjemahan AI)"
              : "예: 💬 Takarir bahasa Indonesia dibuat menggunakan terjemahan otomatis berbasis AI…"}
            className="w-full rounded-lg bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none transition-colors p-2.5 leading-relaxed"
          />
          <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            <b>발행 시점에</b> 이 채널로 나가는 설명 맨 아래에 자동으로 붙습니다
            {platform === "tiktok" ? " (틱톡은 캡션 끝에 붙습니다)" : ""}. 바꾸면 <b>다음 발행부터</b> 전부
            새 문구로 나가고, 이미 발행된 영상은 그대로입니다(유튜브는 메타 재반영 시 적용).
            비우고 저장하면 문구를 끕니다.
            {platform === "naverclip" ? " 네이버 클립은 설명이 300자로 짧아 문구가 길면 잘릴 수 있습니다." : ""}
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button" style={{ boxShadow: "none" }} disabled={busy}
              onClick={() => { setOpen(false); setText(effective?.descriptionFooter ?? ""); }}
              className={BTN}
            >
              닫기
            </button>
            <button type="button" style={{ boxShadow: "none" }} onClick={save} className={BTN_PRIMARY} disabled={busy}>
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
