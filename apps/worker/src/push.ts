import { asService, type Sql } from '@orbit/database';
import type { Logger } from '@orbit/api';
import { sendApns, sendFcm, sendWebPush, type ApnsConfig, type FcmConfig, type PushPayload, type PushResult, type WebPushConfig } from '@orbit/notifications';
import type { PushSender } from './deps';

interface TokenRow {
  id: string;
  channel: 'webpush' | 'apns' | 'fcm';
  token: string;
  endpoint: string | null;
  keys: { p256dh: string; auth: string } | null;
}

/**
 * Fans a payload out to all of a user's registered devices. Channels without credentials are
 * skipped; tokens the provider reports as gone are deleted; transient failures are logged per
 * device and never block delivery to the user's other devices.
 */
export function createPushSender(opts: { sql: Sql; logger: Logger; webPush?: WebPushConfig; apns?: ApnsConfig; fcm?: FcmConfig }): PushSender {
  const { sql, logger } = opts;
  return {
    configured: Boolean(opts.webPush || opts.apns || opts.fcm),
    async send(userId, payload) {
      const tokens = await asService(sql, (tx) => tx<TokenRow[]>`
        select id, channel, token, endpoint, keys from push_tokens where user_id = ${userId} and failed_at is null`);
      let delivered = 0;
      for (const t of tokens) {
        let result: PushResult | 'skipped';
        try {
          result = await deliver(t, payload);
        } catch (error) {
          logger.warn({ channel: t.channel, tokenId: t.id, err: String(error) }, 'push delivery failed');
          continue;
        }
        if (result === 'ok') delivered += 1;
        if (result === 'gone') {
          await asService(sql, (tx) => tx`delete from push_tokens where id = ${t.id}`);
          logger.info({ channel: t.channel, tokenId: t.id }, 'push token expired; removed');
        }
      }
      return delivered;
    },
  };

  async function deliver(t: TokenRow, payload: PushPayload): Promise<PushResult | 'skipped'> {
    switch (t.channel) {
      case 'webpush':
        if (!opts.webPush || !t.keys) return 'skipped';
        return sendWebPush(opts.webPush, { endpoint: t.endpoint ?? t.token, keys: t.keys }, payload);
      case 'apns':
        return opts.apns ? sendApns(opts.apns, t.token, payload) : 'skipped';
      case 'fcm':
        return opts.fcm ? sendFcm(opts.fcm, t.token, payload) : 'skipped';
    }
  }
}
