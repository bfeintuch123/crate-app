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
// Keep a pre-breakpoint reading landmark. A footer peek is not by itself
// evidence that the reader has left a visibly selected FAQ.
const footer = document.querySelector('.footer');
let keyboardInput = false;
let pointerControl = null;
let settledLayout = mobile.matches;
let readingSnapshot = null;
let restoringReading = false;
let snapshotFrame;
let resizeGeneration = 0;

const landmarkRect = landmark => landmark.range
  ? landmark.range.getBoundingClientRect() : landmark.element.getBoundingClientRect();
const visibleLandmark = landmark => {
  if (!landmark) return false;
  const rect = landmarkRect(landmark);
  return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
};
// Text ranges follow the same word when wrapping changes, including within a
// long paragraph. Container intersection alone can mistake an answer tail for
// its heading, or an offscreen focused answer for current keyboard intent.
const textLandmark = (element, firstOnly = true) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const landmark = { element, range };
      if (firstOnly || visibleLandmark(landmark)) return landmark;
    }
  }
  return firstOnly ? { element } : null;
};
const primaryLandmark = item => textLandmark(item.querySelector(mobile.matches ? 'button' : '.faq-answer h3'));
const captureReading = () => {
  const item = faqItems.find(item => item.classList.contains('is-active'));
  if (!item) return null;
  const focused = document.activeElement;
  const focusLandmark = textLandmark(focused);
  const visibleFocus = visibleLandmark(focusLandmark);
  const ownsKeyboard = keyboardInput && visibleFocus && item.contains(focused);
  if (visibleFocus && !item.contains(focused) &&
      (keyboardInput || (pointerControl && pointerControl.contains(focused)))) return null;
  let landmark;
  let primary = false;
  if (ownsKeyboard) {
    primary = focused === item.querySelector('button') || focused === item.querySelector('.faq-answer h3');
    landmark = primary ? primaryLandmark(item) : focusLandmark;
  } else {
    landmark = primaryLandmark(item);
    primary = visibleLandmark(landmark);
    if (!primary) {
      // Deliberate tie-break: footer reading wins over an unfocused answer tail.
      if (footer.getBoundingClientRect().top < innerHeight) return null;
      landmark = [...item.querySelectorAll('.faq-answer p:not(.faq-category), .faq-answer li')]
        .map(element => textLandmark(element, false)).find(Boolean);
    }
  }
  if (!visibleLandmark(landmark)) return null;
  return { item, landmark, primary, offset: landmarkRect(landmark).top,
    keyboardOwner: ownsKeyboard ? focused : null, focusedAtCapture: focused, layout: mobile.matches };
};
const scheduleReadingSnapshot = () => {
  // Capture the completed event synchronously too: a resize can arrive before
  // the next frame after a click, focus move or scroll.
  if (!restoringReading && mobile.matches === settledLayout) readingSnapshot = captureReading();
  cancelAnimationFrame(snapshotFrame);
  snapshotFrame = requestAnimationFrame(() => {
    if (!restoringReading && mobile.matches === settledLayout) readingSnapshot = captureReading();
  });
};
document.addEventListener('keydown', event => {
  if (['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
    keyboardInput = true;
    pointerControl = null;
    scheduleReadingSnapshot();
  }
}, true);
document.addEventListener('pointerdown', event => {
  keyboardInput = false;
  pointerControl = event.target.closest('button, a, input, select, textarea');
  scheduleReadingSnapshot();
}, true);
const pointerScroll = () => { keyboardInput = false; pointerControl = null; scheduleReadingSnapshot(); };
window.addEventListener('wheel', pointerScroll, { passive: true });
window.addEventListener('touchstart', pointerScroll, { passive: true });
window.addEventListener('scroll', scheduleReadingSnapshot, { passive: true });
document.addEventListener('focusin', scheduleReadingSnapshot);
document.addEventListener('click', scheduleReadingSnapshot);
window.addEventListener('resize', scheduleReadingSnapshot);
scheduleReadingSnapshot();

mobile.addEventListener?.('change', () => {
  const snapshot = readingSnapshot;
  const generation = ++resizeGeneration;
  restoringReading = true;
  if (!faqInteracted && !snapshot) setFaq(mobile.matches ? -1 : 0);
  requestAnimationFrame(() => {
    if (generation !== resizeGeneration) return;
    const focused = document.activeElement;
    // Browsers may blur a desktop heading when mobile CSS hides it. This is
    // still the same keyboard context unless a new user input took ownership.
    const keyboardFocusHidden = snapshot?.keyboardOwner && keyboardInput &&
      (focused === snapshot.keyboardOwner || (focused === document.body &&
        !visibleLandmark(textLandmark(snapshot.keyboardOwner))));
    if (snapshot && snapshot.layout !== mobile.matches &&
        snapshot.item.classList.contains('is-active') &&
        (focused === snapshot.focusedAtCapture || snapshot.item.contains(focused) || keyboardFocusHidden)) {
      const landmark = snapshot.primary ? primaryLandmark(snapshot.item) : snapshot.landmark;
      if (!visibleLandmark(landmark)) {
        const rect = landmarkRect(landmark);
        const offset = Math.max(24, Math.min(snapshot.offset, innerHeight - rect.height - 24));
        window.scrollBy({ top: rect.top - offset, behavior: 'instant' });
      }
      // Only genuine keyboard ownership permits a same-FAQ focus transfer.
      // Pointer readers and focus outside this selected FAQ are never moved.
      if (keyboardFocusHidden &&
          !visibleLandmark(textLandmark(snapshot.keyboardOwner))) {
        const target = landmark.element;
        if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON') target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
    settledLayout = mobile.matches;
    restoringReading = false;
    scheduleReadingSnapshot();
  });
});
