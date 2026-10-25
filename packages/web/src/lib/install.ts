import { signal } from '@preact/signals';

/**
 * Installing Eventide to the home screen. Chrome and Edge (Android and desktop) let a page offer its own install
 * button through `beforeinstallprompt`; Safari on iPhone does not, so there the app explains the Share menu instead.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const installPrompt = signal<InstallPrompt | null>(null);
export const installed = signal(
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
);
export const onIphone = /iphone|ipad|ipod/i.test(navigator.userAgent);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); // keep it for our own button, rather than the browser's mini-bar
  installPrompt.value = event as InstallPrompt;
});
window.addEventListener('appinstalled', () => {
  installed.value = true;
  installPrompt.value = null;
});

export async function install(): Promise<void> {
  const prompt = installPrompt.value;
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice;
  installPrompt.value = null; // a prompt can only be used once
}
