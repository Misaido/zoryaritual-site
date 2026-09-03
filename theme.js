/* Theme toggle, shared by every page.
   The initial theme is set by a tiny inline snippet in each page's <head>
   so there is no flash of the wrong theme before this file loads. */
(function () {
  var STORAGE_KEY = 'zorya-theme';
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  var meta = document.querySelector('meta[name="theme-color"]');

  var BAR = { light: '#FAF7F4', dark: '#0D0A12' };

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(mode) {
    root.setAttribute('data-theme', mode);
    if (meta) { meta.setAttribute('content', BAR[mode]); }
    if (toggle) {
      toggle.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
      toggle.setAttribute(
        'aria-label',
        mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
      );
    }
  }

  apply(current());

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    });
  }

  // Follow the system if the visitor has never chosen explicitly.
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) {
      var stored = null;
      try { stored = localStorage.getItem(STORAGE_KEY); } catch (err) {}
      if (!stored) { apply(e.matches ? 'dark' : 'light'); }
    };
    if (mq.addEventListener) { mq.addEventListener('change', onChange); }
    else if (mq.addListener) { mq.addListener(onChange); }
  } catch (e) {}
})();
