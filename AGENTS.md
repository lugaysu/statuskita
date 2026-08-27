# AGENTS.md

Guidance for AI coding agents working in the StatusKita repository.

## Project

StatusKita is an open-source, CDN-native status page generator — a modern
successor to upptime — running on Cloudflare's edge platform, and an independent
derivative of [StatusBeam](https://github.com/pleaseai/statusbeam) (see
[README](./README.md) and [LICENSE](./LICENSE) for attribution). Bun +
Turborepo monorepo: `packages/core` (framework-free domain logic), `apps/worker`
(check/notify Worker), `apps/web` (Astro status page).

## Language

All code, comments, docs, and commit messages are **English only**. The sole
exception is Indonesian text in user-facing locale strings in
`packages/core/src/i18n.ts`.

## Build, test, lint

```bash
bun install
bun run test        # all bun:test unit tests
bun run typecheck   # turbo typecheck (tsc + astro check)
bun run lint        # eslint .
bun run build       # turbo build
```

Core is framework-free (only `zod` + `yaml`). Do not import Cloudflare/Astro
types into `packages/core` — that breaks layering.

## Notifications

Status-change notifications fan out to Slack, Telegram, and generic webhooks
(`packages/core/src/notify.ts` formatters, `apps/worker/src/notify.ts` dispatch).

- The Telegram **bot token is always a Cloudflare secret**
  (`TELEGRAM_BOT_TOKEN`) — never committed and never placed in YAML. Only
  `chatId` lives in `status.config.yml`.
- Never log the token or any secret-bearing URL. `redactUrl` keeps URLs to
  origin only.
- Channel failures are isolated: one bad target (or a missing optional secret)
  is logged and skipped, never allowed to wedge the run.

## i18n

Locales live in `packages/core/src/i18n.ts` (`LOCALES`, dictionaries,
`negotiateLocale`). Supported: `en`, `zh`, `ja`, `ko`, `id`. Each locale needs
a matching page under `apps/web/src/pages/<locale>/index.astro` and a label in
`LOCALE_NAMES` in `apps/web/src/components/StatusPage.astro`.
