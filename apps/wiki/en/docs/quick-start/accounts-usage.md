---
title: Accounts & Usage
description: View live quotas across agents, import credentials into Pi, and track token spend.
---

# Accounts & Usage

CodexHost reads your existing agent sign-ins in read-only mode. It does not store passwords centrally or modify official Codex login flows.

## Quota isolation

In standard Codex Desktop, exhausting your 5-hour or 7-day ChatGPT / Codex allowance locks the message composer.

With CodexHost, only native Codex threads use Codex quota. When Codex hits its limit, switch the bottom-right composer selector to Claude Code, Pi, OpenCode, Grok, DSH, or another installed agent to keep working—each uses its own local login or API key.

## Quota overview

Open **codexhost Settings → Accounts** to check live plan allowances and prepaid balances in one table:

- **Supported agents**: Codex (5-hour / 7-day windows and reset-card expirations), Claude Code, Grok, Cursor, Kimi Code, Qoder, Antigravity, and Pi providers with balance endpoints (such as DeepSeek).
- **View toggle**: Switch between **Remaining** and **Used** percentages with local reset countdowns.
- **Email masking**: Click the eye icon in the toolbar to mask email addresses (`al****ce@example.com`) across the page before sharing screenshots.

## Import Codex / Grok credentials into Pi

If you are already signed in to Codex or Grok via OAuth on your machine, you can share those credentials with Pi in one click:

1. Open **codexhost Settings → Accounts**.
2. Click **Import to Pi** under your Codex or Grok account.
3. Confirm the provider entry name and save.

No restart is required—new Pi threads can immediately select those models. You can refresh or remove imported entries anytime from the same section without signing out of Codex or Grok.

## Token usage and cost

### Live session popover

In sessions that report usage metrics, click the usage indicator in the bottom status bar to inspect the active conversation:

- **Context**: Active token count vs. context window limit.
- **Cache**: Cache hit rate (cached read vs. write tokens).
- **TTFT & cost**: Time to first token and estimated turn cost.

### Global usage dashboard

Open **Usage Statistics** in **codexhost Settings** or the **Local Console (`codexhost console`)**. CodexHost scans and deduplicates native session logs across Codex and external agents, breaking down token totals and estimated spend by model, agent, and date.
