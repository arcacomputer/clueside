const samples = {
  real: {
    label: 'likely real', score: 0.12, cf: 0.08, dino: 0.18, meta: 'camera metadata', verdict: 'OK', className: 'is-real', art: 'photo-real'
  },
  generated: {
    label: 'likely generated', score: 0.91, cf: 0.84, dino: 0.91, meta: 'generator trace', verdict: 'AI', className: 'is-ai', art: 'photo-ai'
  },
  uncertain: {
    label: 'not sure', score: 0.57, cf: 0.48, dino: 0.57, meta: 'no strong trace', verdict: '?', className: 'is-uncertain', art: 'photo-uncertain'
  }
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const buttons = [...document.querySelectorAll('[data-sample]')];
const frame = document.querySelector('.scan-frame');
const score = document.querySelector('[data-score]');
const label = document.querySelector('[data-label]');
const badge = document.querySelector('[data-badge]');
const meta = document.querySelector('[data-meta]');
const cfBar = document.querySelector('[data-cf]');
const dinoBar = document.querySelector('[data-dino]');
const fusionBar = document.querySelector('[data-fusion]');

function pct(value) { return `${Math.round(value * 100)}%`; }

function setSample(key) {
  const item = samples[key];
  buttons.forEach((button) => {
    const active = button.dataset.sample === key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  frame.className = `scan-frame ${item.art}`;
  badge.className = `image-badge ${item.className}`;
  badge.textContent = `${item.verdict} ${pct(item.score)}`;
  score.textContent = pct(item.score);
  label.textContent = item.label;
  meta.textContent = item.meta;
  cfBar.style.setProperty('--value', pct(item.cf));
  dinoBar.style.setProperty('--value', pct(item.dino));
  fusionBar.style.setProperty('--value', pct(item.score));
  if (!reduceMotion) {
    frame.classList.remove('scan-once');
    requestAnimationFrame(() => frame.classList.add('scan-once'));
  }
}

buttons.forEach((button) => button.addEventListener('click', () => setSample(button.dataset.sample)));
setSample('generated');

document.querySelector('[data-year]').textContent = new Date().getFullYear();
