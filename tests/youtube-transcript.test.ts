import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  YouTubeTranscriptClient,
  parseVtt,
} from "../src/providers/youtube-transcript";

const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<c>First sentence.</c>

00:00:01.500 --> 00:00:03.000
First sentence.

00:00:03.000 --> 00:00:05.000
Second &amp; final sentence.
`;

describe("YouTube transcript client", () => {
  it("parses VTT cues into normalized plain text", () => {
    expect(parseVtt(vtt)).toBe("First sentence.\n\nSecond & final sentence.");
  });

  it("retrieves a transcript without persisting media", async () => {
    let receivedArgs: string[] = [];
    const client = new YouTubeTranscriptClient({
      runProcess: async (args, cwd) => {
        receivedArgs = args;
        await writeFile(`${cwd}/video-1.en.vtt`, vtt);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const transcript = await client.retrieve("video-1");

    expect(transcript).toMatchObject({
      videoId: "video-1",
      language: "en",
      status: "available",
      reason: null,
    });
    expect(transcript.content?.text).toBe(
      "First sentence.\n\nSecond & final sentence.",
    );
    expect(receivedArgs).toContain("--write-auto-subs");
    expect(receivedArgs).toContain("--skip-download");
    expect(receivedArgs).toContain("https://www.youtube.com/watch?v=video-1");
    expect(receivedArgs).not.toContain("--audio-format");
  });

  it("returns explicit missing and failed states", async () => {
    const missing = new YouTubeTranscriptClient({
      runProcess: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    await expect(missing.retrieve("video-1")).resolves.toMatchObject({
      status: "missing",
      reason: "transcript_unavailable",
    });

    const failed = new YouTubeTranscriptClient({
      runProcess: async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 429" }),
    });
    await expect(failed.retrieve("video-1")).resolves.toMatchObject({
      status: "failed",
      reason: "transcript_provider_error:HTTP 429",
    });
  });

  it("marks provider output with an error as partial when captions exist", async () => {
    const client = new YouTubeTranscriptClient({
      runProcess: async (_args, cwd) => {
        await writeFile(`${cwd}/video-1.en.vtt`, vtt);
        return { exitCode: 1, stdout: "", stderr: "connection closed" };
      },
    });

    await expect(client.retrieve("video-1")).resolves.toMatchObject({
      status: "partial",
      reason: "transcript_provider_partial",
    });
  });
});
