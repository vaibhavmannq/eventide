-- Signing in to the Windows app (docs/DESIGN.md §9.1). Google refuses to sign anyone in inside an app's own web
-- view, so the app opens the sign-in in the person's browser. The browser cannot hand its session cookie to the
-- app, so the server hands it a one-time code instead, which the app swaps for a session of its own.
--
-- The code alone is not enough: the app also proves it holds a secret (the verifier) whose hash it sent when the
-- sign-in started (the challenge). Another program that registers the same eventide:// link and catches the code
-- cannot use it. Codes are single-use, stored only as hashes, and last two minutes.

create table sign_in_handoffs (
  code_hash  bytea primary key,
  user_id    uuid not null references users (id),
  challenge  text not null,
  next       text not null,
  expires_at timestamptz not null
);

-- No row-level security, like sessions: a handoff is looked up before anyone is known, and only by its code's hash.
grant select, insert, delete on sign_in_handoffs to eventide_app;
