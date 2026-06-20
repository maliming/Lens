// Source-directory + image-cache path constants. Per-source data lives under
// its CLI's own home dir; centralising the constants here means parsers,
// scanners and IPC handlers all agree on the canonical root and a future
// AI source (Gemini, Cursor, etc.) plugs in by adding one more constant
// plus matching parser + auth modules.
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
// Claude Code 2.x stores pasted screenshots as files in this directory and
// leaves a `[Image: source: ...]` marker in the message text.
const CLAUDE_IMAGE_CACHE_ROOT = path.join(CLAUDE_DIR, 'image-cache');

module.exports = {
  HOME,
  CLAUDE_DIR,
  PROJECTS_DIR,
  CODEX_DIR,
  CODEX_SESSIONS_DIR,
  CLAUDE_IMAGE_CACHE_ROOT,
};
