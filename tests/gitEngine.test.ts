import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { GitEngine } from "../src/engines/gitEngine";

describe("GitEngine.ensureCleanWorktree", () => {
  let tempDir: string;
  let engine: GitEngine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-engine-test-"));
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello\n", "utf8");
    execSync("git add a.txt", { cwd: tempDir, stdio: "ignore" });
    execSync("git -c user.name=test -c user.email=test@example.com commit -m init", {
      cwd: tempDir,
      stdio: "ignore"
    });
    engine = new GitEngine({
      commitAuthorName: "test-bot",
      commitAuthorEmail: "bot@test.local"
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes on clean worktree", async () => {
    await expect(engine.ensureCleanWorktree(tempDir)).resolves.toBeUndefined();
  });

  it("includes branch and changed files when dirty", async () => {
    fs.writeFileSync(path.join(tempDir, "dirty.txt"), "x\n", "utf8");
    await expect(engine.ensureCleanWorktree(tempDir)).rejects.toThrow(/Working tree is not clean/);
    await expect(engine.ensureCleanWorktree(tempDir)).rejects.toThrow(/branch=/);
    await expect(engine.ensureCleanWorktree(tempDir)).rejects.toThrow(/dirty.txt/);
  });

  it("auto stashes dirty worktree and makes it clean", async () => {
    fs.writeFileSync(path.join(tempDir, "dirty.txt"), "x\n", "utf8");
    const result = await engine.autoStashDirtyWorktree(tempDir, "bot-auto-stash:test");
    expect(result.stashed).toBe(true);
    expect(result.changedCount).toBeGreaterThan(0);
    await expect(engine.ensureCleanWorktree(tempDir)).resolves.toBeUndefined();

    const stashList = execSync("git stash list", { cwd: tempDir, encoding: "utf8" });
    expect(stashList).toContain("bot-auto-stash:test");
  });

  it("allows untracked-only worktree for tracked-safety check", async () => {
    fs.writeFileSync(path.join(tempDir, "untracked.txt"), "x\n", "utf8");
    await expect(engine.ensureNoTrackedChanges(tempDir)).resolves.toBeUndefined();
  });

  it("blocks tracked changes for tracked-safety check", async () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "changed\n", "utf8");
    await expect(engine.ensureNoTrackedChanges(tempDir)).rejects.toThrow(/Tracked changes still exist/);
  });
});
