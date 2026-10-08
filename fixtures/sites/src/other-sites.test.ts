import { expect as pw } from '@playwright/test';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { launch, open, type Session } from './test-utils.js';

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});

async function withSession(options: Parameters<typeof open>[1], fn: (s: Session) => Promise<void>) {
  const session = await open(browser, options);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

async function saveName(s: Session, name: string): Promise<void> {
  await s.page.getByLabel('Display name').fill(name);
  await s.page.getByRole('button', { name: 'Save changes' }).click();
  await pw(s.page.getByRole('status')).toHaveText('Settings saved');
}

describe('settings', () => {
  it('saves the profile and toggles, and they persist after reload', async () => {
    await withSession({}, async (s) => {
      await s.page.goto(`${s.base}/settings`);
      await s.page.getByLabel('Dark mode').check();
      await s.page.getByLabel('Email notifications').uncheck();
      await saveName(s, 'Sam Rivers');
      await s.page.reload();
      await pw(s.page.getByLabel('Display name')).toHaveValue('Sam Rivers');
      await pw(s.page.getByLabel('Dark mode')).toBeChecked();
      await pw(s.page.getByLabel('Email notifications')).not.toBeChecked();
    });
  });

  it('settings.save-silently-fails: the toast appears but nothing is stored', async () => {
    await withSession({ bugs: ['settings.save-silently-fails'] }, async (s) => {
      await s.page.goto(`${s.base}/settings`);
      await saveName(s, 'Sam Rivers');
      await s.page.reload();
      await pw(s.page.getByLabel('Display name')).toHaveValue('Alex Doe');
    });
  });

  it('cancelling the delete dialog keeps the account; confirming deletes it', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/settings`);
      await page.getByRole('button', { name: 'Delete account' }).click();
      await pw(page.getByRole('alertdialog', { name: 'Delete account?' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pw(page.getByRole('alertdialog')).toBeHidden();
      await pw(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

      await page.getByRole('button', { name: 'Delete account' }).click();
      await page.getByRole('button', { name: 'Delete my account' }).click();
      await pw(page.getByRole('heading', { name: 'Account deleted' })).toBeVisible();
    });
  });
});

const FIELD_ERRORS: Record<string, string> = {
  fullname: 'Full name is required',
  email: 'Enter a valid email address',
  zip: 'ZIP must be 5 digits',
  country: 'Select a country',
  dob: 'Date of birth must be in the past',
  terms: 'You must accept the terms',
};

describe('forms', () => {
  it('shows an error for every invalid field and blocks submit', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/forms`);
      await page.getByRole('button', { name: 'Send' }).click();
      for (const [id, message] of Object.entries(FIELD_ERRORS)) {
        await pw(page.locator(`#${id}-error`)).toHaveText(message);
      }
      await pw(page.getByRole('status')).toHaveText('');
    });
  });

  it('submits a valid form', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/forms`);
      await page.getByLabel('Full name').fill('Alex Doe');
      await page.getByLabel('Email address').fill('alex@example.com');
      await page.getByLabel('ZIP code').fill('94105');
      await page.getByLabel('Country').selectOption('India');
      await page.getByLabel('Date of birth').fill('1990-05-17');
      await page.getByLabel('Phone').check();
      await page.getByLabel('I accept the terms').check();
      await page.getByRole('button', { name: 'Send' }).click();
      await pw(page.getByRole('status')).toHaveText('Form submitted');
    });
  });

  it('rejects a malformed email and a future date', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/forms`);
      await page.getByLabel('Email address').fill('not-an-email');
      await page.getByLabel('Date of birth').fill('2999-01-01');
      await page.getByRole('button', { name: 'Send' }).click();
      await pw(page.locator('#email-error')).toHaveText(FIELD_ERRORS['email'] as string);
      await pw(page.locator('#dob-error')).toHaveText(FIELD_ERRORS['dob'] as string);
    });
  });

  it('forms.error-not-shown: no messages appear, the fields are still marked invalid and submit is still blocked', async () => {
    await withSession({ bugs: ['forms.error-not-shown'] }, async ({ page, base }) => {
      await page.goto(`${base}/forms`);
      await page.getByRole('button', { name: 'Send' }).click();
      for (const id of Object.keys(FIELD_ERRORS)) {
        await pw(page.locator(`#${id}-error`)).toHaveText('');
      }
      await pw(page.locator('#fullname')).toHaveAttribute('aria-invalid', 'true');
      await pw(page.getByRole('status')).toHaveText('');
    });
  });
});

describe('mail', () => {
  it('lists the inbox and shows the OTP code in the verification message', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/mail`);
      await pw(page.getByRole('listitem')).toHaveCount(3);
      await page.getByRole('link', { name: 'Your verification code' }).click();
      await pw(page.getByTestId('otp')).toHaveText('482913');
      await page.getByRole('link', { name: 'Back to inbox' }).click();
      await pw(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    });
  });

  it('returns 404 for an unknown message', async ({ expect }) => {
    await withSession({}, async ({ base }) => {
      expect((await fetch(`${base}/mail/message/99`)).status).toBe(404);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    });
  });
});
