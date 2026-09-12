import { useEffect, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Sun, Moon, Monitor, Settings as Gear, Check, FolderOpen, FlaskConical, Activity, Terminal as TerminalIcon, ChevronDown, SlidersHorizontal, MessageSquare, BarChart3, Wrench } from 'lucide-react';
import { cn } from '../lib/utils';
import { useDisplayPrefs } from '../lib/displayPrefs';
import type { ThemeMode } from '../App';
import { useTranslation } from '../lib/I18nProvider';
import {
  MAX_WARN_THRESHOLD, MIN_WARN_THRESHOLD, getTerminalPrefs, setTerminalWarn,
  getTerminalStartMode, setTerminalStartMode,
} from '../lib/terminals';
import { LOCALES, type Locale, type TKey } from '../lib/i18n';
import { US, CN, TR, JP, KR, DE, FR, ES, BR, RU } from 'country-flag-icons/react/3x2';
import { IS_DEMO_BUILD, DEMO_AVAILABLE } from '../lib/demoMode';
import { useSystemCapabilities } from '../lib/systemCapabilities';
import { useAppPrefs } from '../lib/appPrefs';
import { useCurrentSource, getSource, SOURCE_ORDER } from '../lib/sources';

// Icon per tab: at five tabs the labels are still readable, but a glyph is
// what makes the strip scannable at a glance and gives the active tab a second
// signal beyond colour.
const SETTINGS_TABS = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'conversation', icon: MessageSquare },
  { id: 'usage', icon: BarChart3 },
  { id: 'terminal', icon: TerminalIcon },
  { id: 'advanced', icon: Wrench },
] as const;
const TAB_STORAGE = 'settings-tab-v1';

type Props = {
  themeMode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  onThemeChange: (m: ThemeMode) => void;
  demoMode: boolean;
  onDemoModeChange: (v: boolean) => void;
  rlConsent: 'pending' | 'granted' | 'denied';
  onRlConsentChange: (v: 'pending' | 'granted' | 'denied') => void;
  onOpenRlPrompt: () => void;
  onOpenTerminalPrompt: () => void;
};

export function SettingsView({ themeMode, resolvedTheme, onThemeChange, demoMode, onDemoModeChange, rlConsent, onRlConsentChange, onOpenRlPrompt, onOpenTerminalPrompt }: Props) {
  // Terminal prefs live outside React (lib/terminals owns them so non-component
  // code can read them); this tick just re-renders the rows after a change.
  const [, setTermTick] = useState<number>(0);
  const termPrefs = getTerminalPrefs();
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
  const supportsLaunchAtLogin = caps?.platform === 'darwin' || caps?.platform === 'win32';
  // Providers this machine can report a quota for, in declaration order. Main
  // owns the rule — the two probes need different things installed — so these
  // rows can never offer to configure a number the menu bar won't draw.
  const quotaSources = SOURCE_ORDER.filter(id => caps?.quotaSources?.includes(id));

  const [tab, setTab] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE);
      if (saved && SETTINGS_TABS.some(x => x.id === saved)) return saved;
    } catch { /* private window, blocked storage */ }
    return SETTINGS_TABS[0].id;
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE, tab); } catch { /* not worth failing over */ }
  }, [tab]);

  return (
    <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-surface border border-border rounded-2xl">
      <div className="px-8 py-8 max-w-[2000px] mx-auto">
        {/* Same header shape as Usage and Workspace: tinted icon tile beside a
            title-and-subtitle block, so the three pages share a baseline. */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-xl bg-accent-soft flex items-center justify-center shadow-soft flex-shrink-0">
            <Gear className="w-5 h-5 text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold text-text leading-tight">{t('settings.title')}</h1>
            <p className="text-text-muted text-[12px] mt-0.5">{t('settings.subtitle')}</p>
          </div>
        </div>

        {/* Wraps rather than scrolls: five short labels, and a horizontally
            scrolling strip hides the fact that more tabs exist. */}
        <nav className="flex flex-wrap gap-1 mb-6 border-b border-border-soft pb-2">
          {SETTINGS_TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition whitespace-nowrap',
                tab === id ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text hover:bg-muted'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t(`settings.section.${id}` as TKey)}
            </button>
          ))}
        </nav>

        {/* Appearance — theme + compact + language */}
        <Section id="general" active={tab} title={t('settings.section.appearance')}>
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
          <Row label={t('settings.toolbarLabels')} hint={t('settings.toolbarLabels.hint')}>
            <Switch checked={prefs.toolbarLabels} onChange={v => setPrefs({ toolbarLabels: v })} />
          </Row>
        </Section>

        {/* Conversation — what shows up next to / inside messages */}
        <Section id="conversation" active={tab} title={t('settings.section.conversation')}>
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

        {/* Usage — subscription quota probe */}
        <Section id="usage" active={tab} title={t('settings.section.usage')}>
          <Row label={t('settings.realQuota')} hint={t('settings.realQuota.hint')}>
            <div className="flex items-center gap-2">
              <Activity className={cn('w-3.5 h-3.5', rlConsent === 'granted' ? 'text-accent' : 'text-text-muted')} />
              <Switch
                checked={rlConsent === 'granted'}
                onChange={v => { if (v) onOpenRlPrompt(); else onRlConsentChange('denied'); }}
              />
            </div>
          </Row>
          {/* macOS only: `tray.setTitle()` exists on no other platform. Needs a
              tray to draw on, so it follows the same disabled treatment as the
              close-behavior buttons above. */}
          {isMac && quotaSources.length > 0 && (
            <Row
              label={t('settings.menuBarQuota')}
              hint={appPrefs.showTrayIcon ? t('settings.menuBarQuota.hint') : t('settings.closeBehavior.disabledTip')}
            >
              <Switch
                checked={appPrefs.menuBarQuota && appPrefs.showTrayIcon}
                disabled={!appPrefs.showTrayIcon}
                onChange={v => setAppPrefs({ menuBarQuota: v })}
              />
            </Row>
          )}
          {/* The title is two bare percentages, so position is the only thing
              identifying them — this row is what makes that readable. Only
              shown while the title is on AND there are actually two numbers to
              tell apart: with one provider the title is a single unambiguous
              percentage and an order to pick would be meaningless. Driven by
              the provider list rather than a hardcoded one, so a new provider
              needs no edit here; picking one moves it to the front and the
              rest keep their relative order. */}
          {isMac && appPrefs.showTrayIcon && appPrefs.menuBarQuota && quotaSources.length > 1 && (
            <Row label={t('settings.menuBarQuotaOrder')} hint={t('settings.menuBarQuotaOrder.hint')}>
              <div className="inline-flex p-0.5 bg-muted rounded-lg gap-0.5">
                {quotaSources.map(id => {
                  // Mirrors the poller's own normalisation: the first provider
                  // the pref names that this host actually has, else the first
                  // one it has. A pref left pointing at an absent provider
                  // therefore highlights what the menu bar really draws first.
                  const first = appPrefs.menuBarQuotaOrder?.find(x => quotaSources.includes(x)) ?? quotaSources[0];
                  return (
                    <button
                      key={id}
                      onClick={() => setAppPrefs({ menuBarQuotaOrder: [id, ...SOURCE_ORDER.filter(x => x !== id)] })}
                      className={cn(
                        'px-3 py-1 rounded-md text-[12px] font-medium transition',
                        first === id ? 'bg-surface shadow-soft text-text' : 'text-text-muted hover:text-text'
                      )}
                    >
                      {getSource(id).label}
                    </button>
                  );
                })}
              </div>
            </Row>
          )}
        </Section>

        {/* Terminal — the embedded PTY, plus which external terminal the
            open-in buttons use. One section because the user's question is
            "how do terminals work here", not "which process owns them". */}
        <Section id="terminal" active={tab} title={t('settings.section.terminal')}>
          {/* Turning it on goes through the modal — it spawns a real shell and,
              on macOS, hands the CLI's permission prompts to the user under
              Lens's name. Turning it off needs no ceremony. */}
          <Row label={t('settings.embeddedTerminal')} hint={t('settings.embeddedTerminal.hint')}>
            <Switch
              checked={appPrefs.embeddedTerminal}
              onChange={v => { if (v) onOpenTerminalPrompt(); else setAppPrefs({ embeddedTerminal: false }); }}
            />
          </Row>
          {appPrefs.embeddedTerminal && (<>
          <Row label={t('settings.termWarn')} hint={t('settings.termWarn.hint')}>
            <Switch
              checked={termPrefs.warnEnabled}
              onChange={v => { setTerminalWarn({ enabled: v }); setTermTick((n: number) => n + 1); }}
            />
          </Row>
          {/* One row per CLI. Both are shown regardless of which source is
              selected in the sidebar: this is a preference about how terminals
              start, not about what the user is currently browsing, and finding
              it only after switching provider would be worse than a second
              row. The CLI's own value is kept next to the plain-language label
              so `--permission-mode auto` is recognisable to anyone who set it
              on the command line. */}
          {SOURCE_ORDER.map(id => {
            const src = getSource(id);
            if (!src.terminal.supported) return null;
            return (
              <Row key={id} label={t(src.terminal.modeLabelKey)} hint={t(src.terminal.modeHintKey)}>
                <select
                  value={getTerminalStartMode(id)}
                  onChange={e => { setTerminalStartMode(id, e.target.value); setTermTick((n: number) => n + 1); }}
                  className="px-2 py-1 rounded-lg border border-border bg-surface text-text text-[13px] outline-none focus:border-accent max-w-[15rem]"
                >
                  <option value="">{t('termMode.default')}</option>
                  {src.terminal.modes.map(m => (
                    <option key={m.value} value={m.value}>{t(m.labelKey)} — {m.value}</option>
                  ))}
                </select>
              </Row>
            );
          })}
          {termPrefs.warnEnabled && (
            <Row label={t('settings.termWarnAt')} hint={t('settings.termWarnAt.hint')}>
              <input
                type="number"
                min={MIN_WARN_THRESHOLD}
                max={MAX_WARN_THRESHOLD}
                value={termPrefs.warnThreshold}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  if (!Number.isNaN(n)) { setTerminalWarn({ threshold: n }); setTermTick((x: number) => x + 1); }
                }}
                className="w-16 px-2 py-1 rounded-lg border border-border bg-surface text-text text-[13px] text-center tabular-nums outline-none focus:border-accent"
              />
            </Row>
          )}
          </>)}
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
        </Section>

        {/* App behavior — tray + close + autostart. Standard packaged-app prefs. */}
        <Section id="general" active={tab} title={t('settings.section.appBehavior')}>
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
          {supportsLaunchAtLogin && (
            <Row label={t('settings.launchAtLogin')} hint={t('settings.launchAtLogin.hint')}>
              <Switch checked={appPrefs.launchAtLogin} onChange={v => setAppPrefs({ launchAtLogin: v })} />
            </Row>
          )}
        </Section>

        {/* Advanced — local folders + power-user toggles. Order: AI tool's
            data dir first (source-aware), then Lens's own user-data dir, then
            the debug log dir. Diagnostics-only rows live after the everyday
            ones; Demo mode (dev-only) anchors the bottom. */}
        <Section id="advanced" active={tab} title={t('settings.section.advanced')}>
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

function Section({ id, active, title, children }: { id: string; active: string; title: string; children: React.ReactNode }) {
  // Unmounted rather than hidden: every row here is a controlled input reading
  // from a store, so there is no scroll position or draft text to preserve, and
  // keeping inactive panels mounted would keep their subscriptions live for
  // nothing.
  if (id !== active) return null;
  return (
    <section className="mb-6 last:mb-0">
      {/* A tab holding one group repeats its own name here, which reads as a
          mistake — but General holds two, and there the headings are the only
          thing separating "how it looks" from "how it behaves". Cheap enough
          to always draw, and the duplication only shows on single-group tabs. */}
      <h2 className="text-[11px] uppercase tracking-wider font-semibold text-text-muted mb-2">{title}</h2>
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

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors duration-150 outline-none',
        checked ? 'bg-accent' : 'bg-muted',
        disabled && 'opacity-40 cursor-not-allowed'
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
