import { spawn } from "child_process";
import { RunCommandResult } from "../types";

export interface SpawnLineHandlers {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  handlers?: SpawnLineHandlers,
  timeoutMs = 300000
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let stderrRemainder = "";

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timeout: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const combined = stdoutRemainder + chunk.toString();
      const { lines, rest } = splitLines(combined);
      stdoutRemainder = rest;
      for (const line of lines) {
        handlers?.onStdoutLine?.(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      const combined = stderrRemainder + chunk.toString();
      const { lines, rest } = splitLines(combined);
      stderrRemainder = rest;
      for (const line of lines) {
        handlers?.onStderrLine?.(line);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (stdoutRemainder) {
        handlers?.onStdoutLine?.(stdoutRemainder);
      }
      if (stderrRemainder) {
        handlers?.onStderrLine?.(stderrRemainder);
      }
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr
      });
    });
  });
}

export async function runShell(
  commandText: string,
  cwd: string,
  handlers?: SpawnLineHandlers,
  timeoutMs = 300000
): Promise<RunCommandResult> {
  return runCommand(
    "pwsh.exe",
    ["-NoProfile", "-Command", commandText],
    cwd,
    handlers,
    timeoutMs
  );
}