/**
 * ffmpeg/ffprobe wrapper — used in Cloud Run (ffmpeg baked into Docker image).
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  /** Frame rate parsed from r_frame_rate ("30000/1001" → 29.97). 0 when unknown. */
  fps: number;
  /** ffprobe `format.format_name` ("mov,mp4,m4a,…" · "mxf" · "matroska,webm"). 정규화 판정 축. */
  formatName: string;
  /** 첫 오디오 스트림의 코덱("aac"·"pcm_s24le"·"mp2"…). 없으면 "". */
  audioCodec: string;
  /** 오디오 스트림 **개수** — 방송 MXF 는 모노 8트랙이 흔하다(믹스·대사·효과). */
  audioStreams: number;
  /** 첫 오디오 스트림의 채널 수(1=모노 · 2=스테레오). 0=알 수 없음. */
  audioChannels: number;
  /** `field_order` 가 인터레이스(tt·bb·tb·bt)인가 — 방송 원본은 1080i 가 흔하다. */
  interlaced: boolean;
  /**
   * 소스 시작 타임코드("10:00:00:00"). 없으면 "".
   *
   * 방송 원본은 00:00:00:00 이 아니라 10:00:00:00 에서 시작하는 게 표준이다. STEP-D 내부는
   * **파일 0초 기준**으로 일관되지만(모든 -ss·구간이 그렇다), Premiere·EDL 은 소스 타임코드
   * 기준이라 이 값을 모르면 편집자 화면에서 10시간 어긋난 자리를 가리킨다.
   */
  startTimecode: string;
  /**
   * 원본 부가 스트림 인벤토리 — **MXF 는 "굽기 전 재료"라 자막·대사 트랙이 따로 들어 있다.**
   * mp4 로 정규화하면서 이걸 통째로 버리고 있었다(사용자 2026-08-27 지적).
   *
   * 지금은 **기록만** 한다. 실제 방송사 원본이 자막을 어디에 담는지(비디오 임베드 CEA-608 /
   * 별도 데이터 트랙 SMPTE-436M), 오디오 트랙을 어떤 순서로 배치하는지가 방송사마다 달라서,
   * 추측으로 배선하면 어긋난다. 첫 실파일 로그를 보고 STT 대체·트랙 선택을 결정한다.
   */
  sourceStreams: SourceStreamInfo[];
};

/** 원본 스트림 한 줄 — ffprobe 가 준 그대로(추측 없이). */
export type SourceStreamInfo = {
  index: number;
  type: string;      // video · audio · subtitle · data
  codec: string;     // mpeg2video · pcm_s24le · eia_608 · smpte_436m …
  channels?: number;
  /** 트랙 이름·언어 태그 — 방송 MXF 는 여기에 "Dialogue"·"M&E" 같은 라벨을 넣기도 한다. */
  language?: string;
  title?: string;
};

/** #rrggbb 또는 rrggbb 문자열을 3~6자 안 되면 fallback으로 대체. ffmpeg color 필터에 넘길 값 정규화용. */
function normalizeHexColor(input: string | undefined, fallback: string): string {
  const v = (input ?? "").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

// 성공은 영구 캐시, 실패는 30초 간격으로만 재프로브한다.
// 부팅 1회 프로브를 상수로 들고 있으면 콜드스타트 CPU 경합에서 5초 타임아웃 오탐 한 번에
// 인스턴스 수명 내내 false 로 고착된다(실측 2026-08-13 — 이미지에 ffmpeg 이 있는데 /health
// 가 false). 반대로 스로틀 없이 매번 물으면 ffmpeg 없는 로컬 폴백 환경에서 요청마다 5초씩
// 동기 블로킹된다 — 그래서 실패 쪽만 간격을 둔다.
let ffmpegOk = false;
let lastProbeAt = 0;
export function hasFfmpeg(): boolean {
  if (ffmpegOk) return true;
  const now = Date.now();
  if (now - lastProbeAt < 30_000) return false;
  lastProbeAt = now;
  try {
    const out = execFileSync("ffmpeg", ["-version"], { timeout: 5000, encoding: "utf8", stdio: "pipe" });
    ffmpegOk = out.includes("ffmpeg version");
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    // filePath may be a signed https:// URL (GCS range-read) — only guard local paths.
    const isUrl = /^https?:\/\//i.test(filePath);
    if (!isUrl && !fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    execFile(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const format = data.format ?? {};
          const videoStream = (data.streams ?? []).find(
            (s: any) => s.codec_type === "video"
          );
          const audioStream = (data.streams ?? []).find(
            (s: any) => s.codec_type === "audio"
          );
          // r_frame_rate is "num/den" (e.g. "30000/1001" for NTSC 29.97). Zero-guard the
          // divisor — some containers report "0/0" for still images or bad streams.
          const rate = String(videoStream?.r_frame_rate ?? "");
          const [rnStr, rdStr] = rate.split("/");
          const rn = parseFloat(rnStr || "0");
          const rd = parseFloat(rdStr || "1");
          const fps = rd > 0 && rn > 0 ? rn / rd : 0;
          const audios = (data.streams ?? []).filter((s: any) => s.codec_type === "audio");
          resolve({
            durationSec: parseFloat(format.duration ?? "0") || 0,
            width: videoStream?.width ?? 0,
            height: videoStream?.height ?? 0,
            codec: videoStream?.codec_name ?? "",
            hasAudio: !!audioStream,
            fps,
            formatName: String(format.format_name ?? ""),
            audioCodec: String(audioStream?.codec_name ?? ""),
            audioStreams: audios.length,
            audioChannels: Number(audioStream?.channels ?? 0) || 0,
            // ffprobe 는 progressive 를 "progressive", 인터레이스를 tt/bb/tb/bt 로 준다.
            // 모르면(unknown·빈 값) **인터레이스가 아니라고 본다** — 아니면 멀쩡한 소스를
            // 매번 디인터레이스해 화질만 깎는다.
            interlaced: /^(tt|bb|tb|bt)$/.test(String(videoStream?.field_order ?? "")),
            // 타임코드는 컨테이너마다 자리가 다르다: MXF·MOV 는 별도 data 스트림 tags,
            // mp4 는 비디오 스트림 tags, 일부는 format tags. 세 곳을 순서대로 본다.
            sourceStreams: (data.streams ?? []).map((st: any) => ({
              index: Number(st.index ?? 0),
              type: String(st.codec_type ?? ""),
              codec: String(st.codec_name ?? ""),
              ...(st.channels ? { channels: Number(st.channels) } : {}),
              ...(st.tags?.language ? { language: String(st.tags.language) } : {}),
              ...(st.tags?.title ? { title: String(st.tags.title) } : {}),
            })),
            startTimecode: String(
              videoStream?.tags?.timecode
              ?? (data.streams ?? []).find((s: any) => s?.tags?.timecode)?.tags?.timecode
              ?? format.tags?.timecode
              ?? "",
            ),
          });
        } catch (e) {
          reject(new Error(`ffprobe parse error: ${e}`));
        }
      }
    );
  });
}

/**
 * ffmpeg stderr 버퍼 상한 — Node execFile 기본(1MB)은 경고가 프레임 단위로 반복되는
 * 렌더에서 넘친다. 넘치면 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 로 프로세스가 **인코딩과
 * 무관하게** 죽어 "렌더 실패" 가 된다 — 2026-08-26 ENA 실전: 60초 쇼츠 2건이 매 시도
 * 이걸로만 실패해 자동 게시가 멈췄다. 로그는 버려도 되지만 렌더가 죽으면 안 된다.
 */
const FF_MAXBUF = 64 * 1024 * 1024;

export function captureThumbnail(
  inputPath: string,
  timeOffset: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss", String(timeOffset),
        "-i", inputPath,
        "-vframes", "1",
        "-q:v", "2",
        outputPath,
      ],
      { timeout: 30_000, maxBuffer: FF_MAXBUF },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) {
          return reject(new Error("Thumbnail not produced"));
        }
        resolve();
      }
    );
  });
}

/**
 * Remux a video to a browser-friendly progressive mp4 (single moov at the front, no
 * fragments) WITHOUT re-encoding (`-c copy` → fast). Uploaded files are frequently
 * fragmented (fMP4: tiny init moov + moof/mdat fragments) which a plain <video> element
 * can't stream. `input` may be a local path or an https signed URL.
 */
export function remuxFaststart(input: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath],
      { timeout: 300_000, maxBuffer: FF_MAXBUF },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) return reject(new Error("remux output not produced"));
        resolve();
      },
    );
  });
}

// ── 원본 정규화 (MXF 등 → mp4) ────────────────────────────────────────────────
//
// 사용자 결정 2026-08-27: **"웹에서는 오로지 MXF 를 mp4 로 전환 후 다룬다."**
// 방송사 원본(MXF/MOV 안의 MPEG-2 422·AVC-Intra·DNxHD·ProRes·PCM, 1080i, 오디오 8트랙,
// 20~50GB)은 브라우저가 못 재생하고, 파이프라인 곳곳이 mp4 를 전제로 짜여 있다.
// 그래서 **업로드 직후 한 번** mp4 로 정규화하고, 그 뒤 모든 단계(웹 재생·분석·렌더)는
// 그 mp4 만 본다. 원본은 GCS 에 그대로 남는다(지우지 않는다 — 방송사 소재다).

/** 정규화가 필요한가 — 순수 판정(테스트가 이 함수를 직접 짚는다). */
/**
 * 정규화 산출물을 올릴 오브젝트 경로. **원본과 절대 같으면 안 된다.**
 *
 * ⚠️ 예전엔 `objectPath.replace(/\.[^./]+$/, "") + ".mp4"` 였다. `.mxf`·`.mov` 면 경로가
 * 갈리지만, **업로드 확장자가 이미 `.mp4` 인데 정규화가 필요한 경우**(1080i · 오디오 트랙
 * 2개 · hevc · 비-aac — 전부 mp4 컨테이너에서 생긴다, `needsMp4Normalize` 참고) 결과가
 * 원본과 같은 경로가 되어 **방송사 원본을 변환본으로 덮어썼다.** GCS 업로드는 존재 검사가
 * 없어 복구가 안 되고, 뒤따르는 원본 자막 추출도 사라진 파일을 읽어 조용히 "자막 없음" 으로
 * 빠졌다(로그에는 "원본 보존" 이라고 반대로 찍혔다).
 *
 * 충돌하면 `.norm.mp4` 로 비킨다 — 방송사 소재는 지우지 않는다는 규칙이 먼저다.
 */
export function normalizedMp4Path(objectPath: string): string {
  const candidate = objectPath.replace(/\.[^./]+$/, "") + ".mp4";
  return candidate === objectPath ? `${objectPath.replace(/\.[^./]+$/, "")}.norm.mp4` : candidate;
}

export function needsMp4Normalize(p: Pick<ProbeResult,
  "formatName" | "codec" | "audioCodec" | "audioStreams" | "interlaced" | "hasAudio">,
): { needed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const fmt = p.formatName.toLowerCase();
  // mov/mp4 계열이 아니면 브라우저가 못 연다(mxf·mpegts·mxf_opatom·avi…).
  if (fmt && !/(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)/.test(fmt)) reasons.push(`컨테이너 ${fmt}`);
  // 비디오 코덱: h264 만 안전하다(hevc 는 브라우저·플랫폼 지원이 갈린다).
  if (p.codec && p.codec.toLowerCase() !== "h264") reasons.push(`비디오 ${p.codec}`);
  // 오디오 코덱: aac 가 아니면 mp4 로 copy 가 안 되거나 재생이 안 된다(pcm_s24le·mp2…).
  if (p.hasAudio && p.audioCodec && p.audioCodec.toLowerCase() !== "aac") reasons.push(`오디오 ${p.audioCodec}`);
  // 오디오 트랙이 여럿이면 하나로 정리해야 한다 — 안 하면 플랫폼이 첫 트랙만 쓰는데
  // 방송 MXF 의 1번 트랙은 대개 **모노 반쪽**(L 채널)이라 소리가 반만 나간다.
  if (p.audioStreams > 1) reasons.push(`오디오 트랙 ${p.audioStreams}개`);
  // 1080i 는 그대로 두면 빗살무늬가 결과물에 그대로 박힌다.
  if (p.interlaced) reasons.push("인터레이스");
  return { needed: reasons.length > 0, reasons };
}

/**
 * 오디오 매핑 인자 — 방송 원본의 트랙 구성을 하나의 스테레오로 접는다.
 *
 * · 트랙 1개              → 그대로 쓴다(`-map 0:a:0`).
 * · 모노가 2개 이상       → **앞의 두 트랙을 L/R 로 합친다**(방송 표준: 1=L · 2=R).
 *                           이걸 안 하면 첫 트랙만 잡혀 소리가 한쪽만 나온다.
 * · 첫 트랙이 스테레오+   → 그 트랙만 쓴다(나머지는 대개 M&E·예비).
 * 오디오가 없으면 빈 배열(무음 영상도 정규화는 된다).
 */
export function audioMapArgs(p: Pick<ProbeResult, "hasAudio" | "audioStreams" | "audioChannels">): string[] {
  if (!p.hasAudio || p.audioStreams === 0) return ["-an"];
  if (p.audioStreams > 1 && p.audioChannels === 1) {
    return ["-filter_complex", "[0:a:0][0:a:1]amerge=inputs=2[aout]", "-map", "[aout]", "-ac", "2"];
  }
  return ["-map", "0:a:0", "-ac", "2"];
}

/** 정규화 출력 상한 — 세로 쇼츠(1080×1920)가 최종이라 소스는 1080p 면 충분하다. */
export const NORMALIZE_MAX_HEIGHT = 1080;

/**
 * 원본을 **브라우저·파이프라인 공용 mp4** 로 정규화한다. `input` 은 로컬 경로 또는 서명 URL —
 * URL 을 그대로 주면 ffmpeg 이 range-read 로 읽어 20~50GB 를 디스크에 안 내려도 된다
 * (Cloud Run 의 /tmp 는 RAM 이라 원본 다운로드는 그 자체로 OOM 이다).
 *
 * 타임아웃은 길이에 비례해 잡는다 — 60분 1080p 트랜스코드는 실기로 10~25분이 걸린다.
 */
export function normalizeToMp4(
  input: string,
  outputPath: string,
  opts: { probe: ProbeResult; timeoutMs?: number } = {} as never,
): Promise<void> {
  const p = opts.probe;
  const vf: string[] = [];
  // 디인터레이스는 인터레이스 소스에만 — yadif 는 progressive 에 걸면 디테일을 깎는다.
  if (p.interlaced) vf.push("yadif=0:-1:0");
  if (p.height > NORMALIZE_MAX_HEIGHT) vf.push(`scale=-2:${NORMALIZE_MAX_HEIGHT}`);
  // 홀수 해상도는 libx264(yuv420p)가 거부한다 — 방송 소스는 1920×1080 이라 보통 무해하지만
  // 스케일 없이 그대로 갈 때를 위해 항상 짝수로 맞춘다.
  vf.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");

  const args = [
    "-y", "-i", input,
    "-map", "0:v:0",
    ...audioMapArgs(p),
    "-vf", vf.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-pix_fmt", "yuv420p",
    ...(p.hasAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
  // 실시간의 3배(최소 10분·최대 3시간) — 넘기면 잡이 재시도한다.
  const timeout = opts.timeoutMs
    ?? Math.min(3 * 3600_000, Math.max(10 * 60_000, Math.round(p.durationSec * 3) * 1000));
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: FF_MAXBUF }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(outputPath)) return reject(new Error("normalize output not produced"));
      resolve();
    });
  });
}

// ── 원본 자막 건지기 (MXF 등) ─────────────────────────────────────────────────
//
// 방송 원본에는 **사람이 검수한 대본**이 자막으로 들어 있는 경우가 많다. 그걸 STT 로 다시
// 만들면 회차당 ₩141 을 쓰면서 정확도는 더 낮다(고유명사·프로그램 용어를 틀린다).
// 그래서 정규화할 때 한 번 건져 본다 — **있으면 쓰고, 없으면 지금처럼 STT.**
//
// 자막이 담기는 자리는 방송사마다 다르다:
//   ① 별도 자막 스트림 (codec_type=subtitle)         → -map 0:s:0 로 바로 뽑힌다
//   ② 비디오에 임베드된 CEA-608/708 (a53 SEI·VANC)   → lavfi movie 필터의 subcc 로 뽑는다
// 둘 다 실패하면 조용히 없는 것으로 친다(자막 없는 원본이 더 흔하다).

/** 자막 추출 결과 — `cues` 가 0 이면 "뽑았지만 비었다"(파일은 지운다). */
export type CaptionExtract = { path: string; cues: number; source: "stream" | "embedded" } | null;

function srtCueCount(file: string): number {
  try {
    const text = fs.readFileSync(file, "utf8");
    // SRT 는 큐마다 "번호\n시간 --> 시간" 이 온다. 화살표 수가 곧 큐 수다.
    return (text.match(/-->/g) ?? []).length;
  } catch { return 0; }
}

function runFfmpeg(args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: FF_MAXBUF }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 원본에서 자막을 SRT 로 뽑는다. **절대 던지지 않는다** — 자막은 있으면 좋은 것이지
 * 없다고 정규화를 막을 이유가 없다.
 *
 * `input` 은 로컬 경로 또는 서명 URL. `probe` 는 이미 잰 결과(스트림 인벤토리 사용).
 */
export async function extractSourceCaptions(
  input: string, outSrt: string, p: ProbeResult, timeoutMs = 15 * 60_000,
): Promise<CaptionExtract> {
  const hasSubtitleStream = p.sourceStreams.some((s) => s.type === "subtitle");

  // ① 별도 자막 스트림
  if (hasSubtitleStream) {
    try {
      await runFfmpeg(["-y", "-v", "error", "-i", input, "-map", "0:s:0", "-c:s", "srt", "-f", "srt", outSrt], timeoutMs);
      const cues = srtCueCount(outSrt);
      if (cues > 0) return { path: outSrt, cues, source: "stream" };
      fs.rmSync(outSrt, { force: true });
    } catch { fs.rmSync(outSrt, { force: true }); }
  }

  // ② 비디오에 임베드된 CEA-608/708 — lavfi movie 필터가 subcc 출력으로 뽑아 준다.
  // 경로 구분자·콜론이 필터 문법과 충돌하므로 이스케이프한다(Windows 로컬 경로·URL 모두).
  try {
    const esc = input.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await runFfmpeg(
      ["-y", "-v", "error", "-f", "lavfi", "-i", `movie=${esc}[out0+subcc]`,
       "-map", "0:s:0", "-c:s", "srt", "-f", "srt", outSrt],
      timeoutMs,
    );
    const cues = srtCueCount(outSrt);
    if (cues > 0) return { path: outSrt, cues, source: "embedded" };
    fs.rmSync(outSrt, { force: true });
  } catch { fs.rmSync(outSrt, { force: true }); }

  return null;
}

export type RenderShortOpts = {
  inputPath: string;
  /** Absolute source seconds. */
  startTime: number;
  endTime: number;
  outputPath: string;
  /** Target frame size (e.g. 1080×1920 for 9:16). */
  width: number;
  height: number;
  /** Optional ASS file to burn (title/channel/overlays). Requires a CJK font in the image. */
  assPath?: string | null;
  /** 정적 오버레이 PNG (overlay-canvas.ts) — 제목·채널 텍스트를 canvas 로 그린 **투명 전체프레임
   *  이미지**(W×H). 주면 그 정적 오버레이는 ASS 번인 대신 ffmpeg `overlay=0:0` 으로 합성한다
   *  (AENA 방식 · 구조적 WYSIWYG). 합성 위치는 그레이드 뒤·ASS(자막/애니메이션 타이틀) 앞이라
   *  자막이 정적 오버레이 위에 온다. ⚠️ 단일입력 basic 경로에서만 소비된다 — 프리롤·AI(reframe)
   *  경로는 자체 입력 구성이 복잡해 여전히 ASS 를 쓴다(index.ts 가 그 경우 assPath 로만 굽는다). */
  overlayPngPath?: string | null;
  /** Optional ffmpeg video-filter fragment (colour grade), e.g. "eq=contrast=1.20,colorbalance=rm=0.15".
   *  Applied to the composited frame before the ASS burn so overlays stay ungraded. */
  videoFilters?: string | null;
  /** Optional ffmpeg audio-filter fragment, e.g. "volume=0.500" (may already include atempo
   *  for speed). Only pass when the source actually has an audio stream (ffmpeg errors on -af
   *  with no audio). */
  audioFilter?: string | null;
  /** Uniform playback speed (1 = normal, 2 = 2× fast, 0.5 = half). Burned via setpts AFTER
   *  the ASS/overlay burn so captions speed up in sync. Audio atempo is expected in audioFilter. */
  speed?: number;
  /** 배경 채우기 방식.
   *  - "blur"(기본, 하위호환): 원본 확대 블러 커버.
   *  - "solid": 단색 letterbox. bgColor(#rrggbb 또는 0xRRGGBB) 사용.
   *  - "image": TODO — 지금은 solid로 폴백. 이미지 파일 준비·filter graph 확장 후 활성. */
  bgType?: "solid" | "blur" | "image";
  /** bgType='solid'일 때의 letterbox 색 (예: "#0E0E12"). */
  bgColor?: string;
  /**
   * 축2 — 원본을 컨테이너에 어떻게 넣나. **프레임(frame)이 없을 때만** 본다.
   *  - "cover": 잘라 채우기(레터박스 없음, bgType 무의미).
   *  - "contain"/미설정: 맞춤(레터박스 + bgType 여백). 기존 동작.
   * 프레임이 있으면 frame.video.fit 이 우선이라 이 값은 무시된다.
   */
  fit?: "contain" | "cover";
  /** 세로 밴드 크롭(9:16-crop-main/sub) — 비디오가 앉을 **캔버스 내 사각형**(px). 주면 fit/bgType 을
   *  무시하고 `crop=ih*w/h:ih,scale=w:h,pad=W:H:x:y` 경로를 탄다(나머지는 검정 pad = 캡션 밴드).
   *  프레임(frame)·AI(reframePlan) 경로가 없을 때만 본다 — 둘 다 자체 기하를 소유하므로 우선한다.
   *  좌표는 aspect-presets.ts CROP 프리셋에서 온다(에디터 미리보기와 같은 숫자 = 파리티). */
  cropRect?: { x: number; y: number; w: number; h: number } | null;
  /** 프레임 템플릿 기하 (assets/shorts-template/<name>/meta.json).
   *  주면 배경 blur/solid 대신 **프레임 합성 경로**를 탄다: 검정 바탕 → 영상 사각형(cover)
   *  → bands → overlay.png 조각 → over bands. 편집기 미리보기와 같은 순서여야 한다. */
  frame?: {
    overlayPath: string;
    video: { x: number; y: number; w: number; h: number; fit?: "cover" | "contain" };
    bands: { x: number; y: number; w: number; h: number; color?: string; over?: boolean }[];
    overlayRegions: { x: number; y: number; w: number; h: number }[];
  } | null;
  /** 첫 3초 hook 프리롤 (2026-08-02 · docs/plans/shorts-hook-intro-3sec.md · Phase 3/α).
   *  설정 시 · 본문 앞에 hook 구간의 짧은 클립을 punch-in(전체화면 커버 + 살짝 그레이드)으로
   *  붙이고 cross-dissolve 로 본문에 이어붙인다. 이탈 방지용 attention retention.
   *  프리롤은 자막·타이틀 없이 순수 hook clip (본문 오버레이는 본문 프레임에만 번인). */
  hookPreroll?: {
    /** hook 대사가 시작하는 마스터 절대 초. (본문 start + hook_time_sec, 캘러가 클램프) */
    startTime: number;
    /** 프리롤 길이(초). 기본 3. */
    durationSec: number;
    /** 오디오 크로스페이드 포함 여부 (마스터에 오디오 있을 때만 true). */
    hasAudio?: boolean;
    /**
     * 훅 내레이션 mp3 경로 (tts.ts). 있으면 프리롤 구간에서 **원음을 덕킹하고** 그 위에 얹는다.
     * 원음을 완전히 죽이지 않는 이유: 웃음·환호가 훅의 실체라 그걸 지우면 껍데기만 남는다.
     */
    ttsPath?: string | null;
    /** 훅 캡션 ASS 경로 (index.ts buildHookCaptionAss). 있으면 프리롤 화면 상단에 크게 굽는다 —
     *  편집자가 고친 hookCaption 을 **화면 자막**으로(사용자 2026-08-20). 없으면 자막 없이 프리롤만. */
    captionAssPath?: string | null;
  } | null;
  /** 하단 브랜딩 아이콘/로고 — 프로그램에서 미리 설정한 이미지. **높이(h) 기준**으로
   *  스케일하고 가로는 비율 유지 + 화면 중앙 정렬((W-w)/2 식) — 정사각 아이콘과 가로
   *  워드마크 로고가 같은 코드로 자연스럽게 앉는다. ASS 번인 뒤에 얹는다.
   *  ⚠️ hookPreroll 경로에는 아직 미지원 — 캘러가 프리롤일 땐 넘기지 않는다. */
  /**
   * 하단 브랜딩 아이콘. `x` 는 미리보기와 같은 흐름 배치(아이콘+채널명 한 행)를 위해 서버가
   * 계산한 좌표 — 없으면 종전대로 가로 중앙. **ASS 의 채널명 x 와 같은 계산에서 나와야 한다**
   * (index.ts `channelBadgeLayout`). 두 곳이 따로 계산하면 아이콘과 이름이 어긋난다.
   */
  badge?: { path: string; y: number; h: number; x?: number } | null;
  /** AI multi-layout plan. Times are absolute master seconds and tracking centres are
   * normalized source-frame coordinates. The renderer intersects it with startTime/endTime
   * and deterministically fills every uncovered gap with `fit`. */
  reframePlan?: ReframeRenderPlan | null;
  /** In AI multi-layout mode captions stay visible during both layouts, while decorative
   * editor overlays are pre-clipped to fit intervals by the caller. `assPath` remains the
   * backwards-compatible all-in-one path used by basic mode. */
  captionAssPath?: string | null;
  decorationAssPath?: string | null;
};

export type ReframeTrackingKeyframe = {
  /** Absolute master second. */
  t: number;
  /** Normalized source-frame centre. */
  cx: number;
  cy: number;
  confidence?: number;
};

export type ReframeRenderSegment = {
  beatId?: string | number;
  /** Absolute master seconds. */
  start: number;
  end: number;
  layout: "fit" | "fill";
  score?: number;
  reasonCodes?: string[];
  tracking?: ReframeTrackingKeyframe[];
};

export type ReframeRenderPlan = {
  version: 1;
  mode: "ai_multi";
  sourceStart?: number;
  sourceEnd?: number;
  segments?: ReframeRenderSegment[];
  /** `beats` is accepted as a wire-format alias so the worker plan can stay beat-shaped. */
  beats?: ReframeRenderSegment[];
};

export type NormalizedReframeSegment = ReframeRenderSegment & {
  start: number;
  end: number;
  tracking: ReframeTrackingKeyframe[];
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Validate, sort and fully cover an export window. Invalid/overlapping pieces never reach
 * ffmpeg; uncovered ranges intentionally become fit instead of silently inheriting a stale
 * crop. Export routes validate too, but keeping this boundary pure protects every caller.
 */
export function normalizeReframeSegments(
  plan: ReframeRenderPlan | null | undefined,
  windowStart: number,
  windowEnd: number,
): NormalizedReframeSegment[] {
  if (!plan || plan.mode !== "ai_multi" || !(windowEnd > windowStart)) return [];
  const raw = (Array.isArray(plan.segments) ? plan.segments : Array.isArray(plan.beats) ? plan.beats : [])
    .filter((s): s is ReframeRenderSegment => !!s && finite(s.start) && finite(s.end) && s.end > s.start
      && (s.layout === "fit" || s.layout === "fill"))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: NormalizedReframeSegment[] = [];
  let cursor = windowStart;
  for (const source of raw) {
    const start = Math.max(windowStart, cursor, source.start);
    const end = Math.min(windowEnd, source.end);
    if (end <= start + 1e-6) continue;
    if (start > cursor + 1e-6) {
      out.push({ start: cursor, end: start, layout: "fit", reasonCodes: ["uncovered_range"], tracking: [] });
    }
    const byTime = new Map<number, ReframeTrackingKeyframe>();
    for (const k of Array.isArray(source.tracking) ? source.tracking : []) {
      if (!k || !finite(k.t) || !finite(k.cx) || !finite(k.cy)) continue;
      // Keep one sample immediately outside each edge useful for interpolation, but reject
      // unrelated points from another beat/plan.
      if (k.t < source.start - 0.5 || k.t > source.end + 0.5) continue;
      byTime.set(k.t, {
        t: k.t,
        cx: clamp01(k.cx),
        cy: clamp01(k.cy),
        ...(finite(k.confidence) ? { confidence: clamp01(k.confidence) } : {}),
      });
    }
    const tracking = [...byTime.values()].sort((a, b) => a.t - b.t);
    out.push({ ...source, start, end, tracking });
    cursor = end;
    if (cursor >= windowEnd - 1e-6) break;
  }
  if (cursor < windowEnd - 1e-6) {
    out.push({ start: cursor, end: windowEnd, layout: "fit", reasonCodes: ["uncovered_range"], tracking: [] });
  }
  if (!out.length) {
    out.push({ start: windowStart, end: windowEnd, layout: "fit", reasonCodes: ["missing_plan"], tracking: [] });
  }
  return out;
}

const ffNum = (v: number): string => {
  const s = Number(v.toFixed(6)).toString();
  return s === "-0" ? "0" : s;
};

/** 브랜딩 아이콘의 overlay x — 서버가 흐름 배치로 계산해 줬으면 그 값, 아니면 가로 중앙. */
const badgeX = (badge: { x?: number }): string =>
  Number.isFinite(badge.x as number) ? ffNum(Math.round(badge.x as number)) : "(W-w)/2";

/** Piecewise-linear focus expression for ffmpeg's per-frame crop x/y evaluation. */
export function trackingAxisExpression(
  tracking: ReframeTrackingKeyframe[],
  axis: "cx" | "cy",
  segmentStart: number,
): string {
  const pts = tracking
    .filter((k) => finite(k?.t) && finite(k?.[axis]))
    .map((k) => ({ t: Math.max(0, k.t - segmentStart), v: clamp01(k[axis]) }))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return "0.5";
  if (pts.length === 1) return ffNum(pts[0].v);
  let expr = ffNum(pts[pts.length - 1].v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    const dt = Math.max(0.000001, b.t - a.t);
    const lerp = `${ffNum(a.v)}+(${ffNum(b.v - a.v)})*clip((t-${ffNum(a.t)})/${ffNum(dt)},0,1)`;
    expr = `if(lt(t,${ffNum(b.t)}),${lerp},${expr})`;
  }
  return expr;
}

/**
 * 이미지를 원형으로 잘라 PNG 로 저장 (하단 브랜딩 아이콘용). geq 로 원 밖 알파를 0 으로.
 * size 는 정사각 한 변(px) — 렌더에서 다시 줄이지 않도록 최종 크기로 만든다.
 */
export function circleCrop(srcPath: string, dstPath: string, size: number): Promise<void> {
  const vf =
    `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=rgba,` +
    `geq=a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),alpha(X,Y),0)'` +
    `:r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'`;
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", srcPath, "-vf", vf, "-frames:v", "1", dstPath],
      { timeout: 30_000 }, (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(dstPath)) return reject(new Error("circleCrop output not produced"));
        resolve();
      });
  });
}

/** 프리롤→본문 cross-dissolve 길이(초). 프로토타입(render_shorts.py) 검증값. */
const HOOK_XFADE_SEC = 0.25;
/** 내레이션 음량 — 원음 위에서 또렷하게 들려야 하지만 클리핑은 피한다. */
const HOOK_TTS_VOL = 1.6;
/**
 * 내레이션 덕킹 — **사이드체인**이다(고정 감쇠가 아니라).
 *
 * 실측(2026-08-16 · 3초 훅에 1.5초 내레이션)으로 고른 방식이다:
 *   고정 감쇠(volume=0.35 + dynaudnorm) → 내레이션이 끝난 뒤에도 원음이 눌린 채 남아
 *     뒷부분이 원음보다 **9dB 더 조용**해졌다(-37.8 vs 원음 -28.7). 소리가 죽은 것처럼 들린다.
 *   사이드체인 → 내레이션 중에만 누르고 끝나면 원음이 그대로 돌아온다(-28.7 = 원음과 동일).
 *
 * ⚠️ 사이드체인 입력을 **apad 로 늘려야 한다** — 안 그러면 sidechaincompress 가 출력 길이를
 * 사이드체인 길이(1.48초)로 잘라서 프리롤 오디오가 통째로 짧아진다(실측).
 */
const HOOK_DUCK = "sidechaincompress=threshold=0.02:ratio=8:attack=5:release=300";

/**
 * renderShort 의 hook-preroll 분기 — 2입력 xfade.
 *   입력0 = 프리롤(hook 구간) · 입력1 = 본문(원 세그먼트).
 * 본문은 기존 renderShort 와 동일한 커버/그레이드/자막/속도 처리를 거친 뒤,
 * 프리롤(punch-in 전체화면 + 살짝 채도·대비 강조)과 cross-dissolve 로 이어붙는다.
 * xfade 는 두 입력의 fps 가 같아야 하므로 두 스트림 모두 fps=30 으로 정규화한다(쇼츠 표준).
 */
function renderShortWithPreroll(opts: RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> }): Promise<void> {
  const { inputPath, startTime, endTime, outputPath, width: W, height: H, assPath, videoFilters, audioFilter } = opts;
  const bodyDur = endTime - startTime;
  if (bodyDur <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const pre = opts.hookPreroll;
  const preDur = Math.max(0.5, pre.durationSec);
  const preStart = Math.max(0, pre.startTime);
  const preEnd = preStart + preDur;

  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");

  // ── 본문(입력1) 체인 — 기존 renderShort 와 동일 구성, 입력 라벨만 [1:v] ──
  let vf: string;
  if (opts.fit === "cover") {
    // 축2 "채우기": 잘라 채운다(레터박스 없음).
    vf = `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[bc0]`;
  } else if (bgMode === "solid") {
    const colorHex = `0x${solidColor.slice(1)}`;
    vf =
      `color=c=${colorHex}:s=${W}x${H}:d=${(bodyDur / speed).toFixed(3)}[bbg];` +
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[bfg];` +
      `[bbg][bfg]overlay=(W-w)/2:(H-h)/2:shortest=1[bc0]`;
  } else {
    vf =
      `[1:v]split=2[ba0][bb0];` +
      `[ba0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bbg];` +
      `[bb0]scale=${W}:${H}:force_original_aspect_ratio=decrease[bfg];` +
      `[bbg][bfg]overlay=(W-w)/2:(H-h)/2[bc0]`;
  }
  let last = "[bc0]";
  if (videoFilters) { vf += `;${last}${videoFilters}[bcg]`; last = "[bcg]"; }
  if (assPath) {
    const esc = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `;${last}ass='${esc}'[bca]`; last = "[bca]";
  }
  if (speed !== 1) { vf += `;${last}setpts=PTS/${speed}[bcs]`; last = "[bcs]"; }
  // 본문 fps/sar 정규화 (xfade 호환).
  vf += `;${last}fps=30,setsar=1[bodyv]`;

  // ── 프리롤(입력0) — punch-in 전체화면 커버 + 살짝 채도·대비 강조 (+훅 캡션 ASS) ──
  const preCapAss = pre.captionAssPath ? `,ass='${escapeAssPath(pre.captionAssPath)}'` : "";
  vf +=
    `;[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `eq=saturation=1.20:contrast=1.05${preCapAss},fps=30,setsar=1[prev]`;

  // ── xfade: 프리롤 → 본문 (offset = preDur - transition) ──
  const xfadeOffset = Math.max(0, preDur - HOOK_XFADE_SEC).toFixed(3);
  vf += `;[prev][bodyv]xfade=transition=fade:duration=${HOOK_XFADE_SEC}:offset=${xfadeOffset}[v]`;

  const withAudio = pre.hasAudio === true;
  // 훅 내레이션(TTS) — 프리롤 원음을 덕킹하고 그 위에 얹는다. 원음을 죽이지 않는 이유는
  // 웃음·환호가 훅의 실체라서다. TTS 가 3초보다 길면 amix(duration=first)가 잘라낸다.
  const tts = withAudio && pre.ttsPath ? pre.ttsPath : null;
  if (withAudio) {
    // 본문 오디오에 volume/atempo(속도) 적용 후 · 프리롤 오디오와 크로스페이드.
    vf += `;[1:a]${audioFilter ? audioFilter : "anull"}[ba]`;
    if (tts) {
      vf += `;[2:a]volume=${HOOK_TTS_VOL},aresample=async=1,asplit=2[tk][tv]`
        + `;[tk]apad[tkp]`                       // ⚠️ 없으면 출력이 내레이션 길이로 잘린다
        + `;[0:a][tkp]${HOOK_DUCK}[pd]`
        + `;[pd][tv]amix=inputs=2:duration=first:dropout_transition=0[pa]`;
    } else {
      vf += `;[0:a]anull[pa]`;
    }
    vf += `;[pa][ba]acrossfade=d=${HOOK_XFADE_SEC}[a]`;
  }

  const args = [
    "-y",
    "-ss", String(preStart), "-to", String(preEnd), "-i", inputPath,
    "-ss", String(startTime), "-to", String(endTime), "-i", inputPath,
    ...(tts ? ["-i", tts] : []),
    "-filter_complex", vf,
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000, maxBuffer: FF_MAXBUF }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(outputPath)) return reject(new Error("Preroll render output not produced"));
      resolve();
    });
  });
}

function escapeAssPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function trackingValueAt(
  tracking: ReframeTrackingKeyframe[],
  axis: "cx" | "cy",
  absoluteTime: number,
): number {
  const pts = tracking
    .filter((k) => finite(k?.t) && finite(k?.[axis]))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return 0.5;
  if (absoluteTime <= pts[0].t) return clamp01(pts[0][axis]);
  if (absoluteTime >= pts[pts.length - 1].t) return clamp01(pts[pts.length - 1][axis]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (absoluteTime <= b.t) {
      const f = (absoluteTime - a.t) / Math.max(0.000001, b.t - a.t);
      return clamp01(a[axis] + (b[axis] - a[axis]) * f);
    }
  }
  return 0.5;
}

type DynamicBodyGraph = {
  graph: string;
  last: string;
  segments: NormalizedReframeSegment[];
};

/**
 * Build only the AI body video graph. Keeping this separate lets the hook-preroll path use
 * exactly the same beat cuts/crops/overlays instead of falling back to the legacy static body.
 */
function buildDynamicBodyGraph(
  opts: RenderShortOpts,
  sourceInput: number,
  templateInput: number | null,
  badgeInput: number | null,
  prefix: string,
): DynamicBodyGraph {
  const W = opts.width, H = opts.height;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const segments = normalizeReframeSegments(opts.reframePlan, opts.startTime, opts.endTime);
  const parts: string[] = [];
  const srcLabels = segments.map((_, i) => `[${prefix}src${i}]`).join("");
  if (segments.length === 1) parts.push(`[${sourceInput}:v]setpts=PTS-STARTPTS,null${srcLabels}`);
  else parts.push(`[${sourceInput}:v]setpts=PTS-STARTPTS,split=${segments.length}${srcLabels}`);

  const fr = opts.frame;
  const fitCount = segments.filter((s) => s.layout === "fit").length;
  const tplUseCount = fr && templateInput != null ? fitCount * fr.overlayRegions.length : 0;
  const tplLabels = Array.from({ length: tplUseCount }, (_, i) => `[${prefix}tpl${i}]`);
  if (tplUseCount === 1) parts.push(`[${templateInput}:v]null${tplLabels[0]}`);
  else if (tplUseCount > 1) parts.push(`[${templateInput}:v]split=${tplUseCount}${tplLabels.join("")}`);
  let tplUse = 0;

  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");

  segments.forEach((segment, i) => {
    const relStart = segment.start - opts.startTime;
    const relEnd = segment.end - opts.startTime;
    const dur = relEnd - relStart;
    const src = `[${prefix}src${i}]`;
    let cur: string;

    if (segment.layout === "fill") {
      const cx = trackingAxisExpression(segment.tracking, "cx", segment.start);
      const cy = trackingAxisExpression(segment.tracking, "cy", segment.start);
      // After `increase`, iw/ih are the scaled source dimensions. Mapping normalized source
      // centres through those dimensions is equivalent because scale preserves aspect ratio.
      const x = `max(0,min(iw-ow,(${cx})*iw-ow/2))`;
      const y = `max(0,min(ih-oh,(${cy})*ih-oh/2))`;
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:x='${x}':y='${y}'[${prefix}raw${i}]`,
      );
      cur = `${prefix}raw${i}`;
    } else if (fr) {
      const v = fr.video;
      // AI `fit` has a product-level meaning: preserve the entire 16:9 source. A template's
      // legacy static slot may say cover (broadcast-drama), but carrying that into this mode
      // would turn a low-score safety fallback into another crop.
      const fit = `scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease,` +
        `pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2:black`;
      parts.push(`color=c=black:s=${W}x${H}:d=${ffNum(dur)}[${prefix}base${i}]`);
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,${fit},setsar=1[${prefix}fg${i}]`,
      );
      parts.push(`[${prefix}base${i}][${prefix}fg${i}]overlay=${v.x}:${v.y}:shortest=1[${prefix}comp${i}]`);
      cur = `${prefix}comp${i}`;
      const boxes = (over: boolean) => fr.bands.filter((b) => !!b.over === over)
        .map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color ?? "black"}:t=fill`)
        .join(",");
      const under = boxes(false);
      if (under) {
        parts.push(`[${cur}]${under}[${prefix}under${i}]`);
        cur = `${prefix}under${i}`;
      }
      fr.overlayRegions.forEach((r, ri) => {
        const tpl = tplLabels[tplUse++];
        parts.push(`${tpl}crop=${r.w}:${r.h}:${r.x}:${r.y}[${prefix}frg${i}_${ri}]`);
        parts.push(
          `[${cur}][${prefix}frg${i}_${ri}]overlay=${r.x}:${r.y}:eof_action=repeat:repeatlast=1[${prefix}fov${i}_${ri}]`,
        );
        cur = `${prefix}fov${i}_${ri}`;
      });
      const over = boxes(true);
      if (over) {
        parts.push(`[${cur}]${over}[${prefix}over${i}]`);
        cur = `${prefix}over${i}`;
      }
    } else if (bgMode === "solid") {
      const colorHex = `0x${solidColor.slice(1)}`;
      parts.push(`color=c=${colorHex}:s=${W}x${H}:d=${ffNum(dur)}[${prefix}bg${i}]`);
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease[${prefix}fg${i}]`,
      );
      parts.push(
        `[${prefix}bg${i}][${prefix}fg${i}]overlay=(W-w)/2:(H-h)/2:shortest=1[${prefix}solid${i}]`,
      );
      cur = `${prefix}solid${i}`;
    } else {
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,split=2` +
        `[${prefix}ba${i}][${prefix}bb${i}]`,
      );
      parts.push(
        `[${prefix}ba${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},boxblur=20:1[${prefix}bg${i}]`,
      );
      parts.push(
        `[${prefix}bb${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[${prefix}fg${i}]`,
      );
      parts.push(`[${prefix}bg${i}][${prefix}fg${i}]overlay=(W-w)/2:(H-h)/2[${prefix}blur${i}]`);
      cur = `${prefix}blur${i}`;
    }
    parts.push(`[${cur}]fps=30,format=yuv420p,setsar=1[${prefix}seg${i}]`);
  });

  if (segments.length === 1) parts.push(`[${prefix}seg0]null[${prefix}base]`);
  else {
    const labels = segments.map((_, i) => `[${prefix}seg${i}]`).join("");
    parts.push(`${labels}concat=n=${segments.length}:v=1:a=0[${prefix}base]`);
  }
  let last = `[${prefix}base]`;
  if (opts.videoFilters) {
    parts.push(`${last}${opts.videoFilters}[${prefix}grade]`);
    last = `[${prefix}grade]`;
  }
  // Decorations first, captions last, matching the former single ASS event order while
  // allowing decorations to be absent during fill beats.
  const assLayers = [opts.decorationAssPath, opts.assPath, opts.captionAssPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  assLayers.forEach((p, i) => {
    parts.push(`${last}ass='${escapeAssPath(p)}'[${prefix}ass${i}]`);
    last = `[${prefix}ass${i}]`;
  });

  const fitIntervals = segments.filter((s) => s.layout === "fit")
    .map((s) => ({ start: s.start - opts.startTime, end: s.end - opts.startTime }));
  if (opts.badge && badgeInput != null && fitIntervals.length) {
    const enable = fitIntervals
      .map((x) => `gte(t,${ffNum(x.start)})*lt(t,${ffNum(x.end)})`)
      .join("+");
    parts.push(`[${badgeInput}:v]scale=-1:${opts.badge.h}[${prefix}badge]`);
    parts.push(
      `${last}[${prefix}badge]overlay=${badgeX(opts.badge)}:${opts.badge.y}:enable='${enable}'[${prefix}badged]`,
    );
    last = `[${prefix}badged]`;
  }
  if (speed !== 1) {
    parts.push(`${last}setpts=PTS/${speed}[${prefix}speed]`);
    last = `[${prefix}speed]`;
  }
  return { graph: parts.join(";"), last, segments };
}

function dynamicInputArgs(opts: RenderShortOpts, startTime: number, endTime?: number): string[] {
  return [
    "-ss", String(startTime),
    ...(endTime != null ? ["-t", String(Math.max(0, endTime - startTime))] : []),
    "-i", opts.inputPath,
  ];
}

/** AI beat renderer without a hook preroll. */
function renderDynamicShort(opts: RenderShortOpts): Promise<void> {
  const duration = opts.endTime - opts.startTime;
  if (duration <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const frameIndex = opts.frame ? 1 : null;
  const badgeIndex = opts.badge ? (opts.frame ? 2 : 1) : null;
  const body = buildDynamicBodyGraph(opts, 0, frameIndex, badgeIndex, "rf");
  const args = [
    "-y",
    ...dynamicInputArgs(opts, opts.startTime),
    ...(opts.frame ? ["-i", opts.frame.overlayPath] : []),
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    "-t", String(duration / speed),
    "-filter_complex", body.graph,
    "-map", body.last,
    "-map", "0:a?",
    ...(opts.audioFilter ? ["-af", opts.audioFilter] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    opts.outputPath,
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000, maxBuffer: FF_MAXBUF }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(opts.outputPath)) return reject(new Error("AI reframe output not produced"));
      resolve();
    });
  });
}

/** AI beat renderer with the legacy hook clip prepended to the exact same dynamic body. */
function renderDynamicShortWithPreroll(
  opts: RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> },
): Promise<void> {
  const bodyDur = opts.endTime - opts.startTime;
  if (bodyDur <= 0) return Promise.reject(new Error("Invalid render duration"));
  const pre = opts.hookPreroll;
  const preDur = Math.max(0.5, pre.durationSec);
  const preStart = Math.max(0, pre.startTime);
  const preEnd = preStart + preDur;
  const frameIndex = opts.frame ? 2 : null;
  const badgeIndex = opts.badge ? (opts.frame ? 3 : 2) : null;
  const body = buildDynamicBodyGraph(opts, 1, frameIndex, badgeIndex, "rfb");
  const focusSeg = body.segments.find((s) => preStart >= s.start && preStart < s.end)
    ?? body.segments.find((s) => s.tracking.length > 0);
  const cx = focusSeg ? trackingValueAt(focusSeg.tracking, "cx", preStart) : 0.5;
  const cy = focusSeg ? trackingValueAt(focusSeg.tracking, "cy", preStart) : 0.5;
  const x = `max(0,min(iw-ow,${ffNum(cx)}*iw-ow/2))`;
  const y = `max(0,min(ih-oh,${ffNum(cy)}*ih-oh/2))`;
  const parts = [body.graph];
  const preCapAss = pre.captionAssPath ? `,ass='${escapeAssPath(pre.captionAssPath)}'` : "";
  parts.push(
    `[0:v]setpts=PTS-STARTPTS,scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,` +
    `crop=${opts.width}:${opts.height}:x='${x}':y='${y}',` +
    `eq=saturation=1.20:contrast=1.05${preCapAss},fps=30,setsar=1[rfpre]`,
  );
  parts.push(`${body.last}fps=30,setsar=1[rfbody]`);
  const xfadeOffset = Math.max(0, preDur - HOOK_XFADE_SEC);
  parts.push(
    `[rfpre][rfbody]xfade=transition=fade:duration=${HOOK_XFADE_SEC}:offset=${ffNum(xfadeOffset)}[v]`,
  );
  if (pre.hasAudio === true) {
    parts.push(`[1:a]${opts.audioFilter || "anull"}[rfa_body]`);
    parts.push(`[0:a]anull[rfa_pre]`);
    parts.push(`[rfa_pre][rfa_body]acrossfade=d=${HOOK_XFADE_SEC}[a]`);
  }
  const args = [
    "-y",
    ...dynamicInputArgs(opts, preStart, preEnd),
    ...dynamicInputArgs(opts, opts.startTime, opts.endTime),
    ...(opts.frame ? ["-i", opts.frame.overlayPath] : []),
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    "-filter_complex", parts.join(";"),
    "-map", "[v]",
    ...(pre.hasAudio === true ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    opts.outputPath,
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000, maxBuffer: FF_MAXBUF }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(opts.outputPath)) return reject(new Error("AI reframe preroll output not produced"));
      resolve();
    });
  });
}

/**
 * Render construct F (plan §2.4 — the single expensive render). Reframes the trimmed
 * segment to the target aspect with a blurred-cover background + centered fit foreground
 * (scale+boxblur+overlay filtergraph), then burns the ASS overlay via libass. One ffmpeg
 * pass. `inputPath` may be a local path or an https signed URL (range-seek via -ss).
 */
export function renderShort(opts: RenderShortOpts): Promise<void> {
  const dynamic = normalizeReframeSegments(opts.reframePlan, opts.startTime, opts.endTime).length > 0;
  if (dynamic) {
    return opts.hookPreroll && opts.hookPreroll.durationSec > 0
      ? renderDynamicShortWithPreroll(opts as RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> })
      : renderDynamicShort(opts);
  }
  // 첫 3초 hook 프리롤이 요청되면 · 2입력 xfade 경로로 분기(본문 처리 로직은 renderShortWithPreroll
  // 안에서 동일하게 재현). 아래 단일 입력 경로는 프리롤 없을 때 그대로 유지(무회귀).
  if (opts.hookPreroll && opts.hookPreroll.durationSec > 0) {
    return renderShortWithPreroll(opts as RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> });
  }
  const { inputPath, startTime, endTime, outputPath, width: W, height: H, assPath, videoFilters, audioFilter } = opts;
  const duration = endTime - startTime;
  if (duration <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  // Sped-up video is shorter (duration/speed); the output -t must match or slow-mo would be
  // truncated back to the source length.
  const outDur = duration / speed;

  // 배경 채우기 방식 결정 — blur(기본): 원본 확대 블러 커버 · solid: 단색 letterbox.
  // image는 아직 solid로 폴백(파일 준비 파이프라인 없음). 프리뷰가 3종 모두 표시하므로
  // 렌더가 solid만 되도 최소한 프리뷰↔렌더 일관성이 solid·blur 두 경로에서 성립.
  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");
  let vf: string;
  const fr = opts.frame;
  if (fr) {
    // 프레임 경로. drawbox 는 필터 인자 순서가 x,y,w,h 라 meta.json 을 그대로 옮기면 된다.
    const boxes = (over: boolean) =>
      fr.bands.filter((b) => !!b.over === over)
        .map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color ?? "black"}:t=fill`)
        .join(",");
    const v = fr.video;
    const fit = v.fit === "contain"
      ? `scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease,pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2:black`
      : `scale=${v.w}:${v.h}:force_original_aspect_ratio=increase,crop=${v.w}:${v.h}`;
    // ⚠️ color 에 d= 를 빼면 무한 입력이라 인코딩이 안 끝난다.
    vf = `color=c=black:s=${W}x${H}:d=${outDur.toFixed(3)}[base];` +
         `[0:v]${fit},setsar=1[fgv];` +
         `[base][fgv]overlay=${v.x}:${v.y}:shortest=1[comp0]`;
    const under = boxes(false);
    vf += under ? `;[comp0]${under}[comp1]` : `;[comp0]copy[comp1]`;
    let cur = "comp1";
    fr.overlayRegions.forEach((r, i) => {
      vf += `;[1:v]crop=${r.w}:${r.h}:${r.x}:${r.y}[frg${i}]`;
      vf += `;[${cur}][frg${i}]overlay=${r.x}:${r.y}[fov${i}]`;
      cur = `fov${i}`;
    });
    const overBoxes = boxes(true);
    vf += overBoxes ? `;[${cur}]${overBoxes}[v0]` : `;[${cur}]copy[v0]`;
  } else if (opts.cropRect) {
    // 세로 밴드 크롭(9:16-crop-main/sub) — 소스를 사각형 비율로 중앙 크롭 → 사각형 크기로 스케일
    // → 캔버스 위 (x,y) 에 검정 pad. 나머지 밴드(위/아래)가 캡션·브랜딩 자리가 된다.
    // AENA aspect-presets 수식 그대로: crop=ih*vW/vH:ih,scale=vw:vh,pad=W:H:vx:vy (pad 기본 검정).
    const r = opts.cropRect;
    vf = `[0:v]crop=ih*${r.w}/${r.h}:ih,scale=${r.w}:${r.h},pad=${W}:${H}:${r.x}:${r.y}[v0]`;
  } else if (opts.fit === "cover") {
    // 축2 "채우기": 프레임 없이 원본을 잘라 컨테이너를 꽉 채운다(레터박스·배경 없음).
    // increase 로 키워 넘치는 부분을 crop. bgType 은 여백이 없으므로 무의미.
    vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v0]`;
  } else if (bgMode === "solid") {
    // 축2 "맞춤"(레터박스) + 검정/단색 여백. fit-to-frame foreground 를 단색 캔버스에 오버레이.
    // color 필터는 지속 프레임 만들고, -shortest 없이 -t로 컷하므로 무한 스트림도 안전.
    const colorHex = `0x${solidColor.slice(1)}`;
    vf =
      `color=c=${colorHex}:s=${W}x${H}:d=${outDur.toFixed(3)}[bg];` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v0]`;
  } else {
    // 축2 "맞춤"(레터박스) + 원본 블러 여백. 전경은 decrease(맞춤), 뒤는 같은 영상의 크롭·블러.
    vf =
      `split=2[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`;
  }
  let last = "[v0]";
  // Colour grade the composited frame BEFORE the ASS burn, so titles/captions stay crisp
  // and are not tinted by the operator's brightness/contrast/warmth adjustments.
  if (videoFilters) {
    vf += `;${last}${videoFilters}[vg]`;
    last = "[vg]";
  }
  // 정적 오버레이 PNG(제목·채널 텍스트) — 그레이드 뒤·ASS 앞에 전체프레임 합성(overlay=0:0).
  // 이미지 입력은 마지막 -i 라 인덱스는 (소스0 + frame? + badge?) 다음. 1프레임이라
  // overlay 기본 eof_action=repeat 로 전체 길이에 유지된다. 그레이드 뒤라 자막처럼 안 물든다.
  if (opts.overlayPngPath) {
    const ovi = 1 + (fr ? 1 : 0) + (opts.badge ? 1 : 0);
    vf += `;${last}[${ovi}:v]overlay=0:0[vovl]`;
    last = "[vovl]";
  }
  if (assPath) {
    // Escape the path for the filtergraph (backslash, colon, single-quote).
    const esc = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `;${last}ass='${esc}'[vout]`;
    last = "[vout]";
  }
  // 브랜딩 아이콘 — ASS 뒤에 얹는다(자막·타이틀과 같은 레이어 감각). 이미지 입력은 1프레임이라
  // overlay 기본 eof_action=repeat 로 전체 길이에 유지된다.
  if (opts.badge) {
    const bi = 1 + (fr ? 1 : 0);
    vf += `;[${bi}:v]scale=-1:${opts.badge.h}[bdg]` +
          `;${last}[bdg]overlay=${badgeX(opts.badge)}:${opts.badge.y}[vbdg]`;
    last = "[vbdg]";
  }
  // Speed LAST — after the burn, so the captions/overlays already baked into the frames
  // speed up in lockstep and never desync.
  if (speed !== 1) {
    vf += `;${last}setpts=PTS/${speed}[vspd]`;
    last = "[vspd]";
  }

  const args = [
    "-y",
    "-ss", String(startTime),
    "-i", inputPath,
    // 프레임 PNG 는 입력 1번 — filtergraph 의 [1:v] 와 짝이 맞아야 한다.
    ...(fr ? ["-i", fr.overlayPath] : []),
    // 브랜딩 아이콘은 그다음 입력 (fr 유무에 따라 [1:v] 또는 [2:v]).
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    // 정적 오버레이 PNG 는 **마지막** 입력 — ovi 계산(위)이 이 순서에 의존한다.
    ...(opts.overlayPngPath ? ["-i", opts.overlayPngPath] : []),
    "-t", String(outDur),
    "-filter_complex", vf,
    "-map", last,
    "-map", "0:a?",
    ...(audioFilter ? ["-af", audioFilter] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000, maxBuffer: FF_MAXBUF }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(outputPath)) return reject(new Error("Render output not produced"));
      resolve();
    });
  });
}

export function trimEncode(
  inputPath: string,
  startTime: number,
  endTime: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    if (duration <= 0) {
      return reject(new Error("Invalid trim duration"));
    }
    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss", String(startTime),
        "-i", inputPath,
        "-t", String(duration),
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outputPath,
      ],
      { timeout: 120_000, maxBuffer: FF_MAXBUF },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) {
          return reject(new Error("Trim output not produced"));
        }
        resolve();
      }
    );
  });
}
