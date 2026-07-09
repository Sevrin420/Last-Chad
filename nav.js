(function () {
  var page = window.location.pathname.split('/').pop() || 'index.html';
  var active = {
    'clublounge.html': 'lobby',
    'index.html':      'lobby',
    'docs.html':       'docs'
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
        link('/clublounge.html', 'LOBBY', 'lobby') +
        link('/docs.html',     'DOCS', 'docs') +
      '</div>' +
    '</div>';

  var toggle   = document.getElementById('navToggle');
  var dropdown = document.getElementById('navDropdown');

  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
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
