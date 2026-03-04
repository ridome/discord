const DANGER_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bdel\b/i,
  /\bformat\b/i,
  /\bgit\s+push\b/i,
  /\bdocker\b/i,
  /\bkubectl\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\binvoke-webrequest\b/i
];

export class CommandGuard {
  public isDangerous(command: string): boolean {
    return DANGER_PATTERNS.some((pattern) => pattern.test(command));
  }
}