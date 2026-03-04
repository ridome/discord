import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { RepoRegistry } from "../src/security/repoRegistry";

describe("RepoRegistry", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-registry-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws when repo path does not exist", () => {
    const registry = new RepoRegistry([
      {
        id: "sample",
        path: path.join(tempDir, "missing"),
        defaultBaseBranch: "main",
        testProfiles: {}
      }
    ]);

    expect(() => registry.get("sample")).toThrow(/Repo path not found/);
  });

  it("throws when repo path is not a git repository", () => {
    const repoPath = path.join(tempDir, "plain-dir");
    fs.mkdirSync(repoPath, { recursive: true });

    const registry = new RepoRegistry([
      {
        id: "sample",
        path: repoPath,
        defaultBaseBranch: "main",
        testProfiles: {}
      }
    ]);

    expect(() => registry.get("sample")).toThrow(/not a git repository/);
  });

  it("returns repo when path is valid git repository", () => {
    const repoPath = path.join(tempDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath, stdio: "ignore" });

    const registry = new RepoRegistry([
      {
        id: "sample",
        path: repoPath,
        defaultBaseBranch: "main",
        testProfiles: {}
      }
    ]);

    const repo = registry.get("sample");
    expect(repo.path).toBe(repoPath);
  });

  it("supports local path repo when enabled", () => {
    const repoPath = path.join(tempDir, "local-repo");
    fs.mkdirSync(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath, stdio: "ignore" });

    const registry = new RepoRegistry([], {
      allowLocalPathRepo: true
    });

    const repo = registry.get(repoPath);
    expect(repo.path).toBe(repoPath);
    expect(repo.id).toMatch(/^local-/);
  });

  it("rejects local path repo when disabled", () => {
    const repoPath = path.join(tempDir, "local-repo-disabled");
    fs.mkdirSync(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath, stdio: "ignore" });

    const registry = new RepoRegistry([], {
      allowLocalPathRepo: false
    });

    expect(() => registry.get(repoPath)).toThrow(/Unknown repo id/);
  });
});
