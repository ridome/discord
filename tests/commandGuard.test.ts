import { CommandGuard } from "../src/security/commandGuard";

describe("CommandGuard", () => {
  const guard = new CommandGuard();

  it("marks dangerous commands", () => {
    expect(guard.isDangerous("git push origin main")).toBe(true);
    expect(guard.isDangerous("docker ps")).toBe(true);
    expect(guard.isDangerous("rm -rf ./tmp")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(guard.isDangerous("git status")).toBe(false);
    expect(guard.isDangerous("npm test")).toBe(false);
  });
});