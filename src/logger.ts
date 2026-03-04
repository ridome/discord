const REDACT_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)([^\s]+)/gi,
  /(token\s*[:=]\s*)([^\s]+)/gi,
  /(cookie\s*[:=]\s*)([^\s]+)/gi,
  /(apikey\s*[:=]\s*)([^\s]+)/gi,
  /(secret\s*[:=]\s*)([^\s]+)/gi,
  /(password\s*[:=]\s*)([^\s]+)/gi
];

export function redactText(text: string): string {
  let output = text;
  for (const pattern of REDACT_PATTERNS) {
    output = output.replace(pattern, "$1[REDACTED]");
  }
  return output;
}

export class Logger {
  public info(message: string): void {
    this.log("INFO", message);
  }

  public warn(message: string): void {
    this.log("WARN", message);
  }

  public error(message: string): void {
    this.log("ERROR", message);
  }

  private log(level: string, message: string): void {
    const now = new Date().toISOString();
    console.log(`[${now}] [${level}] ${redactText(message)}`);
  }
}