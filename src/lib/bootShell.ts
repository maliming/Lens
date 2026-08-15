// Handover from the startup skeleton in index.html to the real UI.
//
// The skeleton is markup the browser paints before this bundle has been parsed
// (see index.html). It has to stay up until React has actually put something on
// screen, and not a frame longer.
//
// Getting that moment right is the whole job. `createRoot().render()` returns
// before React has committed anything — it schedules the work — so counting
// frames from the render call can dismiss the skeleton while the root is still
// empty, which showed as the animation finishing onto a blank list. The signal
// has to come from inside React, after a commit; App calls this from a mount
// effect, and the two frames here take it from "committed" to "painted".

let dismissed = false;

export function dismissBootShell(): void {
  if (dismissed) return;
  dismissed = true;
  // Effects run after the commit but before the browser has painted it. One
  // frame to let that paint happen, a second because the first callback can
  // still run in the same frame the commit landed in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('boot-done');
    boot.addEventListener('transitionend', () => boot.remove(), { once: true });
    // A window that is hidden or occluded runs no transitions, and the element
    // must not be left sitting over the app.
    setTimeout(() => boot.remove(), 400);
  }));
}
