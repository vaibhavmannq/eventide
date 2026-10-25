import {
  acceptInvite,
  addMember,
  changesSince,
  createGroup,
  createInvite,
  deleteGroup,
  deleteTransaction,
  editTransaction,
  getBalances,
  getGroup,
  leaveGroup,
  listGroups,
  previewInvite,
  recordTransaction,
  removeMember,
} from '@eventide/db';
import { settleUp } from '@eventide/ledger';
import { Hono } from 'hono';
import type { AppEnv } from './auth.ts';
import { HttpError } from './errors.ts';
import {
  acceptBody,
  afterSeq,
  editBody,
  groupId,
  idempotencyKey,
  newGroup,
  newMember,
  recordBody,
  revision,
} from './schemas.ts';

/** Every change to money must carry an Idempotency-Key, so a retry can never apply it twice (DESIGN §7). */
function keyOf(header: string | undefined): string {
  if (!header) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (a UUID)');
  return idempotencyKey.parse(header);
}

export const routes = new Hono<AppEnv>()
  .get('/me', (c) => c.json({ user: c.get('user') }))

  .get('/groups', async (c) => c.json({ groups: await listGroups(c.env.db, c.get('user').id) }))

  .post('/groups', async (c) => {
    const body = newGroup.parse(await c.req.json());
    const { groupId: id } = await createGroup(c.env.db, c.get('user').id, body);
    return c.json({ group: await getGroup(c.env.db, c.get('user').id, id) }, 201);
  })

  .get('/groups/:groupId', async (c) => {
    const id = groupId.parse(c.req.param('groupId'));
    return c.json({ group: await getGroup(c.env.db, c.get('user').id, id) });
  })

  /** Hides the group for everyone; only its creator can. The ledger itself is kept. */
  .delete('/groups/:groupId', async (c) => {
    await deleteGroup(c.env.db, c.get('user').id, groupId.parse(c.req.param('groupId')));
    return c.body(null, 204);
  })

  /** Leave a group; refused with 409 NOT_SETTLED until your balance is zero. */
  .post('/groups/:groupId/leave', async (c) => {
    await leaveGroup(c.env.db, c.get('user').id, groupId.parse(c.req.param('groupId')));
    return c.body(null, 204);
  })

  .delete('/groups/:groupId/members/:memberId', async (c) => {
    await removeMember(
      c.env.db,
      c.get('user').id,
      groupId.parse(c.req.param('groupId')),
      groupId.parse(c.req.param('memberId')),
    );
    return c.body(null, 204);
  })

  .post('/groups/:groupId/members', async (c) => {
    const id = groupId.parse(c.req.param('groupId'));
    const { displayName } = newMember.parse(await c.req.json());
    return c.json({ member: await addMember(c.env.db, c.get('user').id, id, displayName) }, 201);
  })

  .post('/groups/:groupId/invites', async (c) => {
    const id = groupId.parse(c.req.param('groupId'));
    const { token, expiresAt } = await createInvite(c.env.db, c.get('user').id, id);
    const url = new URL(`/join/${token}`, c.req.url).toString();
    return c.json({ invite: { token, url, expiresAt } }, 201);
  })

  .get('/invites/:token', async (c) =>
    c.json({ invite: await previewInvite(c.env.db, c.get('user').id, c.req.param('token')) }),
  )

  .post('/invites/:token/accept', async (c) => {
    const join = acceptBody.parse(await c.req.json());
    return c.json(await acceptInvite(c.env.db, c.get('user').id, c.req.param('token'), join));
  })

  /** The change feed, which is also how the app loads a group: ask for everything after the last seq you have. */
  .get('/groups/:groupId/changes', async (c) => {
    const id = groupId.parse(c.req.param('groupId'));
    const after = afterSeq.parse(c.req.query('after'));
    const changes = await changesSince(c.env.db, c.get('user').id, id, after, 200);
    return c.json({ changes, lastSeq: changes.at(-1)?.seq ?? after });
  })

  .post('/groups/:groupId/transactions', async (c) => {
    const key = keyOf(c.req.header('Idempotency-Key'));
    const id = groupId.parse(c.req.param('groupId'));
    const body = recordBody.parse(await c.req.json());
    const saved = await recordTransaction(c.env.db, c.get('user').id, { ...body, groupId: id, idempotencyKey: key });
    return c.json({ transaction: saved }, 201);
  })

  .put('/groups/:groupId/transactions/:id', async (c) => {
    const key = keyOf(c.req.header('Idempotency-Key'));
    const id = groupId.parse(c.req.param('groupId'));
    const body = editBody.parse(await c.req.json());
    const saved = await editTransaction(c.env.db, c.get('user').id, {
      ...body,
      groupId: id,
      id: groupId.parse(c.req.param('id')),
      idempotencyKey: key,
    });
    return c.json({ transaction: saved });
  })

  .delete('/groups/:groupId/transactions/:id', async (c) => {
    const key = keyOf(c.req.header('Idempotency-Key'));
    const saved = await deleteTransaction(c.env.db, c.get('user').id, {
      groupId: groupId.parse(c.req.param('groupId')),
      id: groupId.parse(c.req.param('id')),
      idempotencyKey: key,
      expectedRevision: revision.parse(c.req.query('revision')),
    });
    return c.json({ transaction: saved });
  })

  /** Balances per currency, and the fewest payments that would settle each currency (DESIGN §5.5). */
  .get('/groups/:groupId/balances', async (c) => {
    const id = groupId.parse(c.req.param('groupId'));
    const balances = await getBalances(c.env.db, c.get('user').id, id);
    const result: Record<string, { balances: Record<string, number>; settleUp: ReturnType<typeof settleUp> }> = {};
    for (const [currency, members] of balances) {
      result[currency] = { balances: Object.fromEntries(members), settleUp: settleUp(members) };
    }
    return c.json({ currencies: result });
  });
