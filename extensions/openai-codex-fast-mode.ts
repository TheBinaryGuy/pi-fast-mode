import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-codex-fast-mode";
const STATE_FILE_NAME = "openai-codex-fast-mode.json";

interface FastModeState {
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsFastMode(modelId: string): boolean {
  return modelId === "gpt-5.5" || /^gpt-5\.6(?:-|$)/.test(modelId);
}

export function readFastModeState(statePath: string): FastModeState {
  if (!existsSync(statePath)) return { enabled: false };

  try {
    const value: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (isRecord(value) && typeof value.enabled === "boolean") {
      return { enabled: value.enabled };
    }
  } catch {
    // Invalid or unreadable state safely falls back to disabled.
  }

  return { enabled: false };
}

export function writeFastModeState(
  statePath: string,
  state: FastModeState,
): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export default function openaiCodexFastMode(pi: ExtensionAPI) {
  const statePath = join(getAgentDir(), STATE_FILE_NAME);
  let fastModeEnabled = readFastModeState(statePath).enabled;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, fastModeEnabled ? "fast" : undefined);
  }

  function setFastMode(enabled: boolean, ctx: ExtensionContext): void {
    writeFastModeState(statePath, { enabled });
    fastModeEnabled = enabled;
    updateStatus(ctx);
    ctx.ui.notify(
      `OpenAI Codex Fast mode ${enabled ? "enabled" : "disabled"}`,
      "info",
    );
  }

  pi.on("session_start", (_event, ctx) => {
    fastModeEnabled = readFastModeState(statePath).enabled;
    updateStatus(ctx);
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex Fast mode: /fast [on|off|status]",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off", "status"];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length > 0
        ? matches.map((option) => ({ value: option, label: option }))
        : null;
    },
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case "":
          setFastMode(!fastModeEnabled, ctx);
          break;
        case "on":
          setFastMode(true, ctx);
          break;
        case "off":
          setFastMode(false, ctx);
          break;
        case "status":
          ctx.ui.notify(
            `OpenAI Codex Fast mode is ${fastModeEnabled ? "enabled" : "disabled"}`,
            "info",
          );
          break;
        default:
          ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastModeEnabled) return;

    const model = ctx.model;
    if (!model) return;
    if (model.provider !== "openai-codex") return;
    if (model.api !== "openai-codex-responses") return;
    if (!supportsFastMode(model.id)) return;

    if (!isRecord(event.payload)) return;
    if (event.payload.model !== model.id) return;
    if ("service_tier" in event.payload) return;

    return {
      ...event.payload,
      service_tier: "priority",
    };
  });
}
