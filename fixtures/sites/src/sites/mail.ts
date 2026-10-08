import type { Ctx, SiteHandler } from '../context.js';
import { esc, page } from '../html.js';

/** The one-time code shown in message 2. */
export const OTP_CODE = '482913';

const MESSAGES = [
  { id: '1', from: 'team@fixture.mail', subject: 'Welcome to Fixture Mail', body: '<p>Thanks for joining. This inbox is for testing.</p>' },
  {
    id: '2',
    from: 'security@fixture.mail',
    subject: 'Your verification code',
    body: `<p>Your one-time code is <code data-testid="otp">${OTP_CODE}</code>. It expires in 10 minutes.</p>`,
  },
  { id: '3', from: 'news@fixture.mail', subject: 'Weekly digest', body: '<p>Nothing happened this week.</p>' },
];

function layout(ctx: Ctx, title: string, body: string): string {
  return page({ title, site: 'Fixture Mail', nav: '<a href="/mail">Inbox</a>', flags: ctx.flags, body });
}

/** `/mail`: inbox list, message view and an OTP message. */
export const mail: SiteHandler = (ctx) => {
  if (ctx.path === '/') {
    return ctx.html(
      layout(
        ctx,
        'Inbox',
        `<h1>Inbox</h1>
<ul>${MESSAGES.map((m) => `<li><a href="/mail/message/${m.id}">${esc(m.subject)}</a> <small>from ${esc(m.from)}</small></li>`).join('\n')}</ul>`,
      ),
    );
  }
  const match = /^\/message\/(\d+)$/.exec(ctx.path);
  const message = MESSAGES.find((m) => m.id === match?.[1]);
  if (!message) return ctx.notFound();
  ctx.html(
    layout(
      ctx,
      message.subject,
      `<p><a href="/mail">Back to inbox</a></p>
<h1>${esc(message.subject)}</h1>
<p>From ${esc(message.from)}</p>
${message.body}`,
    ),
  );
};
