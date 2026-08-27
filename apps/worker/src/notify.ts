import type { Notifications, StatusChangePayload } from '@statusbeam/core'
import type { Env } from './env'
import { toSlackMessage, toTelegramMessage } from '@statusbeam/core'

export type NotificationChannel = 'slack' | 'telegram' | 'webhook'

/**
 * A single ready-to-POST notification, discriminated by channel so the delivery
 * layer can construct each target's wire URL at POST time:
 *
 * - `slack` and `webhook` carry their target `url` directly.
 * - `telegram` deliberately carries **no** target URL: the Bot API send URL
 *   embeds the bot token (`/bot<TOKEN>/sendMessage`), which is a Cloudflare
 *   secret and must never be serialized — a Queue message is persisted
 *   (and a dead-lettered message survives indefinitely). So the message only
 *   carries `chatId`; the delivery layer builds the URL just-in-time from the
 *   consumer Env secret (`TELEGRAM_BOT_TOKEN`). Inline delivery may construct
 *   it transiently the same way.
 *
 * This is the wire shape for both delivery modes — inline dispatch POSTs it
 * directly; queue dispatch enqueues it as one message.
 */
export interface NotificationMessage {
  kind: NotificationChannel
  /** Target URL for `slack` / `webhook` messages; `''` for `telegram`. */
  url: string
  /** Telegram chat/channel target; meaningful only when `kind === 'telegram'`. */
  chatId: string | number
  body: unknown
}

/** Cloudflare Queues caps a single `sendBatch` at 100 messages. */
const QUEUE_BATCH_LIMIT = 100

/**
 * Resolve the wire URL for a message, injecting the secret **only** when a
 * `telegram` message is actually being delivered. Returns `undefined` when a
 * Telegram message has no token — the caller skips (isolates) that single
 * target so one missing secret never fails the run.
 */
function targetUrl(message: NotificationMessage, telegramToken: string | undefined): string | undefined {
  if (message.kind === 'telegram') {
    return telegramToken
      ? `https://api.telegram.org/bot${telegramToken}/sendMessage`
      : undefined
  }
  return message.url
}

/**
 * Fan a status-change payload out into one {@link NotificationMessage} per
 * configured target. Shared by both delivery modes so they dispatch to exactly
 * the same set of targets with the same bodies.
 *
 * The bot token is **never** involved here — Telegram messages carry only the
 * `chatId` plus their formatted body. The token is injected solely at delivery
 * time (see {@link deliverNotification}) from the consumer Env secret, so no
 * serialized queue payload can ever contain it.
 */
export function buildNotificationMessages(
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
): NotificationMessage[] {
  if (!notifications) {
    return []
  }
  const messages: NotificationMessage[] = []
  if (notifications.slack) {
    messages.push({ kind: 'slack', url: notifications.slack.webhookUrl, chatId: '', body: toSlackMessage(payload) })
  }
  if (notifications.telegram) {
    messages.push({
      kind: 'telegram',
      url: '',
      chatId: notifications.telegram.chatId,
      body: toTelegramMessage(payload, notifications.telegram.chatId),
    })
  }
  for (const hook of notifications.webhooks ?? []) {
    messages.push({ kind: 'webhook', url: hook.url, chatId: '', body: payload })
  }
  return messages
}

/**
 * Deliver a status-change payload, picking the transport from
 * `notifications.delivery` (see {@link Notifications}):
 *
 * - `queue`: enqueue one message per target onto {@link Env.NOTIFY_QUEUE} so a
 *   consumer dispatches them with the queue's retries + dead-lettering.
 * - `inline` (default): POST each target directly here.
 *
 * Falls back to inline dispatch — so a status change is never silently dropped —
 * whenever the queue path can't be taken:
 * - the queue binding is absent (misconfiguration, or the free plan where Queues
 *   is unavailable), or
 * - the enqueue itself fails (`sendBatch` throws on a quota/throttle/transient
 *   API error).
 * Both cases warn the operator so the misconfiguration or outage is visible.
 */
export async function notify(
  env: Env,
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (notifications?.delivery === 'queue') {
    if (env.NOTIFY_QUEUE) {
      const messages = buildNotificationMessages(notifications, payload)
      if (messages.length === 0) {
        return
      }
      // Chunk to the sendBatch limit so a large target list still takes the
      // queue path instead of erroring straight into the inline fallback.
      let enqueued = 0
      try {
        for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
          const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT)
          await env.NOTIFY_QUEUE.sendBatch(chunk.map(body => ({ body })))
          enqueued += chunk.length
        }
        return
      }
      catch (err) {
        // A chunk failed to enqueue. `sendBatch` is atomic per call, so
        // `enqueued` counts only fully-accepted chunks — fall back to inline for
        // just the un-enqueued remainder. Re-dispatching the already-queued
        // messages would double-deliver them. Log with the file's `notify:`
        // style (counts, never payload contents).
        console.error(`notify: enqueue failed after ${enqueued}/${messages.length} message(s); dispatching the rest inline`, err)
        await postAll(fetchImpl, messages.slice(enqueued), env.TELEGRAM_BOT_TOKEN)
        return
      }
    }
    else {
      console.warn(
        'notify: notifications.delivery is "queue" but the NOTIFY_QUEUE binding is missing; '
        + 'add the queues.producers binding in wrangler.jsonc. Falling back to inline dispatch.',
      )
    }
  }
  await dispatchNotifications(notifications, payload, fetchImpl, env.TELEGRAM_BOT_TOKEN)
}

/**
 * Inline dispatch: POST every target directly (the default transport {@link notify}
 * selects, and its fallback when the queue path is unavailable). Failures are
 * logged, never thrown, so one bad target cannot wedge the run and a status
 * change still reaches the healthy targets. Best-effort — no retries; the
 * {@link notify} queue path is the opt-in reliable alternative. Resolves once
 * every dispatch settles.
 */
export async function dispatchNotifications(
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
  fetchImpl: typeof fetch = fetch,
  telegramToken?: string,
): Promise<void> {
  await postAll(fetchImpl, buildNotificationMessages(notifications, payload), telegramToken)
}

/** POST every message inline, swallowing individual failures. */
async function postAll(
  fetchImpl: typeof fetch,
  messages: NotificationMessage[],
  telegramToken?: string,
): Promise<void> {
  await Promise.allSettled(messages.map(m => postJson(fetchImpl, m, telegramToken)))
}

/**
 * Queue consumer: deliver each message, acking on success and retrying on
 * failure. Cloudflare Queues re-delivers retried messages with backoff and,
 * once `max_retries` is exhausted, routes them to the configured dead-letter
 * queue — so a persistently failing target surfaces there, never silently
 * dropped. Messages are settled independently so one bad target doesn't force
 * healthy ones to redeliver.
 *
 * `telegramToken` is the consumer's own Env secret (`TELEGRAM_BOT_TOKEN`): the
 * queued Telegram message contains no token, so delivery injects it here — and
 * only here — via {@link deliverNotification}.
 */
export async function consumeNotificationBatch(
  batch: MessageBatch<NotificationMessage>,
  fetchImpl: typeof fetch = fetch,
  telegramToken?: string,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await deliverNotification(message.body, fetchImpl, telegramToken)
      }
      catch (err) {
        // Delivery failed — retry so Queues re-delivers and eventually
        // dead-letters. Keep `ack()` out of this try so a post-success ack
        // failure isn't misread as a delivery failure and spuriously retried.
        console.error(`notify: queue delivery failed, retrying`, err)
        // Do NOT swallow a retry() failure: an unsettled message is implicitly
        // acked when the handler returns, so swallowing here would silently drop
        // a notification that failed to deliver. Let it propagate — the batch
        // fails and Queues redelivers the message. (A settle call throwing is a
        // near-impossible runtime edge; when it does, redelivering — duplicates
        // and all — beats dropping an alert.)
        message.retry()
        return
      }
      try {
        message.ack()
      }
      catch (err) {
        // Delivery already succeeded; a failed ack must not crash the batch or
        // trigger a retry (that would re-POST a delivered notification). Log in
        // the file's `notify:` style and let Queues auto-settle the message.
        console.error(`notify: ack failed after successful delivery`, err)
      }
    }),
  )
}

/**
 * POST one notification message. Throws on a network error or a non-2xx
 * response so the queue consumer retries (and eventually dead-letters) it. The
 * inline path wraps this in {@link postJson} to swallow failures instead.
 *
 * The Telegram Bot API URL is constructed **here**, at delivery time, from the
 * supplied token — the token never lives in a stored message. When a Telegram
 * message has no token, it is isolated (logged and skipped) rather than
 * retried: a missing secret will never become available later, so retrying
 * would only wedge the queue.
 */
export async function deliverNotification(
  message: NotificationMessage,
  fetchImpl: typeof fetch = fetch,
  telegramToken?: string,
): Promise<void> {
  const url = targetUrl(message, telegramToken)
  if (url === undefined) {
    // `kind === 'telegram'` without a token. Skip only this target; treat the
    // delivery as successful so the queue acks (a retry could never succeed).
    console.warn(
      'notify: telegram is configured but the TELEGRAM_BOT_TOKEN secret is missing; skipping the Telegram target',
    )
    return
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.body),
    // Cap a slow/hung target so it can't stall the queue consumer (or hold an
    // inline `ctx.waitUntil`). A timeout aborts as a throw → the consumer
    // retries (transient), the inline path swallows it.
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`POST ${redactUrl(url)} failed (${res.status})`)
  }
}

/** Scheme + host only — webhook URLs embed secrets (Slack path, `?token=`). */
function redactUrl(url: string): string {
  try {
    return new URL(url).origin
  }
  catch {
    return '<invalid url>'
  }
}

/** Inline variant of {@link deliverNotification}: logs failures, never throws. */
async function postJson(
  fetchImpl: typeof fetch,
  message: NotificationMessage,
  telegramToken?: string,
): Promise<void> {
  try {
    await deliverNotification(message, fetchImpl, telegramToken)
  }
  catch (err) {
    // A non-2xx error already names the target; a thrown fetch (network failure)
    // does not, so include the redacted URL either way.
    console.error(`notify: POST ${redactUrl(targetUrl(message, telegramToken) ?? '<invalid url>')} failed`, err)
  }
}
