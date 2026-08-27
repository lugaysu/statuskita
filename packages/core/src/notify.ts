import type { CheckStatus, Severity } from './types'
import { overallSeverity } from './types'

/** A single site whose status flipped between two check runs. */
export interface StatusChange {
  slug: string
  from: CheckStatus
  to: CheckStatus
}

/**
 * Channel-agnostic description of one or more status changes. Formatters
 * (Slack, Telegram, generic webhook, …) turn this into their own wire shape.
 */
export interface StatusChangePayload {
  /** ISO-8601 timestamp of when the changes were detected. */
  timestamp: string
  /** Worst resulting status across all changes, for headline severity. */
  severity: Severity
  changes: StatusChange[]
}

/**
 * Build a channel-agnostic payload from a list of status changes. Pure: the
 * caller supplies the timestamp so the result is deterministic and testable.
 */
export function buildStatusChangePayload(
  changes: StatusChange[],
  timestamp: string,
): StatusChangePayload {
  return {
    timestamp,
    severity: overallSeverity(changes.map(c => c.to)),
    changes,
  }
}

const STATUS_EMOJI: Record<CheckStatus, string> = {
  up: '✅',
  degraded: '⚠️',
  down: '🔴',
}

/** Minimal shape of a Slack incoming-webhook message. */
export interface SlackMessage {
  /** Plain-text fallback (notifications, screen readers, old clients). */
  text: string
  blocks: unknown[]
}

/** Format a payload as a Slack incoming-webhook message (text + Block Kit). */
export function toSlackMessage(payload: StatusChangePayload): SlackMessage {
  const count = payload.changes.length
  const headline = `Status changed for ${count} service${count === 1 ? '' : 's'}`
  const lines = payload.changes.map(
    c => `${STATUS_EMOJI[c.to]} *${c.slug}*: ${c.from} → ${c.to}`,
  )
  return {
    text: [headline, ...lines].join('\n'),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: payload.timestamp }] },
    ],
  }
}

/**
 * Format a payload as a Telegram Bot API `sendMessage` request body.
 * Uses plain text (no Markdown/HTML parse_mode) to avoid escaping edge cases
 * and to keep the message readable in all Telegram clients.
 * The caller must POST this to:
 *   https://api.telegram.org/bot<TOKEN>/sendMessage
 * with the bot token kept in a Cloudflare secret, never logged.
 */
export function toTelegramMessage(
  payload: StatusChangePayload,
  chatId: string | number,
): { chat_id: string | number, text: string } {
  const count = payload.changes.length
  const headline = `Status changed for ${count} service${count === 1 ? '' : 's'}`
  const lines = payload.changes.map(
    c => `${STATUS_EMOJI[c.to]} ${c.slug}: ${c.from} -> ${c.to}`,
  )
  return {
    chat_id: chatId,
    text: [headline, ...lines, payload.timestamp].join('\n'),
  }
}
