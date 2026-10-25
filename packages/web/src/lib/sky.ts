import { signal } from '@preact/signals';

/**
 * Which sky to show behind the app, to choose between on a real phone: open the app with ?sky=glow, clear, sea,
 * tonight or none, and it stays that way on this device. Temporary: once one is chosen, it becomes the only one.
 */
export const SKIES = ['glow', 'clear', 'sea', 'tonight', 'none'] as const;
export type Sky = (typeof SKIES)[number];

function chosen(): Sky {
  const asked = new URLSearchParams(location.search).get('sky');
  if (asked && (SKIES as readonly string[]).includes(asked)) {
    try {
      localStorage.setItem('eventide.sky', asked);
    } catch {
      // private mode: it holds for this visit only
    }
    return asked as Sky;
  }
  try {
    const kept = localStorage.getItem('eventide.sky');
    if (kept && (SKIES as readonly string[]).includes(kept)) return kept as Sky;
  } catch {
    // storage unavailable
  }
  return 'glow';
}

export const sky = signal<Sky>(chosen());
document.documentElement.dataset.sky = sky.value;

/** True once the page has scrolled, so the top bar knows to darken. */
export const scrolled = signal(window.scrollY > 4);
window.addEventListener(
  'scroll',
  () => {
    scrolled.value = window.scrollY > 4;
  },
  { passive: true },
);
