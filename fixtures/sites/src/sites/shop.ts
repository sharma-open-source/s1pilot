import type { Ctx, SiteHandler } from '../context.js';
import { readCookie } from '../flags.js';
import { esc, page } from '../html.js';

interface Product {
  slug: string;
  name: string;
  price: string;
  keywords: string[];
  sized: boolean;
}

const PRODUCTS: Product[] = [
  { slug: 'classic-tee', name: 'Classic Tee', price: '$19.00', keywords: ['t-shirt', 'tee', 'shirt'], sized: true },
  { slug: 'classic-hoodie', name: 'Classic Hoodie', price: '$39.00', keywords: ['hoodie', 'sweatshirt'], sized: true },
  { slug: 'coffee-mug', name: 'Coffee Mug', price: '$9.00', keywords: ['mug', 'cup'], sized: false },
];
const COLOURS = ['Blue', 'Black'];
const SIZES = ['S', 'M', 'L'];
const DEMO_USER = { email: 'demo@example.com', password: 'password123' };

/** Client-side cart (sessionStorage) and the header badge. Seeded cart/badge bugs live here. */
const CART_JS = `
(function () {
  var KEY = 'fx_cart', bugs = window.__FX__.bugs;
  var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  if (bugs.indexOf('shop.cart-empties-on-reload') >= 0 && nav && nav.type === 'reload') sessionStorage.removeItem(KEY);
  function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  var cart = {
    read: read,
    add: function (item) { var items = read(); items.push(item); sessionStorage.setItem(KEY, JSON.stringify(items)); cart.render(); },
    render: function () {
      var n = read().length;
      if (bugs.indexOf('shop.badge-wrong-count') >= 0 && n > 0) n = n + 1;
      var badge = document.getElementById('cart-badge');
      if (badge) badge.textContent = String(n);
    }
  };
  window.fxCart = cart;
  cart.render();
})();
`;

function nav(ctx: Ctx): string {
  const user = readCookie(ctx.req.headers.cookie, 'fx_user');
  const account = user
    ? `<span>Signed in as ${esc(user)}</span><a href="/shop/logout">Log out</a>`
    : '<a href="/shop/login">Log in</a>';
  return `<a href="/shop">Home</a>
<a href="/shop/cart">Cart <span id="cart-badge" role="status" aria-label="Cart items">0</span></a>
${account}`;
}

function layout(ctx: Ctx, title: string, body: string, script = ''): string {
  return page({
    title: `${title} · Shop`,
    site: 'Fixture Shop',
    nav: nav(ctx),
    flags: ctx.flags,
    body,
    script: CART_JS + script,
  });
}

function productCard(p: Product): string {
  return `<div class="card"><h2><a href="/shop/product/${p.slug}">${esc(p.name)}</a></h2><p>${p.price}</p></div>`;
}

function home(ctx: Ctx): void {
  ctx.html(
    layout(
      ctx,
      'Home',
      `<h1>Fixture Shop</h1>
<form action="/shop/search" method="get" role="search">
  <label for="q">Search products</label>
  <input id="q" name="q" type="search">
  <button type="submit">Search</button>
</form>
<h2>Featured</h2>
${PRODUCTS.map(productCard).join('\n')}`,
    ),
  );
}

function search(ctx: Ctx): void {
  const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
  const hits = PRODUCTS.filter(
    (p) => q === '' || p.name.toLowerCase().includes(q) || p.keywords.some((k) => k.includes(q)),
  );
  ctx.html(
    layout(
      ctx,
      'Search',
      `<h1>Search results</h1>
<p>${hits.length} result${hits.length === 1 ? '' : 's'} for "${esc(q)}"</p>
${hits.map(productCard).join('\n') || '<p>No products found.</p>'}`,
    ),
  );
}

function sizePicker(ctx: Ctx): string {
  if (ctx.flags.variants.has('shop.size-picker-dropdown')) {
    return `<label for="size">Size</label>
<select id="size" name="size"><option value="">Select size</option>${SIZES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>`;
  }
  return `<fieldset><legend>Size</legend>${SIZES.map((s) => `<label><input type="radio" name="size" value="${s}"> ${s}</label>`).join('')}</fieldset>`;
}

function product(ctx: Ctx, slug: string): void {
  const p = PRODUCTS.find((item) => item.slug === slug);
  if (!p) return ctx.notFound();
  ctx.html(
    layout(
      ctx,
      p.name,
      `<h1>${esc(p.name)}</h1>
<p>${p.price}</p>
<form id="add-form">
  <fieldset><legend>Colour</legend>${COLOURS.map((c) => `<label><input type="radio" name="colour" value="${c}"> ${c}</label>`).join('')}</fieldset>
  ${p.sized ? sizePicker(ctx) : ''}
  <p id="add-error" role="alert"></p>
  <button type="submit">Add to cart</button>
</form>`,
      `
document.getElementById('add-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target, colour = f.querySelector('[name=colour]:checked'), sizeEl = f.querySelector('[name=size]:checked') || f.querySelector('select[name=size]');
  var size = sizeEl ? sizeEl.value : '';
  var needsSize = ${p.sized ? 'true' : 'false'};
  if (!colour || (needsSize && !size)) { document.getElementById('add-error').textContent = 'Choose a colour' + (needsSize ? ' and size' : '') + ' first.'; return; }
  document.getElementById('add-error').textContent = '';
  window.fxCart.add({ slug: ${JSON.stringify(p.slug)}, name: ${JSON.stringify(p.name)}, colour: colour.value, size: size });
});`,
    ),
  );
}

function cart(ctx: Ctx): void {
  const promo = `<label for="promo">Promo code</label>
<input id="promo" name="promo" type="text">
<button type="button" id="apply-promo">Apply code</button>
<p id="promo-message" aria-live="polite"></p>`;
  const promoBlock = ctx.flags.variants.has('shop.promo-in-accordion')
    ? `<details><summary>Have a promo code?</summary>${promo}</details>`
    : promo;
  ctx.html(
    layout(
      ctx,
      'Cart',
      `<h1>Your cart</h1>
<ul id="cart-items"></ul>
<p id="cart-empty">Your cart is empty.</p>
${promoBlock}
<p><a href="/shop/checkout">Checkout</a></p>`,
      `
var items = window.fxCart.read(), list = document.getElementById('cart-items');
items.forEach(function (i) { var li = document.createElement('li'); li.textContent = i.name + ' – ' + i.colour + (i.size ? ' / ' + i.size : ''); list.appendChild(li); });
document.getElementById('cart-empty').hidden = items.length > 0;
document.getElementById('apply-promo').addEventListener('click', function () {
  var code = document.getElementById('promo').value.trim().toUpperCase();
  document.getElementById('promo-message').textContent = code === 'SAVE10' ? 'Promo applied: 10% off' : 'Invalid promo code';
});`,
    ),
  );
}

function checkout(ctx: Ctx): void {
  const guestLabel = ctx.flags.variants.has('shop.guest-button-renamed') ? 'Checkout as guest' : 'Guest checkout';
  ctx.html(
    layout(
      ctx,
      'Checkout',
      `<h1>Checkout</h1>
<form action="/shop/checkout/shipping" method="get"><button type="submit">${guestLabel}</button></form>
<p>Have an account? <a href="/shop/login">Log in</a></p>`,
    ),
  );
}

function shippingForm(ctx: Ctx, values: { name: string; zip: string }, errors: string[] = []): string {
  return layout(
    ctx,
    'Shipping',
    `<h1>Shipping</h1>
${errors.map((e) => `<p role="alert">${esc(e)}</p>`).join('\n')}
<form action="/shop/checkout/shipping" method="post">
  <label for="shipping_name">Full name</label>
  <input id="shipping_name" name="shipping_name" type="text" value="${esc(values.name)}">
  <label for="shipping_zip">ZIP code</label>
  <input id="shipping_zip" name="shipping_zip" type="text" value="${esc(values.zip)}">
  <p><button type="submit">Continue to payment</button></p>
</form>`,
  );
}

async function shipping(ctx: Ctx): Promise<void> {
  if (ctx.req.method !== 'POST') return ctx.html(shippingForm(ctx, { name: '', zip: '' }));
  const form = await ctx.form();
  const values = { name: (form.get('shipping_name') ?? '').trim(), zip: (form.get('shipping_zip') ?? '').trim() };
  const errors: string[] = [];
  if (values.name === '') errors.push('Enter your full name');
  if (!ctx.flags.bugs.has('shop.zip-validation-missing') && !/^\d{5}$/.test(values.zip)) {
    errors.push('Enter a valid 5-digit ZIP code');
  }
  if (errors.length > 0) return ctx.html(shippingForm(ctx, values, errors), 422);
  ctx.redirect('/shop/checkout/payment');
}

function payment(ctx: Ctx): void {
  ctx.html(
    layout(
      ctx,
      'Payment',
      `<h1>Payment</h1>
<form action="/shop/order-confirmation" method="post">
  <label for="card">Card number</label>
  <input id="card" name="card" type="text" autocomplete="off">
  <p><button type="submit">Pay now</button></p>
</form>`,
    ),
  );
}

function confirmation(ctx: Ctx): void {
  ctx.html(layout(ctx, 'Order placed', '<h1>Order placed</h1><p>Thank you for your order.</p>'));
}

async function login(ctx: Ctx): Promise<void> {
  if (ctx.req.method === 'POST') {
    const form = await ctx.form();
    if (form.get('email') === DEMO_USER.email && form.get('password') === DEMO_USER.password) {
      return ctx.redirect('/shop', { 'set-cookie': `fx_user=${encodeURIComponent(DEMO_USER.email)}; Path=/` });
    }
    return ctx.html(loginForm(ctx, true), 401);
  }
  ctx.html(loginForm(ctx, false));
}

function loginForm(ctx: Ctx, failed: boolean): string {
  return layout(
    ctx,
    'Log in',
    `<h1>Log in</h1>
${failed ? '<p role="alert">Invalid email or password</p>' : ''}
<form action="/shop/login" method="post">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <label for="password">Password</label>
  <input id="password" name="password" type="password">
  <p><button type="submit">Log in</button></p>
</form>`,
  );
}

/** `/shop`: search, product pages, cart, guest checkout, promo codes and login. */
export const shop: SiteHandler = async (ctx) => {
  const { path } = ctx;
  if (path === '/') return home(ctx);
  if (path === '/search') return search(ctx);
  if (path.startsWith('/product/')) return product(ctx, path.slice('/product/'.length));
  if (path === '/cart') return cart(ctx);
  if (path === '/checkout') return checkout(ctx);
  if (path === '/checkout/shipping') return shipping(ctx);
  if (path === '/checkout/payment') return payment(ctx);
  if (path === '/order-confirmation') return confirmation(ctx);
  if (path === '/login') return login(ctx);
  if (path === '/logout') return ctx.redirect('/shop', { 'set-cookie': 'fx_user=; Path=/; Max-Age=0' });
  ctx.notFound();
};
