import { runCommand } from "../utils/process";

export class VSCodeBridge {
  public async openRepo(repoPath: string): Promise<void> {
    await runCommand("code", ["-r", repoPath], repoPath);
  }

  public async openFile(repoPath: string, relativeFile: string, line = 1): Promise<void> {
    await runCommand("code", ["-r", "-g", `${relativeFile}:${line}`], repoPath);
  }

  public async openChat(repoPath: string, prompt: string): Promise<void> {
    await runCommand("code", ["chat", "-r", "-m", "agent", prompt], repoPath);
  }
}