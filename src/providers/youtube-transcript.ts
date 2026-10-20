import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeHtmlContent,
  type NormalizedContent,
} from "../pipeline/normalize";

export type TranscriptStatus = "available" | "missing" | "partial" | "failed";

export type YouTubeTranscript = {
  videoId: string;
  language: string | null;
  status: TranscriptStatus;
  content: NormalizedContent | null;
  reason: string | null;
};

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type YouTubeTranscriptOptions = {
  executable?: string;
  language?: string;
  timeoutMs?: number;
  runProcess?: (args: string[], cwd: string) => Promise<ProcessResult>;
};

const defaultExecutable = "yt-dlp";
const defaultLanguage = "en,en-US,en-GB";
const defaultTimeoutMs = 120_000;

export class YouTubeTranscriptError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "YouTubeTranscriptError";
    this.reason = reason;
  }
}

export class YouTubeTranscriptClient {
  private readonly executable: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly runProcess: (
    args: string[],
    cwd: string,
  ) => Promise<ProcessResult>;

  constructor(options: YouTubeTranscriptOptions = {}) {
    this.executable = options.executable ?? defaultExecutable;
    this.language = options.language ?? defaultLanguage;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.runProcess = options.runProcess ?? runYtDlp;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("YouTube transcript timeout must be a positive integer");
    }
  }

  async retrieve(videoId: string): Promise<YouTubeTranscript> {
    if (!/^[A-Za-z0-9_-]{6,20}$/u.test(videoId)) {
      throw new Error("YouTube video ID is invalid");
    }

    const workspace = await mkdtemp(join(tmpdir(), "aperture-youtube-"));
    try {
      const result = await withTimeout(
        this.runProcess(
          [
            this.executable,
            "--no-warnings",
            "--ignore-config",
            "--no-playlist",
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            this.language,
            "--sub-format",
            "vtt",
            "--output",
            "%(id)s.%(ext)s",
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          workspace,
        ),
        this.timeoutMs,
      );
      const transcriptFiles = (await readdir(workspace)).filter((file) =>
        /\.vtt$/iu.test(file),
      );

      if (transcriptFiles.length === 0) {
        if (result.exitCode !== 0) {
          return failedTranscript(videoId, result.stderr);
        }
        return {
          videoId,
          language: null,
          status: "missing",
          content: null,
          reason: "transcript_unavailable",
        };
      }

      const [file] = transcriptFiles.sort();
      if (!file) {
        return {
          videoId,
          language: null,
          status: "missing",
          content: null,
          reason: "transcript_unavailable",
        };
      }
      const rawTranscript = await readFile(join(workspace, file), "utf8");
      const text = parseVtt(rawTranscript);
      if (text.length === 0) {
        return {
          videoId,
          language: languageFromFilename(file),
          status: "missing",
          content: null,
          reason: "transcript_empty",
        };
      }

      const content = normalizeHtmlContent(text);
      return {
        videoId,
        language: languageFromFilename(file),
        status: result.exitCode === 0 ? "available" : "partial",
        content,
        reason: result.exitCode === 0 ? null : "transcript_provider_partial",
      };
    } catch (error) {
      if (error instanceof YouTubeTranscriptError) {
        return failedTranscript(videoId, error.message, error.reason);
      }
      return failedTranscript(
        videoId,
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export function parseVtt(value: string): string {
  const lines = value.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const cues: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const cue = current
      .join(" ")
      .replace(/<[^>]+>/gu, "")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
    if (cue.length > 0 && cues.at(-1) !== cue) cues.push(cue);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      /^WEBVTT(?:\s|$)/u.test(trimmed) ||
      /^NOTE(?:\s|$)/u.test(trimmed) ||
      /^STYLE(?:\s|$)/u.test(trimmed) ||
      /^REGION(?:\s|$)/u.test(trimmed) ||
      /^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+/u.test(trimmed) ||
      /^\d+$/.test(trimmed)
    ) {
      if (trimmed === "") flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();

  return cues.join("\n\n");
}

function languageFromFilename(filename: string): string | null {
  const match = filename.match(
    /\.([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)?)\.(?:vtt)$/u,
  );
  return match?.[1] ?? null;
}

function failedTranscript(
  videoId: string,
  message: string,
  reason = "transcript_provider_error",
): YouTubeTranscript {
  return {
    videoId,
    language: null,
    status: "failed",
    content: null,
    reason: `${reason}:${message.slice(0, 200)}`,
  };
}

async function runYtDlp(args: string[], cwd: string): Promise<ProcessResult> {
  const subprocess = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new YouTubeTranscriptError(
                "transcript_timeout",
                "yt-dlp timed out",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
