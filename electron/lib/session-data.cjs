// Bounded session metadata shared by parsers, persistence, IPC projection, and
// usage aggregation. The main process keeps usage-only fields; the renderer
// receives a strict whitelist so an internal cache field can never leak into a
// large structured-clone payload by accident.

const { createHash } = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_USAGE_DAYS = 30;
const FIRST_USER_MAX_LENGTH = 512;
const SUMMARY_MAX_LENGTH = 1000;
const PATH_MAX_LENGTH = 4096;
const SMALL_TEXT_MAX_LENGTH = 512;
const ERROR_MAX_LENGTH = 2000;
const SESSION_TEXT_LIMITS = Object.freeze({
  id: SMALL_TEXT_MAX_LENGTH,
  summary: SUMMARY_MAX_LENGTH,
  firstUser: FIRST_USER_MAX_LENGTH,
  projectDir: PATH_MAX_LENGTH,
  projectCwd: PATH_MAX_LENGTH,
  decodedCwd: PATH_MAX_LENGTH,
  lastCwd: PATH_MAX_LENGTH,
  filePath: PATH_MAX_LENGTH,
  gitBranch: SMALL_TEXT_MAX_LENGTH,
  model: SMALL_TEXT_MAX_LENGTH,
  version: SMALL_TEXT_MAX_LENGTH,
});

function capText(value, maxLength) {
  if (typeof value !== 'string') return '';
  if (value.length <= maxLength) return value;
  let end = maxLength;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
  return value.slice(0, end);
}

function capSessionText(session, field) {
  return capText(session?.[field], SESSION_TEXT_LIMITS[field]);
}

function localDayKey(ts) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeTimestamp(value) {
  if (typeof value === 'string') return capText(value, SMALL_TEXT_MAX_LENGTH) || null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  try { return new Date(value).toISOString(); }
  catch { return null; }
}

function addDay(days, day, value) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  const current = days.get(day) || { day, i: 0, o: 0, cr: 0, cc: 0 };
  current.i += finiteNumber(value.i);
  current.o += finiteNumber(value.o);
  current.cr += finiteNumber(value.cr);
  current.cc += finiteNumber(value.cc);
  days.set(day, current);
}

// Keep exact events only for windows Usage can query (up to 30 days). Older
// events collapse into one row per calendar day, preserving the heatmap and
// activity statistics without growing once per model turn forever.
function compactTokenUsage(tokenEvents, tokenDays, now = Date.now()) {
  const cutoffDate = new Date(now - RECENT_USAGE_DAYS * DAY_MS);
  cutoffDate.setHours(0, 0, 0, 0);
  const cutoff = cutoffDate.getTime();
  const recent = [];
  const days = new Map();

  for (const value of Array.isArray(tokenDays) ? tokenDays : []) {
    addDay(days, value?.day, value || {});
  }

  for (const value of Array.isArray(tokenEvents) ? tokenEvents : []) {
    const ts = finiteNumber(value?.ts);
    if (ts <= 0) continue;
    const event = {
      ts,
      i: finiteNumber(value.i),
      o: finiteNumber(value.o),
      cr: finiteNumber(value.cr),
      cc: finiteNumber(value.cc),
    };
    if (ts > cutoff) {
      recent.push(event);
      continue;
    }
    const day = localDayKey(ts);
    if (day) addDay(days, day, event);
  }

  recent.sort((a, b) => a.ts - b.ts);
  const compactDays = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    tokenEvents: recent,
    tokenDays: compactDays,
    usageRevision: tokenUsageRevision(recent, compactDays),
  };
}

// A row with nothing behind it: no counted human/assistant turn and no token
// usage. Both CLIs write such a file whenever a session starts and exits
// without a prompt — the JSONL still carries hook attachments and slash-command
// system lines, so it is neither zero-length on disk nor parseable into a
// single message, and the detail pane renders blank. Rows that failed to parse
// (`error`) or hit the size cap (`tooLarge`) are never empty in this sense:
// their transcript exists and the user still needs a way to reach it.
function isEmptySession(session) {
  if (!session || session.error || session.tooLarge) return false;
  if ((session.userMsgs || 0) + (session.assistantMsgs || 0) > 0) return false;
  return (session.tokensIn || 0) + (session.tokensOut || 0)
    + (session.tokensCacheRead || 0) + (session.tokensCacheCreate || 0) === 0;
}

function normalizeCommonSessionFields(session) {
  return {
    source: session?.source === 'codex' ? 'codex' : 'claude',
    id: capSessionText(session, 'id'),
    projectDir: capSessionText(session, 'projectDir'),
    projectCwd: capSessionText(session, 'projectCwd'),
    decodedCwd: capSessionText(session, 'decodedCwd'),
    lastCwd: capSessionText(session, 'lastCwd'),
    filePath: capSessionText(session, 'filePath'),
    summary: capSessionText(session, 'summary'),
    firstUser: capSessionText(session, 'firstUser'),
    firstTs: normalizeTimestamp(session?.firstTs),
    lastTs: normalizeTimestamp(session?.lastTs),
    userMsgs: finiteNumber(session?.userMsgs),
    assistantMsgs: finiteNumber(session?.assistantMsgs),
    gitBranch: capSessionText(session, 'gitBranch'),
    model: capSessionText(session, 'model'),
    version: capSessionText(session, 'version'),
    tokensIn: finiteNumber(session?.tokensIn),
    tokensOut: finiteNumber(session?.tokensOut),
    tokensCacheRead: finiteNumber(session?.tokensCacheRead),
    tokensCacheCreate: finiteNumber(session?.tokensCacheCreate),
    fileSize: finiteNumber(session?.fileSize),
    mtime: finiteNumber(session?.mtime),
    favorite: session?.favorite === true,
    excluded: session?.excluded === true,
    alias: session?.alias == null ? null : capText(String(session.alias), SMALL_TEXT_MAX_LENGTH),
  };
}

function normalizeSessionForCache(session, now = Date.now()) {
  const usage = compactTokenUsage(session?.tokenEvents, session?.tokenDays, now);
  return {
    ...normalizeCommonSessionFields(session),
    planType: session?.planType == null ? null : capText(session.planType, SMALL_TEXT_MAX_LENGTH),
    reasoningEffort: session?.reasoningEffort == null ? null : capText(session.reasoningEffort, SMALL_TEXT_MAX_LENGTH),
    codexId: session?.codexId == null ? undefined : capText(String(session.codexId), SMALL_TEXT_MAX_LENGTH),
    isSubagent: session?.isSubagent === true,
    // v15 and earlier persisted final Claude rows after subagents had already
    // been folded in. Mark migrated rows so a warm scan never adds them twice.
    subagentsFolded: session?.source === 'claude' ? session?.subagentsFolded !== false : false,
    subagentSignature: session?.subagentSignature == null
      ? null
      : capText(String(session.subagentSignature), SMALL_TEXT_MAX_LENGTH),
    tooLarge: session?.tooLarge === true,
    error: session?.error == null ? undefined : capText(String(session.error), ERROR_MAX_LENGTH),
    tokenEvents: usage.tokenEvents,
    tokenDays: usage.tokenDays,
    usageRevision: usage.usageRevision,
  };
}

function toRendererSession(session) {
  return {
    ...normalizeCommonSessionFields(session),
    ...(session.planType == null ? {} : { planType: capText(session.planType, SMALL_TEXT_MAX_LENGTH) }),
    ...(session.reasoningEffort == null ? {} : { reasoningEffort: capText(session.reasoningEffort, SMALL_TEXT_MAX_LENGTH) }),
    ...(session.tooLarge === true ? { tooLarge: true } : {}),
    ...(session.error ? { error: capText(String(session.error), ERROR_MAX_LENGTH) } : {}),
  };
}

function toRendererSessions(sessions, source) {
  const rows = source ? sessions.filter(session => session.source === source) : sessions;
  return rows.map(toRendererSession);
}

function createRevisionHasher() {
  const hash = createHash('sha256');
  let pending = '';
  const flush = () => {
    if (!pending) return;
    hash.update(pending);
    pending = '';
  };
  return {
    write(value) {
      const text = String(value ?? '');
      pending += `${Buffer.byteLength(text)}:${text}`;
      if (pending.length >= 64 * 1024) flush();
    },
    digest(length) {
      flush();
      return `${length}-${hash.digest('hex')}`;
    },
  };
}

function tokenUsageRevision(tokenEvents, tokenDays) {
  const hasher = createRevisionHasher();
  const events = Array.isArray(tokenEvents) ? tokenEvents : [];
  const days = Array.isArray(tokenDays) ? tokenDays : [];
  hasher.write(events.length);
  for (const event of events) {
    hasher.write(event?.ts);
    hasher.write(event?.i);
    hasher.write(event?.o);
    hasher.write(event?.cr);
    hasher.write(event?.cc);
  }
  hasher.write(days.length);
  for (const day of days) {
    hasher.write(day?.day);
    hasher.write(day?.i);
    hasher.write(day?.o);
    hasher.write(day?.cr);
    hasher.write(day?.cc);
  }
  return hasher.digest(events.length + days.length);
}

function writeUsageRevision(hasher, session) {
  hasher.write(session.subagentSignature);
  hasher.write(session.usageRevision || tokenUsageRevision(session.tokenEvents, session.tokenDays));
}

function toRendererSessionsWithRevision(sessions, source) {
  const hasher = createRevisionHasher();
  const projected = [];
  for (const session of sessions) {
    if (source && session.source !== source) continue;
    const row = toRendererSession(session);
    projected.push(row);
    for (const key of Object.keys(row)) {
      hasher.write(key);
      hasher.write(row[key]);
    }
    writeUsageRevision(hasher, session);
  }
  return { sessions: projected, revision: hasher.digest(projected.length) };
}

// Persistence needs a slightly broader fingerprint than renderer updates.
// File mtimes cover parser-visible text, while usage totals and compact-series
// edges also catch one-time migrations such as subagent de-duplication and an
// event crossing the rolling retention boundary.
function cacheRevision(sessions) {
  const hasher = createRevisionHasher();
  for (const session of sessions) {
    hasher.write(session.id);
    hasher.write(session.filePath);
    hasher.write(session.mtime);
    hasher.write(session.favorite);
    hasher.write(session.excluded);
    hasher.write(session.alias);
    hasher.write(session.tokensIn);
    hasher.write(session.tokensOut);
    hasher.write(session.tokensCacheRead);
    hasher.write(session.tokensCacheCreate);
    hasher.write(session.usageRevision || tokenUsageRevision(session.tokenEvents, session.tokenDays));
    hasher.write(session.subagentSignature);
    hasher.write(session.planType);
    hasher.write(session.reasoningEffort);
  }
  return hasher.digest(sessions.length);
}

module.exports = {
  DAY_MS,
  RECENT_USAGE_DAYS,
  FIRST_USER_MAX_LENGTH,
  capText,
  normalizeTimestamp,
  localDayKey,
  compactTokenUsage,
  createRevisionHasher,
  tokenUsageRevision,
  isEmptySession,
  normalizeSessionForCache,
  toRendererSession,
  toRendererSessions,
  toRendererSessionsWithRevision,
  cacheRevision,
};
