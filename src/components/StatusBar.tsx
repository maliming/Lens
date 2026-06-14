import { Database, Clock, Folder, Tag } from 'lucide-react';
import { cleanDisplayText, fmtBytes, sessionTimestamp } from '../lib/format';
import { agoLabel } from '../lib/rateLimits';
import { useTranslation } from '../lib/I18nProvider';
import { useCurrentSource, getSource } from '../lib/sources';
import type { SessionMeta } from '../types';

type Props = {
  sessions: SessionMeta[];
  message: string;
};

// Status bar — shows index-scope + build provenance the sidebar doesn't:
// total file size on disk, project directory count, the most recent activity,
// the data dir we're reading, the app version, the git commit it was built
// from. Useful when a user files a bug screenshot.
export function StatusBar({ sessions, message }: Props) {
  const { t } = useTranslation();
  const [source] = useCurrentSource();
  const sourceDef = getSource(source);
  const totalSize = sessions.reduce((n, s) => n + (s.fileSize || 0), 0);
  const projectCount = new Set(sessions.map(s => s.projectDir)).size;
  const newestTs = sessions.reduce<number>((n, s) => {
    const t = sessionTimestamp(s);
    return t > n ? t : n;
  }, 0);
  const buildTitle = `Branch: ${__GIT_BRANCH__}${__GIT_DATE__ ? ` · ${new Date(__GIT_DATE__).toLocaleString()}` : ''} · Click to open on GitHub`;
  const RELEASE_URL = `https://github.com/maliming/Lens/releases/tag/v${__APP_VERSION__}`;
  const openExt = (url: string) => { window.api.openExternal?.(url).catch(() => {}); };

  return (
    <footer className="h-7 px-3 border-t border-border-soft flex items-center gap-3 text-[11px] text-text-muted bg-bg/60">
      {/* Left: index scope facts */}
      <span className="flex items-center gap-1.5">
        <Database className="w-3 h-3" />
        <span className="tabular-nums">{t('status.indexed', { size: fmtBytes(totalSize) })}</span>
      </span>
      <Sep />
      <span className="flex items-center gap-1.5">
        <Folder className="w-3 h-3" />
        <span className="tabular-nums">{t('status.projects', { n: projectCount })}</span>
      </span>
      {newestTs > 0 && (
        <>
          <Sep />
          <span className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            <span className="tabular-nums">{t('status.newest', { when: agoLabel(newestTs, t) })}</span>
          </span>
        </>
      )}
      <Sep />
      <span className="font-mono text-[10.5px] text-text-muted/80 truncate" title={t('status.dataSource')}>{sourceDef.pathHint}</span>
      <span className="flex-1" />

      {/* Middle: transient status messages */}
      {message && <span className="text-accent flex-shrink-0">{cleanDisplayText(message)}</span>}

      {/* Right: build provenance — single chip shows version + commit SHA,
         clicking opens the matching release page on GitHub. */}
      <button
        type="button"
        onClick={() => openExt(RELEASE_URL)}
        title={`${buildTitle}\nOpen release v${__APP_VERSION__} on GitHub`}
        className="flex items-center gap-1.5 flex-shrink-0 hover:text-text transition-colors cursor-pointer"
      >
        <Tag className="w-3 h-3" />
        <span className="tabular-nums">v{__APP_VERSION__}</span>
        <span className="text-text-muted/50" aria-hidden>·</span>
        <span className="font-mono">{__GIT_COMMIT__}</span>
      </button>
    </footer>
  );
}

function Sep() {
  return <span className="text-text-muted/40" aria-hidden>·</span>;
}
