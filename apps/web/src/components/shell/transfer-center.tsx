"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { type NativeUploadJob, useNativeTransfers } from "@/lib/native-transfers";

const ACCEPT = "video/*,.mxf,.mov,.mkv,.avi,.ts,.m2ts,.mpg,.mpeg,.wmv";

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function fmtEta(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}초 남음`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}분 남음`;
  return `${(seconds / 3600).toFixed(1)}시간 남음`;
}

const LABEL: Record<NativeUploadJob["status"], string> = {
  queued: "대기",
  initializing: "전송 준비",
  uploading: "업로드 중",
  paused: "일시정지",
  finalizing: "서버 등록 중",
  completed: "완료",
  needs_attention: "확인 필요",
  failed: "실패",
  canceled: "취소됨",
};

export function TransferCenter() {
  const transfers = useNativeTransfers();
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [relinkId, setRelinkId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!transfers.available) return null;

  async function act(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      toast({ title: "전송 작업 실패", description: error instanceof Error ? error.message : String(error), tone: "error" });
    }
  }

  function openResult(job: NativeUploadJob) {
    if (job.result?.episodeId) router.push(`/episodes/${job.result.episodeId}`);
    else if (job.result?.clipId) router.push(`/media?clip=${encodeURIComponent(job.result.clipId)}`);
    else return;
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="sd-btn flex items-center gap-1.5"
        onClick={() => setOpen(true)}
        title="네이티브 전송 큐"
      >
        <UploadCloud className="size-[13px]" aria-hidden />
        <span>전송</span>
        {transfers.activeCount > 0 && (
          <span className="sd-mono rounded-full bg-[var(--sd-accent)] px-1.5 text-[9px] text-[var(--sd-on-accent)]">
            {transfers.activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[80]">
          <button className="absolute inset-0 bg-black/45" onClick={() => setOpen(false)} aria-label="전송 센터 닫기" />
          <aside
            className="absolute inset-y-0 right-0 flex w-[min(430px,100vw)] flex-col border-l border-[var(--sd-border)] bg-[var(--sd-card)] shadow-2xl"
            aria-label="전송 센터"
            aria-modal="true"
            role="dialog"
          >
            <header className="flex h-[54px] items-center justify-between border-b border-[var(--sd-border)] px-4">
              <div>
                <h2 className="sd-serif text-[15px] font-semibold">전송 센터</h2>
                <p className="text-[10.5px] text-[var(--sd-mut)]">창을 닫거나 PC를 재시작해도 이어집니다</p>
              </div>
              <button type="button" className="sd-btn p-1.5" onClick={() => setOpen(false)} aria-label="닫기">
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {transfers.jobs.length === 0 && (
                <div className="grid min-h-52 place-items-center text-center text-[12px] text-[var(--sd-mut)]">
                  <div><UploadCloud className="mx-auto mb-2 size-7" /><p>아직 전송한 영상이 없습니다.</p></div>
                </div>
              )}
              {transfers.jobs.map((job) => {
                const running = ["queued", "initializing", "uploading", "finalizing"].includes(job.status);
                const canRelink = job.errorCode === "FILE_MISSING" || job.errorCode === "FILE_CHANGED";
                return (
                  <article key={job.id} className="sd-card p-3">
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5">
                        {running ? <Loader2 className="size-4 animate-spin text-[var(--sd-accent)]" />
                          : job.status === "completed" ? <CheckCircle2 className="size-4 text-[var(--sd-ok)]" />
                            : ["failed", "needs_attention"].includes(job.status) ? <AlertTriangle className="size-4 text-[var(--sd-danger)]" />
                              : <UploadCloud className="size-4 text-[var(--sd-mut)]" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left text-[12.5px] font-medium disabled:cursor-default"
                          onClick={() => openResult(job)}
                          disabled={job.status !== "completed" || (!job.result?.episodeId && !job.result?.clipId)}
                          title={job.filename}
                        >
                          {job.filename}
                        </button>
                        <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-[var(--sd-mut)]">
                          <span>{job.kind === "episode" ? "회차 원본" : "완성 영상"} · {LABEL[job.status]}</span>
                          <span className="sd-mono">{job.progress}%</span>
                        </div>
                        <div className="sd-progress mt-2"><span style={{ width: `${job.progress}%` }} /></div>
                        <div className="sd-mono mt-1 flex justify-between text-[9.5px] text-[var(--sd-mut)]">
                          <span>{fmtBytes(job.uploadedBytes)} / {fmtBytes(job.size)}</span>
                          <span>{job.speedBps ? `${fmtBytes(job.speedBps)}/s · ${fmtEta(job.etaSec)}` : ""}</span>
                        </div>
                        {job.errorMessage && (
                          <p className="mt-2 rounded-[4px] bg-[var(--sd-danger-bg)] px-2 py-1.5 text-[10.5px] text-[var(--sd-danger-strong)]">
                            {job.errorMessage}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {running && (
                            <button className="sd-btn flex items-center gap-1 py-1" onClick={() => void act(() => transfers.pauseUpload(job.id))}>
                              <Pause className="size-3" /> 일시정지
                            </button>
                          )}
                          {job.status === "paused" && (
                            <button className="sd-btn flex items-center gap-1 py-1" onClick={() => void act(() => transfers.resumeUpload(job.id))}>
                              <Play className="size-3" /> 재개
                            </button>
                          )}
                          {(["failed", "needs_attention"] as const).includes(job.status as "failed" | "needs_attention") && !canRelink && (
                            <button className="sd-btn flex items-center gap-1 py-1" onClick={() => void act(() => transfers.retryUpload(job.id))}>
                              <RotateCcw className="size-3" /> 재시도
                            </button>
                          )}
                          {canRelink && (
                            <button className="sd-btn flex items-center gap-1 py-1" onClick={() => { setRelinkId(job.id); fileRef.current?.click(); }}>
                              <FolderOpen className="size-3" /> 파일 다시 찾기
                            </button>
                          )}
                          {!(["completed", "canceled"] as const).includes(job.status as "completed" | "canceled") && (
                            <button className="sd-btn flex items-center gap-1 py-1" onClick={() => void act(() => transfers.cancelUpload(job.id))}>
                              <X className="size-3" /> 취소
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {transfers.jobs.some((job) => job.status === "completed" || job.status === "canceled") && (
              <footer className="flex justify-end border-t border-[var(--sd-border)] p-3">
                <button className="sd-btn flex items-center gap-1" onClick={() => void act(transfers.clearCompleted)}>
                  <Trash2 className="size-3" /> 완료 기록 지우기
                </button>
              </footer>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                const id = relinkId;
                event.target.value = "";
                setRelinkId(null);
                if (file && id) void act(() => transfers.relinkUpload(id, file));
              }}
            />
          </aside>
        </div>
      )}
    </>
  );
}
