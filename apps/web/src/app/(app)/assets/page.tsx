"use client";

/**
 * 에셋 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/assets/page.tsx` 447줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * ## ⚠️ 이 화면은 목업에 **안전장치가 빠져 있다** — 그대로 옮기면 데이터가 날아간다
 *
 * | | 원본(목업) | 이식본 |
 * |---|---|---|
 * | 폴더 삭제 | **확인 없이 즉시**, 게다가 하위 폴더를 안 지운다 | `dryRun` 으로 세어 "하위 폴더 N개 · 파일 M개…되돌릴 수 없습니다" 확인 |
 * | 파일 삭제 | 즉시 | 개수 확인 |
 * | 폴더 트리 | **1단계 평면** (루트 화살표는 장식) | `parent` 로 **재귀 중첩** |
 * | 파일 이동 | 셀렉트가 state 만 바꾸고 아무 일도 안 함 | `moveAssets()` 실행 |
 * | 폴더 이동 | 없음 | 드래그&드롭(`moveAssetFolder`) |
 *
 * **서버는 폴더를 지울 때 트리 전체를 지운다.** 원본대로 옮겼으면 클릭 한 번에 파일 수백 개가
 * 복구 불가로 사라진다. 삭제 확인은 협상 대상이 아니다.
 *
 * ## 중첩을 마크업 추가 없이 그리는 법
 * 원본 L198 의 `<div className="pl-4 space-y-1.5">` 를 **재귀로 중첩**한다. 같은 클래스가
 * depth 마다 반복되면서 들여쓰기가 자연히 생긴다 — 인라인 style 도 새 클래스도 필요 없다.
 * 접기/펼치기 마크업은 원본에 없으므로 **항상 펼침**으로 둔다(잃는 건 접기뿐, 데이터 접근은 보존).
 *
 * ## 그 밖에 원본과 다른 곳
 * - 폴더 비교가 **이름이 아니라 경로**다. 원본은 이름 비교라 `/a/x` 와 `/b/x` 가 동시에 선택된다.
 * - 카테고리 판정은 **서버가 정본**(`kindOf`). 원본의 클라이언트 확장자 판정은 버렸다.
 * - 이동 셀렉트 옵션은 실제 폴더 목록이다(원본은 2개 고정이라 아무 데도 못 옮긴다).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Trash2, UploadCloud } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import {
  assetRawUrl,
  createAssetFolder,
  deleteAssetFolder,
  deleteAssets,
  fetchAssets,
  moveAssetFolder,
  moveAssets,
  uploadAsset,
  type AssetFile,
  type AssetFolder,
  type AssetKind,
  type AssetSort,
} from "@/lib/data/api";

const KIND_LABEL: Record<AssetKind | "all", string> = {
  all: "전체",
  image: "이미지",
  video: "영상",
  audio: "오디오",
  font: "폰트",
  other: "기타",
};
const KINDS: (AssetKind | "all")[] = ["all", "image", "video", "audio", "font", "other"];

const SORT_LABEL: Record<AssetSort, string> = { recent: "최근순", name: "이름순", size: "크기순" };
const ROOT = "/";

/** bytes → `1.4 MB`. 원본 목이 이미 이 형태의 문자열이었다. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function AssetsPage() {
  const { toast } = useToast();
  const [folder, setFolder] = useState(ROOT);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [sort, setSort] = useState<AssetSort>("recent");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const backdropMouseDownRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchAssets(folder);
      setFolders(r.folders);
      setFiles(r.files);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => { void load(); setSelected(new Set()); }, [load]);

  const shown = useMemo(() => {
    const filtered = kind === "all" ? files : files.filter((f) => f.kind === kind);
    const out = [...filtered];
    if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    else if (sort === "size") out.sort((a, b) => b.size - a.size);
    else out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }, [files, kind, sort]);

  const childrenOf = useCallback(
    (parent: string) => folders.filter((f) => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [folders],
  );

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const failed: string[] = [];
    for (const f of Array.from(list)) {
      try { await uploadAsset(folder, f); } catch (err) {
        failed.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    await load();
    // 실패를 조용히 넘기지 않는다 — 몇 개 올라갔는지 사용자가 알아야 한다.
    if (failed.length > 0) {
      toast({ title: `${failed.length}건 업로드 실패`, description: failed.slice(0, 3).join(" · "), tone: "error" });
    } else {
      toast({ title: `${list.length}건 올렸습니다`, tone: "done" });
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createAssetFolder(folder, name);
      setIsNewFolderModalOpen(false);
      setNewFolderName("");
      await load();
    } catch (err) {
      toast({ title: "폴더를 만들지 못했습니다", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  /** 삭제 — 되돌릴 수 없으므로 **무엇이 지워지는지 세어서** 확인을 받는다. */
  async function removeFolder(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const counts = await deleteAssetFolder(path, true);
      const ok = window.confirm(
        `${path}\n\n하위 폴더 ${counts.folders}개 · 파일 ${counts.files}개가 함께 지워집니다.\n되돌릴 수 없습니다. 계속할까요?`,
      );
      if (!ok) return;
      await deleteAssetFolder(path, false);
      if (folder === path || folder.startsWith(`${path}/`)) setFolder(ROOT);
      await load();
      toast({ title: "폴더를 지웠습니다", description: `파일 ${counts.files}개 포함`, tone: "done" });
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`파일 ${selected.size}개를 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) return;
    try {
      const n = await deleteAssets([...selected]);
      setSelected(new Set());
      await load();
      toast({ title: `${n}개를 지웠습니다`, tone: "done" });
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  async function moveSelectedTo(target: string) {
    if (selected.size === 0 || !target) return;
    try {
      const n = await moveAssets([...selected], target);
      setSelected(new Set());
      await load();
      toast({ title: `${n}개를 옮겼습니다`, description: target, tone: "done" });
    } catch (err) {
      toast({ title: "이동 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  async function moveFolderTo(from: string, to: string) {
    if (from === to || to.startsWith(`${from}/`)) return;
    try {
      await moveAssetFolder(from, to);
      await load();
      toast({ title: "폴더를 옮겼습니다", description: `${from} → ${to}`, tone: "done" });
    } catch (err) {
      toast({ title: "이동 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  const toggleAssetSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const categories = KINDS.map((k) => ({
    key: k,
    label: KIND_LABEL[k],
    count: k === "all" ? files.length : files.filter((f) => f.kind === k).length,
  }));

  const moveOptions = [
    { value: "", label: "여기로 이동하기" },
    ...(folder === ROOT ? [] : [{ value: ROOT, label: "/ (루트)" }]),
    ...folders.filter((f) => f.path !== folder).map((f) => ({ value: f.path, label: f.path })),
  ];

  /**
   * 폴더 한 겹 — 원본 L198~223 의 마크업을 **그대로** 쓰되, 자식이 있으면 같은
   * `pl-4 space-y-1.5` 를 재귀로 한 겹 더 연다. 그래서 들여쓰기가 depth 를 그린다.
   */
  function FolderLevel({ parent }: { parent: string }) {
    const kids = childrenOf(parent);
    if (kids.length === 0) return null;
    return (
      <div className="pl-4 space-y-1.5">
        {kids.map((f) => {
          const isSelected = folder === f.path;
          return (
            <React.Fragment key={f.path}>
              <div
                onClick={() => setFolder(f.path)}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData("text/folder", f.path); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  // 조상 노드가 같은 drop 을 또 받지 않게 여기서 멈춘다.
                  e.stopPropagation();
                  const from = e.dataTransfer.getData("text/folder");
                  if (from) void moveFolderTo(from, f.path);
                }}
                className={`group py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-between select-none ${
                  isSelected
                    ? "bg-[#1C60FF] text-white shadow-xs"
                    : "bg-[var(--color-bg-input)]/50 hover:bg-[var(--color-bg-input)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                <span className="truncate pr-1" title={f.path}>{f.name}</span>
                <button
                  type="button"
                  onClick={(e) => { void removeFolder(f.path, e); }}
                  title="폴더 삭제"
                  className="opacity-0 group-hover:opacity-100 text-rose-500 hover:text-rose-400 p-0.5 rounded transition-all cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* 중첩 — 같은 클래스가 한 겹 더 열리면서 들여쓰기가 된다 */}
              <FolderLevel parent={f.path} />
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <Header title="에셋" subtitle="폴더로 정리하는 브랜드·소재 파일" />

      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
        multiple
        className="hidden"
      />

      {/* Assets Main Body Layout */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-hidden gap-4">
        {/* Main 2-Column Split Workspace */}
        <div className="flex-1 flex gap-5 min-h-0 overflow-hidden">
          {/* Left Folder Tree Panel */}
          <div className="w-64 shrink-0 flex flex-col justify-between space-y-4 overflow-visible relative">
            <div className="space-y-3">
              {/* + 새 폴더 Active Button */}
              <button
                onClick={() => setIsNewFolderModalOpen(true)}
                className="w-full h-10 px-4 rounded-xl bg-[var(--color-bg-card)] text-xs text-[var(--color-text-primary)] hover:text-[#1C60FF] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer border-none shadow-md shadow-slate-900/5 dark:shadow-none active:scale-[0.98]"
              >
                <Plus className="w-4 h-4 text-[#1C60FF]" />
                <span>새 폴더</span>
              </button>

              {/* Folder Tree Box */}
              <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-4 space-y-2.5 overflow-y-auto">
                {/* Root Tree Item: 전체 */}
                <div
                  onClick={() => setFolder(ROOT)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.stopPropagation();
                    const from = e.dataTransfer.getData("text/folder");
                    if (from) void moveFolderTo(from, ROOT);
                  }}
                  className={`flex items-center gap-1.5 text-xs font-bold cursor-pointer transition-colors select-none ${
                    folder === ROOT
                      ? "text-[#1C60FF] font-extrabold"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  }`}
                >
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  <span>전체</span>
                </div>

                {/* Indented Subfolders List (재귀) */}
                <FolderLevel parent={ROOT} />
              </div>
            </div>

            {/* Notice text at bottom of left panel */}
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed font-normal opacity-80 select-none">
              이름 변경은 없습니다 ㅡ 에셋은 이름으로 참조되기 때문입니다. 삭제·이동은 되돌릴 수 없습니다.
            </p>
          </div>

          {/* Right File Filter & Asset Display Area */}
          <div className="flex-1 flex flex-col space-y-3 min-w-0 min-h-0 relative">
            {/* Top Filter & Action Bar */}
            <div className="flex items-center justify-between gap-3 text-xs shrink-0 select-none">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[var(--color-text-muted)] font-bold font-mono px-1">
                  {folder}
                </span>

                {/* Category Filter Pills */}
                <div className="h-10 bg-white dark:bg-[#1C1E24] p-1 rounded-full shadow-none flex items-center gap-1 text-xs border-none">
                  {categories.map((cat) => (
                    <button
                      key={cat.key}
                      onClick={() => setKind(cat.key)}
                      className={`h-8 px-3 rounded-full text-xs transition-colors cursor-pointer flex items-center justify-center gap-1 shrink-0 ${
                        kind === cat.key
                          ? "bg-[#1C60FF] text-white font-bold shadow-md shadow-[#1C60FF]/25 dark:shadow-none"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
                      }`}
                    >
                      <span>{cat.label}</span>
                      <span className="text-[10px] opacity-75">{cat.count}</span>
                    </button>
                  ))}
                </div>

                {/* Sort Dropdown Selector */}
                <div className="w-28 shrink-0">
                  <CustomSelect
                    ariaLabel="정렬"
                    options={(Object.keys(SORT_LABEL) as AssetSort[]).map((s) => ({ value: s, label: SORT_LABEL[s] }))}
                    value={sort}
                    onChange={(val) => setSort(val as AssetSort)}
                    className="text-xs"
                    triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs font-bold border-none rounded-full shadow-md shadow-slate-900/5 dark:shadow-none"
                  />
                </div>
              </div>

              {/* Primary Upload Button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="h-10 px-4 rounded-full bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-colors cursor-pointer shrink-0 border-none shadow-md shadow-slate-900/5 dark:shadow-none flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>{busy ? "올리는 중…" : "파일 올리기"}</span>
              </button>
            </div>

            {/* Selection Action Bar */}
            {selected.size > 0 && (
              <div className="p-3.5 rounded-xl bg-[var(--color-bg-card)] border border-[var(--color-border-card)] flex items-center justify-between shadow-xl shrink-0 z-40 animate-in slide-in-from-top-2 duration-150 relative">
                {/* Left Actions */}
                <div className="flex items-center gap-3">
                  <span className="font-bold text-xs text-[var(--color-text-primary)]">
                    {selected.size}개 선택
                  </span>

                  {/* Move Dropdown — 원본은 state 만 바꾸고 아무 일도 안 했다. 실제로 옮긴다. */}
                  <div className="w-40 relative z-50">
                    <CustomSelect
                      ariaLabel="선택 파일 이동"
                      options={moveOptions}
                      value=""
                      onChange={(val) => { void moveSelectedTo(val); }}
                      className="text-xs"
                      triggerClassName="text-xs"
                    />
                  </div>

                  {/* Deselect Button */}
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="px-4 py-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] font-medium transition-colors cursor-pointer"
                  >
                    선택 해제
                  </button>
                </div>

                {/* Right Actions */}
                <div>
                  <button
                    type="button"
                    onClick={() => { void removeSelected(); }}
                    className="px-4 py-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] hover:bg-rose-500 hover:text-white text-xs text-[var(--color-text-primary)] font-medium transition-colors cursor-pointer"
                  >
                    삭제
                  </button>
                </div>
              </div>
            )}

            {/* Main Asset Grid Display Container */}
            <div className="flex-1 flex flex-col min-h-0">
              {shown.length > 0 ? (
                <div className="flex-1 overflow-y-auto pr-1">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {shown.map((item) => {
                      const isSelected = selected.has(item.id);
                      const previewUrl = item.kind === "image" ? assetRawUrl(item.id) : null;
                      return (
                        <div
                          key={item.id}
                          onClick={() => toggleAssetSelect(item.id)}
                          className={`rounded-xl p-3 space-y-2 cursor-pointer transition-all select-none ${
                            isSelected
                              ? "border-2 border-[#1C60FF] bg-[#1C60FF]/10 shadow-md ring-1 ring-[#1C60FF]/50"
                              : "bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none"
                          }`}
                        >
                          {/* Preview Image Tile Container */}
                          <div className="w-full h-36 rounded-lg bg-slate-900 overflow-hidden border border-slate-700/60 relative flex items-center justify-center p-2">
                            {previewUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- 사용자 업로드 원본, next/image 불필요
                              <img
                                src={previewUrl}
                                alt={item.name}
                                loading="lazy"
                                className="w-full h-full object-contain"
                              />
                            ) : (
                              <div className="absolute inset-0 bg-gradient-to-tr from-pink-900/60 to-purple-900/60 flex items-center justify-center p-2 text-center text-xs font-bold text-pink-200">
                                {item.name}
                              </div>
                            )}
                          </div>

                          {/* File Name (Max 1 line, truncated) */}
                          <div>
                            <h4
                              className="font-bold text-xs text-[var(--color-text-primary)] truncate block max-w-full"
                              title={item.name}
                            >
                              {item.name}
                            </h4>
                            <p className="text-[11px] text-[var(--color-text-muted)] font-mono mt-0.5">
                              {fmtBytes(item.size)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* Empty State Banner — 원본은 "비어 있음" 하나뿐이라 로딩·에러를 여기서 구분한다 */
                <div className="flex-1 bg-[var(--color-bg-card)]/40 border-2 border-dashed border-[var(--color-border-card)] rounded-2xl flex flex-col items-center justify-center p-8 text-center relative overflow-hidden select-none">
                  {/* 원본 문구는 그대로 JSX 텍스트로 둔다 — 큰따옴표가 문구의 일부다. */}
                  <p className="text-xs text-[var(--color-text-muted)] font-medium">
                    {loading ? "불러오는 중…"
                      : error ? `에셋을 불러오지 못했습니다 (${error})`
                        : <>이 폴더는 비어 있습니다 — 오른쪽 위 &quot;파일 올리기&quot; 또는 파일을 끌어다 놓으세요</>}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* New Folder Modal Popup */}
        {isNewFolderModalOpen && (
          <div
            onMouseDown={(e) => {
              backdropMouseDownRef.current = e.target === e.currentTarget;
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget && backdropMouseDownRef.current) {
                setIsNewFolderModalOpen(false);
              }
              backdropMouseDownRef.current = false;
            }}
            className="fixed inset-0 bg-black/65 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-150 cursor-pointer"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-[var(--color-bg-card)] border border-[var(--color-border-card)] rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl z-10 cursor-default"
            >
              <h3 className="text-sm font-bold text-[var(--color-text-primary)]">
                새 폴더 이름
              </h3>

              <input
                type="text"
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateFolder();
                  if (e.key === "Escape") setIsNewFolderModalOpen(false);
                }}
                placeholder="예: 브랜드 로고"
                className="w-full px-3.5 py-2.5 rounded-xl border-2 border-[#1C60FF] bg-[var(--color-bg-input)] text-xs text-[var(--color-text-primary)] focus:outline-none shadow-xs placeholder:text-[var(--color-text-muted)]"
              />

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => setIsNewFolderModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-[var(--color-bg-input)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-xs font-semibold transition-colors cursor-pointer"
                >
                  취소
                </button>

                <button
                  onClick={() => { void handleCreateFolder(); }}
                  className="px-5 py-2 rounded-lg bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-colors cursor-pointer shadow-xs"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}
