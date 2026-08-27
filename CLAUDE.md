# StatusKita — Project Instructions

StatusKita is an independent, community-driven derivative of
[StatusBeam](https://github.com/pleaseai/statusbeam) (see the LICENSE and README
for attribution). Open-source, CDN-native status page generator (a modern
successor to upptime), running on Cloudflare's edge platform. Bun + Turborepo
monorepo.

All docs, code, comments, and commit messages are **English only** (Indonesian
text appears solely in user-facing locale strings under `packages/core/src/i18n.ts`).

<!-- please:knowledge v1 -->
## Project Knowledge

Consult these files for project context before exploring the codebase.
For full file listing with workspace artifacts, use `Skill("please:project-knowledge")`.

### Project Documents
- `SECURITY.md` — Security policies, authentication, authorization
- `CONTRIBUTING.md` — Contribution guide, code review process

### Domain Knowledge (.please/docs/knowledge/)
- `product.md` — Product vision, goals, target users
- `product-guidelines.md` — Branding, UX principles, design system
- `tech-stack.md` — Technology choices with rationale
- `workflow.md` — Task lifecycle, TDD, quality gates, dev commands

### Decision Records
- `docs/adr/` — Architecture Decision Records (ADR)
<!-- /please:knowledge -->

## Notifications

Status-change notifications fan out to Slack, Telegram, and generic webhooks
(`packages/core/src/notify.ts` for formatters, `apps/worker/src/notify.ts` for
dispatch). The Telegram **bot token is always a Cloudflare secret**
(`TELEGRAM_BOT_TOKEN`), never committed or placed in YAML — only `chatId` lives in
`status.config.yml`.
