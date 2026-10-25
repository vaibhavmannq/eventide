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

## 2. Cloudflare: the server

1. **Hyperdrive.** Cloudflare dashboard → **Storage & databases → Hyperdrive → Create configuration**. Name
   `eventide`. Connection string: the direct one from step 1.2, with the user and password replaced by
   `eventide_api` and its password:
   `postgresql://eventide_api:PASSWORD@ep-....neon.tech/neondb?sslmode=require`.
   Create it, then copy its **ID** into `packages/api/wrangler.jsonc` (`hyperdrive[0].id`). The ID is not a
   secret.
2. **Placement.** In `wrangler.jsonc`, set `placement.region` to the Neon region, for example
   `aws:ap-southeast-1`, so the server runs next to the database.
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

Sign in with Google works the same way (Google Cloud console → OAuth client, callback
`/api/auth/google/callback`, secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) and can come later.

## Never in production

`DEV_LOGIN` lets anyone sign in as any email. It belongs only in `packages/api/.dev.vars` on your own machine.
