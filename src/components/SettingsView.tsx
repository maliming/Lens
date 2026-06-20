import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Sun, Moon, Monitor, Settings as Gear, Check, FolderOpen, FlaskConical, Activity, Terminal as TerminalIcon, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useDisplayPrefs } from '../lib/displayPrefs';
import type { ThemeMode } from '../App';
import { useTranslation } from '../lib/I18nProvider';
import { LOCALES, type Locale } from '../lib/i18n';
import { US, CN, TR, JP, KR, DE, FR, ES, BR, RU } from 'country-flag-icons/react/3x2';
import { IS_DEMO_BUILD, DEMO_AVAILABLE } from '../lib/demoMode';
import { useSystemCapabilities } from '../lib/systemCapabilities';
import { useAppPrefs } from '../lib/appPrefs';
import { useCurrentSource, getSource } from '../lib/sources';

type Props = {
  themeMode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  onThemeChange: (m: ThemeMode) => void;
  demoMode: boolean;
  onDemoModeChange: (v: boolean) => void;
  rlConsent: 'pending' | 'granted' | 'denied';
  onRlConsentChange: (v: 'pending' | 'granted' | 'denied') => void;
};

export function SettingsView({ themeMode, resolvedTheme, onThemeChange, demoMode, onDemoModeChange, rlConsent, onRlConsentChange }: Props) {
  const [prefs, setPrefs] = useDisplayPrefs();
  const { t, locale, setLocale } = useTranslation();
  const [source] = useCurrentSource();
  const sourceDef = getSource(source);
  // Strip the trailing slash from the path hint (e.g. "~/.codex/sessions/")
  // for the directory label — Open ~/.codex/sessions reads cleaner than the
  // version with a dangling slash.
  const sourceDir = sourceDef.pathHint.replace(/\/$/, '');
  const resolvedThemeLabel = resolvedTheme === 'dark' ? t('settings.theme.darkLower') : t('settings.theme.lightLower');
  const caps = useSystemCapabilities();
  // Preferred-terminal toggle only makes sense when there's a real choice: macOS
  // with iTerm actually installed. Everywhere else, hide it — there's no
  // ambiguity for the renderer to surface.
  const showTerminalChoice = caps?.platform === 'darwin' && caps.terminals.iterm;
  const [appPrefs, setAppPrefs] = useAppPrefs();
  const isMac = caps?.platform === 'darwin';

  return (
    <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-surface border border-border rounded-2xl">
      <div className="max-w-4xl mx-auto px-10 py-8">
        <div className="flex items-center gap-3 mb-1">
          <Gear className="w-5 h-5 text-accent" />
          <h1 className="text-[22px] font-bold text-text">{t('settings.title')}</h1>
        </div>
        <p className="text-text-muted text-[12px] mb-8">{t('settings.subtitle')}</p>

        {/* Appearance — theme + compact + language */}
        <Section title={t('settings.section.appearance')}>
          <Row label={t('settings.theme')} hint={themeMode === 'system' ? t('settings.theme.followingSystem', { theme: resolvedThemeLabel }) : t('settings.theme.pick')}>
            <div className="inline-flex p-0.5 bg-muted rounded-lg gap-0.5">
              <ThemeOption icon={<Sun className="w-3.5 h-3.5" />} label={t('settings.theme.light')} active={themeMode === 'light'} onClick={() => onThemeChange('light')} />
              <ThemeOption icon={<Moon className="w-3.5 h-3.5" />} label={t('settings.theme.dark')} active={themeMode === 'dark'} onClick={() => onThemeChange('dark')} />
              <ThemeOption icon={<Monitor className="w-3.5 h-3.5" />} label={t('settings.theme.system')} active={themeMode === 'system'} onClick={() => onThemeChange('system')} />
            </div>
          </Row>
          <Row label={t('settings.compact')} hint={t('settings.compact.hint')}>
            <Switch checked={prefs.compact} onChange={v => setPrefs({ compact: v })} />
          </Row>
          <Row label={t('settings.language.label')} hint={t('settings.language.hint')}>
            <LanguagePicker locale={locale} onChange={setLocale} />
          </Row>
        </Section>

        {/* Conversation — what shows up next to / inside messages */}
        <Section title={t('settings.section.conversation')}>
          <Row label={t('settings.showTimestamps')} hint={t('settings.showTimestamps.hint')}>
            <Switch checked={prefs.showTimestamps} onChange={v => setPrefs({ showTimestamps: v })} />
          </Row>
          <Row label={t('settings.showMsgTokens')} hint={t('settings.showMsgTokens.hint')}>
            <Switch checked={prefs.showMsgTokens} onChange={v => setPrefs({ showMsgTokens: v })} />
          </Row>
          <Row label={t('settings.showAvatars')} hint={t('settings.showAvatars.hint')}>
            <Switch checked={prefs.showAvatars} onChange={v => setPrefs({ showAvatars: v })} />
          </Row>
          <Row label={t('settings.showTools')} hint={t('settings.showTools.hint')}>
            <Switch checked={prefs.showTools} onChange={v => setPrefs({ showTools: v })} />
          </Row>
          <Row label={t('settings.loadRemoteImages')} hint={t('settings.loadRemoteImages.hint')}>
            <Switch checked={prefs.loadRemoteImages} onChange={v => setPrefs({ loadRemoteImages: v })} />
          </Row>
        </Section>

        {/* Integrations — terminal + how the open-in toolbar shows */}
        <Section title={t('settings.section.integrations')}>
          {showTerminalChoice && (
            <Row label={t('settings.preferredTerminal')} hint={t('settings.preferredTerminal.hint')}>
              <div className="inline-flex p-0.5 bg-muted rounded-lg gap-0.5">
                <button
                  onClick={() => setPrefs({ preferredTerminal: 'terminal' })}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition',
                    prefs.preferredTerminal === 'terminal' ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
                  )}
                >
                  <TerminalIcon className="w-3.5 h-3.5" />
                  Terminal
                </button>
                <button
                  onClick={() => setPrefs({ preferredTerminal: 'iterm' })}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition',
                    prefs.preferredTerminal === 'iterm' ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
                  )}
                >
                  <TerminalIcon className="w-3.5 h-3.5" />
                  iTerm
                </button>
              </div>
            </Row>
          )}
          <Row label={t('settings.toolbarLabels')} hint={t('settings.toolbarLabels.hint')}>
            <Switch checked={prefs.toolbarLabels} onChange={v => setPrefs({ toolbarLabels: v })} />
          </Row>
        </Section>

        {/* App behavior — tray + close + autostart. Standard packaged-app prefs. */}
        <Section title={t('settings.section.appBehavior')}>
          <Row label={t('settings.tray')} hint={t('settings.tray.hint')}>
            <Switch checked={appPrefs.showTrayIcon} onChange={v => setAppPrefs({ showTrayIcon: v })} />
          </Row>
          <Row label={t('settings.closeBehavior')} hint={isMac ? t('settings.closeBehavior.hint.mac') : t('settings.closeBehavior.hint.other')}>
            <div className="inline-flex p-0.5 bg-muted rounded-lg gap-0.5">
              <button
                onClick={() => setAppPrefs({ closeBehavior: 'hide' })}
                disabled={!appPrefs.showTrayIcon}
                className={cn(
                  'px-3 py-1 rounded-md text-[12px] font-medium transition disabled:opacity-40 disabled:cursor-not-allowed',
                  appPrefs.closeBehavior === 'hide' ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
                )}
                title={!appPrefs.showTrayIcon ? t('settings.closeBehavior.disabledTip') : ''}
              >
                {t('settings.closeBehavior.hide')}
              </button>
              <button
                onClick={() => setAppPrefs({ closeBehavior: 'quit' })}
                className={cn(
                  'px-3 py-1 rounded-md text-[12px] font-medium transition',
                  appPrefs.closeBehavior === 'quit' ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
                )}
              >
                {t('settings.closeBehavior.quit')}
              </button>
            </div>
          </Row>
          <Row label={t('settings.launchAtLogin')} hint={t('settings.launchAtLogin.hint')}>
            <Switch checked={appPrefs.launchAtLogin} onChange={v => setAppPrefs({ launchAtLogin: v })} />
          </Row>
        </Section>

        {/* Usage — subscription quota probe */}
        <Section title={t('settings.section.usage')}>
          <Row label={t('settings.realQuota')} hint={t('settings.realQuota.hint')}>
            <div className="flex items-center gap-2">
              <Activity className={cn('w-3.5 h-3.5', rlConsent === 'granted' ? 'text-accent' : 'text-text-muted')} />
              <Switch checked={rlConsent === 'granted'} onChange={v => onRlConsentChange(v ? 'granted' : 'denied')} />
            </div>
          </Row>
        </Section>

        {/* Advanced — local folders + power-user toggles. Order: AI tool's
            data dir first (source-aware), then Lens's own user-data dir, then
            the debug log dir. Diagnostics-only rows live after the everyday
            ones; Demo mode (dev-only) anchors the bottom. */}
        <Section title={t('settings.section.advanced')}>
          {/* Source-aware: button label / path follow the active AI tool, so
             switching to Codex flips this to "Open ~/.codex/sessions". */}
          <Row
            label={t('settings.openClaudeDir', { dir: sourceDir })}
            hint={t('settings.openClaudeDir.hint', { source: sourceDef.label })}
          >
            <button
              onClick={() => window.api.revealSourceDir(source).catch(() => {})}
              className="px-3 py-1.5 bg-bg border border-border-soft rounded-md text-[12px] hover:bg-muted flex items-center gap-1.5"
            >
              <FolderOpen className="w-3 h-3" />
              {t('settings.openClaude.btn')}
            </button>
          </Row>
          <Row label={t('settings.appData')} hint={t('settings.appData.hint')}>
            <button
              onClick={() => window.api.openUserDataFolder?.().catch(() => {})}
              className="px-3 py-1.5 bg-bg border border-border-soft rounded-md text-[12px] hover:bg-muted flex items-center gap-1.5"
            >
              <FolderOpen className="w-3 h-3" />
              {t('settings.appData.btn')}
            </button>
          </Row>
          <Row label={t('settings.logs')} hint={t('settings.logs.hint')}>
            <button
              onClick={() => window.api.openLogsFolder?.().catch(() => {})}
              className="px-3 py-1.5 bg-bg border border-border-soft rounded-md text-[12px] hover:bg-muted flex items-center gap-1.5"
            >
              <FolderOpen className="w-3 h-3" />
              {t('settings.logs.btn')}
            </button>
          </Row>
          {/* Demo toggle only renders in dev (npm run dev) — packaged production
             builds never expose it so an end-user can't surface fake content.
             IS_DEMO_BUILD shipped artifacts force-on and also skip the toggle. */}
          {DEMO_AVAILABLE && !IS_DEMO_BUILD && (
            <Row label={t('settings.demoMode')} hint={t('settings.demoMode.hint')}>
              <div className="flex items-center gap-2">
                <FlaskConical className={cn('w-3.5 h-3.5', demoMode ? 'text-accent' : 'text-text-muted')} />
                <Switch checked={demoMode} onChange={onDemoModeChange} />
              </div>
            </Row>
          )}
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[11px] uppercase tracking-wider font-semibold text-text-muted mb-3">{title}</h2>
      <div className="bg-surface border border-border-soft rounded-xl divide-y divide-border-soft/60">
        {children}
      </div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        {label && <div className="text-[13px] font-medium text-text">{label}</div>}
        {hint && <div className="text-[11px] text-text-muted mt-0.5 leading-snug">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function ThemeOption({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition',
        active ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// SVG flags — Win's Segoe UI Emoji deliberately doesn't render regional
// indicator sequences, so the unicode flag emoji shows as "US" / "CN" text on
// Windows. SVGs render identically on every platform.
// `FlagComponent` from country-flag-icons takes its own attribute shape
// (HTMLSVGElement-augmented), not a vanilla SVGProps, so type the map loosely.
type FlagComp = (typeof US);
const FLAG_BY_LOCALE: Record<Locale, FlagComp> = {
  'en': US,
  'zh-CN': CN,
  'tr': TR,
  'ja': JP,
  'ko': KR,
  'de': DE,
  'fr': FR,
  'es': ES,
  'pt-BR': BR,
  'ru': RU,
};

function LocaleFlag({ code, className }: { code: Locale; className?: string }) {
  const Flag = FLAG_BY_LOCALE[code];
  if (!Flag) return null;
  return (
    <Flag
      className={cn('rounded-[2px] shadow-[0_0_0_0.5px_hsl(var(--border-soft))]', className)}
      aria-hidden="true"
    />
  );
}

// Radix-backed language picker. Each row shows the country flag + native name
// + English name; selected row gets a check mark. Looks consistent with the
// rest of the Lens dropdowns and is keyboard-navigable for free.
function LanguagePicker({ locale, onChange }: { locale: Locale; onChange: (l: Locale) => void }) {
  const current = LOCALES.find(l => l.code === locale) || LOCALES[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-bg border border-border-soft rounded-md hover:border-accent/40 transition outline-none focus:border-accent"
        >
          <LocaleFlag code={current.code} className="w-[18px] h-[13px]" />
          <span className="text-[12.5px] text-text">{current.native}</span>
          <ChevronDown className="w-3 h-3 text-text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[200px] bg-elevated border border-border rounded-lg shadow-pop p-1 animate-in"
        >
          {LOCALES.map(l => {
            const active = l.code === locale;
            return (
              <DropdownMenu.Item
                key={l.code}
                onSelect={() => onChange(l.code)}
                className={cn(
                  'flex items-center gap-2.5 px-2 py-1.5 rounded text-[12.5px] cursor-pointer outline-none',
                  active ? 'bg-accent/10 text-text' : 'text-text-dim hover:bg-muted hover:text-text',
                )}
              >
                <LocaleFlag code={l.code} className="w-[20px] h-[14px]" />
                <span className="flex-1">{l.native}</span>
                <span className="text-[10.5px] text-text-muted">{l.name}</span>
                {active && <Check className="w-3.5 h-3.5 text-accent" />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors duration-150 outline-none',
        checked ? 'bg-accent' : 'bg-muted'
      )}
      role="switch"
      aria-checked={checked}
    >
      <span className={cn(
        'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150',
        checked && 'translate-x-4'
      )} />
    </button>
  );
}
