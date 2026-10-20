/* tagave.app/docs: the theme pill and the folding sidebar and contents list. */
(function () {
  var root = document.documentElement;
  var KEY = 'tagave-theme';
  var system = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  function saved() {
    try { var t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : null; } catch (e) { return null; }
  }
  function effective() {
    return root.getAttribute('data-theme') || (system && system.matches ? 'dark' : 'light');
  }
  var radios = document.querySelectorAll('.theme-pill input');
  function syncRadios() {
    var t = effective();
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === t;
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* not persisted */ }
    syncRadios();
  }
  function choose(theme) {
    if (theme === effective()) { apply(theme); return; }
    if (reduce && reduce.matches) { apply(theme); return; }
    if (document.startViewTransition) {
      document.startViewTransition(function () { apply(theme); });
      return;
    }
    root.classList.add('theme-fade');
    apply(theme);
    setTimeout(function () { root.classList.remove('theme-fade'); }, 320);
  }

  syncRadios();
  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener('change', function (ev) { if (ev.target.checked) choose(ev.target.value); });
  }
  /* With no saved choice the page, and the pill, follow the system. */
  if (system) {
    var onSystem = function () { if (!saved()) syncRadios(); };
    if (system.addEventListener) system.addEventListener('change', onSystem); else system.addListener(onSystem);
  }
  /* Another tab picked a theme: follow it. */
  window.addEventListener('storage', function (ev) {
    if (ev.key !== KEY) return;
    if (ev.newValue === 'light' || ev.newValue === 'dark') root.setAttribute('data-theme', ev.newValue);
    else root.removeAttribute('data-theme');
    syncRadios();
  });

  /* The sidebar folds on phones and the contents list below the wide layout; both open
     again when the window grows past their breakpoint. */
  var folds = document.querySelectorAll('details[data-fold]');
  for (var f = 0; f < folds.length; f++) {
    (function (d) {
      var mq = matchMedia(d.getAttribute('data-fold'));
      var onChange = function () { d.open = !mq.matches; };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
    })(folds[f]);
  }
  /* Picking a section from the folded contents list closes it. */
  var links = document.querySelectorAll('details[data-fold] a[href^="#"]');
  for (var l = 0; l < links.length; l++) {
    links[l].addEventListener('click', function (ev) {
      var d = ev.currentTarget.closest('details');
      if (d && matchMedia(d.getAttribute('data-fold')).matches) d.open = false;
    });
  }
})();
