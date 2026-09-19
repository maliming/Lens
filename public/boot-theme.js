// Theme before first paint. `data-theme` used to be hardcoded to light, so
// anyone on the dark theme got a white flash on every launch — this has to run
// synchronously in <head>, before the body is painted, which is why it is a
// classic script and not a module.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('theme-mode'); } catch (e) {}
  var dark = mode === 'dark' || (mode !== 'light'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

  // Same for the style family. The ids repeat src/themes/families.ts.
  var family = 'lens';
  try {
    var prefs = JSON.parse(localStorage.getItem('display-prefs-v1') || 'null');
    if (prefs && /^(lens|claude|openai|github)$/.test(prefs.themeFamily)) family = prefs.themeFamily;
  } catch (e) {}
  document.documentElement.setAttribute('data-theme-family', family);
})();
