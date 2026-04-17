// Hook payloads POSTed by Claude Code hooks to the daemon. Matches the
// contract in BUILDING_PLAN.md §6 "Hook payload format."

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";

export interface HookPayload {
  event: HookEvent;
  tool: string | null;
  target: string | null;
  cwd: string;
  session_id: string;
  timestamp: number;
  success: boolean | null;
  prompt: string | null;
}
