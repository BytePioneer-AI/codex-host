import type { HarnessCommandInvocation, HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

export const QODER_COMMAND_CATALOG: HarnessCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
        "id": "qoder.about",
        "invocation": "/about",
        "label": "About",
        "description": "Show version info",
        "argumentMode": "none"
    },
    {
        "id": "qoder.agents",
        "invocation": "/agents",
        "label": "Agents",
        "description": "Manage agents",
        "argumentMode": "text"
    },
    {
        "id": "qoder.btw",
        "invocation": "/btw",
        "label": "Btw",
        "description": "Ask a quick side question without interrupting the main conversation",
        "argumentMode": "text"
    },
    {
        "id": "qoder.login",
        "invocation": "/login",
        "label": "Login",
        "description": "Sign in or change the authentication method",
        "argumentMode": "none"
    },
    {
        "id": "qoder.logout",
        "invocation": "/logout",
        "label": "Logout",
        "description": "Sign out and clear all cached credentials",
        "argumentMode": "none"
    },
    {
        "id": "qoder.feedback",
        "invocation": "/feedback",
        "label": "Feedback",
        "description": "Submit feedback or report a bug with diagnostic information",
        "argumentMode": "text"
    },
    {
        "id": "qoder.branch",
        "invocation": "/branch",
        "label": "Branch",
        "description": "Create a new session branch from the current conversation",
        "argumentMode": "text"
    },
    {
        "id": "qoder.subtask",
        "invocation": "/subtask",
        "label": "Subtask",
        "description": "Send a subagent off with your full context; its result comes back here",
        "argumentMode": "text"
    },
    {
        "id": "qoder.clear",
        "invocation": "/clear",
        "label": "Clear",
        "description": "Clear the screen and start a new conversation",
        "argumentMode": "none"
    },
    {
        "id": "qoder.new",
        "invocation": "/new",
        "label": "New",
        "description": "Start a new conversation",
        "argumentMode": "none"
    },
    {
        "id": "qoder.commands",
        "invocation": "/commands",
        "label": "Commands",
        "description": "Reload and list all available slash commands",
        "argumentMode": "none"
    },
    {
        "id": "qoder.compact",
        "invocation": "/compact",
        "label": "Compact",
        "description": "Compresses the context by replacing it with a summary",
        "argumentMode": "text"
    },
    {
        "id": "qoder.copy",
        "invocation": "/copy",
        "label": "Copy",
        "description": "Copy the last assistant response to clipboard, or /copy N for the Nth-latest",
        "argumentMode": "text"
    },
    {
        "id": "qoder.docs",
        "invocation": "/docs",
        "label": "Docs",
        "description": "Open full application documentation in your browser",
        "argumentMode": "none"
    },
    {
        "id": "qoder.editor",
        "invocation": "/editor",
        "label": "Editor",
        "description": "Set external editor preference",
        "argumentMode": "text"
    },
    {
        "id": "qoder.effort",
        "invocation": "/effort",
        "label": "Effort",
        "description": "Set reasoning effort for the current model",
        "argumentMode": "text"
    },
    {
        "id": "qoder.fast",
        "invocation": "/fast",
        "label": "Fast",
        "description": "Toggle fast mode for the current model",
        "argumentMode": "text"
    },
    {
        "id": "qoder.export",
        "invocation": "/export",
        "label": "Export",
        "description": "Export the current conversation to a file or clipboard",
        "argumentMode": "text"
    },
    {
        "id": "qoder.help",
        "invocation": "/help",
        "label": "Help",
        "description": "Show application help and keyboard shortcuts",
        "argumentMode": "text"
    },
    {
        "id": "qoder.shortcuts",
        "invocation": "/shortcuts",
        "label": "Shortcuts",
        "description": "Toggle the shortcuts panel above the input",
        "argumentMode": "none"
    },
    {
        "id": "qoder.hooks",
        "invocation": "/hooks",
        "label": "Hooks",
        "description": "Open hooks management panel",
        "argumentMode": "none"
    },
    {
        "id": "qoder.diff",
        "invocation": "/diff",
        "label": "Diff",
        "description": "Show uncommitted git changes",
        "argumentMode": "text"
    },
    {
        "id": "qoder.review",
        "invocation": "/review",
        "label": "Review",
        "description": "Review code changes and find actionable issues",
        "argumentMode": "text"
    },
    {
        "id": "qoder.insights",
        "invocation": "/insights",
        "label": "Insights",
        "description": "Generate a report analyzing your Qoder sessions",
        "argumentMode": "none"
    },
    {
        "id": "qoder.kanban",
        "invocation": "/kanban",
        "label": "Kanban",
        "description": "Show items from the configured kanban backend",
        "argumentMode": "text"
    },
    {
        "id": "qoder.init",
        "invocation": "/init",
        "label": "Init",
        "description": "Analyzes the project and creates a tailored context file",
        "argumentMode": "none"
    },
    {
        "id": "qoder.mcp",
        "invocation": "/mcp",
        "label": "MCP",
        "description": "Manage configured Model Context Protocol (MCP) servers",
        "argumentMode": "text"
    },
    {
        "id": "qoder.memory",
        "invocation": "/memory",
        "label": "Memory",
        "description": "Commands for interacting with memory",
        "argumentMode": "text"
    },
    {
        "id": "qoder.model",
        "invocation": "/model",
        "label": "Model",
        "description": "Set or manage model configuration",
        "argumentMode": "text"
    },
    {
        "id": "qoder.plugins",
        "invocation": "/plugins",
        "label": "Plugins",
        "description": "Manage plugins",
        "argumentMode": "text"
    },
    {
        "id": "qoder.plan",
        "invocation": "/plan",
        "label": "Plan",
        "description": "Toggle Plan Mode (enter when off, exit when on)",
        "argumentMode": "text"
    },
    {
        "id": "qoder.goal",
        "invocation": "/goal",
        "label": "Goal",
        "description": "Set or manage a persistent goal for the current session",
        "argumentMode": "text"
    },
    {
        "id": "qoder.permissions",
        "invocation": "/permissions",
        "label": "Permissions",
        "description": "Manage permissions",
        "argumentMode": "text"
    },
    {
        "id": "qoder.crontab",
        "invocation": "/crontab",
        "label": "Crontab",
        "description": "Manage scheduled loops and cron jobs",
        "argumentMode": "text"
    },
    {
        "id": "qoder.peers",
        "invocation": "/peers",
        "label": "Peers",
        "description": "List peer sessions and review held cross-session messages",
        "argumentMode": "text"
    },
    {
        "id": "qoder.privacy",
        "invocation": "/privacy",
        "label": "Privacy",
        "description": "Display the privacy notice",
        "argumentMode": "none"
    },
    {
        "id": "qoder.profile",
        "invocation": "/profile",
        "label": "Profile",
        "description": "Inspect or control runtime profiling",
        "argumentMode": "text"
    },
    {
        "id": "qoder.security-settings",
        "invocation": "/security-settings",
        "label": "Security Settings",
        "description": "Configure security scan settings",
        "argumentMode": "none"
    },
    {
        "id": "qoder.quit",
        "invocation": "/quit",
        "label": "Quit",
        "description": "Exit the application",
        "argumentMode": "none"
    },
    {
        "id": "qoder.rewind",
        "invocation": "/rewind",
        "label": "Rewind",
        "description": "Open rewind selector",
        "argumentMode": "none"
    },
    {
        "id": "qoder.continue",
        "invocation": "/continue",
        "label": "Continue",
        "description": "Continue the most recent session for the current project",
        "argumentMode": "none"
    },
    {
        "id": "qoder.rename",
        "invocation": "/rename",
        "label": "Rename",
        "description": "Set a custom title for the current session",
        "argumentMode": "text"
    },
    {
        "id": "qoder.resume",
        "invocation": "/resume",
        "label": "Resume",
        "description": "Resume a session by identifier, or open the session browser",
        "argumentMode": "text"
    },
    {
        "id": "qoder.usage",
        "invocation": "/usage",
        "label": "Usage",
        "description": "Show usage statistics for the current billing period",
        "argumentMode": "text"
    },
    {
        "id": "qoder.status",
        "invocation": "/status",
        "label": "Status",
        "description": "Show account and session status",
        "argumentMode": "text"
    },
    {
        "id": "qoder.add-dir",
        "invocation": "/add-dir",
        "label": "Add Dir",
        "description": "Add a directory to the workspace context",
        "argumentMode": "text"
    },
    {
        "id": "qoder.context",
        "invocation": "/context",
        "label": "Context",
        "description": "Visualize current context window usage",
        "argumentMode": "none"
    },
    {
        "id": "qoder.context-window",
        "invocation": "/context-window",
        "label": "Context Window",
        "description": "Set context window for the current model",
        "argumentMode": "text"
    },
    {
        "id": "qoder.theme",
        "invocation": "/theme",
        "label": "Theme",
        "description": "Change the theme",
        "argumentMode": "text"
    },
    {
        "id": "qoder.tools",
        "invocation": "/tools",
        "label": "Tools",
        "description": "List available Qoder CLI tools.",
        "argumentMode": "text"
    },
    {
        "id": "qoder.output-style",
        "invocation": "/output-style",
        "label": "Output Style",
        "description": "Configure the output style for the next conversation",
        "argumentMode": "none"
    },
    {
        "id": "qoder.skills",
        "invocation": "/skills",
        "label": "Skills",
        "description": "Manage agent skills",
        "argumentMode": "text"
    },
    {
        "id": "qoder.release-notes",
        "invocation": "/release-notes",
        "label": "Release Notes",
        "description": "Show release notes for recent CLI versions",
        "argumentMode": "none"
    },
    {
        "id": "qoder.remote-env",
        "invocation": "/remote-env",
        "label": "Remote Env",
        "description": "Choose the default cloud remote environment",
        "argumentMode": "text"
    },
    {
        "id": "qoder.remote-control",
        "invocation": "/remote-control",
        "label": "Remote Control",
        "description": "Manage remote control connection",
        "argumentMode": "text"
    },
    {
        "id": "qoder.settings",
        "invocation": "/settings",
        "label": "Settings",
        "description": "View and edit application settings",
        "argumentMode": "text"
    },
    {
        "id": "qoder.statusline",
        "invocation": "/statusline",
        "label": "Statusline",
        "description": "Set up a custom status line. Uses a sub-agent to read your shell config and create a statusline script that's updated after each response.",
        "argumentMode": "text"
    },
    {
        "id": "qoder.tasks",
        "invocation": "/tasks",
        "label": "Tasks",
        "description": "Show background tasks panel",
        "argumentMode": "none"
    },
    {
        "id": "qoder.workflows",
        "invocation": "/workflows",
        "label": "Workflows",
        "description": "Browse workflow tasks in the session rail",
        "argumentMode": "none"
    },
    {
        "id": "qoder.vim",
        "invocation": "/vim",
        "label": "Vim",
        "description": "Toggle vim mode on/off for this session",
        "argumentMode": "none"
    },
    {
        "id": "qoder.voice",
        "invocation": "/voice",
        "label": "Voice",
        "description": "Toggle voice mode (hold Space to record)",
        "argumentMode": "none"
    },
    {
        "id": "qoder.setup-github",
        "invocation": "/setup-github",
        "label": "Setup GitHub",
        "description": "Set up Qoder GitHub Actions",
        "argumentMode": "none"
    },
    {
        "id": "qoder.upgrade",
        "invocation": "/upgrade",
        "label": "Upgrade",
        "description": "Upgrade your Qoder account plan for higher limits",
        "argumentMode": "none"
    }
],
});

export const QODER_COMMANDS: readonly HarnessCommandDescriptor[] = QODER_COMMAND_CATALOG.commands;

export function findQoderCommandDescriptor(
  commandId: string,
): HarnessCommandDescriptor | undefined {
  return QODER_COMMAND_CATALOG.commands.find(
    (command) =>
      command.id === commandId ||
      command.invocation === commandId ||
      command.id === `qoder.${commandId}` ||
      command.invocation === `/${commandId}`,
  );
}

export interface ParsedQoderCommand {
  prompt: string;
  descriptor: HarnessCommandDescriptor;
}

export function parseAndFormatQoderCommand(
  command: HarnessCommandInvocation,
): HarnessResult<ParsedQoderCommand> {
  const descriptor = findQoderCommandDescriptor(command.commandId);
  if (!descriptor) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Qoder does not expose Harness command '${command.commandId}'`,
        retryable: false,
      },
    };
  }

  const args = command.arguments;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Qoder command arguments must be an object",
        retryable: false,
      },
    };
  }

  if (descriptor.argumentMode === "none" && args && Object.keys(args).length > 0) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: `Qoder command '${descriptor.invocation}' does not accept arguments`,
        retryable: false,
      },
    };
  }

  if (args) {
    if (Object.keys(args).some((key) => key !== "text")) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qoder command has an unknown argument",
          retryable: false,
        },
      };
    }
    if (args.text !== undefined && typeof args.text !== "string") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qoder command argument 'text' must be a string",
          retryable: false,
        },
      };
    }
  }

  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const prompt = text.length > 0 ? `${descriptor.invocation} ${text}` : descriptor.invocation;

  return {
    ok: true,
    value: {
      prompt,
      descriptor,
    },
  };
}

export function formatQoderTurnPrompt(prompt: string): string {
  return prompt;
}
