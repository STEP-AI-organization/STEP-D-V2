/**
 * STEP D Core — Node.js Bridge
 *
 * Calls the Python core pipeline from the Hono backend via child_process.
 * Runs `python -m core.pipeline` with the interpreter that has faster-whisper +
 * CUDA installed — core/.venv310 by default, override with the CORE_PYTHON env var.
 *
 * Usage:
 *   import { runPipeline } from '../../core/bridge.js';
 *   const result = await runPipeline('/path/to/video.mp4', { language: 'ko' });
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// pipeline.py uses package-relative imports (from .asr import ...), so it must be run
// as `python -m core.pipeline` from the repo root — NOT as a bare script. The
// interpreter must be the one that actually has torch/faster-whisper installed:
// core/.venv310 (Python 3.10). Override with CORE_PYTHON if it lives elsewhere.
const PYTHON_BIN =
  process.env.CORE_PYTHON ||
  path.join(__dirname, '.venv310', 'Scripts', 'python.exe');

interface PipelineOptions {
  language?: string;      // 'ko', 'en', 'ja', etc.
  model?: string;         // 'large-v3' (default)
  device?: 'cuda' | 'cpu';
  topN?: number;          // Number of recommendations (default: 5)
  minDuration?: number;   // Minimum clip duration in seconds
  maxDuration?: number;   // Maximum clip duration in seconds
  maxGap?: number;        // Maximum silence gap within clip
}

interface ClipRecommendation {
  start: number;
  end: number;
  duration: number;
  text: string;
  score: number;
}

interface PipelineResult {
  video: string;
  duration: number;
  language: string;
  total_segments: number;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    words: Array<{ word: string; start: number; end: number; probability: number }>;
  }>;
  candidates: Array<ClipRecommendation & { hook_score: number; climax_score: number; resolution_score: number }>;
  recommendations: ClipRecommendation[];
}

export async function runPipeline(
  videoPath: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const args: string[] = [
    '-u',                          // Unbuffered — stream progress promptly
    '-m', 'core.pipeline',         // Run as a module so relative imports resolve
    videoPath,
  ];

  if (options.language) args.push('--lang', options.language);
  if (options.device === 'cpu') args.push('--cpu');

  // Pass additional options via environment variables (pipeline.py reads these).
  const env: Record<string, string> = {};
  if (options.topN !== undefined) env.STEPD_TOP_N = String(options.topN);
  if (options.minDuration !== undefined) env.STEPD_MIN_DURATION = String(options.minDuration);
  if (options.maxDuration !== undefined) env.STEPD_MAX_DURATION = String(options.maxDuration);
  if (options.maxGap !== undefined) env.STEPD_MAX_GAP = String(options.maxGap);

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, {
      cwd: REPO_ROOT,                // -m core.pipeline resolves the package from here
      // Clear PYTHONPATH so a stray site-packages (e.g. the Hermes agent's PIL) can't
      // shadow the venv; force UTF-8 so emoji prints never crash the child.
      env: { ...process.env, ...env, PYTHONPATH: '', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Pipeline exited with code ${code}\n${stderr}`));
        return;
      }

      // Read output JSON from file (more reliable than stdout). pipeline.py resolves
      // the video path against its cwd (REPO_ROOT) and writes the JSON next to it, so
      // resolve the same way here — otherwise a relative videoPath diverges.
      const outputPath = path.join(
        path.dirname(path.resolve(REPO_ROOT, videoPath)),
        'pipeline_output.json',
      );
      import('fs').then((fs) => {
        try {
          const result = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });

    proc.on('error', reject);
  });
}

/**
 * Quick wrapper: transcribe only (no segmentation).
 * Returns raw WhisperX segments.
 */
export async function transcribeOnly(
  videoPath: string,
  language: string = 'ko',
): Promise<Array<{ start: number; end: number; text: string }>> {
  const result = await runPipeline(videoPath, {
    language,
    topN: 0,      // Skip scoring
    minDuration: 0,
    maxDuration: 99999,
  });
  return result.segments;
}