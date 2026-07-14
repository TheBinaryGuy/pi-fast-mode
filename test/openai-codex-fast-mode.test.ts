import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiCodexFastMode, {
  readFastModeState,
  supportsFastMode,
  writeFastModeState,
} from "../extensions/openai-codex-fast-mode.ts";

const temporaryDirectories: string[] = [];

function createStatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "openai-codex-fast-mode.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("supportsFastMode", () => {
  it.each([
    "gpt-5.5",
    "gpt-5.6",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ])("supports %s", (modelId) => {
    expect(supportsFastMode(modelId)).toBe(true);
  });

  it.each(["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-6"])(
    "does not support %s",
    (modelId) => {
      expect(supportsFastMode(modelId)).toBe(false);
    },
  );
});

describe("persistent state", () => {
  it("defaults to disabled when the state file does not exist", () => {
    expect(readFastModeState(createStatePath())).toEqual({ enabled: false });
  });

  it("creates parent directories and persists enabled state", () => {
    const statePath = createStatePath();

    writeFastModeState(statePath, { enabled: true });

    expect(readFastModeState(statePath)).toEqual({ enabled: true });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      enabled: true,
    });
  });

  it("safely defaults to disabled for invalid state", () => {
    const statePath = createStatePath();
    writeFastModeState(statePath, { enabled: true });
    rmSync(statePath);

    expect(readFastModeState(statePath)).toEqual({ enabled: false });
  });
});

type ExtensionHandler = (event: unknown, context: unknown) => unknown;
type CommandHandler = (args: string, context: unknown) => Promise<void>;

function createExtensionHarness() {
  const handlers = new Map<string, ExtensionHandler>();
  let commandHandler: CommandHandler | undefined;

  const pi = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, command: { handler: CommandHandler }) {
      commandHandler = command.handler;
    },
  } as unknown as ExtensionAPI;

  openaiCodexFastMode(pi);

  return {
    getHandler(name: string): ExtensionHandler {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing handler: ${name}`);
      return handler;
    },
    getCommandHandler(): CommandHandler {
      if (!commandHandler) throw new Error("Missing /fast command");
      return commandHandler;
    },
  };
}

function createContext(modelId = "gpt-5.6-sol") {
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];

  return {
    context: {
      model: {
        id: modelId,
        provider: "openai-codex",
        api: "openai-codex-responses",
      },
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        notify(message: string) {
          notifications.push(message);
        },
      },
    },
    statuses,
    notifications,
  };
}

describe("extension", () => {
  it("toggles priority requests and persists state across extension instances", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fast-mode-agent-"));
    temporaryDirectories.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const first = createExtensionHarness();
    const firstContext = createContext();
    await first.getCommandHandler()("on", firstContext.context);

    const payload = { model: "gpt-5.6-sol", input: [] };
    expect(
      first.getHandler("before_provider_request")(
        { payload },
        firstContext.context,
      ),
    ).toEqual({ ...payload, service_tier: "priority" });

    const second = createExtensionHarness();
    const secondContext = createContext();
    second.getHandler("session_start")({}, secondContext.context);

    expect(secondContext.statuses.at(-1)).toBe("fast");
    expect(
      readFastModeState(join(agentDir, "openai-codex-fast-mode.json")),
    ).toEqual({
      enabled: true,
    });
  });

  it("does not override an existing service tier", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fast-mode-agent-"));
    temporaryDirectories.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const harness = createExtensionHarness();
    const { context } = createContext();
    await harness.getCommandHandler()("on", context);

    expect(
      harness.getHandler("before_provider_request")(
        {
          payload: {
            model: "gpt-5.6-sol",
            service_tier: "default",
          },
        },
        context,
      ),
    ).toBeUndefined();
  });

  it("stops adding priority after Fast mode is disabled", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fast-mode-agent-"));
    temporaryDirectories.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const harness = createExtensionHarness();
    const { context } = createContext();
    await harness.getCommandHandler()("on", context);
    await harness.getCommandHandler()("off", context);

    expect(
      harness.getHandler("before_provider_request")(
        { payload: { model: "gpt-5.6-sol" } },
        context,
      ),
    ).toBeUndefined();
  });
});
