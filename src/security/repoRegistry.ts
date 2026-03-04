import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { RepoConfig } from "../types";

export interface RepoRegistryOptions {
  allowLocalPathRepo?: boolean;
}

export class RepoRegistry {
  private readonly byId: Map<string, RepoConfig>;
  private readonly byPath: Map<string, string>;
  private readonly allowLocalPathRepo: boolean;

  constructor(repos: RepoConfig[], options: RepoRegistryOptions = {}) {
    this.byId = new Map(repos.map((r) => [r.id, r]));
    this.byPath = new Map(
      repos.map((repo) => [this.normalizePath(repo.path), repo.id])
    );
    this.allowLocalPathRepo = options.allowLocalPathRepo ?? false;
  }

  public get(repoId: string): RepoConfig {
    const configured = this.byId.get(repoId);
    if (configured) {
      this.assertValidRepo(configured.path, configured.id);
      return configured;
    }

    if (!this.allowLocalPathRepo || !this.looksLikePath(repoId)) {
      throw new Error(`Unknown repo id: ${repoId}`);
    }

    const resolvedPath = path.resolve(repoId);
    this.assertValidRepo(resolvedPath, repoId);

    const normalized = this.normalizePath(resolvedPath);
    const existingId = this.byPath.get(normalized);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) {
        return existing;
      }
    }

    const syntheticId = this.buildSyntheticRepoId(normalized);
    const localRepo: RepoConfig = {
      id: syntheticId,
      path: resolvedPath,
      defaultBaseBranch: this.detectCurrentBranch(resolvedPath),
      testProfiles: {}
    };

    this.byId.set(syntheticId, localRepo);
    this.byPath.set(normalized, syntheticId);
    return localRepo;
  }

  public list(): RepoConfig[] {
    return Array.from(this.byId.values());
  }

  private assertValidRepo(repoPath: string, repoLabel: string): void {
    if (!fs.existsSync(repoPath)) {
      throw new Error(
        `Repo path not found for '${repoLabel}': ${repoPath}. Update config/repos.json and restart bot.`
      );
    }

    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      throw new Error(`Repo path is not a directory for '${repoLabel}': ${repoPath}`);
    }

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      throw new Error(`Repo is not a git repository for '${repoLabel}': ${repoPath}`);
    }
  }

  private looksLikePath(value: string): boolean {
    return path.isAbsolute(value) || value.includes("\\") || value.includes("/") || value.startsWith(".");
  }

  private normalizePath(repoPath: string): string {
    return path.resolve(repoPath).replace(/\\/g, "/").toLowerCase();
  }

  private buildSyntheticRepoId(normalizedPath: string): string {
    let hash = 0;
    for (let i = 0; i < normalizedPath.length; i += 1) {
      hash = (hash * 31 + normalizedPath.charCodeAt(i)) >>> 0;
    }

    let candidate = `local-${hash.toString(16)}`;
    let suffix = 1;
    while (this.byId.has(candidate)) {
      candidate = `local-${hash.toString(16)}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private detectCurrentBranch(repoPath: string): string {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      windowsHide: true
    });

    if (result.status === 0) {
      const branch = String(result.stdout ?? "").trim();
      if (branch && branch !== "HEAD") {
        return branch;
      }
    }

    return "main";
  }
}
