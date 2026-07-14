"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV } from "@/lib/nav";
import { useAppData } from "@/lib/data/store";

interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  run: () => void;
}

/** Global command palette (⌘K / Ctrl+K). Also opens on the "open-command-palette"
 *  window event dispatched by the topbar search button. (plan §6) */
export function CommandPalette() {
  const router = useRouter();
  const { episodes, clips } = useAppData();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV.map((item) => ({
      id: `nav-${item.href}`,
      label: item.label,
      group: "이동",
      keywords: item.href,
      run: () => router.push(item.href),
    }));
    const eps: Command[] = episodes.map((ep) => ({
      id: `ep-${ep.id}`,
      label: `${ep.programTitle} ${ep.episodeNumber}화`,
      group: "회차",
      keywords: `${ep.programTitle} ${ep.episodeNumber} 회차 episode`,
      run: () => router.push(`/episodes/${ep.id}`),
    }));
    const clipCmds: Command[] = clips.map((clip) => ({
      id: `clip-${clip.id}`,
      label: clip.title,
      group: "클립",
      keywords: `${clip.title} ${clip.programTitle}`,
      run: () => router.push(`/clips`),
    }));
    const actions: Command[] = [
      {
        id: "action-theme",
        label: "테마 전환 (라이트/다크)",
        group: "액션",
        run: () => {
          const el = document.documentElement;
          const next = !el.classList.contains("dark");
          el.classList.toggle("dark", next);
          try {
            localStorage.setItem("stepd-theme", next ? "dark" : "light");
          } catch {
            /* ignore */
          }
        },
      },
    ];
    return [...nav, ...eps, ...clipCmds, ...actions];
  }, [router, episodes, clips]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.keywords ?? "").toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Global open shortcut + custom event from topbar button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function runAt(idx: number) {
    const cmd = filtered[idx];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-label="커맨드 팔레트"
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="이동하거나 검색… (회차·클립·화면)"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">결과 없음</li>
          )}
          {filtered.map((cmd, idx) => (
            <li key={cmd.id}>
              <button
                onMouseEnter={() => setActive(idx)}
                onClick={() => runAt(idx)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm",
                  idx === active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{cmd.group}</span>
                  <span>{cmd.label}</span>
                </span>
                {idx === active && <CornerDownLeft className="size-3.5 text-muted-foreground" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
