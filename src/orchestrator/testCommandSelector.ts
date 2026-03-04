export interface TestCommandSelection {
  commands: string[];
  droppedSuggested: string[];
  source: "profile" | "codex" | "default" | "none";
}

export function sanitizeSuggestedTestCommands(commands: string[]): {
  accepted: string[];
  rejected: string[];
} {
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const raw of commands) {
    const command = String(raw ?? "").trim();
    if (!command) {
      continue;
    }

    const lower = command.toLowerCase();
    if (command.includes("<") || lower.includes("patch-file") || /^\s*git\s+apply\b/i.test(command)) {
      rejected.push(command);
      continue;
    }

    accepted.push(command);
  }

  return { accepted, rejected };
}

export function selectTestCommands(
  testProfile: string | null,
  profiles: Record<string, string[]>,
  suggestedCommands: string[]
): TestCommandSelection {
  if (testProfile && profiles[testProfile]) {
    return {
      commands: profiles[testProfile],
      droppedSuggested: [],
      source: "profile"
    };
  }

  const sanitized = sanitizeSuggestedTestCommands(suggestedCommands);
  if (sanitized.accepted.length > 0) {
    return {
      commands: sanitized.accepted,
      droppedSuggested: sanitized.rejected,
      source: "codex"
    };
  }

  const defaults = profiles.default ?? [];
  if (defaults.length > 0) {
    return {
      commands: defaults,
      droppedSuggested: sanitized.rejected,
      source: "default"
    };
  }

  return {
    commands: [],
    droppedSuggested: sanitized.rejected,
    source: "none"
  };
}
