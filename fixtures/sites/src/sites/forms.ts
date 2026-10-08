import type { SiteHandler } from '../context.js';
import { page } from '../html.js';

const COUNTRIES = ['Germany', 'India', 'United States'];

/** `/forms`: validation-heavy form. The seeded bug hides the error messages but still blocks submit. */
export const forms: SiteHandler = (ctx) => {
  if (ctx.path !== '/') return ctx.notFound();
  const field = (id: string, label: string, input: string) =>
    `<label for="${id}">${label}</label>\n  ${input}\n  <p id="${id}-error" class="field-error" role="alert"></p>`;
  ctx.html(
    page({
      title: 'Contact form',
      site: 'Fixture Forms',
      nav: '<a href="/forms">Form</a>',
      flags: ctx.flags,
      body: `<h1>Contact form</h1>
<form id="contact" novalidate>
  ${field('fullname', 'Full name', '<input id="fullname" name="fullname" type="text">')}
  ${field('email', 'Email address', '<input id="email" name="email" type="text">')}
  ${field('zip', 'ZIP code', '<input id="zip" name="zip" type="text">')}
  ${field('country', 'Country', `<select id="country" name="country"><option value="">Select a country</option>${COUNTRIES.map((c) => `<option>${c}</option>`).join('')}</select>`)}
  ${field('dob', 'Date of birth', '<input id="dob" name="dob" type="date">')}
  <fieldset><legend>Preferred contact</legend>
    <label><input type="radio" name="contact" value="email" checked> Email</label>
    <label><input type="radio" name="contact" value="phone"> Phone</label>
  </fieldset>
  ${field('terms', 'I accept the terms', '<input id="terms" name="terms" type="checkbox">')}
  <p><button type="submit">Send</button></p>
</form>
<p id="result" role="status"></p>`,
      script: `
var hideErrors = window.__FX__.bugs.indexOf('forms.error-not-shown') >= 0;
var form = document.getElementById('contact');
function check(id, message, ok) {
  var el = document.getElementById(id), out = document.getElementById(id + '-error');
  el.setAttribute('aria-invalid', ok ? 'false' : 'true');
  out.textContent = ok || hideErrors ? '' : message;
  return ok;
}
form.addEventListener('submit', function (e) {
  e.preventDefault();
  var v = form.elements, today = new Date().toISOString().slice(0, 10);
  var results = [
    check('fullname', 'Full name is required', v.fullname.value.trim() !== ''),
    check('email', 'Enter a valid email address', /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.email.value)),
    check('zip', 'ZIP must be 5 digits', /^\\d{5}$/.test(v.zip.value)),
    check('country', 'Select a country', v.country.value !== ''),
    check('dob', 'Date of birth must be in the past', v.dob.value !== '' && v.dob.value < today),
    check('terms', 'You must accept the terms', v.terms.checked)
  ];
  document.getElementById('result').textContent = results.every(Boolean) ? 'Form submitted' : '';
});`,
    }),
  );
};
