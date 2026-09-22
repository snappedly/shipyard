import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import {
  BoundedTail,
  MAX_TAIL_CHARS,
  OutputByteCounter,
} from "./boundedTail.js";

export interface ProcessOutputResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ProcessOutputOptions {
  readonly onLine?: (line: string) => void;
  readonly maxOutputBytes?: number;
  readonly maxOutputTailChars?: number;
}

export class StreamedProcessOutput {
  private readonly maxOutputBytes: number | undefined;
  private readonly byteCounter: OutputByteCounter | undefined;
  private readonly stdoutTail: BoundedTail;
  private readonly stderrTail: BoundedTail;
  private readonly onLine: (line: string) => void;
  private outputLimitError: Error | undefined;

  constructor(options: ProcessOutputOptions) {
    this.maxOutputBytes = options.maxOutputBytes;
    this.byteCounter =
      options.maxOutputBytes === undefined
        ? undefined
        : new OutputByteCounter(options.maxOutputBytes);
    const tailChars =
      options.maxOutputBytes ?? options.maxOutputTailChars ?? MAX_TAIL_CHARS;
    this.stdoutTail = new BoundedTail(tailChars, "\n");
    this.stderrTail = new BoundedTail(tailChars, "");
    this.onLine = options.onLine ?? (() => {});
  }

  checkLimit(chunk: string | Uint8Array): Error | undefined {
    if (this.byteCounter === undefined || this.outputLimitError !== undefined) {
      return this.outputLimitError;
    }
    this.byteCounter.add(chunk);
    if (this.byteCounter.exceeded) {
      this.outputLimitError = new Error(
        `Sandbox command output exceeded ${this.maxOutputBytes} bytes`,
      );
    }
    return this.outputLimitError;
  }

  addStdoutLine(line: string): void {
    this.stdoutTail.push(line);
    this.onLine(line);
  }

  addStderr(chunk: string): void {
    this.stderrTail.push(chunk);
  }

  get error(): Error | undefined {
    return this.outputLimitError;
  }

  result(exitCode: number): ProcessOutputResult {
    return {
      stdout: this.stdoutTail.toString(),
      stderr: this.stderrTail.toString(),
      exitCode,
    };
  }
}

export const collectProcessOutput = (
  process: {
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly kill: () => void;
    readonly onClose: (listener: (code: number | null) => void) => void;
  },
  options: ProcessOutputOptions,
  resolve: (result: ProcessOutputResult) => void,
  reject: (error: Error) => void,
): void => {
  if (options.onLine || options.maxOutputBytes !== undefined) {
    const output = new StreamedProcessOutput(options);
    const checkLimit = (chunk: Buffer): void => {
      if (output.checkLimit(chunk) !== undefined) process.kill();
    };
    process.stdout.on("data", checkLimit);
    process.stderr.on("data", checkLimit);
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => output.addStdoutLine(line));
    process.stderr.on("data", (chunk: Buffer) => {
      output.addStderr(chunk.toString());
    });
    process.onClose((code) => {
      if (output.error !== undefined) {
        reject(output.error);
        return;
      }
      resolve(output.result(code ?? 0));
    });
    return;
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  process.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString());
  });
  process.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });
  process.onClose((code) => {
    resolve({
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode: code ?? 0,
    });
  });
};
