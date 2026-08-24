"use client";

import { useEffect, useState } from "react";
import {
  Type,
  UserCircle,
  LayoutTemplate,
  FileText,
  Palette,
  Plus,
  Trash2,
  Diamond,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { frameOverlaySrc, type FrameTemplate } from "@/lib/data/api";
import type { ClipReframe, ReframeMode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  BG_SWATCHES,
  CAPTION_CHUNK_MAX_CHARS,
  CAPTION_STYLES,
  CHANNEL_BADGE_PRESETS,
  CHANNEL_ICON_PRESETS,
  COLOR_SWATCHES,
  DEFAULT_FILTERS,
  ELEMENT_DEFAULTS,
  FONT_FAMILY_OPTIONS,
  defaultElementSize,
  sampleKeyframes,
  type CaptionStyle,
  type EditorElement,
  type EditorState,
  type ElementType,
  type FilterSettings,
  type KeyframePoint,
  type KfSelection,
} from "@/lib/editor/presets";
import { ASPECT_PRESETS } from "@/lib/editor/aspect-presets";

type Update = (patch: Partial<EditorState>) => void;
type TabKey = "text" | "channel" | "layout" | "captions" | "elements" | "filters";

/** Keyframe editing context threaded into the tabs (selection lives in the shell so the
 *  timeline's diamond markers and this panel stay in sync). Times are clip-local seconds. */
interface KfCtx {
  kfSel: KfSelection;
  setKfSel: (s: KfSelection) => void;
  currentLocal: number;
  maxTime: number;
  seekLocal: (t: number) => void;
}

const TABS: { key: TabKey; label: string; icon: typeof Type }[] = [
  { key: "text", label: "텍스트", icon: Type },
  { key: "channel", label: "채널", icon: UserCircle },
  { key: "layout", label: "레이아웃", icon: LayoutTemplate },
  { key: "captions", label: "자막", icon: FileText },
  { key: "elements", label: "요소", icon: Palette },
  { key: "filters", label: "필터", icon: SlidersHorizontal },
];

export function EditorPanel({
  state,
  update,
  applyTpl,
  frames = [],
  kfSel,
  setKfSel,
  currentTime = 0,
  onSeek,
  reframe,
  reframeBusy = false,
  onReframeModeChange,
}: {
  state: EditorState;
  update: Update;
  applyTpl: (id: EditorState["templateId"]) => void;
  /** 서버에서 받은 프레임 템플릿 목록. 비어 있으면 "서버 미연결" 안내를 띄운다. */
  frames?: FrameTemplate[];
  kfSel?: KfSelection;
  setKfSel?: (s: KfSelection) => void;
  /** Segment-relative playhead seconds ("add keyframe at current time"). */
  currentTime?: number;
  /** Seek the transport to segment-relative seconds. */
  onSeek?: (sec: number) => void;
  reframe?: ClipReframe;
  reframeBusy?: boolean;
  onReframeModeChange?: (mode: ReframeMode) => void;
}) {
  const [tab, setTab] = useState<TabKey>("layout");

  const kf: KfCtx = {
    kfSel: kfSel ?? null,
    setKfSel: setKfSel ?? (() => {}),
    currentLocal: currentTime - state.trimIn,
    maxTime: Math.max(0.1, state.trimOut - state.trimIn),
    seekLocal: (t) => onSeek?.(state.trimIn + t),
  };

  // A keyframe picked on the timeline opens the tab that owns its editor.
  useEffect(() => {
    if (!kfSel) return;
    if (state.elements.some((e) => e.id === kfSel.target)) setTab("elements");
    else if (state.titleLines.some((l) => l.id === kfSel.target)) setTab("text");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kfSel?.target]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-zinc-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                // P5 — 활성 탭 accent 를 단일 cyan 으로(AENA 밑줄식). 비활성은 투명 테두리로 레이아웃 유지.
                "flex flex-1 flex-col items-center gap-1 border-b-2 py-2.5 text-[11px] transition-colors",
                tab === t.key ? "border-cyan-500 bg-zinc-800 text-white" : "border-transparent text-zinc-400 hover:text-white",
              )}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {tab === "text" && <TextTab state={state} update={update} kf={kf} />}
        {tab === "channel" && <ChannelTab state={state} update={update} />}
        {tab === "layout" && (
          <LayoutTab
            state={state}
            update={update}
            applyTpl={applyTpl}
            frames={frames}
            reframe={reframe}
            reframeBusy={reframeBusy}
            onReframeModeChange={onReframeModeChange}
          />
        )}
        {tab === "captions" && <CaptionsTab state={state} update={update} />}
        {tab === "elements" && <ElementsTab state={state} update={update} kf={kf} />}
        {tab === "filters" && <FiltersTab state={state} update={update} />}
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{children}</div>;
}
/** 프리뷰에는 그려지지만 서버 렌더가 읽지 않는 항목 표기 — 미리보기와 결과물이 다르다는 사실을
 *  컨트롤 옆에 붙여 둔다(기능은 유지, 오해만 제거). */
function PreviewOnly({ reason }: { reason: string }) {
  return (
    <span
      title={reason}
      className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium normal-case tracking-normal text-amber-300"
    >
      미리보기 전용
    </span>
  );
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1 text-sm text-zinc-200">
      {label}
      <button
        onClick={onChange}
        className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-emerald-500" : "bg-zinc-700")}
      >
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white transition-all", on ? "left-4" : "left-0.5")} />
      </button>
    </label>
  );
}
function Swatches({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  // 값이 프리셋 스와치 중 하나가 아니면(임의 색) 커스텀 색 칩에 링을 준다.
  const isCustom = !colors.some((c) => c.toLowerCase() === (value ?? "").toLowerCase());
  // <input type="color"> 는 #rrggbb 만 받는다 — 값이 그 형식이 아니면 흰색으로 폴백(표시용).
  const inputValue = /^#[0-9a-fA-F]{6}$/.test(value ?? "") ? value : "#FFFFFF";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          className={cn("size-6 rounded", value === c ? "ring-2 ring-white ring-offset-1 ring-offset-zinc-900" : "ring-1 ring-zinc-700")}
          style={{ background: c }}
          aria-label={c}
        />
      ))}
      {/* 커스텀 색 — 네이티브 색 선택기. 값은 #rrggbb 라 파이프 전체를 그대로 통과(렌더 변경 0). */}
      <label
        className={cn(
          "relative size-6 cursor-pointer overflow-hidden rounded",
          isCustom ? "ring-2 ring-white ring-offset-1 ring-offset-zinc-900" : "ring-1 ring-zinc-700",
        )}
        title="커스텀 색"
        style={{
          background: isCustom
            ? value
            : "conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
      >
        <input
          type="color"
          value={inputValue}
          onChange={(e) => onPick(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          aria-label="커스텀 색 선택"
        />
      </label>
    </div>
  );
}
const field = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500";

/** 파일 → data URL. 실패 시 reject. 큰 파일은 상위에서 크기 체크(2MB 상한 권장). */
async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}

/** 재사용 가능한 이미지 업로드 필드 — 파일 선택 → data URL 콜백. 초과 시 alert.
 *  editorState 안에 base64로 살고 있으니 사이즈가 커지면 저장 페이로드가 통째로 부풀어
 *  라우트 timeouts / SQL row 상한을 건드릴 수 있어 명시적 상한을 둔다. */
function ImagePickField({
  value,
  onChange,
  onClear,
  maxBytes,
  hint,
}: {
  value?: string;
  onChange: (dataUrl: string) => void;
  onClear: () => void;
  maxBytes: number;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex cursor-pointer items-center rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
        {value ? "다시 선택" : "이미지 선택"}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!f) return;
            if (f.size > maxBytes) {
              const kb = Math.round(f.size / 1024);
              const limitKb = Math.round(maxBytes / 1024);
              alert(`파일이 너무 큽니다 (${kb} KB > ${limitKb} KB). 압축·리사이즈 후 다시 시도.`);
              return;
            }
            try {
              onChange(await fileToDataUrl(f));
            } catch {
              alert("이미지 파일을 읽지 못했습니다.");
            }
          }}
        />
      </label>
      {value ? (
        <>
          <img src={value} alt="" className="size-8 rounded-full border border-zinc-700 object-cover" />
          <button
            onClick={onClear}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            제거
          </button>
        </>
      ) : (
        hint && <span className="text-[11px] text-zinc-500">{hint}</span>
      )}
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────
function TextTab({ state, update, kf }: { state: EditorState; update: Update; kf: KfCtx }) {
  function setLine(id: string, patch: Partial<EditorState["titleLines"][number]>) {
    update({ titleLines: state.titleLines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  }
  return (
    <>
      <div>
        <Label>제목 (라인별 스타일)</Label>
        <div className="space-y-3">
          {state.titleLines.map((line) => {
            const kfOpen = kf.kfSel?.target === line.id;
            return (
            <div key={line.id} className="rounded-md border border-zinc-800 p-2">
              <input value={line.text} onChange={(e) => setLine(line.id, { text: e.target.value })} className={field} />
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="range"
                  min={48}
                  max={168}
                  value={line.size}
                  onChange={(e) => setLine(line.id, { size: Number(e.target.value) })}
                  className="flex-1"
                />
                <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{line.size}</span>
                <button
                  onClick={() =>
                    kf.setKfSel(
                      kfOpen ? null : { target: line.id, index: (line.keyframes?.length ?? 0) > 0 ? 0 : -1 },
                    )
                  }
                  className={cn("shrink-0", kfOpen ? "text-amber-300" : "text-zinc-500 hover:text-amber-300")}
                  title="키프레임 애니메이션"
                >
                  <Diamond className="size-3.5" />
                </button>
                {state.titleLines.length > 1 && (
                  <button
                    onClick={() => {
                      update({ titleLines: state.titleLines.filter((l) => l.id !== line.id) });
                      if (kfOpen) kf.setKfSel(null);
                    }}
                    className="text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              {/* 글꼴 — 패밀리 선택. 기본(프리텐다드)은 font 미설정으로 저장(하위호환). */}
              <div className="mt-2">
                <select
                  value={line.font ?? "pretendard"}
                  onChange={(e) =>
                    setLine(line.id, { font: e.target.value === "pretendard" ? undefined : e.target.value })
                  }
                  className={field}
                  title="글꼴"
                >
                  {FONT_FAMILY_OPTIONS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2">
                <Swatches colors={COLOR_SWATCHES} value={line.color} onPick={(c) => setLine(line.id, { color: c })} />
              </div>
              {/* 외곽선(스트로크) — 배경 영상 위 가독성용. 기본 OFF(하위호환). */}
              <div className="mt-1">
                <Toggle
                  on={!!line.stroke}
                  onChange={() =>
                    setLine(line.id, { stroke: line.stroke ? undefined : { color: "#000000", width: 9 } })
                  }
                  label="외곽선"
                />
                {line.stroke && (
                  <div className="mt-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={3}
                        max={36}
                        value={line.stroke.width}
                        onChange={(e) =>
                          setLine(line.id, { stroke: { color: line.stroke!.color, width: Number(e.target.value) } })
                        }
                        className="flex-1"
                      />
                      <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{line.stroke.width}px</span>
                    </div>
                    <Swatches
                      colors={COLOR_SWATCHES}
                      value={line.stroke.color}
                      onPick={(c) => setLine(line.id, { stroke: { color: c, width: line.stroke!.width } })}
                    />
                  </div>
                )}
              </div>
              {kfOpen && (
                <KeyframeSection
                  targetId={line.id}
                  keyframes={line.keyframes ?? []}
                  onChange={(kfs) => setLine(line.id, { keyframes: kfs })}
                  baseX={0}
                  baseY={0}
                  offsetXY
                  kf={kf}
                />
              )}
            </div>
            );
          })}
        </div>
        <Button
          size="xs"
          variant="secondary"
          className="mt-2"
          onClick={() =>
            update({
              titleLines: [
                ...state.titleLines,
                // 크기 = 출력 px(정규화된 state 에 바로 추가). 구 24 스테이지 px × 3 = 72.
                { id: `t${Date.now()}`, text: "새 줄", size: 72, color: "#FFFFFF" },
              ],
            })
          }
        >
          <Plus className="size-3.5" /> 줄 추가
        </Button>
      </div>
      <div>
        <Label>정렬</Label>
        <div className="flex gap-1">
          {(["left", "center", "right"] as const).map((a) => (
            <button
              key={a}
              onClick={() => update({ titleAlign: a })}
              className={cn("flex-1 rounded-md border py-1.5 text-xs", state.titleAlign === a ? "border-zinc-400 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-400")}
            >
              {a === "left" ? "왼쪽" : a === "center" ? "가운데" : "오른쪽"}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function ChannelTab({ state, update }: { state: EditorState; update: Update }) {
  return (
    <>
      <Toggle on={state.showChannel} onChange={() => update({ showChannel: !state.showChannel })} label="채널 표시" />
      <div>
        <Label>채널명</Label>
        <input value={state.channelName} onChange={(e) => update({ channelName: e.target.value })} className={field} />
      </div>
      {/* 렌더가 실제로 굽는 것: "▶ 채널명" · 세로 위치 · **채널 아이콘 합성** · **글자 크기**
          (index.ts buildEditorAss + 아이콘 오버레이). 부가 줄만 아직 미리보기 전용이다.
          예전 이 고지는 "아이콘·크기는 미리보기 전용"이라 했는데 지금은 거짓 — 둘 다 구워진다. */}
      <div className="rounded-md border border-dashed border-zinc-700 p-2 text-[11px] text-zinc-400">
        <b>채널 표시 · 채널명 · 세로 위치 · 아이콘 · 글자 크기</b>는 결과물에 그대로 구워집니다.
        <b> 부가 줄</b>만 아직 미리보기 전용입니다.
      </div>
      {/* 아이콘 끄기 — 렌더는 클립 아이콘이 없으면 **프로그램의 쇼츠 아이콘**으로 폴백하므로
          (index.ts: channelIconDataUrl > program.brandIconDataUrl), 위 그림을 비우는 것만으론
          아이콘이 안 사라진다. 이 스위치가 그 폴백까지 끄는 유일한 수단이다. */}
      <Toggle
        on={state.channelIconOff !== true}
        onChange={() => update({ channelIconOff: !state.channelIconOff } as Partial<EditorState>)}
        label="채널 아이콘 표시"
      />
      <div>
        <Label>
          채널 아이콘
        </Label>
        <div className="mb-1.5 text-[10px] text-zinc-500">
          비워 두면 프로그램 설정의 &quot;쇼츠 아이콘&quot;이 쓰입니다 — 아예 빼려면 위 스위치를 끄세요.
        </div>
        <ImagePickField
          value={state.channelIconDataUrl}
          onChange={(dataUrl) => update({ channelIconDataUrl: dataUrl })}
          onClear={() => update({ channelIconDataUrl: undefined })}
          maxBytes={256 * 1024}
          hint="정사각형 이미지 · 최대 256KB"
        />
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {CHANNEL_ICON_PRESETS.map((p) => {
            const active = state.channelIconDataUrl === p.src;
            return (
              <button
                key={p.id}
                onClick={() => update({ channelIconDataUrl: p.src })}
                title={p.label}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border p-1.5 transition-colors",
                  active ? "border-zinc-400 bg-zinc-800" : "border-zinc-800 hover:bg-zinc-800/50",
                )}
              >
                <img src={p.src} alt={p.label} className="size-8 rounded-full object-cover" draggable={false} />
                <span className="w-full truncate text-center text-[9px] leading-tight text-zinc-400">
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label>
          뱃지 스타일
        </Label>
        <div className="grid grid-cols-2 gap-1.5">
          {CHANNEL_BADGE_PRESETS.map((p) => {
            const active = state.channelBadgeTemplate === p.id;
            return (
              <button
                key={p.id}
                onClick={() => update({ channelBadgeTemplate: p.id, ...p.patch })}
                className={cn(
                  "rounded-md border p-2 text-left transition-colors",
                  active ? "border-zinc-400 bg-zinc-800" : "border-zinc-700 hover:bg-zinc-800/50",
                )}
              >
                <div className="text-xs font-medium text-white">{p.label}</div>
                <div className="mt-0.5 text-[10px] leading-tight text-zinc-500">{p.hint}</div>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label>
          아이콘 크기 {state.channelIconSize ?? 72}px
        </Label>
        <input
          type="range"
          min={36}
          max={360}
          value={state.channelIconSize ?? 72}
          onChange={(e) => update({ channelIconSize: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      <div>
        <Label>
          글자 크기 {state.channelLabelSize ?? 42}px
        </Label>
        <input
          type="range"
          min={30}
          max={120}
          value={state.channelLabelSize ?? 42}
          onChange={(e) => update({ channelLabelSize: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      <div>
        <Label>
          부가 줄
          <PreviewOnly reason="렌더는 채널명 한 줄만 굽습니다 — 부가 줄은 결과물에서 빠집니다." />
        </Label>
        <div className="space-y-2">
          {(state.channelExtraLines ?? []).map((line) => {
            const size = line.size ?? Math.round((state.channelLabelSize ?? 42) * 0.75);
            return (
              <div key={line.id} className="rounded-md border border-zinc-800 p-2">
                <div className="flex items-center gap-1">
                  <input
                    value={line.text}
                    onChange={(e) =>
                      update({
                        channelExtraLines: (state.channelExtraLines ?? []).map((l) =>
                          l.id === line.id ? { ...l, text: e.target.value } : l,
                        ),
                      })
                    }
                    placeholder="예: 매주 토요일 7시"
                    className={cn(field, "flex-1")}
                  />
                  <button
                    onClick={() =>
                      update({
                        channelExtraLines: (state.channelExtraLines ?? []).filter((l) => l.id !== line.id),
                      })
                    }
                    className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                    title="줄 삭제"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="w-16 text-[10px] tabular-nums text-zinc-500">크기 {size}px</span>
                  <input
                    type="range"
                    min={24}
                    max={96}
                    value={size}
                    onChange={(e) =>
                      update({
                        channelExtraLines: (state.channelExtraLines ?? []).map((l) =>
                          l.id === line.id ? { ...l, size: Number(e.target.value) } : l,
                        ),
                      })
                    }
                    className="flex-1"
                  />
                </div>
              </div>
            );
          })}
          <Button
            variant="secondary"
            size="sm"
            className="mt-1 h-7 rounded-[7px] px-2 text-xs"
            onClick={() =>
              update({
                channelExtraLines: [
                  ...(state.channelExtraLines ?? []),
                  { id: `sub-${Date.now()}`, text: "" },
                ],
              })
            }
          >
            <Plus className="size-3.5" /> 줄 추가
          </Button>
        </div>
      </div>
      <div>
        <Label>세로 위치 {state.channelY}%</Label>
        <input type="range" min={60} max={95} value={state.channelY} onChange={(e) => update({ channelY: Number(e.target.value) })} className="w-full" />
      </div>
    </>
  );
}

function LayoutTab({
  state,
  update,
  applyTpl,
  frames = [],
  reframe,
  reframeBusy,
  onReframeModeChange,
}: {
  state: EditorState;
  update: Update;
  applyTpl: (id: EditorState["templateId"]) => void;
  frames?: FrameTemplate[];
  reframe?: ClipReframe;
  reframeBusy?: boolean;
  onReframeModeChange?: (mode: ReframeMode) => void;
}) {
  // 현재 templateId 가 실제 프레임 목록에 있으면 프레임이 핏·배경을 소유한다.
  const frameActive = frames.some((f) => f.name === state.templateId);
  return (
    <>
      <div>
        <Label>화면 구성</Label>
        <div className="grid grid-cols-2 gap-1">
          {([
            { mode: "basic" as const, label: "기본" },
            { mode: "ai_multi" as const, label: "AI 다중 레이아웃" },
          ]).map(({ mode, label }) => {
            const active = (reframe?.mode ?? "basic") === mode;
            const retryable = mode === "ai_multi" && active && (reframe?.status === "failed" || reframe?.status === "stale");
            return (
              <button
                key={mode}
                type="button"
                disabled={reframeBusy}
                onClick={() => onReframeModeChange?.(mode)}
                className={cn(
                  "rounded-md border px-2 py-2 text-xs transition-colors disabled:cursor-wait disabled:opacity-70",
                  active ? "border-violet-400 bg-violet-500/15 text-violet-100" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800",
                )}
              >
                {retryable ? "AI 다시 분석" : label}
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 text-[10px] leading-4 text-zinc-500">
          {(reframe?.mode ?? "basic") === "ai_multi"
            ? reframe?.status === "queued" ? "분석 대기 중입니다. 완료되면 자동 반영됩니다."
            : reframe?.status === "running" ? "Beat별 안전 구도를 분석하고 있습니다."
            : reframe?.status === "failed" ? "분석에 실패했습니다. ‘AI 다시 분석’을 누르거나 기본 모드로 전환하세요."
            : reframe?.status === "stale" ? "트림 변경으로 결과가 오래됐습니다. 자동 재분석 중입니다."
            : "AI가 Beat별 안전 점수로 원본 구도와 풀스크린을 자동 전환합니다. 9:16으로 고정됩니다."
            : "기존 프레임과 레이아웃 설정을 그대로 사용합니다."}
        </div>
      </div>
      <div>
        <Label>프레임 템플릿</Label>
        {frames.length === 0 ? (
          // 빈 목록은 "템플릿 없음"이 아니라 대개 "서버 미연결"이다 — 구분해서 알려준다.
          <div className="rounded-md border border-zinc-700 p-2 text-[11px] text-zinc-400">
            템플릿을 불러오지 못했습니다. 서버 연결과 <code>assets/shorts-template/</code> 을 확인하세요.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {frames.map((f) => (
              <button
                key={f.name}
                onClick={() => applyTpl(f.name)}
                title={f.title}
                className={cn(
                  "overflow-hidden rounded-md border text-left transition-colors",
                  state.templateId === f.name ? "border-zinc-300 bg-zinc-800" : "border-zinc-700 hover:bg-zinc-800/50",
                )}
              >
                {/* 프레임 기하를 축소해 썸네일로 그린다.
                    ⚠️ 예전엔 overlay.png 만 보여줬는데, 이 템플릿들의 overlay 는 전부 **투명**이라
                    (bands·video 는 meta.json 기하로만 정의) 셋 다 빈 검정 사각형으로 똑같이
                    보였다(사용자 지적 2026-08-12). 실제로 다른 건 영상 위치·띠 크기라 그걸 그린다. */}
                <div className="relative aspect-[9/16] overflow-hidden bg-zinc-800">
                  {/* 영상이 차지하는 영역 — contain=레터박스, cover=확대. 파랑으로 표시. */}
                  <div
                    className="absolute grid place-items-center text-[8px] text-white/70"
                    style={{
                      left: `${f.video.x}%`, top: `${f.video.y}%`,
                      width: `${f.video.w}%`, height: `${f.video.h}%`,
                      background: "linear-gradient(135deg,#3b5bdb,#5c7cfa)",
                    }}
                  >
                    영상
                  </div>
                  {/* 검정 띠 — 훅/브랜딩 자리 */}
                  {f.bands.map((b, i) => (
                    <div key={i} className="absolute"
                      style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, background: b.color }} />
                  ))}
                  {/* 투명이 아닌 실제 프레임 그래픽이 있으면 그것도 겹쳐 보여준다 */}
                  <img src={frameOverlaySrc(f)} alt="" className="absolute inset-0 size-full object-contain" />
                </div>
                <div className="truncate px-1.5 py-1 text-[11px] text-white">{f.name}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 상단·하단 스타일 프리셋(2026-08-12)은 **삭제됐다** (사용자 확정 2026-08-19).
          한 번 누르면 텍스트/채널 설정을 통째로 덮어써서, 줄별로 잡아둔 글꼴·외곽선·키프레임·
          시간창이 조용히 날아갔다("한 줄 컬러" 는 줄을 합치며 그 필드들을 통째로 버렸다).
          같은 값을 텍스트·채널 탭이 이미 개별로 편집한다 — 덮어쓰는 지름길만 없앤 것이다.
          단 하나, 아이콘 끄기(channelIconOff)는 여기가 유일한 생산자였고 서버 렌더가 읽으므로
          채널 탭의 아이콘 설정 옆으로 옮겼다. */}
      <div>
        <Label>종횡비 · 크롭</Label>
        {/* 5-값 enum(aspect-presets.ts) — 한 값이 컨테이너·크롭·밴드를 전부 결정한다.
            라벨/정의는 프리셋에서 온다(라벨↔동작 1:1). 미리보기(editor-preview)가 같은 프리셋을
            읽어 정확히 렌더될 모양을 보여준다.
            ⚠️ 프레임 템플릿이 켜져 있으면 **미리보기·렌더 둘 다** 프레임 기하(video rect·밴드)가
            종횡비 크롭을 덮는다(ffmpeg.ts renderShort 는 frame 이 있으면 aspect crop 을 무시). 그래서
            프레임이 활성일 땐 이 버튼이 아무것도 안 바꾸는 것처럼 보였다. 종횡비를 명시적으로 고르면
            = "프레임 없이 이 크롭" 의도 → templateId 를 비워 프레임을 끈다. 그러면 미리보기가 즉시
            바뀌고 렌더도 같은 aspect 경로를 타 파리티가 유지된다. 프레임을 다시 원하면 프레임 템플릿을
            고르면 된다. */}
        <div className="grid grid-cols-1 gap-1">
          {ASPECT_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => update({ aspect: p.id, templateId: "" })}
              disabled={reframe?.mode === "ai_multi"}
              title={reframe?.mode === "ai_multi" ? "AI 다중 레이아웃은 세로로 고정됩니다." : p.hint}
              className={cn(
                "flex flex-col items-start rounded-md border px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-70",
                state.aspect === p.id ? "border-zinc-400 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-400",
              )}
            >
              <span className="text-xs font-medium">{p.label}</span>
              <span className="text-[10px] leading-tight text-zinc-500">{p.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 레터박스 여백 — 세로 전체 담기(9:16-letterbox)이고 프레임이 없을 때만 의미가 있다.
             검정(기본) / 원본 블러. 다른 값(꽉 채우기·밴드 크롭)은 여백이 없어 표시 안 함. ── */}
      {reframe?.mode !== "ai_multi" && !frameActive && state.aspect === "9:16-letterbox" && (
      <div>
        <Label>레터박스 여백</Label>
        <div className="grid grid-cols-2 gap-1">
          {[
            { k: "solid" as const, label: "검정", disabled: false },
            { k: "blur" as const, label: "원본 블러", disabled: false },
          ].map((o) => {
            const active = (state.bgType ?? "solid") === o.k;
            return (
              <button
                key={o.k}
                onClick={() => update({ bgType: o.k })}
                disabled={o.disabled}
                title={o.disabled ? "이미지 배경은 렌더 미지원 — 단색으로 렌더됩니다." : undefined}
                className={cn(
                  "rounded-md border py-1.5 text-xs",
                  active ? "border-zinc-400 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-400",
                  o.disabled && "cursor-not-allowed opacity-70",
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {/* solid: 단색 스와치 · blur: 옵션 없음(원본 그대로) */}
        {(state.bgType ?? "solid") === "solid" && (
          <div className="mt-2">
            <Swatches colors={BG_SWATCHES} value={state.bg} onPick={(c) => update({ bg: c })} />
          </div>
        )}
        {/* 예전에 이미지 배경을 고른 상태만 여기로 온다 — 업로드·크롭 UI 는 렌더가 무시하는 데다
            2MB base64 가 editorState 저장 본문에 그대로 실려서 아예 띄우지 않는다. */}
        {state.bgType === "image" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
            <span>이미지 배경은 렌더 미지원이라 단색으로 렌더됩니다.</span>
            <button
              onClick={() => update({ bgType: "solid", bgImageDataUrl: undefined, bgImageCrop: undefined })}
              className="rounded-md border border-amber-400/40 px-2 py-0.5 text-amber-100 hover:bg-amber-500/20"
            >
              단색으로 전환
            </button>
          </div>
        )}
      </div>
      )}
      <Toggle on={state.showSafeArea} onChange={() => update({ showSafeArea: !state.showSafeArea })} label="세이프 에어리어 · Shorts UI" />
    </>
  );
}

function CaptionsTab({ state, update }: { state: EditorState; update: Update }) {
  return (
    <>
      <Toggle on={state.captionsOn} onChange={() => update({ captionsOn: !state.captionsOn })} label="자막 표시" />
      <div>
        <Label>스타일</Label>
        <select value={state.captionStyle} onChange={(e) => update({ captionStyle: e.target.value as CaptionStyle })} className={field}>
          {(Object.entries(CAPTION_STYLES) as [CaptionStyle, string][]).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      {/* 세로 위치·색·크기 — 미리보기(editor-preview)와 렌더(index.ts buildEditorAss)가 **같은
          captionY/captionColor/captionSize 를 읽는다**. 예전엔 이 컨트롤이 없어 자동배포 규칙만
          세팅할 수 있었다(사용자 2026-08-20: "위치·컬러 조정이 안 됨"). */}
      <div>
        <Label>세로 위치 {Math.round(state.captionY ?? 26)}% <span className="text-zinc-500">(화면 아래에서)</span></Label>
        <input
          type="range"
          min={4}
          max={80}
          value={Math.round(state.captionY ?? 26)}
          onChange={(e) => update({ captionY: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      <div>
        <Label>자막 색 <span className="text-zinc-500">(비우면 스타일 기본색)</span></Label>
        <div className="flex items-center gap-2">
          <Swatches colors={COLOR_SWATCHES} value={state.captionColor ?? ""} onPick={(c) => update({ captionColor: c })} />
          {state.captionColor ? (
            <button
              type="button"
              onClick={() => update({ captionColor: undefined })}
              className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
            >
              스타일 색
            </button>
          ) : null}
        </div>
        <div className="mt-1 text-[11px] text-zinc-500">
          자막 전체 글자색. 아래 <b>강조 색·키워드 색</b>은 <b>말하는 단어만</b> 물들이는 렌더 전용이라 미리보기엔 안 보입니다.
        </div>
      </div>
      <div>
        <Label>자막 크기 {(state.captionSize ?? 4.2).toFixed(1)} <span className="text-zinc-500">(화면 높이 %)</span></Label>
        <input
          type="range"
          min={2.5}
          max={7}
          step={0.1}
          value={state.captionSize ?? 4.2}
          onChange={(e) => update({ captionSize: Number(e.target.value) })}
          className="w-full"
        />
      </div>
      {/* 한 화면 글자수 — 세그먼트를 통째로 띄우면 쇼츠에선 4~5줄이 화면 절반을 덮는다.
          미리보기와 렌더가 같은 상한으로 끊는다(presets.ts / index.ts::chunkCaption). */}
      <div>
        <Label>
          한 화면 글자수 {state.captionMaxChars ?? CAPTION_CHUNK_MAX_CHARS}자
        </Label>
        <input
          type="range"
          min={8}
          max={40}
          value={state.captionMaxChars ?? CAPTION_CHUNK_MAX_CHARS}
          onChange={(e) => update({ captionMaxChars: Number(e.target.value) })}
          className="w-full"
        />
        <div className="mt-1 text-[11px] text-zinc-500">
          말자막을 이 길이로 끊어 순서대로 띄운다. 세로 화면 한 줄이 대략 11자 — 기본 {CAPTION_CHUNK_MAX_CHARS}자면 **항상 한 줄**. 올리면 두 줄 이상.
        </div>
      </div>
      <div>
        <Label>강조 색 (현재 단어)</Label>
        <Swatches colors={COLOR_SWATCHES} value={state.highlightColor} onPick={(c) => update({ highlightColor: c })} />
      </div>
      <div>
        <Label>키워드 색</Label>
        <Swatches colors={COLOR_SWATCHES} value={state.keywordColor ?? state.highlightColor} onPick={(c) => update({ keywordColor: c })} />
      </div>
      {/* 단어별 색은 서버 렌더(buildEditorAss)만 굽는다 — 프리뷰는 세그먼트 통째로 그린다. */}
      <div className="rounded-md border border-dashed border-zinc-700 p-2 text-[11px] text-zinc-400">
        자막은 STT(말자막) 기준으로, 확정(렌더) 결과물에서 말하는 단어는 <b>강조 색</b>, 핵심 단어는{" "}
        <b>키워드 색</b>으로 구워집니다. <b>미리보기에서는 단어별 색 강조가 표시되지 않습니다.</b>
      </div>
    </>
  );
}

function ElementsTab({ state, update, kf }: { state: EditorState; update: Update; kf: KfCtx }) {
  function add(type: ElementType) {
    const el: EditorElement = { id: `e${Date.now()}`, type, x: 50, y: 55, text: ELEMENT_DEFAULTS[type], size: defaultElementSize(type) };
    update({ elements: [...state.elements, el] });
  }
  // z-order (audit #5) — 그리는 순서 = 배열 순서(미리보기 DOM · 서버 ASS 둘 다 뒤 항목이 위로).
  // dir +1 = 앞으로(위 레이어), -1 = 뒤로. 배열만 재배치하므로 미리보기=렌더 파리티가 유지된다.
  function reorder(id: string, dir: 1 | -1) {
    const arr = state.elements;
    const i = arr.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const next = arr.slice();
    [next[i], next[j]] = [next[j], next[i]];
    update({ elements: next });
  }
  const buttons: { type: ElementType; label: string }[] = [
    { type: "cta", label: "CTA 버튼" },
    { type: "sticker", label: "스티커" },
    { type: "arrow", label: "화살표" },
    { type: "bubble", label: "말풍선" },
  ];
  return (
    <>
      <div>
        <Label>요소 추가</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {buttons.map((b) => (
            <Button key={b.type} size="sm" variant="secondary" onClick={() => add(b.type)}>
              <Plus className="size-3.5" /> {b.label}
            </Button>
          ))}
        </div>
      </div>
      {state.elements.length > 0 && (
        <div>
          <Label>추가된 요소</Label>
          <div className="space-y-1">
            {state.elements.map((el, idx) => {
              const kfOpen = kf.kfSel?.target === el.id;
              return (
                <div key={el.id} className="rounded-md border border-zinc-800 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={el.text}
                      onChange={(e) => update({ elements: state.elements.map((x) => (x.id === el.id ? { ...x, text: e.target.value } : x)) })}
                      className={cn(field, "flex-1")}
                    />
                    {/* 레이어 순서 (z-order) — 겹친 요소끼리 앞/뒤로. */}
                    <button
                      onClick={() => reorder(el.id, 1)}
                      disabled={idx === state.elements.length - 1}
                      className="shrink-0 text-zinc-500 hover:text-white disabled:opacity-60"
                      title="앞으로 (위 레이어)"
                    >
                      <ChevronUp className="size-4" />
                    </button>
                    <button
                      onClick={() => reorder(el.id, -1)}
                      disabled={idx === 0}
                      className="shrink-0 text-zinc-500 hover:text-white disabled:opacity-60"
                      title="뒤로 (아래 레이어)"
                    >
                      <ChevronDown className="size-4" />
                    </button>
                    <button
                      onClick={() =>
                        kf.setKfSel(
                          kfOpen ? null : { target: el.id, index: (el.keyframes?.length ?? 0) > 0 ? 0 : -1 },
                        )
                      }
                      className={cn("shrink-0", kfOpen ? "text-amber-300" : "text-zinc-500 hover:text-amber-300")}
                      title="키프레임 애니메이션"
                    >
                      <Diamond className="size-4" />
                    </button>
                    <button
                      onClick={() => {
                        update({ elements: state.elements.filter((x) => x.id !== el.id) });
                        if (kfOpen) kf.setKfSel(null);
                      }}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  {kfOpen && (
                    <KeyframeSection
                      targetId={el.id}
                      keyframes={el.keyframes ?? []}
                      onChange={(kfs) => update({ elements: state.elements.map((x) => (x.id === el.id ? { ...x, keyframes: kfs } : x)) })}
                      baseX={el.x}
                      baseY={el.y}
                      kf={kf}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ── keyframe editor (shared: elements + title lines) ─────────────────────────
function KeyframeSection({
  targetId,
  keyframes,
  onChange,
  baseX,
  baseY,
  offsetXY,
  kf,
}: {
  targetId: string;
  keyframes: KeyframePoint[];
  onChange: (kfs: KeyframePoint[]) => void;
  /** Prefill for a new keyframe's x/y (element position, or 0/0 offsets for title lines). */
  baseX: number;
  baseY: number;
  /** True = x/y are offsets from layout (title lines), not absolute stage %. */
  offsetXY?: boolean;
  kf: KfCtx;
}) {
  const selIndex = kf.kfSel?.target === targetId ? kf.kfSel.index : -1;
  const sel = selIndex >= 0 ? keyframes[selIndex] : undefined;
  // Storage order is insertion order (indices stay stable for selection); navigate by time.
  const order = keyframes.map((_, i) => i).sort((a, b) => keyframes[a].time - keyframes[b].time);
  const pos = order.indexOf(selIndex);

  function select(i: number) {
    kf.setKfSel({ target: targetId, index: i });
    const k = keyframes[i];
    if (k) kf.seekLocal(k.time);
  }
  function addKf() {
    const t = Math.round(Math.max(0, Math.min(kf.currentLocal, kf.maxTime)) * 10) / 10;
    const s = sampleKeyframes(keyframes, t);
    onChange([
      ...keyframes,
      {
        time: t,
        x: s?.x ?? baseX,
        y: s?.y ?? baseY,
        scale: s?.scale ?? 1,
        opacity: s?.opacity ?? 1,
        rotation: s?.rotation ?? 0,
      },
    ]);
    kf.setKfSel({ target: targetId, index: keyframes.length });
  }
  function removeKf() {
    if (selIndex < 0) return;
    onChange(keyframes.filter((_, i) => i !== selIndex));
    kf.setKfSel({ target: targetId, index: -1 });
  }
  function patch(p: Partial<KeyframePoint>) {
    if (selIndex < 0) return;
    onChange(keyframes.map((k, i) => (i === selIndex ? { ...k, ...p } : k)));
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-amber-300">키프레임 {keyframes.length}개</span>
        <div className="flex items-center gap-1">
          <button
            disabled={keyframes.length === 0 || (pos >= 0 && pos <= 0)}
            onClick={() => select(order[pos <= 0 ? order.length - 1 : pos - 1])}
            className="rounded p-0.5 text-zinc-400 hover:text-white disabled:opacity-60"
            title="이전 키프레임"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="text-[10px] tabular-nums text-zinc-400">
            {pos >= 0 ? `${pos + 1}/${keyframes.length}` : `–/${keyframes.length}`}
          </span>
          <button
            disabled={keyframes.length === 0 || (pos >= 0 && pos >= order.length - 1)}
            onClick={() => select(order[pos < 0 ? 0 : pos + 1])}
            className="rounded p-0.5 text-zinc-400 hover:text-white disabled:opacity-60"
            title="다음 키프레임"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
      <Button size="xs" variant="secondary" onClick={addKf}>
        <Plus className="size-3.5" /> 현재 시간에 키프레임 추가
      </Button>
      {sel && (
        <>
          <div>
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>시간</span>
              <span className="tabular-nums">{sel.time.toFixed(1)}s</span>
            </div>
            <input
              type="range"
              min={0}
              max={kf.maxTime}
              step={0.1}
              value={sel.time}
              onChange={(e) => {
                const t = Number(e.target.value);
                patch({ time: t });
                kf.seekLocal(t);
              }}
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <NumField label={offsetXY ? "X 오프셋 (%)" : "X (%)"} value={sel.x ?? baseX} step={1} onChange={(v) => patch({ x: v })} />
            <NumField label={offsetXY ? "Y 오프셋 (%)" : "Y (%)"} value={sel.y ?? baseY} step={1} onChange={(v) => patch({ y: v })} />
            <NumField label="배율" value={sel.scale ?? 1} step={0.05} min={0.5} max={2} onChange={(v) => patch({ scale: v })} />
            <NumField label="불투명도" value={sel.opacity ?? 1} step={0.05} min={0} max={1} onChange={(v) => patch({ opacity: v })} />
            <NumField label="회전 (°)" value={sel.rotation ?? 0} step={1} onChange={(v) => patch({ rotation: v })} />
          </div>
          <button onClick={removeKf} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-400">
            <Trash2 className="size-3" /> 키프레임 삭제
          </button>
        </>
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="text-[10px] text-zinc-400">
      {label}
      <input
        type="number"
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className={cn(field, "mt-0.5 px-1.5 py-1 text-xs")}
      />
    </label>
  );
}

// ── filters ──────────────────────────────────────────────────────────────────
function FiltersTab({ state, update }: { state: EditorState; update: Update }) {
  const tracks = state.tracks ?? [];
  const main = tracks[0];
  const f: FilterSettings = { ...DEFAULT_FILTERS, ...main?.filters };
  function set(patch: Partial<FilterSettings>) {
    if (!main) return;
    update({ tracks: [{ ...main, filters: { ...f, ...patch } }, ...tracks.slice(1)] });
  }
  const isDefault =
    f.brightness === 100 && f.contrast === 100 && f.saturation === 100 && f.warmth === 0;
  return (
    <>
      <div>
        <Label>영상 필터</Label>
        <div className="space-y-3">
          <FilterSlider label="밝기" min={0} max={200} value={f.brightness} onChange={(v) => set({ brightness: v })} suffix="%" />
          <FilterSlider label="대비" min={0} max={200} value={f.contrast} onChange={(v) => set({ contrast: v })} suffix="%" />
          <FilterSlider label="채도" min={0} max={200} value={f.saturation} onChange={(v) => set({ saturation: v })} suffix="%" />
          <FilterSlider label="색온도" min={-100} max={100} value={f.warmth} onChange={(v) => set({ warmth: v })} />
        </div>
      </div>
      <Button size="xs" variant="secondary" disabled={isDefault} onClick={() => set({ ...DEFAULT_FILTERS })}>
        <RotateCcw className="size-3.5" /> 기본값으로 초기화
      </Button>
      <div className="rounded-md border border-dashed border-zinc-700 p-2 text-[11px] text-zinc-400">
        필터는 미리보기(CSS)와 최종 렌더(ffmpeg)에 함께 적용됩니다. 색감은 근사치라 미리보기와 미세하게 다를 수 있습니다.
      </div>
    </>
  );
}

function FilterSlider({
  label,
  min,
  max,
  value,
  onChange,
  suffix = "",
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {value > 0 && min < 0 ? "+" : ""}
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
