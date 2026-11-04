/* RA Ledger Solutions: gentle fade-up as sections scroll into view.
   Everything is fully visible without this script. It does nothing for visitors
   who ask their device for reduced motion, and every animation plays once. */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;

  var selectors = [
    'main section:not(.hero) .section-head',
    'main .grid > *',
    'main .cta-band .container',
    'main .page-hero .container',
    'main .contact-info .row',
    'main form.contact-form',
    'main .industry-art',
    'main .cred-extra',
    'main .scope-note'
  ];
  var els = Array.prototype.slice.call(document.querySelectorAll(selectors.join(',')));
  if (!els.length) return;

  document.documentElement.classList.add('motion-ready');

  function show(el) { el.classList.add('is-visible'); }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        show(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });

  els.forEach(function (el) {
    // Cards in a row arrive one after another
    var parent = el.parentElement;
    if (parent && parent.classList.contains('grid')) {
      var i = Array.prototype.indexOf.call(parent.children, el);
      el.style.transitionDelay = Math.min(i, 5) * 90 + 'ms';
      el.addEventListener('transitionend', function clear() {
        el.style.transitionDelay = '';
        el.removeEventListener('transitionend', clear);
      });
    }
    el.classList.add('reveal');
    observer.observe(el);
  });

  // Never leave keyboard focus inside something still faded out
  document.addEventListener('focusin', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.reveal') : null;
    if (el) show(el);
  });

  // Printouts always show everything
  window.addEventListener('beforeprint', function () { els.forEach(show); });
})();
