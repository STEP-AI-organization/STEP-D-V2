"use client";

/**
 * 완성 영상 직접 업로드 모달.
 *
 * 회차 원본 업로드(upload-video-dialog)와 다르다: 편집자가 **우리 도구 밖에서 이미 만든
 * 완성 영상**을 올려 바로 배포하는 경로다. 분석 파이프라인을 태우지 않고, 회차도 만들지 않는다.
 * 업로드가 끝나면 미디어 목록에 바로 배포 가능한 클립으로 올라온다.
 *
 * 지키는 규칙:
 *  - 필수 2개(프로그램·파일)가 모두 있어야 "업로드 시작"이 눌린다.
 *  - 세로/가로는 서버가 원본 프로브로 판정한다 — 여기서 고르지 않는다(자르지 않으니까).
 *  - 모달을 닫아도 업로드는 계속되지 않는다(회차 업로드와 달리 백그라운드 추적을 붙이지 않았다) —
 *    새로고침·페이지 이동은 업로드를 끊는다고 명시한다.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Film, Info, Loader2, Upload } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import { EDIT_KIND_LABEL, type EditKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNativeTransfers } from "@/lib/native-transfers";

export function UploadClipButton({
  programId,
  className,
  label,
}: {
  programId?: string;
  className?: string;
  /** 라벨. 아이콘+span 같은 원본 버튼 내용을 그대로 넘길 수 있게 ReactNode 다. */
  label?: ReactNode;
} = {}) {
  const { serverConnected } = useAppData();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className ?? "sd-btn"}
        onClick={() => setOpen(true)}
        disabled={!serverConnected}
        title={serverConnected ? undefined : "서버에 연결되지 않았습니다"}
      >
        {label ?? "완성 영상 업로드"}
      </button>
      {open && <UploadClipDialog onClose={() => setOpen(false)} defaultProgramId={programId} />}
    </>
  );
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function UploadClipDialog({
  onClose,
  defaultProgramId,
}: {
  onClose: () => void;
  defaultProgramId?: string;
}) {
  const { programs, uploadFinishedClip } = useAppData();
  const nativeTransfers = useNativeTransfers();
  const { toast } = useToast();

  const [programId, setProgramId] = useState(defaultProgramId ?? programs[0]?.id ?? "");
  useEffect(() => {
    if (!programId && programs.length > 0) setProgramId(defaultProgramId ?? programs[0].id);
  }, [programId, programs, defaultProgramId]);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  // 회차는 번호로 적는다 — 편집본은 회차 엔티티를 만들지 않지만(설계), 몇 화 것인지는
  // 남겨야 매트릭스에서 구분된다. 같은 번호의 회차가 있으면 서버가 연결까지 한다.
  const [episodeNumber, setEpisodeNumber] = useState("");
  const [editKind, setEditKind] = useState<EditKind>("clip");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const epNum = /^\d+$/.test(episodeNumber.trim()) ? Number(episodeNumber.trim()) : undefined;
  const canSubmit = Boolean(file) && Boolean(programId) && !busy;

  function pick(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  const missing = useMemo(() => {
    const m: string[] = [];
    if (!programId) m.push("프로그램");
    if (!file) m.push("파일");
    return m;
  }, [programId, file]);

  async function submit() {
    if (!file || !programId || busy) return;
    setBusy(true);
    setPct(0);
    try {
      if (nativeTransfers.available) {
        await nativeTransfers.enqueueUpload(file, {
          kind: "finished_clip",
          programId,
          title: title || file.name,
          episodeNumber: epNum,
          editKind,
        });
        toast({
          title: "네이티브 전송 큐에 추가했습니다",
          description: "앱을 닫거나 PC를 재시작해도 이어서 전송합니다.",
          tone: "progress",
        });
        onClose();
        return;
      }
      await uploadFinishedClip(file, programId, {
        title: title || file.name,
        episodeNumber: epNum,
        editKind,
        onProgress: setPct,
      });
      toast({
        title: "완성 영상이 올라갔습니다",
        description: "미디어 목록에 배포 가능한 클립으로 추가됐습니다.",
        tone: "done",
      });
      onClose();
    } catch (err) {
      toast({
        title: "업로드 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setBusy(false);
    }
  }

  const uploadedBytes = file ? Math.min(file.size, (pct / 100) * file.size) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[90vh] w-full max-w-[520px] flex-col bg-[var(--sd-card)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            완성 영상 업로드
          </h2>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
            이미 편집을 끝낸 영상을 올려 바로 배포합니다 — 분석 파이프라인을 거치지 않습니다.
          </p>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-4">
          <L label="프로그램" required>
            <select
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
              disabled={busy}
              className="sd-input w-full"
            >
              {programs.length === 0 && <option value="">등록된 프로그램이 없습니다</option>}
              {programs.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </L>

          {programs.length === 0 && (
            <Notice tone="warn">
              업로드하려면 프로그램이 먼저 있어야 합니다.{" "}
              <Link href="/programs" className="underline">프로그램 만들기</Link>
            </Notice>
          )}

          <div className="grid grid-cols-2 gap-3">
            <L label="회차 번호">
              <input
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value.replace(/[^\d]/g, ""))}
                disabled={busy}
                inputMode="numeric"
                placeholder="예: 3 (모르면 비움)"
                className="sd-input w-full"
              />
            </L>
            <L label="유형" required>
              <div className="flex gap-[3px]">
                {(Object.keys(EDIT_KIND_LABEL) as EditKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    className={cn("sd-btn flex-1", editKind === k && "sd-btn--on")}
                    onClick={() => setEditKind(k)}
                  >
                    {EDIT_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </L>
          </div>

          {/* 드롭 존 */}
          <div
            onClick={busy ? undefined : () => inputRef.current?.click()}
            onDragOver={(e) => {
              if (busy) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (busy) return;
              e.preventDefault();
              setDragOver(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-[6px] p-6 text-center",
              busy ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
            style={{
              border: `2px dashed ${dragOver ? "var(--sd-accent)" : "var(--sd-border)"}`,
              background: dragOver ? "var(--sd-accent-bg)" : "transparent",
            }}
          >
            <Film className="size-6" style={{ color: "var(--sd-idle)" }} />
            {file ? (
              <div>
                <div className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>{file.name}</div>
                <div className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>{fmtSize(file.size)}</div>
              </div>
            ) : (
              <div className="text-[12.5px]" style={{ color: "var(--sd-mut)" }}>
                완성 영상을 끌어다 놓거나 <span style={{ color: "var(--sd-accent)" }}>클릭해서 선택</span>
                {/* 완성본 업로드 — 게시본은 MP4 가 정본이다. MXF 도 받아 변환하지만
                    "완성 영상" 자리에선 MP4 를 권하는 게 맞다(재인코딩 없이 그대로 나간다). */}
                <div className="text-[11px]">MP4 권장 · MOV · MXF 도 가능(자동으로 MP4 변환) · 세로/가로는 원본대로 유지</div>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="video/*,.mxf,.mov,.mkv,.avi,.ts,.m2ts,.mpg,.mpeg,.wmv"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </div>

          <L label="제목">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              placeholder={file?.name ?? "비우면 파일명"}
              className="sd-input w-full"
            />
          </L>

          <Notice>
            올린 영상은 <b style={{ color: "var(--sd-fg)" }}>있는 그대로</b> 클립이 됩니다 — 자막·리프레임을
            다시 입히지 않습니다. 세로/가로는 원본 비율로 판정됩니다.
          </Notice>

          {busy && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11.5px]">
                <span style={{ color: "var(--sd-mut)" }}>
                  {pct < 100 ? "업로드 중…" : "서버 처리 중 (프로브·썸네일)…"}
                </span>
                <span className="sd-mono" style={{ color: "var(--sd-fg)" }}>{pct}%</span>
              </div>
              <div className="sd-progress">
                <span style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              {pct < 100 && file && (
                <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {fmtSize(uploadedBytes)} / {fmtSize(file.size)}
                </div>
              )}
              <Notice tone="warn">
                {nativeTransfers.available
                  ? <><b>창을 닫거나 PC를 재시작해도 이어집니다.</b> 상단 전송 센터에서 상태를 확인하세요.</>
                  : <><b>새로고침·페이지 이동은 업로드를 끊습니다.</b> 완료될 때까지 이 창을 두세요.</>}
              </Notice>
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--sd-border)" }}
        >
          {!busy && missing.length > 0 && (
            <span className="mr-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
              {missing.join(" · ")} 이(가) 필요합니다
            </span>
          )}
          <button type="button" className="sd-btn" onClick={onClose} disabled={busy}>취소</button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}
            {busy ? (pct < 100 ? "업로드 중…" : "처리 중…") : "업로드 시작"}
          </button>
        </div>
      </div>
    </div>
  );
}

function L({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{label}</span>
        {required && <span style={{ color: "var(--sd-danger)" }}>*</span>}
      </div>
      {children}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  const warn = tone === "warn";
  return (
    <div
      className="flex items-start gap-2 rounded-[4px] px-3 py-2 text-[11.5px] leading-relaxed"
      style={{
        border: `1px solid ${warn ? "var(--sd-warn-border)" : "var(--sd-border)"}`,
        background: warn ? "var(--sd-warn-bg)" : "var(--sd-card-sub)",
        color: warn ? "var(--sd-warn)" : "var(--sd-mut)",
      }}
    >
      {warn ? <AlertTriangle className="mt-px size-3.5 shrink-0" /> : <Info className="mt-px size-3.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}
