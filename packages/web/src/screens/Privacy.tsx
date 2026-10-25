import { onLink } from '../lib/router.ts';

const CONTACT = 'vaibhavmann.10@gmail.com';

/**
 * The privacy policy: what Eventide keeps and why, in plain words. Readable without signing in, because Google's
 * consent screen links to it. Every line here must stay true of the code; change both together.
 */
export function Privacy() {
  return (
    <>
      <header class="topbar">
        <a class="mono brand" href="/" onClick={(e) => onLink(e, '/')}>
          ← Eventide
        </a>
      </header>
      <main class="page narrow privacy">
        <p class="mono label">Privacy</p>
        <h1 class="title">What Eventide keeps, and why</h1>
        <p class="muted small">Last updated 25 October 2026.</p>

        <h2 class="subtitle">What is stored</h2>
        <ul>
          <li>
            <strong>From your sign-in</strong> (GitHub or Google): your name and your verified email address. Nothing
            else is asked for: no contacts, no files, no access to your account.
          </li>
          <li>
            <strong>What you enter:</strong> your groups, the names of the people in them, and the expenses and payments
            you record, with their history of edits.
          </li>
          <li>
            <strong>To keep you signed in:</strong> one cookie holding a random session token, stored on our side only
            as a one-way hash. It expires after 30 days or when you sign out.
          </li>
          <li>
            <strong>On your device:</strong> a copy of your groups, so the app opens offline.
          </li>
        </ul>

        <h2 class="subtitle">What is not</h2>
        <p>
          No advertising, no analytics or tracking scripts, no selling or sharing of data. Eventide never moves money;
          it only records what people tell it.
        </p>

        <h2 class="subtitle">Who can see it</h2>
        <p>
          A group, its members and its expenses are visible only to the people in that group. The database enforces this
          itself, not only the app.
        </p>

        <h2 class="subtitle">Where it is kept</h2>
        <p>
          The app runs on Cloudflare; the database is Neon Postgres in Singapore. Server logs keep request times and
          error details, not the contents of your groups.
        </p>

        <h2 class="subtitle">Deleting it</h2>
        <p>
          You can leave a group once your balance there is zero, and whoever started a group can delete it. To have your
          account and everything tied to it removed, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. Amounts other
          people recorded with you are kept so their balances still add up, with your name removed.
        </p>

        <h2 class="subtitle">Contact</h2>
        <p>
          Eventide is a personal project by Vaibhav Mann. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </main>
    </>
  );
}
