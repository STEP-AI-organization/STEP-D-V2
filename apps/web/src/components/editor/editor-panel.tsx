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
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ASPECTS,
  BG_SWATCHES,
  CAPTION_STYLES,
  COLOR_SWATCHES,
  DEFAULT_FILTERS,
  ELEMENT_DEFAULTS,
  TEMPLATE_PRESETS,
  defaultElementSize,
  sampleKeyframes,
  type AspectKey,
  type CaptionStyle,
  type EditorElement,
  type EditorState,
  type ElementType,
  type FilterSettings,
  type KeyframePoint,
  type KfSelection,
} from "@/lib/editor/presets";

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
  kfSel,
  setKfSel,
  currentTime = 0,
  onSeek,
}: {
  state: EditorState;
  update: Update;
  applyTpl: (id: EditorState["templateId"]) => void;
  kfSel?: KfSelection;
  setKfSel?: (s: KfSelection) => void;
  /** Segment-relative playhead seconds ("add keyframe at current time"). */
  currentTime?: number;
  /** Seek the transport to segment-relative seconds. */
  onSeek?: (sec: number) => void;
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
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors",
                tab === t.key ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white",
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
        {tab === "layout" && <LayoutTab state={state} update={update} applyTpl={applyTpl} />}
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
  return (
    <div className="flex flex-wrap gap-1.5">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          className={cn("size-6 rounded", value === c ? "ring-2 ring-white ring-offset-1 ring-offset-zinc-900" : "ring-1 ring-zinc-700")}
          style={{ background: c }}
          aria-label={c}
        />
      ))}
    </div>
  );
}
const field = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500";

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
                  min={16}
                  max={56}
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
              <div className="mt-2">
                <Swatches colors={COLOR_SWATCHES} value={line.color} onPick={(c) => setLine(line.id, { color: c })} />
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
                { id: `t${Date.now()}`, text: "새 줄", size: 24, color: "#FFFFFF" },
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
      <div>
        <Label>세로 위치 {state.channelY}%</Label>
        <input type="range" min={60} max={95} value={state.channelY} onChange={(e) => update({ channelY: Number(e.target.value) })} className="w-full" />
      </div>
    </>
  );
}

function LayoutTab({ state, update, applyTpl }: { state: EditorState; update: Update; applyTpl: (id: EditorState["templateId"]) => void }) {
  return (
    <>
      <div>
        <Label>템플릿 프리셋</Label>
        <div className="space-y-1.5">
          {TEMPLATE_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyTpl(p.id)}
              className={cn(
                "w-full rounded-md border p-2 text-left transition-colors",
                state.templateId === p.id ? "border-zinc-400 bg-zinc-800" : "border-zinc-700 hover:bg-zinc-800/50",
              )}
            >
              <div className="text-sm font-medium text-white">{p.label}</div>
              <div className="text-[11px] text-zinc-400">{p.hint}</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>종횡비</Label>
        <div className="grid grid-cols-4 gap-1">
          {(Object.keys(ASPECTS) as AspectKey[]).map((a) => (
            <button
              key={a}
              onClick={() => update({ aspect: a })}
              className={cn("rounded-md border py-1.5 text-xs", state.aspect === a ? "border-zinc-400 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-400")}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>배경</Label>
        <Swatches colors={BG_SWATCHES} value={state.bg} onPick={(c) => update({ bg: c })} />
      </div>
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
      <div>
        <Label>강조 색 (현재 단어)</Label>
        <Swatches colors={COLOR_SWATCHES} value={state.highlightColor} onPick={(c) => update({ highlightColor: c })} />
      </div>
      <div>
        <Label>키워드 색</Label>
        <Swatches colors={COLOR_SWATCHES} value={state.keywordColor ?? state.highlightColor} onPick={(c) => update({ keywordColor: c })} />
      </div>
      <div className="rounded-md border border-dashed border-zinc-700 p-2 text-[11px] text-zinc-400">
        자막은 STT(말자막)로 단어별로 켜집니다 — 말하는 단어는 <b>강조 색</b>, 핵심 단어는 <b>키워드 색</b>으로 표시됩니다. 원본에 자막이 있으면 자동으로 건너뜁니다.
      </div>
    </>
  );
}

function ElementsTab({ state, update, kf }: { state: EditorState; update: Update; kf: KfCtx }) {
  function add(type: ElementType) {
    const el: EditorElement = { id: `e${Date.now()}`, type, x: 50, y: 55, text: ELEMENT_DEFAULTS[type], size: defaultElementSize(type) };
    update({ elements: [...state.elements, el] });
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
            {state.elements.map((el) => {
              const kfOpen = kf.kfSel?.target === el.id;
              return (
                <div key={el.id} className="rounded-md border border-zinc-800 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={el.text}
                      onChange={(e) => update({ elements: state.elements.map((x) => (x.id === el.id ? { ...x, text: e.target.value } : x)) })}
                      className={cn(field, "flex-1")}
                    />
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
            className="rounded p-0.5 text-zinc-400 hover:text-white disabled:opacity-30"
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
            className="rounded p-0.5 text-zinc-400 hover:text-white disabled:opacity-30"
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
