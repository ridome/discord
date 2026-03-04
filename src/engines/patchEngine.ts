import fs from "fs";
import os from "os";
import path from "path";
import { PatchValidationResult } from "../types";
import { runCommand } from "../utils/process";

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i
];

function isPathUnsafe(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (path.isAbsolute(filePath) || /^[A-Za-z]:\//.test(normalized)) {
    return `Absolute path forbidden: ${filePath}`;
  }
  if (normalized.includes("../")) {
    return `Path traversal forbidden: ${filePath}`;
  }
  if (normalized.startsWith(".git/")) {
    return `Modifying .git forbidden: ${filePath}`;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      return `Sensitive file forbidden: ${filePath}`;
    }
  }
  return null;
}

function extractChangedFiles(patch: string): string[] {
  const files = new Set<string>();
  const diffRegex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = diffRegex.exec(patch)) !== null) {
    files.add(match[1]);
    files.add(match[2]);
  }

  if (files.size === 0) {
    const markerRegex = /^(---|\+\+\+)\s+[ab]\/(.+)$/gm;
    while ((match = markerRegex.exec(patch)) !== null) {
      files.add(match[2]);
    }
  }

  return Array.from(files).filter((f) => f !== "/dev/null");
}

function lineStats(patch: string): { addedLines: number; deletedLines: number } {
  let added = 0;
  let deleted = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      deleted += 1;
    }
  }

  return { addedLines: added, deletedLines: deleted };
}

function hasUnifiedDiffMarkers(patch: string): boolean {
  return patch.includes("--- ") && patch.includes("+++ ") && patch.includes("@@");
}

export class PatchEngine {
  public async validateAndPrecheck(
    repoPath: string,
    patch: string,
    maxFiles = 40,
    maxTotalLines = 3000
  ): Promise<PatchValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!hasUnifiedDiffMarkers(patch)) {
      errors.push("Patch does not look like a unified diff.");
    }

    const changedFiles = extractChangedFiles(patch);
    const firstChangedFile = changedFiles[0] ?? null;

    if (changedFiles.length === 0) {
      errors.push("No changed files detected in patch.");
    }

    if (changedFiles.length > maxFiles) {
      errors.push(`Patch changes too many files: ${changedFiles.length} > ${maxFiles}.`);
    }

    for (const file of changedFiles) {
      const issue = isPathUnsafe(file);
      if (issue) {
        errors.push(issue);
      }
    }

    const stats = lineStats(patch);
    if (stats.addedLines + stats.deletedLines > maxTotalLines) {
      errors.push(
        `Patch changes too many lines: ${stats.addedLines + stats.deletedLines} > ${maxTotalLines}.`
      );
    }

    const tmpFile = path.join(os.tmpdir(), `codex-patch-${Date.now()}.diff`);
    fs.writeFileSync(tmpFile, patch, "utf8");
    try {
      const check = await runCommand(
        "git",
        ["apply", "--check", "--whitespace=nowarn", tmpFile],
        repoPath
      );
      if (check.exitCode !== 0) {
        errors.push(`git apply --check failed: ${check.stderr || check.stdout}`.trim());
      }
    } catch (err) {
      errors.push(`git apply --check failed to run: ${(err as Error).message}`);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      changedFiles,
      firstChangedFile,
      addedLines: stats.addedLines,
      deletedLines: stats.deletedLines
    };
  }
}