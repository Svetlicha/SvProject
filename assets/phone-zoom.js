(function setupPhoneZoom() {
  'use strict';
  const shell = document.getElementById('appShell');
  if (!shell) return;
  const key = 'sv_phone_zoom_v1';
  const media = window.matchMedia('(max-width: 950px)');
  let percent = 100;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= 60 && saved <= 140) {
      percent = Math.round(saved / 10) * 10;
    }
  } catch (_) {}
  const bar = document.createElement('div');
  bar.className = 'phone-zoom no-print';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Мащаб на страницата');
  bar.innerHTML = '<button type="button" data-zoom="minus" title="Намали" aria-label="Намали"><i data-lucide="minus" aria-hidden="true"></i></button><button type="button" data-zoom="reset" title="Върни на 100%" aria-label="Върни на 100%"><span aria-live="polite">100%</span></button><button type="button" data-zoom="plus" title="Увеличи" aria-label="Увеличи"><i data-lucide="plus" aria-hidden="true"></i></button>';
  document.body.appendChild(bar);
  const minus = bar.querySelector('[data-zoom="minus"]');
  const plus = bar.querySelector('[data-zoom="plus"]');
  function render() {
    shell.style.zoom = media.matches ? String(percent / 100) : '';
    bar.querySelector('span').textContent = percent + '%';
    minus.disabled = percent <= 60;
    plus.disabled = percent >= 140;
  }
  bar.addEventListener('click', function(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    percent = button.dataset.zoom === 'reset' ? 100 : Math.max(60, Math.min(140, percent + (button === plus ? 10 : -10)));
    try { localStorage.setItem(key, String(percent)); } catch (_) {}
    render();
  });
  media.addEventListener('change', render);
  bar.querySelector('[data-lucide="minus"]').textContent = '\u2212';
  bar.querySelector('[data-lucide="plus"]').textContent = '+';
  window.lucide?.createIcons({root: bar});
  render();
})();
