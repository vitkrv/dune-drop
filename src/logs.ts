export interface LogState {
  text: string;
  replaceCurrentLine: boolean;
}

export const EMPTY_LOG_STATE: LogState = {
  text: "",
  replaceCurrentLine: false,
};

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function removeCurrentLine(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  return text.slice(0, lastNewline + 1);
}

export function appendTerminalLogChunk(state: LogState, chunk: string): LogState {
  let text = state.text;
  let replaceCurrentLine = state.replaceCurrentLine;
  const normalizedChunk = stripAnsi(chunk).replace(/\r\n/g, "\n");

  for (const character of normalizedChunk) {
    if (character === "\r") {
      replaceCurrentLine = true;
      continue;
    }

    if (character === "\n") {
      text += character;
      replaceCurrentLine = false;
      continue;
    }

    if (character === "\b") {
      if (replaceCurrentLine) {
        text = removeCurrentLine(text);
        replaceCurrentLine = false;
      }
      if (text.length && !text.endsWith("\n")) text = text.slice(0, -1);
      continue;
    }

    if (replaceCurrentLine) {
      text = removeCurrentLine(text);
      replaceCurrentLine = false;
    }
    text += character;
  }

  return { text, replaceCurrentLine };
}
