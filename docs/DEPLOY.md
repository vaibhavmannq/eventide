# Deploying

Everything here is done in web dashboards; no command line needed. Secrets go into GitHub or Cloudflare
directly and never into chat, an issue, or the repository.

Free tiers used: Neon (database), Cloudflare Workers and Hyperdrive (server), GitHub Actions (deploys).

## 1. Neon: the database

1. Create the project: Postgres only, the region closest to your users, the newest Postgres version.
2. **Owner connection string, for migrations.** Project dashboard → **Connect**. Role `neondb_owner`, database
   `neondb`, and switch **connection pooling off** (a direct connection: the host has no `-pooler`). Copy it.
3. In GitHub: repository → **Settings → Secrets and variables → Actions → New repository secret**.
   Name `NEON_OWNER_URL`, value the string you copied.
4. Run the migrations: repository → **Actions → Deploy → Run workflow**, tick **Only migrate the database**.
5. **The API's own login.** Neon → **SQL Editor**, database `neondb`, and run, with a long random password from
   your password manager:

   ```sql
   create role eventide_api login password 'paste-a-long-random-password';
   grant eventide_app to eventide_api;
   ```

   Create this role in the SQL Editor, not on Neon's Roles page: roles made there get administrator rights,
   and the whole point of `eventide_api` is that it has almost none (docs/DATABASE.md).

   Use only letters and digits in the password (32 or more of them): characters like `@ : / ? #` break
   connection strings. To check it worked, run `select rolname from pg_roles where rolname like 'eventide%';`
   and expect `eventide_app` and `eventide_api`.

## 2. Cloudflare: the server

1. **Hyperdrive.** Cloudflare dashboard → **Storage & databases → Hyperdrive → Create configuration →
   Connect to public database** (Neon is reachable over the internet with TLS; the private options are for
   databases inside your own network). Name `eventide`, and the connection details of `eventide_api`, never the
   owner:
   - host: the Neon host from step 1.2, without `-pooler` (e.g. `ep-…-…​.c-3.ap-southeast-1.aws.neon.tech`)
   - port `5432`, database `neondb`, user `eventide_api`, password: the one from step 1.5

   **Turn query caching off.** Hyperdrive caches read queries by default, and does not know about row-level
   security: a cached result for one user could be served to another, and balances would lag behind writes by up
   to a minute. Eventide's reads are cheap indexed queries; it needs no cache.

   Create it, then copy its **ID** into `packages/api/wrangler.jsonc` (`hyperdrive[0].id`). The ID is not a
   secret.
2. **Placement.** `placement.region` in `wrangler.jsonc` must match the Neon region (currently
   `aws:ap-southeast-1`, Singapore), so the server runs next to the database.
3. **API token for deploys.** Cloudflare → **My Profile → API Tokens → Create Token → Edit Cloudflare Workers**
   template → your account → Create. Add it to GitHub secrets as `CLOUDFLARE_API_TOKEN`.
4. **Account ID.** Cloudflare → **Workers & Pages**: the account ID is in the right-hand column. Add it to
   GitHub secrets as `CLOUDFLARE_ACCOUNT_ID`.
5. **Deploy.** GitHub → **Actions → Deploy → Run workflow** (leave the box unticked). The Worker appears at
   `https://eventide.<your-subdomain>.workers.dev`.
6. GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   `EVENTIDE_URL` = that address, so each deploy finishes with a health check.

## 3. Sign in with GitHub

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
   - Homepage URL: `https://eventide.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://eventide.<your-subdomain>.workers.dev/api/auth/github/callback`
2. Copy the **Client ID**, and **Generate a new client secret**.
3. Cloudflare → **Workers & Pages → eventide → Settings → Variables and Secrets → Add**: `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`, both of type **Secret**.

## 4. Sign in with Google

The code is in place; the "Sign in with Google" button appears as soon as these two secrets exist.

1. **Project.** [console.cloud.google.com](https://console.cloud.google.com) → the project picker at the top →
   **New project** → name `Eventide` → Create, and make sure it is selected.
2. **Consent screen.** **APIs & Services → OAuth consent screen** (on newer consoles: **Google Auth Platform →
   Branding**). App name `Eventide`, your email as support and developer contact. Audience: **External**.
   Data access / scopes: only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`: the basic
   ones, which need no review by Google.
3. **Publish.** Under **Audience**, press **Publish app** so it is "In production". In "Testing", only test users
   you list can sign in, and their sign-ins expire after a week.
4. **Client.** **Credentials** (or **Clients**) → **Create credentials → OAuth client ID** → **Web application**,
   name `Eventide`.
   - Authorised JavaScript origins: `https://eventide.<your-subdomain>.workers.dev`
   - Authorised redirect URIs: `https://eventide.<your-subdomain>.workers.dev/api/auth/google/callback`
5. Copy the **Client ID** and **Client secret** into Cloudflare → **Workers & Pages → eventide → Settings →
   Variables and Secrets** as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, both of type **Secret**.

A person who signs in with Google and with GitHub using the same verified email is the same account.

## Protecting the free allowances

None of the free plans can charge you: there is no card on any of them. Past its limits, Cloudflare answers with an
error page until midnight UTC, Hyperdrive refuses queries, and Neon suspends the database until next month. So the
worst a stranger can do is take Eventide offline for a while. Three things make that hard:

- **Invite-only sign-up (on by default).** A new account can only be created by someone arriving through a valid
  invite link, or whose email is listed in the `ALLOWED_EMAILS` secret (comma-separated). Anyone with an account
  can always sign in. Add your own email to `ALLOWED_EMAILS` (Cloudflare → eventide → Settings → Variables and
  Secrets) so you can never lock yourself out. To open sign-up to everyone, add a variable `SIGNUPS` = `open`.
- **Rate limits** (`ratelimits` in wrangler.jsonc): 300 requests a minute per IP address, 120 per signed-in person.
  Real use is a few a minute. Over the limit the API answers 429 and the app keeps the change and retries later.
  Local development and CI set `RATE_LIMITS=off` in `.dev.vars`: there every test browser looks like one address.
- **Watching:** Cloudflare → Workers & Pages → eventide → Metrics shows requests per day; Neon → Monitoring shows
  compute hours. To sign someone out everywhere, run `delete from sessions where user_id = '…'` in Neon's SQL
  Editor, and remove them from their groups.

## Never in production

`DEV_LOGIN` lets anyone sign in as any email. It belongs only in `packages/api/.dev.vars` on your own machine.
