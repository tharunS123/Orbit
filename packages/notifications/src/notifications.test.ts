import { describe, expect, it } from 'vitest';
import { createMailer, emailTemplates } from './email';
import { notificationCopy } from './copy';

const task = '00000000-0000-4000-8000-000000000001';

describe('notificationCopy', () => {
  it('describes actions with the actor and task title, linking to the task', () => {
    expect(notificationCopy({ type: 'task_assigned', actorName: 'Ana', data: { title: 'Ship it' }, taskId: task, listId: null, meetingId: null })).toEqual({
      headline: 'Ana assigned you “Ship it”',
      detail: null,
      path: `/task?id=${task}`,
    });
  });

  it('falls back gracefully without actor or title', () => {
    const c = notificationCopy({ type: 'comment', actorName: null, data: {}, taskId: null, listId: null, meetingId: null });
    expect(c.headline).toBe('Someone commented on a task');
    expect(c.path).toBe('/updates');
  });

  it('formats due reminders without quotes', () => {
    const c = notificationCopy({ type: 'task_due', actorName: null, data: { title: 'Pay rent', due: 'Today 09:00' }, taskId: task, listId: null, meetingId: null });
    expect(c).toMatchObject({ headline: 'Pay rent is due', detail: 'Today 09:00' });
  });
});

describe('email templates', () => {
  it('escapes user content in HTML', () => {
    const m = emailTemplates.digest({ items: [{ headline: '<script>alert(1)</script>', url: 'https://app.test/x?a=1&b=2' }, { headline: 'Two', url: 'https://app.test/y' }], url: 'https://app.test/updates' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('a=1&amp;b=2');
    expect(m.subject).toContain('2 unread updates');
  });

  it('caps long digests', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ headline: `Item ${i}`, url: `https://app.test/${i}` }));
    const m = emailTemplates.digest({ items, url: 'https://app.test/updates' });
    expect(m.text).toContain('…and 4 more');
    expect(m.text).not.toContain('Item 12');
  });
});

describe('createMailer', () => {
  it('logs instead of sending with the console provider', async () => {
    const logged: unknown[] = [];
    const mailer = createMailer({ provider: 'console', from: 'x@y.z', log: (msg, data) => logged.push({ msg, data }) });
    await mailer.send({ to: 'a@b.c', subject: 'Hi', text: 'Body', html: '<p>Body</p>' });
    expect(mailer.kind).toBe('console');
    expect(logged).toHaveLength(1);
  });

  it('requires credentials for real providers', () => {
    expect(() => createMailer({ provider: 'smtp', from: 'x@y.z' })).toThrow(/SMTP_URL/);
    expect(() => createMailer({ provider: 'resend', from: 'x@y.z' })).toThrow(/RESEND_API_KEY/);
  });
});
