import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { PatchEngine } from "../src/engines/patchEngine";

describe("PatchEngine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-engine-test-"));
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tempDir, "a.txt"), "hello\n", "utf8");
    execSync("git add a.txt", { cwd: tempDir, stdio: "ignore" });
    execSync("git -c user.name=test -c user.email=test@example.com commit -m init", {
      cwd: tempDir,
      stdio: "ignore"
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts valid patch", async () => {
    fs.writeFileSync(path.join(tempDir, "a.txt"), "world\n", "utf8");
    const patch = execSync("git diff -- a.txt", { cwd: tempDir }).toString("utf8");
    execSync("git checkout -- a.txt", { cwd: tempDir, stdio: "ignore" });

    const engine = new PatchEngine();
    const result = await engine.validateAndPrecheck(tempDir, patch);

    expect(result.ok).toBe(true);
    expect(result.changedFiles).toContain("a.txt");
  });

  it("rejects sensitive path", async () => {
    const patch = [
      "diff --git a/.env b/.env",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/.env",
      "@@ -0,0 +1 @@",
      "+TOKEN=abc"
    ].join("\n");

    const engine = new PatchEngine();
    const result = await engine.validateAndPrecheck(tempDir, patch);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Sensitive file forbidden/);
  });
});
