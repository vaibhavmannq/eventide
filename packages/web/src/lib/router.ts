import { signal } from '@preact/signals';

/** The current path. The Worker serves index.html for every app path, so plain URLs work and can be shared. */
export const path = signal(location.pathname);

window.addEventListener('popstate', () => {
  path.value = location.pathname;
});

export function go(to: string, options: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  path.value = location.pathname;
  window.scrollTo(0, 0);
}

/** Matches "/groups/:id" style patterns; returns the named parts, or null. */
export function match(pattern: string, current: string): Record<string, string> | null {
  const want = pattern.split('/');
  const have = current.replace(/\/+$/, '').split('/');
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? '';
    const h = have[i] ?? '';
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(h);
    else if (w !== h) return null;
  }
  return params;
}

/** A link that navigates inside the app without reloading the page. */
export function onLink(event: MouseEvent, to: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go(to);
}
