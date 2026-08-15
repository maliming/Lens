// Environment for a CLI agent Lens starts.
//
// Passing `process.env` through wholesale looks harmless and is not. When Lens
// is itself launched from inside a Claude Code session — which is exactly what
// happens during development, and can happen to any user who starts it from an
// agent's terminal — the child inherits that session's markers and mistakes
// itself for a nested session.
//
// The observable damage: `CLAUDE_CODE_CHILD_SESSION` makes the CLI announce
// "Transcript saving is off" and write nothing to the JSONL at all. Lens then
// renders a transcript that never grows, and every refresh mechanism above it
// is faultless and useless.
//
// A terminal Lens opens is a top-level session. Strip the inherited identity
// and let the CLI establish its own.

// Markers that describe *a particular running session*, not user configuration.
// Anything a user might legitimately set to configure the CLI (API keys, model
// overrides, proxies) is deliberately left alone.
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  // Codex's equivalents, for when the terminal learns to host it too.
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
];

function agentEnv(base = process.env, extra = {}) {
  const env = { ...base };
  for (const key of SESSION_MARKERS) delete env[key];
  return { ...env, ...extra };
}

module.exports = { agentEnv, SESSION_MARKERS };
