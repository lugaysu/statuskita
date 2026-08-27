import type { StatusChangePayload } from '@statusbeam/core'
import type { Env } from './env'
import type { NotificationMessage } from './notify'
import { buildStatusChangePayload } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import {
  buildNotificationMessages,
  consumeNotificationBatch,
  deliverNotification,
  dispatchNotifications,
  notify,
} from './notify'

const payload: StatusChangePayload = buildStatusChangePayload(
  [{ slug: 'api', from: 'up', to: 'down' }],
  '2026-07-08T00:00:00.000Z',
)

/** A fetch stub recording calls and returning a chosen response/behaviour. */
function fakeFetch(behaviour: (url: string) => { ok: boolean, status: number } | Error) {
  const calls: { url: string, body: unknown }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const result = behaviour(url)
    if (result instanceof Error) {
      throw result
    }
    return { ok: result.ok, status: result.status } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('buildNotificationMessages', () => {
  it('returns an empty list when notifications are absent', () => {
    expect(buildNotificationMessages(undefined, payload)).toEqual([])
  })

  it('emits one message per target: slack (Block Kit) + each webhook (payload)', () => {
    const messages = buildNotificationMessages(
      {
        delivery: 'inline',
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        webhooks: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
      },
      payload,
    )
    expect(messages.map(m => m.url)).toEqual([
      'https://hooks.slack.com/services/T/B/X',
      'https://example.com/a',
      'https://example.com/b',
    ])
    // Slack gets a formatted message; generic webhooks get the raw payload.
    expect((messages[0]?.body as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0)
    expect(messages[1]?.body).toEqual(payload)
  })

  it('emits a Telegram message carrying only the chat target and formatted body — no token, no URL', () => {
    const messages = buildNotificationMessages(
      { delivery: 'inline', telegram: { chatId: -1001234567890 } },
      payload,
    )
    expect(messages).toHaveLength(1)
    const telegram = messages[0] as NotificationMessage
    expect(telegram.kind).toBe('telegram')
    // The secret never lives on the message: no URL is built here, only the
    // `chatId` target (safe to persist) and the formatted body.
    expect(telegram.url).toBe('')
    expect(telegram.chatId).toBe(-1001234567890)
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain('SECRET_TOKEN')
    expect(serialized).not.toContain('api.telegram.org')
    expect((telegram.body as { chat_id: number }).chat_id).toBe(-1001234567890)
  })

  it('fans out Slack + Telegram + webhooks to the same set of targets', () => {
    const messages = buildNotificationMessages(
      {
        delivery: 'inline',
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        telegram: { chatId: -1001234567890 },
        webhooks: [{ url: 'https://example.com/a' }],
      },
      payload,
    )
    expect(messages.map(m => [m.kind, m.chatId])).toEqual([
      ['slack', ''],
      ['telegram', -1001234567890],
      ['webhook', ''],
    ])
  })
})

describe('deliverNotification', () => {
  const message: NotificationMessage = { kind: 'webhook', url: 'https://example.com/hook', chatId: '', body: payload }

  it('resolves on a 2xx response', async () => {
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    await expect(deliverNotification(message, impl)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual(payload)
  })

  it('throws on a non-2xx response (so the queue retries)', async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 500 }))
    await expect(deliverNotification(message, impl)).rejects.toThrow(/500/)
  })

  it('builds the Bot API URL from the injected token at delivery time', async () => {
    const telegramMessage: NotificationMessage = {
      kind: 'telegram',
      url: '',
      chatId: -1001234567890,
      body: { chat_id: -1001234567890, text: 'down' },
    }
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    // The stored message has no URL/token — the token is supplied here, at
    // delivery, and the URL is derived just-in-time.
    await deliverNotification(telegramMessage, impl, '123456:SECRET_TOKEN')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123456:SECRET_TOKEN/sendMessage')
  })

  it('redacts a Telegram token from the error (origin only, never the secret)', async () => {
    const telegramMessage: NotificationMessage = {
      kind: 'telegram',
      url: '',
      chatId: -1001234567890,
      body: { chat_id: -1001234567890, text: 'down' },
    }
    const { impl } = fakeFetch(() => ({ ok: false, status: 403 }))
    // The thrown error names the host, never the token embedded in the URL path.
    await expect(deliverNotification(telegramMessage, impl, '123456:SECRET_TOKEN')).rejects.toThrow(
      'https://api.telegram.org',
    )
    await expect(deliverNotification(telegramMessage, impl, '123456:SECRET_TOKEN')).rejects.not.toThrow('SECRET_TOKEN')
  })

  it('isolates a Telegram target (no POST) when the token is missing', async () => {
    const telegramMessage: NotificationMessage = {
      kind: 'telegram',
      url: '',
      chatId: -1001234567890,
      body: { chat_id: -1001234567890, text: 'down' },
    }
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    // Missing secret → skipped, not thrown/retried (a retry could never succeed).
    await expect(deliverNotification(telegramMessage, impl)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('propagates a thrown fetch (network failure)', async () => {
    const { impl } = fakeFetch(() => new Error('network down'))
    await expect(deliverNotification(message, impl)).rejects.toThrow('network down')
  })
})

describe('dispatchNotifications (inline)', () => {
  it('POSTs every target and swallows a failing one', async () => {
    const { impl, calls } = fakeFetch(url =>
      url.includes('/bad') ? { ok: false, status: 500 } : { ok: true, status: 200 },
    )
    await dispatchNotifications(
      { delivery: 'inline', webhooks: [{ url: 'https://example.com/ok' }, { url: 'https://example.com/bad' }] },
      payload,
      impl,
    )
    // Both were attempted; the 500 did not throw or block the other.
    expect(calls.map(c => c.url)).toEqual(['https://example.com/ok', 'https://example.com/bad'])
  })
})

/**
 * A minimal Env whose NOTIFY_QUEUE records the batches it is sent. `binding`:
 * 'record' captures the enqueued batches, 'throw' simulates an enqueue failure
 * (quota/throttle/transient API error), 'none' omits the binding entirely.
 */
function queueEnv(binding: 'record' | 'throw' | 'none') {
  const sent: { body: NotificationMessage }[][] = []
  const queue = {
    record: { sendBatch: async (msgs: { body: NotificationMessage }[]) => { sent.push([...msgs]) } },
    throw: { sendBatch: async () => { throw new Error('queue backlog full') } },
    none: undefined,
  }[binding]
  const env = { NOTIFY_QUEUE: queue } as unknown as Env
  return { env, sent }
}

describe('notify (transport selection)', () => {
  it('enqueues one message per target when delivery is queue', async () => {
    const { env, sent } = queueEnv('record')
    await notify(
      env,
      {
        delivery: 'queue',
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        webhooks: [{ url: 'https://example.com/a' }],
      },
      payload,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.map(m => m.body.url)).toEqual([
      'https://hooks.slack.com/services/T/B/X',
      'https://example.com/a',
    ])
    expect(sent[0]?.map(m => m.body.kind)).toEqual(['slack', 'webhook'])
    // The enqueued body content survives the { body } wrap: Slack gets its
    // formatted message, the generic webhook gets the raw payload.
    expect((sent[0]?.[0]?.body.body as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0)
    expect(sent[0]?.[1]?.body.body).toEqual(payload)
  })

  it('does not enqueue when there are no targets', async () => {
    const { env, sent } = queueEnv('record')
    await notify(env, { delivery: 'queue' }, payload)
    expect(sent).toHaveLength(0)
  })

  it('chunks a large target list into <=100-message sendBatch calls', async () => {
    const { env, sent } = queueEnv('record')
    // 150 webhooks + 1 slack = 151 messages → two batches (100 + 51).
    const webhooks = Array.from({ length: 150 }, (_, i) => ({ url: `https://example.com/${i}` }))
    await notify(env, { delivery: 'queue', slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' }, webhooks }, payload)
    // 100 + 51 = 151 → every message enqueued exactly once, no chunk-boundary loss.
    expect(sent).toHaveLength(2)
    expect(sent[0]).toHaveLength(100)
    expect(sent[1]).toHaveLength(51)
  })

  it('dispatches only the un-enqueued remainder inline when a later chunk fails', async () => {
    // First sendBatch (100) succeeds, the second throws — the already-queued
    // 100 must NOT be re-POSTed inline (that would double-deliver them); only
    // the 51-message remainder falls back.
    let call = 0
    const enqueued: number[] = []
    const env = {
      NOTIFY_QUEUE: {
        sendBatch: async (msgs: unknown[]) => {
          call += 1
          if (call === 1) {
            enqueued.push(msgs.length)
            return
          }
          throw new Error('queue backlog full')
        },
      },
    } as unknown as Env
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    const webhooks = Array.from({ length: 150 }, (_, i) => ({ url: `https://example.com/${i}` }))
    await notify(env, { delivery: 'queue', slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' }, webhooks }, payload, impl)
    expect(enqueued).toEqual([100]) // first chunk queued
    expect(calls).toHaveLength(51) // only the remainder POSTed inline — no double-delivery
  })

  it('routes to inline dispatch for the default (inline) delivery mode', async () => {
    const { env, sent } = queueEnv('record')
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    await notify(env, { delivery: 'inline', webhooks: [{ url: 'https://example.com/a' }] }, payload, impl)
    // Never touched the queue; POSTed the target directly.
    expect(sent).toHaveLength(0)
    expect(calls.map(c => c.url)).toEqual(['https://example.com/a'])
  })

  it('never serializes the bot token into the queue payload — Telegram carries only chatId', async () => {
    const { env, sent } = queueEnv('record')
    env.TELEGRAM_BOT_TOKEN = '123456:SECRET_TOKEN'
    await notify(
      env,
      { delivery: 'queue', telegram: { chatId: -1001234567890 } },
      payload,
    )
    expect(sent).toHaveLength(1)
    const queued = sent[0]?.[0]?.body as NotificationMessage
    expect(queued.kind).toBe('telegram')
    // The persisted message holds the chat target, not the secret: no URL is
    // built and no token string survives serialization.
    expect(queued.url).toBe('')
    expect(queued.chatId).toBe(-1001234567890)
    expect(JSON.stringify(sent[0])).not.toContain('SECRET_TOKEN')
    expect(JSON.stringify(sent[0])).not.toContain('api.telegram.org')
  })

  it('injects the env secret into the Telegram URL only on the inline path of the queue fallback', async () => {
    // When the queue path falls back to inline (missing binding), Telegram is
    // still posted — but the URL with the token is constructed transiently at
    // delivery, never persisted.
    const { env } = queueEnv('none')
    env.TELEGRAM_BOT_TOKEN = '123456:SECRET_TOKEN'
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    await notify(
      env,
      { delivery: 'queue', telegram: { chatId: -1001234567890 } },
      payload,
      impl,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123456:SECRET_TOKEN/sendMessage')
  })

  it('isolates Telegram on the queue path when the secret is missing (others still enqueue)', async () => {
    const { env, sent } = queueEnv('record')
    await notify(
      env,
      { delivery: 'queue', telegram: { chatId: -1001234567890 }, webhooks: [{ url: 'https://example.com/a' }] },
      payload,
    )
    // The webhook is queued; the token-less Telegram message is enqueued too but
    // carries no token — its delivery is skipped at POST time by the consumer.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.map(m => m.body.kind)).toEqual(['telegram', 'webhook'])
    expect(JSON.stringify(sent[0])).not.toContain('api.telegram.org')
  })

  it('falls back to inline (with a real POST) when delivery is queue but the binding is missing', async () => {
    const { env } = queueEnv('none')
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    await notify(env, { delivery: 'queue', webhooks: [{ url: 'https://example.com/a' }] }, payload, impl)
    // The fallback actually dispatched the target rather than silently no-oping.
    expect(calls.map(c => c.url)).toEqual(['https://example.com/a'])
  })

  it('falls back to inline (with a real POST) when the enqueue itself fails', async () => {
    const { env } = queueEnv('throw')
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    await notify(env, { delivery: 'queue', webhooks: [{ url: 'https://example.com/a' }] }, payload, impl)
    // sendBatch threw → the alert is not dropped; it is delivered inline.
    expect(calls.map(c => c.url)).toEqual(['https://example.com/a'])
  })
})

/** Build a MessageBatch stub whose messages record ack()/retry() calls. */
function batchOf(messages: NotificationMessage[]) {
  const outcomes: ('ack' | 'retry')[] = []
  const batch = {
    messages: messages.map(body => ({
      body,
      ack: () => outcomes.push('ack'),
      retry: () => outcomes.push('retry'),
    })),
  } as unknown as MessageBatch<NotificationMessage>
  return { batch, outcomes }
}

/** A webhook NotificationMessage in the current discriminated shape. */
function webhookMessage(url: string): NotificationMessage {
  return { kind: 'webhook', url, chatId: '', body: payload }
}

describe('consumeNotificationBatch (queue consumer)', () => {
  it('acks a message that delivers successfully', async () => {
    const { impl } = fakeFetch(() => ({ ok: true, status: 200 }))
    const { batch, outcomes } = batchOf([webhookMessage('https://example.com/ok')])
    await consumeNotificationBatch(batch, impl)
    expect(outcomes).toEqual(['ack'])
  })

  it('retries a message whose target fails (so Queues re-delivers / dead-letters)', async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 503 }))
    const { batch, outcomes } = batchOf([webhookMessage('https://example.com/bad')])
    await consumeNotificationBatch(batch, impl)
    expect(outcomes).toEqual(['retry'])
  })

  it('retries a message whose delivery throws (network failure)', async () => {
    const { impl } = fakeFetch(() => new Error('network down'))
    const { batch, outcomes } = batchOf([webhookMessage('https://example.com/bad')])
    await consumeNotificationBatch(batch, impl)
    expect(outcomes).toEqual(['retry'])
  })

  it('injects the env secret into the Telegram URL only during delivery', async () => {
    // The queued Telegram message (built by buildNotificationMessages) has no
    // URL/token; the consumer supplies its own env secret at delivery time.
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    const telegram = {
      kind: 'telegram',
      url: '',
      chatId: -1001234567890,
      body: { chat_id: -1001234567890, text: 'down' },
    } as NotificationMessage
    const { batch, outcomes } = batchOf([telegram])
    await consumeNotificationBatch(batch, impl, '123456:SECRET_TOKEN')
    expect(outcomes).toEqual(['ack'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123456:SECRET_TOKEN/sendMessage')
  })

  it('acks a token-less Telegram message without POSTing when the secret is missing', async () => {
    const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }))
    const telegram = {
      kind: 'telegram',
      url: '',
      chatId: -1001234567890,
      body: { chat_id: -1001234567890, text: 'down' },
    } as NotificationMessage
    const { batch, outcomes } = batchOf([telegram])
    // No token → the Telegram target is isolated (nothing POSTed) and acked:
    // retrying could never succeed, so it must not wedge the queue.
    await consumeNotificationBatch(batch, impl)
    expect(outcomes).toEqual(['ack'])
    expect(calls).toHaveLength(0)
  })

  it('swallows a post-delivery ack failure without retrying (no duplicate POST)', async () => {
    const { impl } = fakeFetch(() => ({ ok: true, status: 200 }))
    let retried = false
    const batch = {
      messages: [{
        body: webhookMessage('https://example.com/ok'),
        ack: () => { throw new Error('already settled') },
        retry: () => { retried = true },
      }],
    } as unknown as MessageBatch<NotificationMessage>
    // Delivery succeeded, so a failing ack must not escalate to a retry.
    await expect(consumeNotificationBatch(batch, impl)).resolves.toBeUndefined()
    expect(retried).toBe(false)
  })

  it('fails the batch when retry() throws, so the message is redelivered (not silently acked)', async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 503 }))
    const batch = {
      messages: [{
        body: webhookMessage('https://example.com/bad'),
        ack: () => {},
        retry: () => { throw new Error('retry unavailable') },
      }],
    } as unknown as MessageBatch<NotificationMessage>
    // Delivery failed and retry() couldn't be recorded — the handler must reject
    // rather than return (a return would let Queues implicitly ack = drop it).
    await expect(consumeNotificationBatch(batch, impl)).rejects.toThrow('retry unavailable')
  })

  it('settles each message independently within a batch', async () => {
    const { impl } = fakeFetch(url =>
      url.includes('/bad') ? { ok: false, status: 500 } : { ok: true, status: 200 },
    )
    const { batch, outcomes } = batchOf([
      webhookMessage('https://example.com/ok'),
      webhookMessage('https://example.com/bad'),
    ])
    await consumeNotificationBatch(batch, impl)
    expect(outcomes).toEqual(['ack', 'retry'])
  })
})
