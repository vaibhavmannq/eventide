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

/** Alice's group with Bob and Sam added by name, open on a new expense. */
async function newExpenseInThree(browser: Browser, group: string) {
  const alice = await person(browser, 'Alice');
  await alice.getByRole('link', { name: /New group/ }).click();
  await alice.getByLabel('Group name').fill(group);
  await alice.getByRole('button', { name: 'Create group' }).click();
  await alice.getByRole('link', { name: 'People & invite' }).click();
  for (const name of ['Bob', 'Sam']) {
    await alice.getByLabel('Name', { exact: true }).fill(name);
    await alice.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(alice.getByText(name, { exact: true })).toBeVisible();
  }
  await alice.getByRole('link', { name: `← ${group}` }).click();
  await alice.getByRole('link', { name: /Add expense/ }).click();
  return alice;
}

const field = (page: Page, label: string) => page.getByLabel(label.replace("'", '’')).or(page.getByLabel(label));

test('splits by percentage, saying how much is left to assign', async ({ browser }) => {
  const alice = await newExpenseInThree(browser, 'Percent flat');
  await alice.getByLabel('Amount', { exact: true }).fill('1000');
  await alice.getByText('Percent', { exact: true }).click();
  await field(alice, "Alice's percentage").fill('50');
  await field(alice, "Bob's percentage").fill('25');
  await field(alice, "Sam's percentage").fill('24.5');
  await expect(alice.getByText('0.5% still to assign')).toBeVisible();
  await field(alice, "Sam's percentage").fill('25.5');
  await expect(alice.getByText('0.5% over 100%')).toBeVisible();
  await field(alice, "Sam's percentage").fill('25');
  await expect(alice.getByText('Alice paid ₹1,000.00, split 3 ways.')).toBeVisible();
  await expect(alice.locator('.split-row', { hasText: 'Bob' }).getByText('₹250.00')).toBeVisible();
  await alice.getByRole('button', { name: 'Add expense' }).click();
  await expect(alice.getByText('You’re owed ₹500.00')).toBeVisible();

  // Editing shows the percentages as they were entered.
  await alice.getByRole('link', { name: /Alice paid ₹1,000.00/ }).click();
  await expect(field(alice, "Sam's percentage")).toHaveValue('25');
});

test('several people can pay one bill', async ({ browser }) => {
  const alice = await newExpenseInThree(browser, 'Dinner for three');
  await alice.getByLabel('Amount', { exact: true }).fill('900');
  await alice.getByLabel('What for').fill('Dinner');
  await alice.getByLabel('Paid by').selectOption({ label: 'Several people…' });
  await field(alice, 'Alice paid').fill('600');
  await field(alice, 'Bob paid').fill('200');
  await expect(alice.getByText('₹100.00 of the payment still to assign')).toBeVisible();
  await field(alice, 'Bob paid').fill('400');
  await expect(alice.getByText('The payments are ₹100.00 more than the total')).toBeVisible();
  await field(alice, 'Bob paid').fill('300');
  await expect(alice.getByText('Alice and Bob paid ₹900.00, split 3 ways.')).toBeVisible();
  await shot(alice, '12-several-payers');
  await alice.getByRole('button', { name: 'Add expense' }).click();

  // Alice paid 600 and owes 300; Bob paid 300 and owes 300; Sam owes 300.
  await expect(alice.getByText('You’re owed ₹300.00')).toBeVisible();
  await expect(alice.getByText('Alice and Bob paid ₹900.00')).toBeVisible();
  await expect(alice.locator('.settle-row')).toHaveCount(1);
  await expect(alice.locator('.settle-row')).toContainText('Sam pays you');
  await expect(alice.getByText('All saved')).toBeVisible();

  // Editing opens with both payers filled in.
  await alice.getByRole('link', { name: /Dinner/ }).click();
  await expect(alice.getByLabel('Paid by')).toHaveValue('several');
  await expect(field(alice, 'Bob paid')).toHaveValue('300.00');
});
