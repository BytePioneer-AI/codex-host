---
title: Schedules
description: Run recurring local tasks on a schedule with any external agent and workspace.
---

# Schedules

CodexHost extends Codex Desktop's built-in scheduler (Automations) so recurring local tasks can run with external agents, their models, and a specific local project directory.

## Create a schedule

1. In Codex Desktop, open **codexhost Settings → Scheduled Tasks** and create a new task.
2. Expand **Advanced settings**, turn on **"Run on this computer"**, and turn off **"Start a new chat each time"**.
3. Select the **Agent** (Claude Code, Pi, Grok, etc.), **Model**, and **Workspace** directory.
4. Set the schedule cadence and prompt, then save.

## Limitations

- **Local pinned-chat mode only**: External agents run on personal, local schedules that reuse a pinned thread. Cloud schedules, team automations, and new-chat-per-run schedules remain native Codex only.
- **Sidebar icons**: Scheduled tasks assigned to an external agent show that agent's icon next to the title in the sidebar.
- **Requires Codex Desktop open**: Scheduled runs are triggered by Codex Desktop; tasks do not fire while your computer is asleep or Codex Desktop is closed.
