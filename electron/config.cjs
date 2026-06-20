// Workspace / "Config" view backend.
//
// Reads ~/.claude (or ~/.codex) and packages its skills, commands, hooks,
// plugins, root markdown (CLAUDE.md / AGENTS.md), and settings file into the
// shape ConfigView renders. Both readers return the same envelope so the
// renderer can use a single ConfigView with per-source labels.
//
// All reads go through readFileSafe / listDirSafe — both refuse to follow
// symlinks (defense against a stray link in ~/.claude pointing outside the
// tool's directory) and enforce MAX_CONFIG_FILE_SIZE so a 200 MB notes file
// can't blow main-process memory.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { HOME, CLAUDE_DIR, CODEX_DIR } = require('./lib/paths.cjs');

// Config files (CLAUDE.md, AGENTS.md, settings.json, individual skill/command/hook
// bodies) — same OOM concern as session JSONL. 5 MB easily covers any real config;
// past that, refuse and let the workspace view show an empty entry rather than
// blowing main-process memory.
const MAX_CONFIG_FILE_SIZE = 5 * 1024 * 1024;

async function readFileSafe(p) {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return null;
    if (st.size > MAX_CONFIG_FILE_SIZE) return null;
    return await fsp.readFile(p, 'utf8');
  } catch { return null; }
}

async function listDirSafe(p) {
  // Refuse to follow a symlinked root directory itself — the per-entry loops
  // in callers already lstat each child, but a symlinked `~/.claude/skills`
  // (or equivalent) would redirect the whole enumeration outside ~/.claude
  // before we got that far. lstat at the root closes that hole.
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
  } catch { return []; }
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}

function parseFrontmatter(md) {
  if (!md.startsWith('---')) return { fm: {}, body: md };
  const end = md.indexOf('\n---', 4);
  if (end < 0) return { fm: {}, body: md };
  const fmRaw = md.slice(4, end);
  const body = md.slice(end + 4).replace(/^\n/, '');
  const fm = {};
  const lines = fmRaw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2].trim();
    if (val === '|' || val === '>' || val === '|-' || val === '>-' || val === '|+' || val === '>+') {
      // YAML block scalar: collect subsequent indented continuation lines until next key or end.
      const fold = val.startsWith('>');
      const collected = [];
      i++;
      let indent = null;
      while (i < lines.length) {
        const next = lines[i];
        const stripped = next.replace(/^\s+/, '');
        if (stripped && next.match(/^[a-zA-Z0-9_-]+:\s/)) break; // next top-level key
        if (next.trim() === '') { collected.push(''); i++; continue; }
        if (indent === null) {
          const lead = next.match(/^(\s+)/);
          indent = lead ? lead[1] : '';
        }
        collected.push(next.startsWith(indent) ? next.slice(indent.length) : next);
        i++;
      }
      val = fold ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim();
    } else {
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      i++;
    }
    fm[key] = val;
  }
  return { fm, body };
}

async function readClaudeConfig() {
  const result = {
    paths: { home: HOME, claudeDir: CLAUDE_DIR },
    claudeMd: null,
    skills: [],
    commands: [],
    hooks: [],
    plugins: [],
    settings: null,
  };

  // v10 — workspace detail view shows "last modified" per resource, so attach mtime.
  // Stat failures are silent; mtime is optional in the renderer.
  const safeMtime = async (p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return undefined; } };

  const claudeMdPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const claudeMd = await readFileSafe(claudeMdPath);
  if (claudeMd != null) result.claudeMd = { path: claudeMdPath, content: claudeMd, mtime: await safeMtime(claudeMdPath) };

  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  for (const e of await listDirSafe(skillsDir)) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
    const content = await readFileSafe(skillMd);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.skills.push({
      name: e.name, path: skillMd,
      title: fm.name || e.name,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(skillMd),
    });
  }
  result.skills.sort((a, b) => a.name.localeCompare(b.name));

  const cmdDir = path.join(CLAUDE_DIR, 'commands');
  for (const e of await listDirSafe(cmdDir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const p = path.join(cmdDir, e.name);
    const content = await readFileSafe(p);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.commands.push({
      name: '/' + e.name.replace(/\.md$/, ''),
      path: p,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(p),
    });
  }
  result.commands.sort((a, b) => a.name.localeCompare(b.name));

  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  for (const e of await listDirSafe(hooksDir)) {
    if (!e.isFile()) continue;
    const p = path.join(hooksDir, e.name);
    const content = await readFileSafe(p);
    result.hooks.push({ name: e.name, path: p, content: content || '', mtime: await safeMtime(p) });
  }
  result.hooks.sort((a, b) => a.name.localeCompare(b.name));

  const pluginsDir = path.join(CLAUDE_DIR, 'plugins');
  for (const e of await listDirSafe(pluginsDir)) {
    if (!e.isDirectory()) continue;
    const pluginPath = path.join(pluginsDir, e.name);
    const subEntries = await listDirSafe(pluginPath);
    const sub = subEntries.filter(x => x.isDirectory() || x.isFile()).map(x => x.name);
    result.plugins.push({ name: e.name, path: pluginPath, entries: sub, mtime: await safeMtime(pluginPath) });
  }
  result.plugins.sort((a, b) => a.name.localeCompare(b.name));

  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const settings = await readFileSafe(settingsPath);
  if (settings != null) result.settings = { path: settingsPath, content: settings, mtime: await safeMtime(settingsPath) };

  return result;
}

// Codex workspace reader. Mirrors the Claude shape so the renderer can use the
// same ConfigView with the same kind buckets:
//   AGENTS.md  → claudeMd (Global instructions)
//   skills/    → skills
//   commands/  → commands (codex doesn't expose these yet — empty)
//   hooks/     → hooks  (same — empty)
//   rules/*.rules → mapped into hooks bucket as security rules
//   plugins/   → plugins (rare; folder usually only holds caches)
//   config.toml → settings
async function readCodexConfig() {
  const result = {
    paths: { home: HOME, claudeDir: CODEX_DIR },
    claudeMd: null,
    skills: [],
    commands: [],
    hooks: [],
    plugins: [],
    settings: null,
  };
  const safeMtime = async (p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return undefined; } };

  const agentsPath = path.join(CODEX_DIR, 'AGENTS.md');
  const agents = await readFileSafe(agentsPath);
  if (agents != null) {
    result.claudeMd = { path: agentsPath, content: agents, mtime: await safeMtime(agentsPath) };
  }

  const skillsDir = path.join(CODEX_DIR, 'skills');
  for (const e of await listDirSafe(skillsDir)) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // skip .system etc.
    const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
    const content = await readFileSafe(skillMd);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.skills.push({
      name: e.name, path: skillMd,
      title: fm.name || e.name,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(skillMd),
    });
  }
  result.skills.sort((a, b) => a.name.localeCompare(b.name));

  // Codex security rules (~/.codex/rules/*.rules) → hooks bucket — they're
  // automation policies that fire on tool invocation, similar to Claude hooks.
  const rulesDir = path.join(CODEX_DIR, 'rules');
  for (const e of await listDirSafe(rulesDir)) {
    if (!e.isFile() || !e.name.endsWith('.rules')) continue;
    const p = path.join(rulesDir, e.name);
    const content = await readFileSafe(p);
    result.hooks.push({ name: e.name, path: p, content: content || '', mtime: await safeMtime(p) });
  }

  const pluginsDir = path.join(CODEX_DIR, 'plugins');
  for (const e of await listDirSafe(pluginsDir)) {
    if (!e.isDirectory()) continue;
    if (e.name === 'cache') continue;
    const pluginPath = path.join(pluginsDir, e.name);
    const subEntries = await listDirSafe(pluginPath);
    const sub = subEntries.filter(x => x.isDirectory() || x.isFile()).map(x => x.name);
    result.plugins.push({ name: e.name, path: pluginPath, entries: sub, mtime: await safeMtime(pluginPath) });
  }
  result.plugins.sort((a, b) => a.name.localeCompare(b.name));

  const cfgPath = path.join(CODEX_DIR, 'config.toml');
  const cfg = await readFileSafe(cfgPath);
  if (cfg != null) result.settings = { path: cfgPath, content: cfg, mtime: await safeMtime(cfgPath) };

  return result;
}

module.exports = {
  MAX_CONFIG_FILE_SIZE,
  readClaudeConfig,
  readCodexConfig,
  // Exported for tests / future config writers; not currently used outside.
  parseFrontmatter,
  readFileSafe,
  listDirSafe,
};
