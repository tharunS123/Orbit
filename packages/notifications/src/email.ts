import nodemailer from 'nodemailer';
import { PRODUCT } from '@orbit/shared';

/** Email delivery behind a tiny interface: console (dev), SMTP, or Resend. */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Idempotency key so retries never send duplicates (Resend honours it). */
  idempotencyKey?: string;
}

export interface Mailer {
  readonly kind: string;
  send(msg: EmailMessage): Promise<void>;
}

export interface MailerConfig {
  provider: 'console' | 'smtp' | 'resend';
  from: string;
  smtpUrl?: string;
  resendApiKey?: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function createMailer(cfg: MailerConfig): Mailer {
  switch (cfg.provider) {
    case 'smtp': {
      if (!cfg.smtpUrl) throw new Error('SMTP_URL is required for EMAIL_PROVIDER=smtp');
      const transport = nodemailer.createTransport(cfg.smtpUrl);
      return {
        kind: 'smtp',
        async send(msg) {
          await transport.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
        },
      };
    }
    case 'resend': {
      if (!cfg.resendApiKey) throw new Error('RESEND_API_KEY is required for EMAIL_PROVIDER=resend');
      return {
        kind: 'resend',
        async send(msg) {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${cfg.resendApiKey}`,
              'content-type': 'application/json',
              ...(msg.idempotencyKey ? { 'idempotency-key': msg.idempotencyKey } : {}),
            },
            body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
          });
          if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
        },
      };
    }
    default:
      return {
        kind: 'console',
        async send(msg) {
          // Dev only: show the message (including links) in the server log.
          cfg.log?.('email (console provider)', { to: msg.to, subject: msg.subject, text: msg.text });
        },
      };
  }
}

// ───────────── templates ─────────────
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1c1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:14px;font-weight:600;color:#5b54e8;letter-spacing:.02em">${escape(PRODUCT.name)}</td></tr>
<tr><td style="padding-top:16px;font-size:20px;font-weight:650;line-height:1.3">${escape(title)}</td></tr>
<tr><td style="padding-top:12px;font-size:15px;line-height:1.6;color:#3d3b37">${bodyHtml}</td></tr>
${cta ? `<tr><td style="padding-top:24px"><a href="${escape(cta.url)}" style="display:inline-block;background:#5b54e8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${escape(cta.label)}</a></td></tr>` : ''}
<tr><td style="padding-top:28px;font-size:12px;color:#8a877f">You received this because of your ${escape(PRODUCT.name)} account. Manage email settings in Settings → Notifications.</td></tr>
</table></td></tr></table></body></html>`;
}

export const emailTemplates = {
  invitation(p: { inviter: string; workspace: string; listTitle?: string | null; url: string; role: string }): Omit<EmailMessage, 'to'> {
    const what = p.listTitle ? `the list “${p.listTitle}” in ${p.workspace}` : `the ${p.workspace} workspace`;
    return {
      subject: `${p.inviter} invited you to ${p.listTitle ?? p.workspace} on ${PRODUCT.name}`,
      text: `${p.inviter} invited you to join ${what} as ${p.role}.\n\nAccept: ${p.url}\n\nThis invitation expires in 14 days.`,
      html: layout(`${p.inviter} invited you to collaborate`, `<p>You're invited to join ${escape(what)} as <b>${escape(p.role)}</b>.</p><p>This invitation expires in 14 days.</p>`, {
        label: 'Accept invitation',
        url: p.url,
      }),
    };
  },
  reminder(p: { title: string; due: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Reminder: ${p.title}`,
      text: `${p.title}\nDue ${p.due}\n\nOpen: ${p.url}`,
      html: layout(p.title, `<p>Due ${escape(p.due)}</p>`, { label: 'Open task', url: p.url }),
    };
  },
  notification(p: { headline: string; detail?: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: p.headline,
      text: `${p.headline}\n${p.detail ?? ''}\n\nOpen: ${p.url}`,
      html: layout(p.headline, p.detail ? `<p>${escape(p.detail)}</p>` : '', { label: 'Open', url: p.url }),
    };
  },
  digest(p: { items: { headline: string; detail?: string; url: string }[]; url: string }): Omit<EmailMessage, 'to'> {
    const shown = p.items.slice(0, 10);
    const more = p.items.length - shown.length;
    return {
      subject: `You have ${p.items.length} unread updates on ${PRODUCT.name}`,
      text: `${shown.map((i) => `• ${i.headline}${i.detail ? ` — ${i.detail}` : ''}\n  ${i.url}`).join('\n')}${more > 0 ? `\n…and ${more} more` : ''}\n\nAll updates: ${p.url}`,
      html: layout(
        `You have ${p.items.length} unread updates`,
        `<ul style="padding-left:18px;margin:0">${shown
          .map((i) => `<li style="margin:6px 0"><a href="${escape(i.url)}" style="color:#1d1c1a">${escape(i.headline)}</a>${i.detail ? `<br><span style="color:#8a877f">${escape(i.detail)}</span>` : ''}</li>`)
          .join('')}</ul>${more > 0 ? `<p>…and ${more} more.</p>` : ''}`,
        { label: 'Open updates', url: p.url },
      ),
    };
  },
  meetingReady(p: { title: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Your meeting notes are ready: ${p.title}`,
      text: `Summary, decisions and action items for “${p.title}” are ready.\n\n${p.url}`,
      html: layout('Your meeting notes are ready', `<p>Summary, decisions and action items for “${escape(p.title)}” are ready to review.</p>`, {
        label: 'Review notes',
        url: p.url,
      }),
    };
  },
  accountDeleted(): Omit<EmailMessage, 'to'> {
    return {
      subject: `Your ${PRODUCT.name} account was deleted`,
      text: `Your account and personal data have been deleted. If this wasn't you, contact ${PRODUCT.supportEmail}.`,
      html: layout('Your account was deleted', `<p>Your account and personal data have been deleted. If this wasn't you, contact ${escape(PRODUCT.supportEmail)}.</p>`),
    };
  },
};
