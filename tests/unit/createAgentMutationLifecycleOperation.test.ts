import { describe, expect, it, vi } from "vitest";

import { createDefaultGuidedDraft } from "@/features/agents/creation/compiler";
import type { AgentCreateModalSubmitPayload } from "@/features/agents/creation/types";
import type {
  CreateAgentMutationLifecycleDeps,
} from "@/features/agents/operations/createAgentMutationLifecycleOperation";
import {
  isCreateBlockTimedOut,
  runCreateAgentMutationLifecycle,
  runPendingCreateSetupRetryLifecycle,
} from "@/features/agents/operations/createAgentMutationLifecycleOperation";
import type { AgentGuidedSetup } from "@/features/agents/operations/createAgentOperation";

const createPayload = (
  overrides: Partial<AgentCreateModalSubmitPayload> = {}
): AgentCreateModalSubmitPayload => ({
  mode: "guided",
  name: "Agent One",
  draft: createDefaultGuidedDraft(),
  avatarSeed: "seed-1",
  ...overrides,
});

const createDeps = (
  overrides: Partial<CreateAgentMutationLifecycleDeps> = {}
): CreateAgentMutationLifecycleDeps => ({
  enqueueConfigMutation: async ({ run }) => {
    await run();
  },
  createAgent: async () => ({ id: "agent-1" }),
  applySetup: async () => undefined,
  upsertPending: () => undefined,
  removePending: () => undefined,
  setQueuedBlock: () => undefined,
  setCreatingBlock: () => undefined,
  setApplyingSetupBlock: () => undefined,
  onCompletion: async () => undefined,
  setCreateAgentModalOpen: () => undefined,
  setCreateAgentModalError: () => undefined,
  setCreateAgentBusy: () => undefined,
  clearCreateBlock: () => undefined,
  onError: () => undefined,
  ...overrides,
});

describe("createAgentMutationLifecycleOperation", () => {
  it("blocks create and sets modal error when disconnected", async () => {
    const setCreateAgentModalError = vi.fn();
    const enqueueConfigMutation = vi.fn(async () => undefined);

    const result = await runCreateAgentMutationLifecycle(
      {
        payload: createPayload(),
        status: "disconnected",
        hasCreateBlock: false,
        hasRenameBlock: false,
        hasDeleteBlock: false,
        createAgentBusy: false,
        isLocalGateway: true,
      },
      createDeps({
        setCreateAgentModalError,
        enqueueConfigMutation,
      })
    );

    expect(result).toBe(false);
    expect(setCreateAgentModalError).toHaveBeenCalledWith("Connect to gateway before creating an agent.");
    expect(enqueueConfigMutation).not.toHaveBeenCalled();
  });

  it("fails fast on compile validation error and does not enqueue mutation", async () => {
    const setCreateAgentModalError = vi.fn();
    const enqueueConfigMutation = vi.fn(async () => undefined);
    const invalidDraft = createDefaultGuidedDraft();
    invalidDraft.controls.execAutonomy = "auto";
    invalidDraft.controls.allowExec = false;

    const result = await runCreateAgentMutationLifecycle(
      {
        payload: createPayload({ draft: invalidDraft }),
        status: "connected",
        hasCreateBlock: false,
        hasRenameBlock: false,
        hasDeleteBlock: false,
        createAgentBusy: false,
        isLocalGateway: true,
      },
      createDeps({
        setCreateAgentModalError,
        enqueueConfigMutation,
      })
    );

    expect(result).toBe(false);
    expect(setCreateAgentModalError).toHaveBeenCalledWith("Auto exec requires runtime tools to be enabled.");
    expect(enqueueConfigMutation).not.toHaveBeenCalled();
  });

  it("runs successful local create/apply flow and completion commands", async () => {
    const order: string[] = [];
    const onCompletion = vi.fn(async (completion: { pendingErrorMessage: string | null }) => {
      order.push(`completion:${completion.pendingErrorMessage === null ? "applied" : "pending"}`);
    });

    const result = await runCreateAgentMutationLifecycle(
      {
        payload: createPayload(),
        status: "connected",
        hasCreateBlock: false,
        hasRenameBlock: false,
        hasDeleteBlock: false,
        createAgentBusy: false,
        isLocalGateway: true,
      },
      createDeps({
        setCreateAgentBusy: (busy) => {
          order.push(`busy:${busy ? "on" : "off"}`);
        },
        setCreateAgentModalError: (message) => {
          order.push(`modalError:${message === null ? "clear" : "set"}`);
        },
        setQueuedBlock: () => {
          order.push("queued");
        },
        enqueueConfigMutation: async ({ run }) => {
          order.push("enqueue");
          await run();
        },
        setCreatingBlock: () => {
          order.push("creating");
        },
        createAgent: async () => {
          order.push("createAgent");
          return { id: "agent-1" };
        },
        setApplyingSetupBlock: () => {
          order.push("applying");
        },
        applySetup: async () => {
          order.push("applySetup");
        },
        removePending: () => {
          order.push("removePending");
        },
        setCreateAgentModalOpen: (open) => {
          order.push(`modalOpen:${open ? "true" : "false"}`);
        },
        onCompletion,
      })
    );

    expect(result).toBe(true);
    expect(order).toEqual([
      "busy:on",
      "modalError:clear",
      "queued",
      "enqueue",
      "creating",
      "createAgent",
      "modalOpen:false",
      "applying",
      "applySetup",
      "removePending",
      "completion:applied",
      "busy:off",
    ]);
    expect(onCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps create successful but reports pending completion when setup apply fails", async () => {
    const upsertPending = vi.fn();
    const removePending = vi.fn();
    const onCompletion = vi.fn();

    const result = await runCreateAgentMutationLifecycle(
      {
        payload: createPayload(),
        status: "connected",
        hasCreateBlock: false,
        hasRenameBlock: false,
        hasDeleteBlock: false,
        createAgentBusy: false,
        isLocalGateway: true,
      },
      createDeps({
        applySetup: async () => {
          throw new Error("setup exploded");
        },
        upsertPending,
        removePending,
        onCompletion,
      })
    );

    expect(result).toBe(true);
    expect(upsertPending).toHaveBeenCalledTimes(1);
    expect(removePending).not.toHaveBeenCalled();
    expect(onCompletion).toHaveBeenCalledWith({
      shouldReloadAgents: true,
      shouldCloseCreateModal: true,
      pendingErrorMessage:
        'Agent "Agent One" was created, but guided setup is pending. Retry or discard setup from chat. setup exploded',
    });
  });

  it("handles manual pending setup retry success", async () => {
    const pendingSetup = {} as AgentGuidedSetup;
    const onApplied = vi.fn();
    const removePending = vi.fn();
    const onError = vi.fn();

    const result = await runPendingCreateSetupRetryLifecycle({
      agentId: "agent-1",
      source: "manual",
      retryBusyAgentId: null,
      inFlightAgentIds: new Set<string>(),
      pendingSetupsByAgentId: { "agent-1": pendingSetup },
      setRetryBusyAgentId: () => undefined,
      applyPendingSetup: async () => ({ applied: true }),
      removePending,
      isDisconnectLikeError: () => false,
      resolveAgentName: () => "Agent One",
      onApplied,
      onError,
    });

    expect(result).toBe(true);
    expect(removePending).toHaveBeenCalledWith("agent-1");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces manual pending setup retry failures", async () => {
    const onError = vi.fn();

    const result = await runPendingCreateSetupRetryLifecycle({
      agentId: "agent-1",
      source: "manual",
      retryBusyAgentId: null,
      inFlightAgentIds: new Set<string>(),
      pendingSetupsByAgentId: { "agent-1": {} as AgentGuidedSetup },
      setRetryBusyAgentId: () => undefined,
      applyPendingSetup: async () => {
        throw new Error("retry exploded");
      },
      removePending: () => undefined,
      isDisconnectLikeError: () => false,
      resolveAgentName: () => "Agent One",
      onApplied: () => undefined,
      onError,
    });

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledWith('Guided setup retry failed for "Agent One". retry exploded');
  });

  it("maps create block timeout through shared mutation timeout policy", () => {
    expect(
      isCreateBlockTimedOut({
        block: null,
        nowMs: 100_000,
        maxWaitMs: 90_000,
      })
    ).toBe(false);

    expect(
      isCreateBlockTimedOut({
        block: {
          agentId: null,
          agentName: "Agent One",
          phase: "queued",
          startedAt: 0,
        },
        nowMs: 100_000,
        maxWaitMs: 90_000,
      })
    ).toBe(false);

    expect(
      isCreateBlockTimedOut({
        block: {
          agentId: "agent-1",
          agentName: "Agent One",
          phase: "creating",
          startedAt: 0,
        },
        nowMs: 95_000,
        maxWaitMs: 90_000,
      })
    ).toBe(true);

    expect(
      isCreateBlockTimedOut({
        block: {
          agentId: "agent-1",
          agentName: "Agent One",
          phase: "applying-setup",
          startedAt: 0,
        },
        nowMs: 45_000,
        maxWaitMs: 90_000,
      })
    ).toBe(false);
  });
});
