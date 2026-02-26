(function () {
  var page = window.location.pathname.split('/').pop() || 'index.html';
  var active = {
    'mint.html':      'mint',
    'quest.html':     'base',
    'game.html':      'base',
    'stats.html':     'base',
    'docs.html':      'docs',
    'market.html':    'base',
    'chadbase.html':  'base'
  }[page] || '';

  function link(href, label, key) {
    return '<a href="' + href + '" class="nav-link' + (active === key ? ' active' : '') + '">' + label + '</a>';
  }

  var placeholder = document.getElementById('nav-placeholder');
  if (!placeholder) return;

  placeholder.outerHTML =
    '<div class="nav-wrapper">' +
      '<button class="nav-toggle" id="navToggle"><span></span><span></span><span></span></button>' +
      '<div class="nav-dropdown" id="navDropdown">' +
        link('/mint.html',     'MINT', 'mint') +
        link('/chadbase.html', 'BASE', 'base') +
        link('/docs.html',     'DOCS', 'docs') +
      '</div>' +
    '</div>';

  var toggle   = document.getElementById('navToggle');
  var dropdown = document.getElementById('navDropdown');

  toggle.addEventListener('click', function () {
    toggle.classList.toggle('open');
    dropdown.classList.toggle('show');
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.nav-wrapper')) {
      toggle.classList.remove('open');
      dropdown.classList.remove('show');
    }
  });
})();
