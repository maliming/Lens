const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSessions: (opts) => ipcRenderer.invoke('sessions:list', opts || {}),
  onSessionsUpdated: (cb) => {
    const listener = (_e, sessions) => cb(sessions);
    ipcRenderer.on('sessions:updated', listener);
    return () => ipcRenderer.removeListener('sessions:updated', listener);
  },
  getSession: (filePath) => ipcRenderer.invoke('sessions:get', filePath),
  getSubagents: (filePath) => ipcRenderer.invoke('sessions:subagents', filePath),
  deepSearch: (query, source) => ipcRenderer.invoke('sessions:deepSearch', { query, source }),
  copyResumeCommand: (id, filePath, source) => ipcRenderer.invoke('sessions:copyResumeCommand', { id, filePath, source }),
  revealInFinder: (filePath) => ipcRenderer.invoke('sessions:revealInFinder', filePath),
  revealSourceDir: (source) => ipcRenderer.invoke('app:revealSourceDir', source),
  openInVSCode: (id, filePath, source) => ipcRenderer.invoke('sessions:openInVSCode', { id, filePath, source }),
  openInTerminal: (id, filePath, source) => ipcRenderer.invoke('sessions:openInTerminal', { id, filePath, source }),
  openInITerm: (id, filePath, source) => ipcRenderer.invoke('sessions:openInITerm', { id, filePath, source }),
  listFavorites: () => ipcRenderer.invoke('favorites:list'),
  toggleFavorite: (source, id) => ipcRenderer.invoke('favorites:toggle', { source, id }),
  listExcludes: () => ipcRenderer.invoke('excludes:list'),
  toggleExclude: (source, id) => ipcRenderer.invoke('excludes:toggle', { source, id }),
  getAliases: () => ipcRenderer.invoke('aliases:get'),
  setAlias: (source, id, alias) => ipcRenderer.invoke('aliases:set', { source, id, alias }),
  readConfig: (source) => ipcRenderer.invoke('config:read', { source }),
  openConfigFile: (filePath) => ipcRenderer.invoke('config:openFile', filePath),
  getUsage: (source) => ipcRenderer.invoke('usage:summary', { source }),
  getAuthStatus: (source) => ipcRenderer.invoke(source === 'codex' ? 'codex:authStatus' : 'claude:authStatus'),
  getRateLimits: (opts) => ipcRenderer.invoke('rateLimits:get', opts || {}),
  getCredentialsLocation: () => ipcRenderer.invoke('rateLimits:credentialsLocation'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getSystemCapabilities: () => ipcRenderer.invoke('system:capabilities'),
  getAppPrefs: () => ipcRenderer.invoke('appPrefs:get'),
  setAppPrefs: (patch) => ipcRenderer.invoke('appPrefs:set', patch),
  // Dedicated consent setter — not routed through setAppPrefs so a renderer
  // compromise can't smuggle 'granted' through the generic prefs path.
  setRateLimitsConsent: (v) => ipcRenderer.invoke('rateLimits:setConsent', v),
  openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),
  openUserDataFolder: () => ipcRenderer.invoke('app:openUserDataFolder'),
  setTitleBarTheme: (theme) => ipcRenderer.invoke('win:setTitleBarTheme', theme),
});
