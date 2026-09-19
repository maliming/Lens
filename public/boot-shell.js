(function () {
  var boot = document.getElementById('boot');

  // Cold process start only. Two independent signals, because they cover
  // different things and neither covers both:
  //
  //   ?warm=1     main saying this process has already shown a window —
  //               catches a window that was closed and reopened, which
  //               arrives as a brand new renderer that would otherwise
  //               have no way to know.
  //   sessionStorage  survives a reload of THIS renderer, which is what
  //               a dev-server reconnect does.
  //
  // This script is included directly after the markup and runs while the
  // document is still parsing, so removing here happens before anything is
  // painted. Leaving the skeleton visible by default means a thrown exception
  // costs nothing.
  if (location.search.indexOf('warm=1') !== -1) { boot.remove(); return; }
  try {
    if (sessionStorage.getItem('lens-booted')) { boot.remove(); return; }
    sessionStorage.setItem('lens-booted', '1');
  } catch (e) {}

  // Match the widths the user dragged the panes to, so the skeleton lines up
  // with the app that is about to replace it.
  try {
    // Same keys and same clamps as the resizers in the app, so a shell built
    // here cannot land on a width the app would refuse.
    var nav = parseInt(localStorage.getItem('sidebar-width'), 10);
    if (nav >= 180 && nav <= 280) boot.style.setProperty('--boot-nav-w', nav + 'px');
    var list = parseInt(localStorage.getItem('list-width'), 10);
    if (list >= 320 && list <= 450) boot.style.setProperty('--boot-list-w', list + 'px');
  } catch (e) {}
})();
