import { expect as pw } from '@playwright/test';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guestCheckout, launch, open, type Session } from './test-utils.js';

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

async function addTee(s: Session): Promise<void> {
  await s.page.goto(`${s.base}/shop/product/classic-tee`);
  await s.page.getByLabel('Blue').check();
  if ((await s.page.locator('select#size').count()) > 0) await s.page.getByLabel('Size').selectOption('M');
  else await s.page.getByLabel('M', { exact: true }).check();
  await s.page.getByRole('button', { name: 'Add to cart' }).click();
}

describe('shop (no bugs)', () => {
  it('completes the plan §1.2 guest checkout up to the payment step', async () => {
    await withSession({}, async ({ page, base }) => {
      await guestCheckout(page, base);
      await pw(page).toHaveURL(/\/shop\/checkout\/payment$/);
      await pw(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
      // "Stop before payment": nothing was ordered.
      expect(await page.getByText('Order placed').count()).toBe(0);
    });
  });

  it('shows the cart badge as 1 after adding one item, and lists it in the cart', async () => {
    await withSession({}, async (s) => {
      await addTee(s);
      await pw(s.page.getByRole('status')).toHaveText('1');
      await s.page.getByRole('link', { name: /^Cart/ }).click();
      await pw(s.page.getByRole('listitem')).toHaveText('Classic Tee – Blue / M');
    });
  });

  it('asks for a colour and size before adding to cart', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/shop/product/classic-tee`);
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await pw(page.getByRole('alert')).toHaveText('Choose a colour and size first.');
      await pw(page.getByRole('status')).toHaveText('0');
    });
  });

  it('searches, applies promo codes and pays', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/shop/search?q=mug`);
      await pw(page.getByRole('link', { name: 'Coffee Mug' })).toBeVisible();
      await pw(page.getByRole('link', { name: 'Classic Tee' })).toHaveCount(0);

      await page.goto(`${base}/shop/cart`);
      await page.getByLabel('Promo code').fill('save10');
      await page.getByRole('button', { name: 'Apply code' }).click();
      await pw(page.getByText('Promo applied: 10% off')).toBeVisible();
      await page.getByLabel('Promo code').fill('NOPE');
      await page.getByRole('button', { name: 'Apply code' }).click();
      await pw(page.getByText('Invalid promo code')).toBeVisible();

      await page.goto(`${base}/shop/checkout/payment`);
      await page.getByRole('button', { name: 'Pay now' }).click();
      await pw(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();
    });
  });

  it('logs in and out', async () => {
    await withSession({}, async ({ page, base }) => {
      await page.goto(`${base}/shop/login`);
      await page.getByLabel('Email').fill('demo@example.com');
      await page.getByLabel('Password').fill('wrong');
      await page.getByRole('button', { name: 'Log in' }).click();
      await pw(page.getByRole('alert')).toHaveText('Invalid email or password');
      await page.getByLabel('Email').fill('demo@example.com');
      await page.getByLabel('Password').fill('password123');
      await page.getByRole('button', { name: 'Log in' }).click();
      await pw(page.getByText('Signed in as demo@example.com')).toBeVisible();
      await page.getByRole('link', { name: 'Log out' }).click();
      await pw(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    });
  });

  it('rejects an invalid ZIP and a missing name; keeps the cart across navigation and reload', async () => {
    await withSession({}, async (s) => {
      await guestCheckout(s.page, s.base, 'abc');
      await pw(s.page.getByRole('alert')).toHaveText('Enter a valid 5-digit ZIP code');
      await pw(s.page.getByRole('heading', { name: 'Shipping' })).toBeVisible();
      await s.page.getByLabel('Full name').fill('');
      await s.page.getByLabel('ZIP code').fill('94105');
      await s.page.getByRole('button', { name: 'Continue to payment' }).click();
      await pw(s.page.getByRole('alert')).toHaveText('Enter your full name');

      await s.page.goto(`${s.base}/shop/cart`);
      await s.page.reload();
      await pw(s.page.getByRole('status')).toHaveText('1');
    });
  });
});

describe('shop seeded bugs', () => {
  it('shop.zip-validation-missing: an invalid ZIP reaches payment; the name is still required', async () => {
    await withSession({ bugs: ['shop.zip-validation-missing'] }, async (s) => {
      await guestCheckout(s.page, s.base, 'abc');
      await pw(s.page).toHaveURL(/\/checkout\/payment$/);

      await s.page.goto(`${s.base}/shop/checkout/shipping`);
      await s.page.getByRole('button', { name: 'Continue to payment' }).click();
      await pw(s.page.getByRole('alert')).toHaveText('Enter your full name');
    });
  });

  it('shop.badge-wrong-count: the badge shows one too many; the cart contents are right', async () => {
    await withSession({ bugs: ['shop.badge-wrong-count'] }, async (s) => {
      await s.page.goto(`${s.base}/shop`);
      await pw(s.page.getByRole('status')).toHaveText('0');
      await addTee(s);
      await pw(s.page.getByRole('status')).toHaveText('2');
      await s.page.getByRole('link', { name: /^Cart/ }).click();
      await pw(s.page.getByRole('listitem')).toHaveCount(1);
    });
  });

  it('shop.cart-empties-on-reload: reload empties the cart, plain navigation does not', async () => {
    await withSession({ bugs: ['shop.cart-empties-on-reload'] }, async (s) => {
      await addTee(s);
      await s.page.goto(`${s.base}/shop/cart`);
      await pw(s.page.getByRole('status')).toHaveText('1');
      await s.page.reload();
      await pw(s.page.getByRole('status')).toHaveText('0');
      await pw(s.page.getByText('Your cart is empty.')).toBeVisible();
    });
  });
});

describe('shop variants', () => {
  it('shop.guest-button-renamed: only the guest button text changes', async () => {
    await withSession({ variant: 'shop.guest-button-renamed' }, async ({ page, base }) => {
      await page.goto(`${base}/shop/checkout`);
      await pw(page.getByRole('button', { name: 'Checkout as guest' })).toBeVisible();
      await pw(page.getByRole('button', { name: 'Guest checkout' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Checkout as guest' }).click();
      await pw(page.getByRole('heading', { name: 'Shipping' })).toBeVisible();
    });
  });

  it('shop.size-picker-dropdown: the size radios become a select, and adding still works', async () => {
    await withSession({ variant: 'shop.size-picker-dropdown' }, async (s) => {
      await s.page.goto(`${s.base}/shop/product/classic-tee`);
      await pw(s.page.getByRole('combobox', { name: 'Size' })).toBeVisible();
      await pw(s.page.getByRole('radio', { name: 'M', exact: true })).toHaveCount(0);
      await pw(s.page.getByRole('radio', { name: 'Blue' })).toBeVisible();
      await addTee(s);
      await pw(s.page.getByRole('status')).toHaveText('1');
    });
  });

  it('shop.promo-in-accordion: the promo field is hidden until the accordion is opened', async () => {
    await withSession({ variant: 'shop.promo-in-accordion' }, async ({ page, base }) => {
      await page.goto(`${base}/shop/cart`);
      await pw(page.getByLabel('Promo code')).toBeHidden();
      await page.getByText('Have a promo code?').click();
      await page.getByLabel('Promo code').fill('SAVE10');
      await page.getByRole('button', { name: 'Apply code' }).click();
      await pw(page.getByText('Promo applied: 10% off')).toBeVisible();
    });
  });
});
