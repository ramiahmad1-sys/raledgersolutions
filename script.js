// Mobile menu: the ☰ button shows/hides the navigation on small screens.
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.querySelector('.menu-toggle');
  var nav = document.querySelector('nav.main-nav');
  if (!btn || !nav) return;
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') nav.classList.remove('open'); });
});
