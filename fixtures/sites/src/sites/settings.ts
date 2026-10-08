import type { Ctx, SiteHandler } from '../context.js';
import { esc, page } from '../html.js';

function view(ctx: Ctx): string {
  const s = ctx.state.settings;
  const body = s.deleted
    ? `<h1>Account deleted</h1><p>Your account has been deleted.</p>`
    : `<h1>Settings</h1>
<form id="settings-form">
  <label for="name">Display name</label>
  <input id="name" name="name" type="text" value="${esc(s.name)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" value="${esc(s.email)}">
  <label><input type="checkbox" role="switch" name="notifications"${s.notifications ? ' checked' : ''}> Email notifications</label>
  <label><input type="checkbox" role="switch" name="darkMode"${s.darkMode ? ' checked' : ''}> Dark mode</label>
  <p><button type="submit">Save changes</button></p>
</form>
<div id="toast" class="toast" role="status" hidden></div>
<h2>Danger zone</h2>
<button type="button" id="delete-open">Delete account</button>
<dialog id="delete-dialog" role="alertdialog" aria-labelledby="delete-title">
  <h2 id="delete-title">Delete account?</h2>
  <p>This cannot be undone.</p>
  <button type="button" id="delete-cancel">Cancel</button>
  <button type="button" id="delete-confirm">Delete my account</button>
</dialog>`;
  return page({
    title: 'Settings',
    site: 'Fixture Settings',
    nav: '<a href="/settings">Settings</a>',
    flags: ctx.flags,
    body,
    script: s.deleted
      ? ''
      : `
var form = document.getElementById('settings-form'), toast = document.getElementById('toast'), dlg = document.getElementById('delete-dialog');
form.addEventListener('submit', function (e) {
  e.preventDefault();
  var data = { name: form.name.value, email: form.email.value, notifications: form.notifications.checked, darkMode: form.darkMode.checked };
  fetch('/settings/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    .then(function (r) { return r.json(); })
    .then(function () { toast.textContent = 'Settings saved'; toast.hidden = false; });
});
document.getElementById('delete-open').addEventListener('click', function () { dlg.showModal(); });
document.getElementById('delete-cancel').addEventListener('click', function () { dlg.close(); });
document.getElementById('delete-confirm').addEventListener('click', function () {
  fetch('/settings/api/delete', { method: 'POST' }).then(function () { location.reload(); });
});`,
  });
}

/** `/settings`: profile form, toggles, save toast and a delete-account dialog (sensitive action). */
export const settings: SiteHandler = async (ctx) => {
  const { path, req, state } = ctx;
  if (path === '/' && req.method === 'GET') return ctx.html(view(ctx));
  if (path === '/api/save' && req.method === 'POST') {
    const body = (await ctx.json()) as Partial<typeof state.settings> | null;
    // Seeded bug: reports success but never stores anything.
    if (!ctx.flags.bugs.has('settings.save-silently-fails') && body) {
      state.settings = {
        ...state.settings,
        name: String(body.name ?? state.settings.name),
        email: String(body.email ?? state.settings.email),
        notifications: Boolean(body.notifications),
        darkMode: Boolean(body.darkMode),
      };
    }
    return ctx.sendJson({ ok: true });
  }
  if (path === '/api/delete' && req.method === 'POST') {
    state.settings = { ...state.settings, deleted: true };
    return ctx.sendJson({ ok: true });
  }
  ctx.notFound();
};
