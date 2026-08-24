"use client";

/**
 * U4a · 회차 원본 업로드 모달 (FLOWS F1).
 *
 * 진입점이 셋(프로그램 홈 회차 섹션 · 편성 예정 빈 상태 · 영상 분석 레일)인데 **모두 같은 모달**이다.
 *
 * 지키는 규칙:
 *  - 필수 3개(파일·회차 번호·분석 트랙) 중 하나라도 비면 "업로드 시작"이 눌리지 않는다.
 *  - 회차 번호는 숫자만. 입력 중 비숫자는 지운다.
 *  - 같은 프로그램·같은 회차 번호는 서버가 409 로 막는다(⊘). 업로드 **시작 전에** 걸러 준다.
 *  - 모달을 닫아도 업로드는 계속된다("백그라운드로 계속").
 *  - 업로드 완료 ≠ 분석 완료. 회차는 `분석 대기` 로 들어간다(Invariant).
 *  - 권리 정보는 이 단계에서 절대 만들어지지 않는다(Invariant) — 그래서 고지 문구가 필수다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Film, Info, Loader2, Upload, Youtube } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { DuplicateEpisodeError } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { trackUpload } from "@/lib/upload-tracker";
import { cn } from "@/lib/utils";

/** 분석 소요 추정 배수 — 러닝타임 × 0.4 (F1 고지 문구). */
const ANALYZE_RATIO = 0.4;

const YOUTUBE_URL_RE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^#]*\bv=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/;

export function UploadVideoButton({
  programId,
  className,
  label,
}: {
  programId?: string;
  variant?: "outline" | "default";
  /** sd-* 재설계 화면용 — 넘기면 이 클래스로 그린다. */
  className?: string;
  label?: string;
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
        {label ?? "회차 영상 업로드"}
      </button>
      {open && <UploadDialog onClose={() => setOpen(false)} defaultProgramId={programId} />}
    </>
  );
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtEta(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.ceil(sec)}초`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}분`;
  return `${(sec / 3600).toFixed(1)}시간`;
}

export function UploadDialog({
  onClose,
  defaultProgramId,
}: {
  onClose: () => void;
  defaultProgramId?: string;
}) {
  const { programs, uploadVideo, importYoutube } = useAppData();
  const { toast } = useToast();
  const router = useRouter();

  const [mode, setMode] = useState<"file" | "youtube">("file");
  const [programId, setProgramId] = useState(defaultProgramId ?? programs[0]?.id ?? "");
  useEffect(() => {
    if (!programId && programs.length > 0) setProgramId(defaultProgramId ?? programs[0].id);
  }, [programId, programs, defaultProgramId]);

  const program = programs.find((p) => p.id === programId);

  const [file, setFile] = useState<File | null>(null);
  const [episodeNumber, setEpisodeNumber] = useState("");
  // 트랙 기본값은 프로그램에서 유추한다(드라마→드라마, 그 외→예능).
  // **미지정 프로그램은 비워 두고 사람이 고르게 한다** — 여기서 짐작하면 잘못된 트랙으로 분석이 돈다.
  const [track, setTrack] = useState<"" | "variety" | "drama">("");
  const [broadDate, setBroadDate] = useState(todayISO());
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");

  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  // "백그라운드로 계속"을 눌렀는지. 눌렀으면 완료 시 화면을 빼앗지 않는다(보던 곳에 머문다).
  const backgrounded = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sampleRef = useRef<{ t: number; bytes: number } | null>(null);

  // 프로그램이 바뀌면 트랙 기본값을 다시 유추한다.
  useEffect(() => {
    if (!program) return;
    setTrack(program.pipelineGenre === "drama" ? "drama" : program.pipelineGenre === "variety" ? "variety" : "");
  }, [program?.id, program?.pipelineGenre, program]);

  const epNum = episodeNumber ? Number(episodeNumber) : NaN;
  const canSubmit =
    mode === "file"
      ? Boolean(file) && Number.isInteger(epNum) && epNum >= 1 && track !== "" && Boolean(programId)
      : YOUTUBE_URL_RE.test(url.trim()) && Boolean(programId);

  function pick(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  function handleProgress(p: number) {
    setPct(p);
    if (!file) return;
    const now = performance.now();
    const bytes = (p / 100) * file.size;
    const prev = sampleRef.current;
    if (prev && now > prev.t && bytes > prev.bytes) {
      const inst = ((bytes - prev.bytes) / (now - prev.t)) * 1000;
      setSpeed((s) => (s === 0 ? inst : s * 0.6 + inst * 0.4));
    }
    sampleRef.current = { t: now, bytes };
  }

  function submit() {
    if (!file || busy || !canSubmit) return;
    setBusy(true);
    setDupError(null);
    setPct(0);
    setSpeed(0);
    sampleRef.current = { t: performance.now(), bytes: 0 };

    // 세션 준비가 끝나면 모달은 즉시 닫힌다. 실제 전송 Promise 는 모듈 전역 tracker 가
    // 들고 있어 화면을 옮겨도 살아 있고, 탭 새로고침/종료 때는 beforeunload 로 막는다.
    const job = trackUpload(
      uploadVideo(file, programId, {
        title: title || file.name,
        onProgress: handleProgress,
        onStarted: () => {
          backgrounded.current = true;
          toast({
            title: "백그라운드 업로드를 시작했습니다",
            description: `회차 ${epNum} · 다른 화면에서 계속 작업해도 됩니다. 탭은 닫지 마세요.`,
            tone: "progress",
          });
          onClose();
        },
        episodeNumber: epNum,
        broadDate,
        track: track as "variety" | "drama",
        // 자막 첨부가 없으므로 항상 STT 경로다(서버 기본값과 같다).
        hasSubtitle: true,
      }),
    );

    void job.then((episodeId) => {
      toast({
        title: `회차 ${epNum} 원본이 올라갔습니다`,
        description: "서버 후처리와 분석 대기열에 들어갔습니다. 회차 목록에서 확인하세요.",
        tone: "done",
      });
      // 세션 준비 전에 동기 폴백이 끝난 특수 경우만 화면을 옮긴다. 정상 GCS 업로드는
      // backgrounded=true 이므로 사용자가 보던 화면을 빼앗지 않는다.
      if (!backgrounded.current) {
        onClose();
        router.push(`/episodes/${episodeId}`);
      }
    }).catch((err) => {
      if (err instanceof DuplicateEpisodeError) {
        setDupError(`회차 ${epNum} 은(는) 이 프로그램에 이미 있습니다. 다른 번호를 쓰세요.`);
        // 모달이 이미 닫혔으면(백그라운드 전환) 위 state 는 아무 데도 안 보인다 — 토스트로도 알린다.
        toast({
          title: "업로드 실패 — 회차 번호 중복",
          description: `회차 ${epNum} 은(는) 이 프로그램에 이미 있습니다. 다른 번호로 다시 올려야 합니다.`,
          tone: "error",
        });
      } else {
        toast({
          title: "업로드 실패",
          description: err instanceof Error ? err.message : String(err),
          tone: "error",
        });
      }
      if (!backgrounded.current) setBusy(false);
    });
  }

  async function submitYoutube() {
    if (busy) return;
    const trimmed = url.trim();
    if (!YOUTUBE_URL_RE.test(trimmed)) {
      toast({ title: "URL 확인 필요", description: "유효한 YouTube 링크가 아닙니다", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const episodeId = await importYoutube(trimmed, programId, title.trim() || undefined);
      toast({
        title: "가져오기 시작",
        description: "워커가 다운로드한 뒤 분석 대기열에 넣습니다.",
        tone: "done",
      });
      onClose();
      router.push(`/episodes/${episodeId}`);
    } catch (err) {
      toast({
        title: "가져오기 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setBusy(false);
    }
  }

  const uploadedBytes = file ? Math.min(file.size, (pct / 100) * file.size) : 0;
  const remaining = file ? Math.max(0, file.size - uploadedBytes) : 0;
  const etaSec = speed > 0 ? remaining / speed : Infinity;

  const missing = useMemo(() => {
    if (mode !== "file") return [];
    const m: string[] = [];
    if (!programId) m.push("프로그램");
    if (!file) m.push("파일");
    if (!(Number.isInteger(epNum) && epNum >= 1)) m.push("회차 번호");
    if (track === "") m.push("분석 트랙");
    return m;
  }, [mode, file, epNum, track, programId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 배경 클릭으로 닫힘 (F11). 업로드 중에는 실수로 닫히지 않게 잠근다. */}
      <div
        className="absolute inset-0 bg-black/55"
        onClick={busy ? undefined : onClose}
        aria-hidden
      />
      <div
        className="sd-modal relative flex max-h-[90vh] w-full max-w-[520px] flex-col bg-[var(--sd-card)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            회차 영상 업로드
          </h2>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-4">
          {/* 소스 — 파일 / 유튜브 링크 */}
          <div
            className="grid grid-cols-2 gap-1 rounded-[5px] p-1 text-[11.5px] font-medium"
            style={{ background: "var(--sd-card-sub)" }}
          >
            {(["file", "youtube"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => !busy && setMode(m)}
                disabled={busy}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-[4px] px-3 py-1.5",
                  mode === m ? "bg-[var(--sd-card)] shadow-sm" : "opacity-75",
                )}
                style={{ color: "var(--sd-fg)" }}
              >
                {m === "file" ? <Upload className="size-3.5" /> : <Youtube className="size-3.5" />}
                {m === "file" ? "파일 업로드" : "유튜브 링크"}
              </button>
            ))}
          </div>

          <L label="프로그램">
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

          {/* 프로그램이 없으면 무엇을 채워도 업로드가 안 된다 — 막힌 이유와 갈 곳을 먼저 말한다. */}
          {programs.length === 0 && (
            <Notice tone="warn">
              업로드하려면 프로그램이 먼저 있어야 합니다.{" "}
              <Link href="/programs" className="underline">프로그램 만들기</Link>
            </Notice>
          )}

          {mode === "youtube" ? (
            <>
              <L label="YouTube URL">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  placeholder="https://www.youtube.com/watch?v=…"
                  className="sd-input w-full"
                />
              </L>
              <L label="제목 (선택)">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={busy}
                  className="sd-input w-full"
                />
              </L>
              <Notice>
                워커가 영상을 내려받은 뒤 분석 대기열에 넣습니다. 회차 번호는 서버가 자동으로 매깁니다.
              </Notice>
            </>
          ) : (
            <>
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
                    <div className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                      {file.name}
                    </div>
                    <div className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>
                      {fmtSize(file.size)}
                    </div>
                  </div>
                ) : (
                  <div className="text-[12.5px]" style={{ color: "var(--sd-mut)" }}>
                    영상 파일을 끌어다 놓거나{" "}
                    <span style={{ color: "var(--sd-accent)" }}>클릭해서 선택</span>
                    <div className="text-[11px]">mp4 · mov · webm · 길이 제한 없음</div>
                  </div>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => pick(e.target.files?.[0])}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <L label="회차 번호" required>
                  <input
                    value={episodeNumber}
                    // 숫자만 — 붙여넣기까지 포함해 비숫자를 즉시 지운다.
                    onChange={(e) => {
                      setEpisodeNumber(e.target.value.replace(/\D/g, ""));
                      setDupError(null);
                    }}
                    disabled={busy}
                    inputMode="numeric"
                    placeholder="예: 12"
                    className="sd-input w-full"
                  />
                </L>
                <L label="방영일">
                  <input
                    type="date"
                    value={broadDate}
                    onChange={(e) => setBroadDate(e.target.value)}
                    disabled={busy}
                    className="sd-input w-full"
                  />
                </L>
              </div>

              {dupError && (
                <div
                  className="rounded-[4px] px-3 py-2 text-[11.5px]"
                  style={{
                    border: "1px solid var(--sd-danger-border)",
                    background: "var(--sd-danger-bg)",
                    color: "var(--sd-danger-strong)",
                  }}
                >
                  {dupError}
                </div>
              )}

              <L
                label="분석 트랙"
                required
                hint={
                  program?.pipelineGenre
                    ? "프로그램 기본값에서 가져왔습니다"
                    : "프로그램에 트랙이 지정돼 있지 않습니다 — 직접 고르세요"
                }
              >
                <select
                  value={track}
                  onChange={(e) => setTrack(e.target.value as "" | "variety" | "drama")}
                  disabled={busy}
                  className="sd-input w-full"
                >
                  <option value="">선택하세요</option>
                  <option value="variety">예능</option>
                  <option value="drama">드라마</option>
                </select>
              </L>

              <L label="제목">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={busy}
                  placeholder={file?.name ?? "비우면 파일명"}
                  className="sd-input w-full"
                />
              </L>

              {/* 자막 — 지금은 항상 음성 인식이다. 끌 수 없는 체크박스를 두지 않고 사실만 적는다. */}
              <Notice>
                <b style={{ color: "var(--sd-fg)" }}>자막 파일은 아직 받지 않습니다.</b> 자막 유무와 관계없이
                음성 인식(STT)으로 대본을 만듭니다.
              </Notice>

              {/* F1 고지 — 소요 시간 안내. */}
              <Notice tone="warn">
                분석에는 대략 <b>러닝타임 × {ANALYZE_RATIO}</b> 만큼 걸립니다(60분 영상 ≈ 24분).
              </Notice>
              {!busy && (
                <Notice>
                  업로드 시작 후 자동으로 백그라운드 전환됩니다. 다른 화면에서 계속 작업할 수 있습니다.
                </Notice>
              )}

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
                    <div
                      className="sd-mono flex items-center justify-between text-[10.5px]"
                      style={{ color: "var(--sd-mut)" }}
                    >
                      <span>{fmtSize(uploadedBytes)} / {fmtSize(file.size)}</span>
                      <span>{speed > 0 ? `${fmtSize(speed)}/s · 남은 시간 ${fmtEta(etaSec)}` : "속도 측정 중…"}</span>
                    </div>
                  )}
                  <Notice tone="warn">
                    창을 닫아도 업로드는 계속됩니다. 단 <b>새로고침·페이지 이동은 업로드를 끊습니다.</b>
                  </Notice>
                </div>
              )}
            </>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--sd-border)" }}
        >
          {mode === "file" && !busy && missing.length > 0 && (
            <span className="mr-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
              {missing.join(" · ")} 이(가) 필요합니다
            </span>
          )}
          <button type="button" className="sd-btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={mode === "file" ? submit : submitYoutube}
            disabled={busy || !canSubmit}
          >
            {busy && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}
            {mode === "file"
              ? busy ? (pct < 100 ? "업로드 중…" : "처리 중…") : "업로드 시작"
              : busy ? "가져오는 중…" : "가져오기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function L({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {label}
        </span>
        {required && <span style={{ color: "var(--sd-danger)" }}>*</span>}
        {hint && (
          <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
            {hint}
          </span>
        )}
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
      {warn ? (
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
      ) : (
        <Info className="mt-px size-3.5 shrink-0" />
      )}
      <span>{children}</span>
    </div>
  );
}
