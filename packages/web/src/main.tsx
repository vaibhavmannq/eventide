import { render } from 'preact';
import { App } from './App.tsx';
import './lib/install.ts'; // listens for the browser's install offer from the first moment
import { start } from './lib/store.ts';
import './styles.css';

render(<App />, document.getElementById('app') as HTMLElement);
void start();

// The service worker keeps the app's files on the device, so it opens offline (public/sw.js).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
