import { type Browser, expect, type Page, test } from '@playwright/test';

/** A person with their own browser, signed in through the development login. */
async function person(browser: Browser, name: string, startAt = '/'): Promise<Page> {
  const context = await browser.newContext(test.info().project.use);
  const page = await context.newPage();
  await page.goto(startAt);
  await page.getByLabel('Email').fill(`${name.toLowerCase()}-${Date.now()}@example.com`);
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });

test('two flatmates share a dinner and settle up', async ({ browser }) => {
  const signedOut = await browser.newPage(test.info().project.use);
  await signedOut.goto('/');
  await expect(signedOut.getByRole('heading', { name: 'Eventide' })).toBeVisible();
  await shot(signedOut, '01-sign-in');

  // Alice starts a group.
  const alice = await person(browser, 'Alice');
  await expect(alice.getByRole('heading', { name: /Good (morning|afternoon|evening|night), Alice/ })).toBeVisible();
  await shot(alice, '02-no-groups');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill('Flat 4');
  await alice.getByLabel('Currency').selectOption('GBP');
  await alice.getByRole('button', { name: 'Create group' }).click();
  await expect(alice.getByRole('heading', { name: 'Flat 4' })).toBeVisible();

  // Adds Sam by name, and makes an invite link for Bob.
  await alice.getByRole('link', { name: 'People & invite' }).click();
  await alice.getByLabel('Name', { exact: true }).fill('Sam');
  await alice.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(alice.getByText('No account yet')).toBeVisible();
  await alice.getByRole('button', { name: 'Create invite link' }).click();
  const link = await alice.getByLabel('Invite link').inputValue();
  await shot(alice, '03-people');

  // Bob opens the link, signs in, and joins.
  const bob = await person(browser, 'Bob', new URL(link).pathname);
  await expect(bob.getByRole('heading', { name: 'Join Flat 4' })).toBeVisible();
  await expect(bob.getByRole('button', { name: 'I’m Sam' })).toBeVisible();
  await shot(bob, '04-join');
  await bob.getByLabel('Your name in this group').fill('Bob');
  await bob.getByRole('button', { name: 'Join Flat 4' }).click();
  await expect(bob.getByRole('heading', { name: 'Flat 4' })).toBeVisible();

  // Alice pays £90 for dinner for the three of them.
  await alice.getByRole('link', { name: 'Flat 4' }).click();
  await alice.reload(); // pick up Bob
  await expect(alice.getByText(/3 people/)).toBeVisible();
  await alice.getByRole('link', { name: /Add expense/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('90');
  await alice.getByLabel('What for').fill('Dinner at Bombay Canteen');
  await expect(alice.getByText('Alice paid £90.00, split 3 ways.')).toBeVisible();
  await shot(alice, '05-add-expense');
  await alice.getByRole('button', { name: 'Add expense' }).click();
  await expect(alice.getByText('You’re owed £60.00')).toBeVisible();
  await expect(alice.getByText('All saved')).toBeVisible();
  await shot(alice, '06-group-owed');

  // Bob sees he owes £30, and pays Alice back.
  await bob.reload();
  await expect(bob.getByText('You owe £30.00')).toBeVisible();
  await shot(bob, '07-group-owe');
  const bobsRow = bob.locator('.settle-row', { hasText: 'You pay' });
  await bobsRow.getByRole('button', { name: 'Mark paid' }).click();
  await expect(bob.getByText('You’re settled up')).toBeVisible();
  await expect(bob.getByText('Bob paid Alice')).toBeVisible();

  // Alice is still owed Sam's share.
  await alice.reload();
  await expect(alice.getByText('You’re owed £30.00')).toBeVisible();
  await alice.getByRole('link', { name: '← Groups' }).click();
  await expect(alice.getByText('You’re owed £30.00')).toBeVisible();
  await shot(alice, '08-groups');
});

test('an expense added offline is saved once the connection comes back', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill('Goa trip');
  await alice.getByLabel('Currency').selectOption('INR');
  await alice.getByRole('button', { name: 'Create group' }).click();
  await alice.getByRole('link', { name: 'People & invite' }).click();
  await alice.getByLabel('Name', { exact: true }).fill('Riya');
  await alice.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(alice.getByText('Riya')).toBeVisible();
  await alice.getByRole('link', { name: '← Goa trip' }).click();

  await alice.context().setOffline(true);
  await alice.getByRole('link', { name: /Add expense/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('1200');
  await alice.getByLabel('What for').fill('Scooter rental');
  await alice.getByRole('button', { name: 'Add expense' }).click();
  await expect(alice.getByText('Waiting to sync')).toBeVisible();
  await expect(alice.getByText(/Offline · 1 waiting/)).toBeVisible();
  await expect(alice.getByText('You’re owed ₹600.00')).toBeVisible(); // computed on the phone, before syncing
  await shot(alice, '09-offline');

  await alice.context().setOffline(false);
  await alice.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(alice.getByText('All saved')).toBeVisible();
  await expect(alice.getByText('Waiting to sync')).toHaveCount(0);

  // The server has it, exactly once.
  const groupId = new URL(alice.url()).pathname.split('/')[2];
  // Asked from inside the page: the session cookie is Secure, which browsers send to 127.0.0.1 but Playwright's
  // separate request client does not.
  const changes = await alice.evaluate(
    async (id) => (await (await fetch(`/api/groups/${id}/changes`)).json()).changes,
    groupId,
  );
  expect(changes).toHaveLength(1);
});

test('editing an expense updates everyone’s balance; deleting it brings them back', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill('Dinner club');
  await alice.getByLabel('Currency').selectOption('EUR');
  await alice.getByRole('button', { name: 'Create group' }).click();
  await alice.getByRole('link', { name: 'People & invite' }).click();
  await alice.getByLabel('Name', { exact: true }).fill('Marco');
  await alice.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(alice.getByText('Marco')).toBeVisible();
  await alice.getByRole('link', { name: '← Dinner club' }).click();

  await alice.getByRole('link', { name: /Add expense/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('40');
  await alice.getByLabel('What for').fill('Wine');
  await alice.getByText('Shares', { exact: true }).click();
  await alice.getByLabel('Marco’s shares').or(alice.getByLabel("Marco's shares")).fill('3');
  await expect(alice.getByText('€30.00')).toBeVisible(); // Marco: 3 of 4 shares
  await alice.getByRole('button', { name: 'Add expense' }).click();
  await expect(alice.getByText('You’re owed €30.00')).toBeVisible();

  await alice.getByRole('link', { name: /Wine/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('80');
  await alice.getByRole('button', { name: 'Save changes' }).click();
  await expect(alice.getByText('You’re owed €60.00')).toBeVisible();
  await expect(alice.getByText('All saved')).toBeVisible();

  alice.once('dialog', (dialog) => dialog.accept());
  await alice.getByRole('link', { name: /Wine/ }).click();
  await alice.getByRole('button', { name: 'Delete' }).click();
  await expect(alice.getByText('Everyone’s even')).toBeVisible();
  await expect(alice.getByText('All saved')).toBeVisible();
});

test('the split boxes stay in line while you type, even when one is empty', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill('Flat 9');
  await alice.getByLabel('Currency').selectOption('INR');
  await alice.getByRole('button', { name: 'Create group' }).click();
  await alice.getByRole('link', { name: 'People & invite' }).click();
  for (const name of ['Aditya', 'Raghav']) {
    await alice.getByLabel('Name', { exact: true }).fill(name);
    await alice.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(alice.getByText(name)).toBeVisible();
  }
  await alice.getByRole('link', { name: '← Flat 9' }).click();
  await alice.getByRole('link', { name: /Add expense/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('1500');
  await alice.getByText('Shares', { exact: true }).click();

  const boxes = alice.locator('.split-row input.small-input');
  const lefts = async () =>
    Promise.all((await boxes.all()).map(async (b) => Math.round((await b.boundingBox())?.x ?? -1)));
  const before = await lefts();
  await alice.getByLabel('Aditya’s shares').or(alice.getByLabel("Aditya's shares")).fill('');
  expect(await lefts()).toEqual(before);
  await alice.getByLabel('Aditya’s shares').or(alice.getByLabel("Aditya's shares")).fill('12');
  expect(await lefts()).toEqual(before);
  expect(new Set(before).size).toBe(1); // and they line up with each other
  await shot(alice, '10-shares');
});

test('leaving needs a zero balance; the creator can delete the group for everyone', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill('Old trip');
  await alice.getByLabel('Currency').selectOption('EUR');
  await alice.getByRole('button', { name: 'Create group' }).click();
  await alice.getByRole('link', { name: 'People & invite' }).click();
  await alice.getByLabel('Name', { exact: true }).fill('Lena');
  await alice.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(alice.getByText('Lena')).toBeVisible();
  await alice.getByRole('link', { name: '← Old trip' }).click();
  await alice.getByRole('link', { name: /Add expense/ }).click();
  await alice.getByLabel('Amount', { exact: true }).fill('20');
  await alice.getByRole('button', { name: 'Add expense' }).click();
  await expect(alice.getByText('All saved')).toBeVisible();

  await alice.getByRole('link', { name: 'People & invite' }).click();
  alice.on('dialog', (dialog) => dialog.accept());
  await alice.getByRole('button', { name: 'Remove Lena' }).click();
  await expect(alice.getByText('They still owe or are owed money here. Settle up first.')).toBeVisible();
  await alice.getByRole('button', { name: 'Leave group' }).click();
  await expect(alice.getByText('You still owe or are owed money here. Settle up first.')).toBeVisible();
  await shot(alice, '11-people');

  const remove = alice.getByRole('button', { name: 'Delete group for everyone' });
  await expect(remove).toBeDisabled();
  await alice.getByLabel('Group name').fill('Old trip');
  await remove.click();
  await expect(alice.getByRole('heading', { name: /Good/ })).toBeVisible();
  await expect(alice.getByRole('link', { name: /Old trip/ })).toHaveCount(0);
});
