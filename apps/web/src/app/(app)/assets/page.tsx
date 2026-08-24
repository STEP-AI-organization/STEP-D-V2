"use client";

/**
 * U10 · 에셋 (README §6 · FLOWS F8).
 *
 * 좌 폴더 트리 + 우 파일 그리드. 다중 선택 → 일괄 이동. 새 폴더. 드래그 업로드.
 *
 * **의도적으로 없는 것 둘** (F8 ⊘):
 *  - 이름 변경. 에셋은 이름으로 참조되므로 바꾸면 참조가 전부 끊긴다.
 *  - 되돌리기. 그래서 삭제는 **무엇이 함께 지워지는지 숫자로 말한 뒤** 확인을 받는다.
 *
 * 정렬·종류 필터는 편집기 패널과 같은 어휘를 쓴다(F8) — lib/assets.ts 한 곳에 둔다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<AssetKind | "all", string> = {
  all: "전체",
  image: "이미지",
  video: "영상",
  audio: "오디오",
  font: "폰트",
  other: "기타",
};

const SORT_LABEL: Record<AssetSort, string> = { recent: "최근순", name: "이름순", size: "크기순" };

const ROOT = "/";

export default function AssetsPage() {
  const { toast } = useToast();
  const [folder, setFolder] = useState(ROOT);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [sort, setSort] = useState<AssetSort>("recent");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT]));
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  async function newFolder() {
    const name = window.prompt("새 폴더 이름");
    if (!name) return;
    try {
      await createAssetFolder(folder, name);
      setExpanded((prev) => new Set(prev).add(folder));
      await load();
    } catch (err) {
      toast({ title: "폴더를 만들지 못했습니다", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  /** 삭제 — 되돌릴 수 없으므로 **무엇이 지워지는지 세어서** 확인을 받는다. */
  async function removeFolder(path: string) {
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
    if (selected.size === 0) return;
    try {
      const n = await moveAssets([...selected], target);
      setSelected(new Set());
      await load();
      toast({ title: `${n}개를 옮겼습니다`, description: target, tone: "done" });
    } catch (err) {
      toast({ title: "이동 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  return (
    <div className="flex gap-4">
      {/* ── 폴더 트리 ─────────────────────────────────────────────────────── */}
      <aside className="flex w-[220px] shrink-0 flex-col gap-2">
        <div className="sd-card flex-1 overflow-y-auto p-1.5">
          <FolderNode
            path={ROOT}
            label="전체"
            depth={0}
            current={folder}
            expanded={expanded}
            childrenOf={childrenOf}
            onSelect={setFolder}
            onToggle={(p) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(p)) next.delete(p);
                else next.add(p);
                return next;
              })
            }
            onDelete={removeFolder}
            onMoveHere={async (from, to) => {
              // 이동 대상은 **드롭된 노드**다. 선택 중인 폴더(folder)를 쓰면 엉뚱한 곳으로 옮겨지고,
              // 되돌리기가 없는 화면이라 복구가 안 된다.
              try {
                await moveAssetFolder(from, to);
                await load();
                toast({ title: "폴더를 옮겼습니다", description: to, tone: "done" });
              } catch (err) {
                toast({ title: "폴더 이동 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
              }
            }}
          />
        </div>
        <button type="button" className="sd-btn" onClick={newFolder}>＋ 새 폴더</button>
        <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
          이름 변경은 없습니다 — 에셋은 이름으로 참조되기 때문입니다. 삭제·이동은 되돌릴 수 없습니다.
        </p>
      </aside>

      {/* ── 파일 그리드 ───────────────────────────────────────────────────── */}
      <div
        className="flex min-w-0 flex-1 flex-col gap-2.5"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void upload(e.dataTransfer.files); }}
      >
        <div className="flex flex-wrap items-center gap-[9px]">
          <span className="sd-mono text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{folder}</span>

          <div className="flex flex-wrap gap-[3px]">
            {(["all", "image", "video", "audio", "font", "other"] as const).map((k) => (
              <button key={k} type="button" className={cn("sd-btn", kind === k && "sd-btn--on")} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
                <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>
                  {k === "all" ? files.length : files.filter((f) => f.kind === k).length}
                </span>
              </button>
            ))}
          </div>

          <select value={sort} onChange={(e) => setSort(e.target.value as AssetSort)} className="sd-input">
            {(Object.keys(SORT_LABEL) as AssetSort[]).map((s) => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>

          <button type="button" className="sd-btn sd-btn-primary ml-auto" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "올리는 중…" : "파일 올리기"}
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
        </div>

        {error && (
          <div
            className="rounded-[4px] px-3 py-2 text-[11.5px]"
            style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
          >
            에셋을 불러오지 못했습니다 ({error}).
          </div>
        )}

        {shown.length === 0 ? (
          <div
            className="sd-ph grid min-h-[220px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: `2px dashed ${dragOver ? "var(--sd-accent)" : "var(--sd-border)"}`, background: dragOver ? "var(--sd-accent-bg)" : undefined }}
          >
            {loading ? "불러오는 중…" : files.length === 0 ? "이 폴더는 비어 있습니다 — 파일을 끌어다 놓으세요" : "조건에 맞는 파일이 없습니다"}
          </div>
        ) : (
          <div
            className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]"
            style={dragOver ? { outline: "2px dashed var(--sd-accent)", outlineOffset: 6 } : undefined}
          >
            {shown.map((f) => (
              <FileCard
                key={f.id}
                file={f}
                checked={selected.has(f.id)}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}

        {selected.size > 0 && (
          <div
            className="sticky bottom-4 flex flex-wrap items-center gap-2 rounded-[6px] px-3 py-2.5"
            style={{ background: "var(--sd-card)", border: "1px solid var(--sd-border)", boxShadow: "0 2px 10px rgba(0,0,0,.18)" }}
          >
            <span className="text-[12.5px]" style={{ color: "var(--sd-fg)" }}>{selected.size}개 선택</span>
            <select
              className="sd-input"
              value=""
              onChange={(e) => { if (e.target.value) void moveSelectedTo(e.target.value); }}
            >
              <option value="">여기로 이동…</option>
              <option value={ROOT}>/ (루트)</option>
              {folders.filter((f) => f.path !== folder).map((f) => (
                <option key={f.path} value={f.path}>{f.path}</option>
              ))}
            </select>
            <button type="button" className="sd-btn" onClick={() => setSelected(new Set())}>선택 해제</button>
            <button type="button" className="sd-btn ml-auto" onClick={removeSelected}>삭제</button>
          </div>
        )}
      </div>
    </div>
  );
}

function FolderNode({
  path,
  label,
  depth,
  current,
  expanded,
  childrenOf,
  onSelect,
  onToggle,
  onDelete,
  onMoveHere,
}: {
  path: string;
  label: string;
  depth: number;
  current: string;
  expanded: Set<string>;
  childrenOf: (parent: string) => AssetFolder[];
  onSelect: (p: string) => void;
  onToggle: (p: string) => void;
  onDelete: (p: string) => void | Promise<void>;
  onMoveHere: (from: string, to: string) => void | Promise<void>;
}) {
  const kids = childrenOf(path);
  const open = expanded.has(path);
  const active = current === path;

  return (
    <div>
      <div
        className={cn("group flex items-center gap-1 rounded-[4px] px-1.5 py-1", active && "bg-[var(--sd-accent-bg)]")}
        style={{ paddingLeft: 6 + depth * 12 }}
        draggable={path !== ROOT}
        onDragStart={(e) => e.dataTransfer.setData("text/folder", path)}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("text/folder")) e.preventDefault(); }}
        onDrop={(e) => {
          // 버블링을 끊는다 — 중첩 노드에 떨어뜨리면 조상 노드까지 같은 드롭을 받는다.
          e.stopPropagation();
          const from = e.dataTransfer.getData("text/folder");
          if (from && from !== path) void onMoveHere(from, path);
        }}
      >
        <button
          type="button"
          className="w-[12px] shrink-0 text-[10px]"
          style={{ color: "var(--sd-mut)", visibility: kids.length > 0 ? "visible" : "hidden" }}
          onClick={() => onToggle(path)}
          aria-label={open ? "접기" : "펼치기"}
        >
          {open ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[12px]"
          style={{ color: "var(--sd-fg)" }}
          onClick={() => onSelect(path)}
        >
          {label}
        </button>
        {path !== ROOT && (
          <button
            type="button"
            className="shrink-0 px-1 text-[10.5px] opacity-0 group-hover:opacity-100"
            style={{ color: "var(--sd-danger-strong)" }}
            onClick={() => void onDelete(path)}
            title="폴더 삭제 (되돌릴 수 없음)"
          >
            삭제
          </button>
        )}
      </div>

      {open &&
        kids.map((k) => (
          <FolderNode
            key={k.path}
            path={k.path}
            label={k.name}
            depth={depth + 1}
            current={current}
            expanded={expanded}
            childrenOf={childrenOf}
            onSelect={onSelect}
            onToggle={onToggle}
            onDelete={onDelete}
            onMoveHere={onMoveHere}
          />
        ))}
    </div>
  );
}

function FileCard({ file, checked, onToggle }: { file: AssetFile; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sd-card flex flex-col overflow-hidden text-left"
      style={checked ? { outline: "2px solid var(--sd-accent)", outlineOffset: -1 } : undefined}
    >
      <div className="sd-ph h-[104px]" style={{ borderBottom: "1px solid var(--sd-border)" }}>
        {file.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetRawUrl(file.id)} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-[10.5px]">{KIND_LABEL[file.kind]}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <span className="truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{file.name}</span>
        <span className="sd-mono text-[10px]" style={{ color: "var(--sd-mut)" }}>{fmtBytes(file.size)}</span>
      </div>
    </button>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
