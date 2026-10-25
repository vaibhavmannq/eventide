import type { JSX } from 'preact';
import { match, path } from './lib/router.ts';
import { me } from './lib/store.ts';
import { ExpenseForm } from './screens/ExpenseForm.tsx';
import { GroupScreen } from './screens/Group.tsx';
import { Groups } from './screens/Groups.tsx';
import { Join } from './screens/Join.tsx';
import { NewGroup } from './screens/NewGroup.tsx';
import { People } from './screens/People.tsx';
import { Privacy } from './screens/Privacy.tsx';
import { SignIn } from './screens/SignIn.tsx';

/** Every screen and its address. The first pattern that matches wins; anything else is the list of groups. */
const routes: [string, (p: Record<string, string>) => JSX.Element][] = [
  ['/join/:token', (p) => <Join token={p.token ?? ''} />],
  ['/new', () => <NewGroup />],
  ['/groups/:id/add', (p) => <ExpenseForm groupId={p.id ?? ''} />],
  ['/groups/:id/t/:tid', (p) => <ExpenseForm groupId={p.id ?? ''} transactionId={p.tid} />],
  ['/groups/:id/people', (p) => <People groupId={p.id ?? ''} />],
  ['/groups/:id', (p) => <GroupScreen id={p.id ?? ''} />],
];

export function App() {
  if (match('/privacy', path.value)) return <Privacy />; // readable without signing in
  if (me.value === undefined) return <main class="page" aria-busy="true" />;
  if (me.value === null) return <SignIn />;
  for (const [pattern, screen] of routes) {
    const params = match(pattern, path.value);
    if (params) return screen(params);
  }
  return <Groups />;
}
