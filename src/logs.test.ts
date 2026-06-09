import { describe, expect, it } from "vitest";
import { appendTerminalLogChunk, EMPTY_LOG_STATE, LogState } from "./logs";

function appendChunks(chunks: string[]): LogState {
  return chunks.reduce((state, chunk) => appendTerminalLogChunk(state, chunk), EMPTY_LOG_STATE);
}

describe("appendTerminalLogChunk", () => {
  it("replaces carriage-return progress lines", () => {
    expect(appendChunks(["[download] 1%", "\r[download] 2%", "\r[download] 3%"]).text).toBe("[download] 3%");
  });

  it("keeps the visible line when a chunk ends with a carriage return", () => {
    const state = appendTerminalLogChunk(EMPTY_LOG_STATE, "[download] 1%\r");
    expect(state.text).toBe("[download] 1%");
    expect(appendTerminalLogChunk(state, "[download] 2%\r").text).toBe("[download] 2%");
  });

  it("preserves normal completed log lines", () => {
    expect(appendChunks(["Destination: video.mp4\n", "[download] 1%\r", "[download] 100%\n"]).text).toBe(
      "Destination: video.mp4\n[download] 100%\n",
    );
  });
});
