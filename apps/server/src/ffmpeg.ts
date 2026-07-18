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
};

export function hasFfmpeg(): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-version"], { timeout: 5000, encoding: "utf8", stdio: "pipe" });
    return out.includes("ffmpeg version");
  } catch {
    return false;
  }
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
          resolve({
            durationSec: parseFloat(format.duration ?? "0") || 0,
            width: videoStream?.width ?? 0,
            height: videoStream?.height ?? 0,
            codec: videoStream?.codec_name ?? "",
            hasAudio: !!audioStream,
          });
        } catch (e) {
          reject(new Error(`ffprobe parse error: ${e}`));
        }
      }
    );
  });
}

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
      { timeout: 30_000 },
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
      { timeout: 300_000 },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) return reject(new Error("remux output not produced"));
        resolve();
      },
    );
  });
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
};

/**
 * Render construct F (plan §2.4 — the single expensive render). Reframes the trimmed
 * segment to the target aspect with a blurred-cover background + centered fit foreground
 * (scale+boxblur+overlay filtergraph), then burns the ASS overlay via libass. One ffmpeg
 * pass. `inputPath` may be a local path or an https signed URL (range-seek via -ss).
 */
export function renderShort(opts: RenderShortOpts): Promise<void> {
  const { inputPath, startTime, endTime, outputPath, width: W, height: H, assPath, videoFilters, audioFilter } = opts;
  const duration = endTime - startTime;
  if (duration <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  // Sped-up video is shorter (duration/speed); the output -t must match or slow-mo would be
  // truncated back to the source length.
  const outDur = duration / speed;

  // Blurred cover behind a fit-to-frame foreground → 9:16 (or any target) with no letterbox.
  let vf =
    `split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`;
  let last = "[v0]";
  // Colour grade the composited frame BEFORE the ASS burn, so titles/captions stay crisp
  // and are not tinted by the operator's brightness/contrast/warmth adjustments.
  if (videoFilters) {
    vf += `;${last}${videoFilters}[vg]`;
    last = "[vg]";
  }
  if (assPath) {
    // Escape the path for the filtergraph (backslash, colon, single-quote).
    const esc = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `;${last}ass='${esc}'[vout]`;
    last = "[vout]";
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
    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
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
      { timeout: 120_000 },
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