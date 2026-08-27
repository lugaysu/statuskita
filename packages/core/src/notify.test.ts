import { describe, expect, it } from 'bun:test'
import { buildStatusChangePayload, toSlackMessage, toTelegramMessage } from './notify'

const timestamp = '2026-07-07T00:00:00.000Z'

describe('buildStatusChangePayload', () => {
  it('carries the timestamp and changes through unchanged', () => {
    const changes = [{ slug: 'api', from: 'up', to: 'down' } as const]
    const payload = buildStatusChangePayload(changes, timestamp)
    expect(payload.timestamp).toBe(timestamp)
    expect(payload.changes).toEqual(changes)
  })

  it('rolls up the worst resulting status as severity', () => {
    expect(
      buildStatusChangePayload(
        [
          { slug: 'a', from: 'up', to: 'degraded' },
          { slug: 'b', from: 'up', to: 'down' },
        ],
        timestamp,
      ).severity,
    ).toBe('major_outage')

    expect(
      buildStatusChangePayload([{ slug: 'a', from: 'down', to: 'up' }], timestamp).severity,
    ).toBe('operational')
  })

  it('is operational for an empty change list', () => {
    expect(buildStatusChangePayload([], timestamp).severity).toBe('operational')
  })
})

describe('toSlackMessage', () => {
  it('summarises a single change with a from → to line', () => {
    const message = toSlackMessage(
      buildStatusChangePayload([{ slug: 'api', from: 'up', to: 'down' }], timestamp),
    )
    expect(message.text).toContain('Status changed for 1 service')
    expect(message.text).toContain('*api*: up → down')
    expect(message.blocks.length).toBeGreaterThan(0)
  })

  it('pluralises and lists every change', () => {
    const message = toSlackMessage(
      buildStatusChangePayload(
        [
          { slug: 'api', from: 'up', to: 'down' },
          { slug: 'web', from: 'up', to: 'degraded' },
        ],
        timestamp,
      ),
    )
    expect(message.text).toContain('Status changed for 2 services')
    expect(message.text).toContain('*api*: up → down')
    expect(message.text).toContain('*web*: up → degraded')
  })
})

describe('toTelegramMessage', () => {
  it('returns a sendMessage body with the chat id and plain-text status lines', () => {
    const message = toTelegramMessage(
      buildStatusChangePayload([{ slug: 'api', from: 'up', to: 'down' }], timestamp),
      -1001234567890,
    )
    // The caller POSTs this to /bot<TOKEN>/sendMessage; the body carries the
    // chat target and a readable plain-text message (no parse_mode to avoid
    // escaping edge cases), not the token itself.
    expect(message.chat_id).toBe(-1001234567890)
    expect(message.text).toContain('Status changed for 1 service')
    expect(message.text).toContain('🔴 api: up -> down')
    expect(message.text).toContain(timestamp)
  })

  it('accepts a string chat id (channel/supergroup handle) and lists all changes', () => {
    const message = toTelegramMessage(
      buildStatusChangePayload(
        [
          { slug: 'api', from: 'up', to: 'down' },
          { slug: 'web', from: 'up', to: 'degraded' },
        ],
        timestamp,
      ),
      '@mychannel',
    )
    expect(message.chat_id).toBe('@mychannel')
    expect(message.text).toContain('Status changed for 2 services')
    expect(message.text).toContain('🔴 api: up -> down')
    expect(message.text).toContain('⚠️ web: up -> degraded')
  })
})
