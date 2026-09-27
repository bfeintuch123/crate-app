const carousel = document.querySelector('.apps-track');
const originalApps = carousel?.querySelector('.apps-set');
if (carousel && originalApps) {
  const repeat = originalApps.cloneNode(true);
  repeat.setAttribute('aria-hidden', 'true');
  carousel.append(repeat);
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
for (const demo of document.querySelectorAll('[data-demo]')) {
  const panels = [...demo.querySelectorAll('[data-panel]')];
  const steps = [...demo.querySelectorAll('[data-step]')];
  const count = demo.querySelector('.demo-count');
  let current = 0;
  let timer;
  let userSelected = false;
  const show = index => {
    current = (index + panels.length) % panels.length;
    panels.forEach((panel, i) => {
      panel.hidden = i !== current;
      panel.classList.toggle('is-active', i === current);
    });
    steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === current);
      step.setAttribute('aria-pressed', String(i === current));
    });
    if (count) count.textContent = `${String(current + 1).padStart(2, '0')} / ${String(panels.length).padStart(2, '0')}`;
  };
  const select = index => { userSelected = true; clearInterval(timer); show(index); };
  steps.forEach((step, i) => {
    step.addEventListener('click', () => select(i));
    step.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); select(i + 1); steps[(i + 1) % steps.length].focus(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); select(i - 1); steps[(i - 1 + steps.length) % steps.length].focus(); }
    });
  });
  demo.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => select(current + Number(button.dataset.dir))));
  const observer = new IntersectionObserver(entries => {
    clearInterval(timer);
    if (entries[0].isIntersecting && !userSelected && !reducedMotion.matches) timer = setInterval(() => show(current + 1), 6000);
  }, { threshold: .45 });
  observer.observe(demo);
  reducedMotion.addEventListener?.('change', () => { clearInterval(timer); if (!reducedMotion.matches && !userSelected) timer = setInterval(() => show(current + 1), 6000); });
}

const faqItems = [...document.querySelectorAll('.faq-item')];
const mobile = window.matchMedia('(max-width: 700px)');
let faqInteracted = false;
const setFaq = selected => faqItems.forEach((item, index) => {
  const open = index === selected;
  item.classList.toggle('is-active', open);
  item.querySelector('button').setAttribute('aria-expanded', String(open));
  item.querySelector('.faq-sign').textContent = open ? '−' : '+';
  item.querySelector('.faq-answer').hidden = !open;
});
if (mobile.matches) setFaq(-1);
faqItems.forEach((item, index) => item.querySelector('button').addEventListener('click', () => {
  faqInteracted = true;
  const selected = mobile.matches && item.classList.contains('is-active') ? -1 : index;
  setFaq(selected);
  if (selected !== -1) {
    const target = mobile.matches ? item.querySelector('button') : item.querySelector('.faq-answer');
    const bounds = target.getBoundingClientRect();
    // Lower questions must reveal the selected answer; collapsing an earlier
    // mobile answer can also move the newly selected question above the viewport.
    if (bounds.top < 24 || bounds.top > window.innerHeight - 100) {
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      if (!mobile.matches) {
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
  }
}));
// Remember the reading context before a resize changes the FAQ's layout.
const faqSection = document.querySelector('.faq');
const footer = document.querySelector('.footer');
let readingFaq = false;
window.addEventListener('scroll', () => {
  const bounds = faqSection.getBoundingClientRect();
  const footerFullyVisible = footer.getBoundingClientRect().bottom <= window.innerHeight + 1;
  readingFaq = bounds.top < window.innerHeight && bounds.bottom > 0 && !footerFullyVisible;
}, { passive: true });
mobile.addEventListener?.('change', () => {
  if (!faqInteracted) { setFaq(mobile.matches ? -1 : 0); return; }
  const selected = faqItems.find(item => item.classList.contains('is-active'));
  if (!selected || !readingFaq) return;
  requestAnimationFrame(() => {
    const target = selected.querySelector(mobile.matches ? 'button' : '.faq-answer');
    const bounds = target.getBoundingClientRect();
    if (bounds.top < 24 || bounds.top > window.innerHeight - 100) {
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  });
});
