import { balancesOf, type Minor, settleUp, type Transaction, type Transfer, toPostings } from '@eventide/ledger';
import { computed, signal } from '@preact/signals';
import { ApiError, api, isNetworkError } from './api.ts';
import * as idb from './idb.ts';

/**
 * Everything the app knows, as signals. The server is the source of truth; this is a copy kept in IndexedDB so
 * the app opens instantly and works offline, plus an outbox of changes waiting to be sent (docs/DESIGN.md §8).
 */

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Member {
  id: string;
  displayName: string;
  userId: string | null;
  role: 'owner' | 'member';
  leftAt?: string | null;
}

export interface Group {
  id: string;
  name: string;
  defaultCurrency: string;
  members: Member[];
}

export interface TransactionView {
  id: string;
  groupId: string;
  revision: number;
  deleted: boolean;
  description: string;
  occurredOn: string;
  transaction: Transaction;
  seq: number;
}

interface Change {
  seq: number;
  kind: 'create' | 'edit' | 'delete';
  view: TransactionView;
}

/** A change made on this device, not yet confirmed by the server. */
export interface OutboxItem {
  key: string; // the Idempotency-Key: the same on every retry, so the server applies it once
  groupId: string;
  op: 'record' | 'edit' | 'delete';
  transactionId: string;
  description: string;
  occurredOn: string;
  transaction: Transaction;
  expectedRevision: number;
  /** Set once a send was attempted: after that the body must not change under the same key. */
  sent: boolean;
  failed?: string;
}

interface GroupCache {
  group: Group;
  transactions: Record<string, TransactionView>;
  lastSeq: number;
}

export interface Providers {
  github: boolean;
  google: boolean;
  dev: boolean;
}

export const me = signal<User | null | undefined>(undefined); // undefined while loading
export const providers = signal<Providers>({ github: false, google: false, dev: false });
export const groupIds = signal<string[]>([]);
export const groups = signal<Record<string, GroupCache>>({});
export const outbox = signal<OutboxItem[]>([]);
export const online = signal(navigator.onLine);
export const syncing = signal(false);

// ─── Starting up ────────────────────────────────────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  const [cachedMe, cachedIds, cachedOutbox] = await Promise.all([
    idb.get<User>('me'),
    idb.get<string[]>('groups'),
    idb.get<OutboxItem[]>('outbox'),
  ]);
  if (cachedIds) {
    const loaded: Record<string, GroupCache> = {};
    for (const id of cachedIds) {
      const cache = await idb.get<GroupCache>(`group:${id}`);
      if (cache) loaded[id] = cache;
    }
    groups.value = loaded;
    groupIds.value = cachedIds.filter((id) => loaded[id]);
  }
  outbox.value = cachedOutbox ?? [];

  api<Providers>('GET', '/auth/providers')
    .then((p) => {
      providers.value = p;
    })
    .catch(() => {});

  try {
    const { user } = await api<{ user: User }>('GET', '/me');
    me.value = user;
    await idb.set('me', user);
    void sync();
  } catch (error) {
    if (isNetworkError(error) && cachedMe)
      me.value = cachedMe; // offline: carry on with what we have
    else me.value = null;
  }

  window.addEventListener('online', () => {
    online.value = true;
    void sync();
  });
  window.addEventListener('offline', () => {
    online.value = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void sync();
  }, 30_000);
}

export async function signOut(): Promise<void> {
  await api('POST', '/auth/logout').catch(() => {});
  await idb.clear();
  groups.value = {};
  groupIds.value = [];
  outbox.value = [];
  me.value = null;
}

// ─── Syncing ────────────────────────────────────────────────────────────────────────────────────────────────

let running: Promise<void> | undefined;
let again = false;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * After a failed send (the connection dropped, the server was busy), try again soon rather than at the next
 * 30-second tick: 1 s, then 2, 4, 8… up to 30 s, back to 1 s once a sync gets through.
 */
function retrySoon() {
  if (retryTimer || pendingCount.value === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void sync();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30_000);
}

/**
 * Sends the outbox, then pulls what changed. One run at a time. A call during a run (say, a change saved while
 * updates are being fetched) asks for one more run afterwards, because the current one may already be past the
 * outbox; without that, the change would wait for the next 30-second tick.
 */
export function sync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    syncing.value = true;
    try {
      do {
        again = false;
        try {
          await flush();
          retryDelay = 1000;
          await refreshGroups();
        } catch (error) {
          if (!isNetworkError(error)) console.error(error);
          retrySoon();
          break;
        }
      } while (again);
    } finally {
      syncing.value = false;
      running = undefined;
    }
  })();
  return running;
}

async function refreshGroups(): Promise<void> {
  const { groups: list } = await api<{ groups: Omit<Group, 'members'>[] }>('GET', '/groups');
  // A group deleted or left on another device is no longer listed: forget it here too.
  for (const id of groupIds.value) if (!list.some((g) => g.id === id)) await forget(id);
  groupIds.value = list.map((g) => g.id);
  await idb.set('groups', groupIds.value);
  await Promise.all(list.map((g) => refreshGroup(g.id)));
}

export async function refreshGroup(groupId: string): Promise<void> {
  const { group } = await api<{ group: Group }>('GET', `/groups/${groupId}`);
  const cache: GroupCache = groups.value[groupId] ?? { group, transactions: {}, lastSeq: 0 };
  let { lastSeq } = cache;
  const transactions = { ...cache.transactions };
  // Page through the feed; seq has no gaps, so "after the last one I saw" never misses a change.
  for (;;) {
    const page = await api<{ changes: Change[]; lastSeq: number }>(
      'GET',
      `/groups/${groupId}/changes?after=${lastSeq}`,
    );
    for (const { view } of page.changes) transactions[view.id] = view;
    lastSeq = page.lastSeq;
    if (page.changes.length < 200) break;
  }
  await save({ group, transactions, lastSeq });
}

async function save(cache: GroupCache): Promise<void> {
  groups.value = { ...groups.value, [cache.group.id]: cache };
  await idb.set(`group:${cache.group.id}`, cache);
}

async function saveOutbox(items: OutboxItem[]): Promise<void> {
  outbox.value = items;
  await idb.set('outbox', items);
}

/** Sends waiting changes in order. Stops at the first network failure and tries again on the next sync. */
async function flush(): Promise<void> {
  for (const item of outbox.value) {
    if (item.failed) continue;
    await saveOutbox(outbox.value.map((i) => (i.key === item.key ? { ...i, sent: true } : i)));
    try {
      const { transaction: view } = await send(item);
      await confirmed(item, view);
    } catch (error) {
      if (isNetworkError(error) || (error instanceof ApiError && (error.status >= 500 || error.status === 429)))
        throw error;
      const message =
        error instanceof ApiError && error.code === 'CONFLICT'
          ? 'Someone else changed this at the same time, so this change was not saved.'
          : error instanceof Error
            ? error.message
            : 'This change could not be saved.';
      await saveOutbox(outbox.value.map((i) => (i.key === item.key ? { ...i, failed: message } : i)));
    }
  }
}

/**
 * The server accepted a change: its new version goes into the copy and the change leaves the outbox in the same
 * moment, so nothing reading both (like nextRevision) ever sees it counted twice.
 */
async function confirmed(item: OutboxItem, view: TransactionView): Promise<void> {
  const cache = groups.value[item.groupId];
  const items = outbox.value.filter((i) => i.key !== item.key);
  if (cache) {
    const next = { ...cache, transactions: { ...cache.transactions, [view.id]: view } };
    groups.value = { ...groups.value, [item.groupId]: next };
    outbox.value = items;
    await Promise.all([idb.set(`group:${item.groupId}`, next), idb.set('outbox', items)]);
  } else {
    await saveOutbox(items);
  }
}

/**
 * The revision a new edit or delete must expect: the server's current revision, plus one for every change to
 * this transaction still waiting in the outbox (each one, record or edit, moves it on by exactly one).
 * Without this, editing something still being sent would claim to edit revision 0 and be refused.
 */
function nextRevision(groupId: string, transactionId: string): number {
  const base = groups.value[groupId]?.transactions[transactionId]?.revision ?? 0;
  const queued = outbox.value.filter((i) => i.transactionId === transactionId && !i.failed && i.op !== 'delete');
  return base + queued.length;
}

function send(item: OutboxItem): Promise<{ transaction: TransactionView }> {
  const base = `/groups/${item.groupId}/transactions`;
  const details = { description: item.description, occurredOn: item.occurredOn, transaction: item.transaction };
  if (item.op === 'record') {
    return api('POST', base, { idempotencyKey: item.key, body: { id: item.transactionId, ...details } });
  }
  if (item.op === 'edit') {
    return api('PUT', `${base}/${item.transactionId}`, {
      idempotencyKey: item.key,
      body: { expectedRevision: item.expectedRevision, ...details },
    });
  }
  return api('DELETE', `${base}/${item.transactionId}?revision=${item.expectedRevision}`, {
    idempotencyKey: item.key,
  });
}

// ─── Changing things ────────────────────────────────────────────────────────────────────────────────────────

/** Queues a new expense or payment, shows it straight away, and sends it when possible. */
export async function record(
  groupId: string,
  details: { description: string; occurredOn: string; transaction: Transaction },
): Promise<void> {
  const item: OutboxItem = {
    key: crypto.randomUUID(),
    groupId,
    op: 'record',
    transactionId: crypto.randomUUID(),
    expectedRevision: 0,
    sent: false,
    ...details,
  };
  await saveOutbox([...outbox.value, item]);
  void sync();
}

export async function edit(
  current: TransactionView,
  details: { description: string; occurredOn: string; transaction: Transaction },
): Promise<void> {
  const waiting = outbox.value.find((i) => i.transactionId === current.id && i.op === 'record' && !i.sent);
  if (waiting) {
    // Never sent: change it in place, under a fresh key since the body changed.
    await saveOutbox(outbox.value.map((i) => (i === waiting ? { ...i, ...details, key: crypto.randomUUID() } : i)));
  } else {
    await saveOutbox([
      ...outbox.value,
      {
        key: crypto.randomUUID(),
        groupId: current.groupId,
        op: 'edit',
        transactionId: current.id,
        expectedRevision: nextRevision(current.groupId, current.id),
        sent: false,
        ...details,
      },
    ]);
  }
  void sync();
}

export async function remove(current: TransactionView): Promise<void> {
  const waiting = outbox.value.find((i) => i.transactionId === current.id && i.op === 'record' && !i.sent);
  if (waiting) {
    await saveOutbox(outbox.value.filter((i) => i !== waiting));
    return;
  }
  await saveOutbox([
    ...outbox.value,
    {
      key: crypto.randomUUID(),
      groupId: current.groupId,
      op: 'delete',
      transactionId: current.id,
      expectedRevision: nextRevision(current.groupId, current.id),
      sent: false,
      description: current.description,
      occurredOn: current.occurredOn,
      transaction: current.transaction,
    },
  ]);
  void sync();
}

export async function dismiss(item: OutboxItem): Promise<void> {
  await saveOutbox(outbox.value.filter((i) => i.key !== item.key));
}

export async function createGroup(input: { name: string; currency: string; displayName: string }): Promise<string> {
  const { group } = await api<{ group: Group }>('POST', '/groups', { body: input });
  await save({ group, transactions: {}, lastSeq: 0 });
  groupIds.value = [...groupIds.value, group.id];
  await idb.set('groups', groupIds.value);
  return group.id;
}

export async function addMember(groupId: string, displayName: string): Promise<void> {
  await api('POST', `/groups/${groupId}/members`, { body: { displayName } });
  await refreshGroup(groupId);
}

/** Removes the group from this device after it was deleted or left. */
async function forget(groupId: string): Promise<void> {
  const { [groupId]: _gone, ...rest } = groups.value;
  groups.value = rest;
  groupIds.value = groupIds.value.filter((id) => id !== groupId);
  outbox.value = outbox.value.filter((i) => i.groupId !== groupId);
  await Promise.all([
    idb.set('groups', groupIds.value),
    idb.set('outbox', outbox.value),
    idb.set(`group:${groupId}`, undefined),
  ]);
}

export async function deleteGroup(groupId: string): Promise<void> {
  await api('DELETE', `/groups/${groupId}`);
  await forget(groupId);
}

export async function leaveGroup(groupId: string): Promise<void> {
  await api('POST', `/groups/${groupId}/leave`);
  await forget(groupId);
}

export async function removeMember(groupId: string, memberId: string): Promise<void> {
  await api('DELETE', `/groups/${groupId}/members/${memberId}`);
  await refreshGroup(groupId);
}

export async function createInvite(groupId: string): Promise<string> {
  const { invite } = await api<{ invite: { url: string } }>('POST', `/groups/${groupId}/invites`);
  return invite.url;
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────────────────────────

/** A transaction as the app shows it: the server's version with this device's waiting changes applied. */
export interface Shown extends TransactionView {
  pending?: boolean;
  failed?: string;
}

export function shownTransactions(groupId: string): Shown[] {
  const cache = groups.value[groupId];
  const shown = new Map<string, Shown>();
  for (const view of Object.values(cache?.transactions ?? {})) if (!view.deleted) shown.set(view.id, view);
  for (const item of outbox.value) {
    if (item.groupId !== groupId) continue;
    const base = shown.get(item.transactionId);
    if (item.failed) {
      if (base) shown.set(base.id, { ...base, failed: item.failed });
      continue;
    }
    if (item.op === 'delete') {
      shown.delete(item.transactionId);
      continue;
    }
    shown.set(item.transactionId, {
      id: item.transactionId,
      groupId,
      revision: base?.revision ?? 0,
      deleted: false,
      description: item.description,
      occurredOn: item.occurredOn,
      transaction: item.transaction,
      seq: base?.seq ?? Number.MAX_SAFE_INTEGER,
      pending: true,
    });
  }
  return [...shown.values()].sort((a, b) =>
    a.occurredOn === b.occurredOn ? b.seq - a.seq : a.occurredOn < b.occurredOn ? 1 : -1,
  );
}

export interface CurrencySummary {
  currency: string;
  balances: Map<string, Minor>;
  settleUp: Transfer[];
}

/**
 * Balances and settle-up, computed on the device with the same ledger code the server uses, including changes
 * that have not synced yet. The server's balances are the ones that count; these match them once synced.
 */
export function summarise(groupId: string): CurrencySummary[] {
  const postings = shownTransactions(groupId).flatMap((t) => {
    try {
      return toPostings(t.transaction);
    } catch {
      return []; // a change the server would refuse; it shows as failed instead
    }
  });
  return [...balancesOf(postings)].map(([currency, balances]) => ({
    currency,
    balances,
    settleUp: settleUp(balances),
  }));
}

export const myMemberId = (group: Group | undefined) =>
  group?.members.find((m) => m.userId && m.userId === me.value?.id)?.id;

export const pendingCount = computed(() => outbox.value.filter((i) => !i.failed).length);
