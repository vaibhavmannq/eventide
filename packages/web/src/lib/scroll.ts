import { signal } from '@preact/signals';

/** True once the page has scrolled, so the top bar knows to darken (it is clear over the sky at the top). */
export const scrolled = signal(window.scrollY > 4);
window.addEventListener(
  'scroll',
  () => {
    scrolled.value = window.scrollY > 4;
  },
  { passive: true },
);
