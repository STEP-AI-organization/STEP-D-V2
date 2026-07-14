/**
 * ffmpeg/ffprobe wrapper — used in Cloud Run (ffmpeg baked into Docker image).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
};

export function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
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