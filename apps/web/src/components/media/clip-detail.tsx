"use client";

/**
 * 미디어 상세 — **실제 렌더된 영상 + 채널별 업로드 메타데이터.**
 *
 * 목록은 한 줄씩만 보여주고, 클릭하면 여기가 열린다. 운영자가 발행 직전에 확인하는 것은
 * 결국 둘뿐이다 — "이 영상이 맞나" 와 "이 문구로 나가도 되나".
 *
 * 설계에서 지킨 것:
 *  - **렌더 전이면 재생하는 척하지 않는다.** 목록의 썸네일은 원본 프레임 폴백이라 그럴듯해
 *    보이지만, 발행되는 건 렌더 결과물이다. 아직 없으면 없다고 말하고 편집기로 보낸다.
 *  - **채널마다 규격이 다르다는 걸 화면이 말한다.** 네이버 클립은 제목 필드가 아예 없고
 *    설명 10자 이상이 필수다 — 그걸 모르면 발행 시점에야 막힌다.
 *  - **사람이 고친 값은 재생성이 덮지 않는다**(서버가 `edited` 로 보존). 그 사실을 배지로 보여준다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  generateClipMetadata,
  saveClipMetadata,
  type ChannelMeta,
  type MetaChannel,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { clipVideoSrc, clipThumbSrc } from "@/lib/media-url";
import type { Clip } from "@/lib/types";

/** 화면에 보여줄 채널 순서 — 실제로 파일이 올라가는 곳을 앞에 둔다.
 *  네이버 TV 는 제품에서 제외 (2026-08-13) — 타입(MetaChannel)에는 남아 있지만 그리지 않는다. */
const CHANNEL_ORDER: MetaChannel[] = [
  "youtube", "naverclip", "instagram", "facebook", "tiktok",
];

const CHANNEL_LABEL: Record<MetaChannel, string> = {
  youtube: "YouTube",
  naverclip: "네이버 클립",
  navertv: "네이버 TV",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
};

/** 그 채널에 제목 필드가 있는가. 서버 CHANNEL_SPECS 와 같은 판단이다. */
const HAS_TITLE: Record<MetaChannel, boolean> = {
  youtube: true, navertv: true, facebook: true,
  naverclip: false, instagram: false, tiktok: false,
};

export function ClipDetail({
  clip,
  programTitle,
  onClose,
}: {
  clip: Clip & { channelMeta?: Record<string, ChannelMeta> };
  programTitle?: string;
  onClose: () => void;
}) {
  // 스토어를 갱신해 둔다 — 안 하면 닫았다 다시 열었을 때 옛 값이 보인다.
  const { refresh } = useAppData();
  const [meta, setMeta] = useState<Record<string, ChannelMeta>>(clip.channelMeta ?? {});
  const [tab, setTab] = useState<MetaChannel>("youtube");
  const [busy, setBusy] = useState<null | "generate" | "save">(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const videoSrc = clipVideoSrc(clip);
  const current = meta[tab];

  // 편집 중인 값. 탭을 바꾸면 그 채널 값으로 갈아탄다.
  const [draft, setDraft] = useState({ title: "", description: "", tags: "" });
  useEffect(() => {
    setDraft({
      title: current?.title ?? "",
      description: current?.description ?? "",
      tags: (current?.tags ?? []).join(", "),
    });
  }, [tab, current]);

  // Esc 로 닫는다 — 목록으로 빨리 돌아가는 게 이 화면의 기본 동작이다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const generate = useCallback(async () => {
    setBusy("generate"); setErr(null); setNote(null);
    try {
      const r = await generateClipMetadata(clip.id);
      setMeta(r.channels);
      setNote("메타데이터를 새로 만들었습니다. 직접 고친 채널은 그대로 두었습니다.");
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [clip.id, refresh]);

  const save = useCallback(async () => {
    setBusy("save"); setErr(null); setNote(null);
    try {
      const saved = await saveClipMetadata(clip.id, tab, {
        title: HAS_TITLE[tab] ? draft.title : null,
        description: draft.description,
        tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setMeta((m) => ({ ...m, [tab]: saved }));
      setNote(`${CHANNEL_LABEL[tab]} 저장됨.`);
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [clip.id, tab, draft, refresh]);

  const problems = useMemo(() => current?.problems ?? [], [current]);

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-label="미디어 상세">
      <button
        type="button"
        aria-label="닫기"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        className="relative ml-auto flex h-full w-full max-w-[980px] flex-col overflow-y-auto"
        style={{ background: "var(--sd-bg, #fff)", borderLeft: "1px solid var(--sd-border)" }}
      >
        {/* 머리 */}
        <div
          className="sticky top-0 z-10 flex items-center gap-3 px-5 py-3"
          style={{ background: "var(--sd-bg, #fff)", borderBottom: "1px solid var(--sd-border)" }}
        >
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              {clip.title || "무제 클립"}
            </div>
            <div className="truncate text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              {programTitle ? `${programTitle} · ` : ""}
              {Math.round(clip.durationSec ?? 0)}초 · {clip.aspectRatio}
            </div>
          </div>
          <button type="button" className="sd-btn ml-auto" onClick={onClose}>닫기 (Esc)</button>
        </div>

        {/* 영상 — 발행되는 것은 렌더 결과물이다. 없으면 없다고 말한다. */}
        <div className="px-5 pt-4">
          {videoSrc ? (
            <video
              src={videoSrc}
              poster={clipThumbSrc(clip)}
              controls
              playsInline
              className="w-full rounded-[6px] bg-black"
              style={{ maxHeight: "62vh", objectFit: "contain" }}
            />
          ) : (
            <div
              className="grid place-items-center rounded-[6px] px-6 py-14 text-center text-[12.5px]"
              style={{ background: "var(--sd-ph-bg, #f4f3f0)", color: "var(--sd-mut)" }}
            >
              <div>
                <b style={{ color: "var(--sd-fg)" }}>아직 렌더되지 않았습니다.</b>
                <div className="mt-1">
                  발행되는 파일은 편집기에서 확정(렌더)한 결과물입니다 — 목록 썸네일은 원본 프레임입니다.
                </div>
                <a href={`/editor/${clip.id}`} className="sd-btn mt-3 inline-block">편집기로 이동</a>
              </div>
            </div>
          )}
        </div>

        {/* 메타데이터 */}
        <div className="px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              업로드 메타데이터
            </h3>
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              채널마다 규격이 다릅니다 — 그대로 올라갈 문구입니다
            </span>
            <button
              type="button"
              className="sd-btn ml-auto"
              onClick={generate}
              disabled={busy !== null}
            >
              {busy === "generate" ? "만드는 중…" : Object.keys(meta).length ? "다시 만들기" : "메타데이터 만들기"}
            </button>
          </div>

          {note && (
            <div className="mb-2 rounded-[6px] px-3 py-2 text-[12px]"
                 style={{ background: "var(--sd-ok-bg, #eef7ee)", color: "var(--sd-fg)" }}>
              {note}
            </div>
          )}
          {err && (
            <div className="mb-2 rounded-[6px] px-3 py-2 text-[12px]"
                 style={{ background: "var(--sd-danger-bg, #fdecec)", color: "var(--sd-danger-strong, #a11)" }}>
              {err}
            </div>
          )}

          {Object.keys(meta).length === 0 ? (
            <div
              className="rounded-[6px] px-4 py-8 text-center text-[12.5px]"
              style={{ background: "var(--sd-ph-bg, #f4f3f0)", color: "var(--sd-mut)" }}
            >
              아직 만들어진 메타데이터가 없습니다. 위 버튼을 누르면 채널별로 한 벌씩 만듭니다.
            </div>
          ) : (
            <>
              {/* 채널 탭 */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {CHANNEL_ORDER.filter((ch) => meta[ch]).map((ch) => {
                  const m = meta[ch];
                  const bad = (m?.problems?.length ?? 0) > 0;
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => setTab(ch)}
                      className="rounded-[6px] px-2.5 py-1 text-[12px]"
                      style={{
                        border: "1px solid var(--sd-border)",
                        background: tab === ch ? "var(--sd-fg)" : "transparent",
                        color: tab === ch ? "#fff" : "var(--sd-fg)",
                      }}
                    >
                      {CHANNEL_LABEL[ch]}
                      {m?.edited && <span title="직접 수정함"> ✎</span>}
                      {bad && <span title="규격 확인 필요" style={{ color: tab === ch ? "#ffb4b4" : "var(--sd-danger-strong)" }}> ●</span>}
                    </button>
                  );
                })}
              </div>

              {/* 규격 문제 — 발행 전에 사람이 해결해야 하는 것 */}
              {problems.length > 0 && (
                <ul
                  className="mb-3 list-disc rounded-[6px] py-2 pl-8 pr-3 text-[12px]"
                  style={{ background: "var(--sd-warn-bg, #fff4e5)", color: "var(--sd-warn-fg, #7a4a00)" }}
                >
                  {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}

              <div className="flex flex-col gap-3">
                {HAS_TITLE[tab] ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                      제목 {tab === "youtube" && "· 프로그램 해시태그가 유입 축입니다"}
                    </span>
                    <input
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      className="sd-input rounded-[6px] px-2.5 py-1.5 text-[13px]"
                      style={{ border: "1px solid var(--sd-border)" }}
                    />
                  </label>
                ) : (
                  <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                    이 채널에는 <b>제목 필드가 없습니다</b> — 설명 하나가 전부입니다.
                  </div>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                    설명 · {draft.description.length}자
                  </span>
                  <textarea
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    rows={6}
                    className="rounded-[6px] px-2.5 py-1.5 text-[13px]"
                    style={{ border: "1px solid var(--sd-border)", background: "transparent", color: "var(--sd-fg)" }}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                    태그 · 쉼표로 구분
                  </span>
                  <input
                    value={draft.tags}
                    onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                    className="rounded-[6px] px-2.5 py-1.5 text-[13px]"
                    style={{ border: "1px solid var(--sd-border)", background: "transparent", color: "var(--sd-fg)" }}
                  />
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="sd-btn sd-btn-primary"
                    onClick={save}
                    disabled={busy !== null}
                  >
                    {busy === "save" ? "저장 중…" : `${CHANNEL_LABEL[tab]} 저장`}
                  </button>
                  {current?.edited && (
                    <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                      직접 수정한 채널입니다 — 다시 만들어도 덮어쓰지 않습니다.
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
