import { compileGuidedAgentCreation } from "@/features/agents/creation/compiler";
import type { AgentCreateModalSubmitPayload } from "@/features/agents/creation/types";
import type { AgentGuidedSetup } from "@/features/agents/operations/createAgentOperation";
import {
  resolveGuidedCreateCompletion,
  runGuidedCreateWorkflow,
  runGuidedRetryWorkflow,
  type GuidedCreateCompletion,
} from "@/features/agents/operations/guidedCreateWorkflow";
import { applyPendingGuidedSetupRetryViaStudio } from "@/features/agents/operations/pendingGuidedSetupRetryOperation";
import {
  resolveMutationStartGuard,
  resolveMutationTimeoutIntent,
} from "@/features/agents/operations/agentMutationLifecycleController";
import type { ConfigMutationKind } from "@/features/agents/operations/useConfigMutationQueue";

type SetState<T> = (next: T | ((current: T) => T)) => void;

export type CreateAgentBlockState = {
  agentId: string | null;
  agentName: string;
  phase: "queued" | "creating" | "applying-setup";
  startedAt: number;
};

export type CreateAgentMutationLifecycleDeps = {
  enqueueConfigMutation: (params: {
    kind: ConfigMutationKind;
    label: string;
    run: () => Promise<void>;
  }) => Promise<void>;
  createAgent: (name: string, avatarSeed: string | null) => Promise<{ id: string }>;
  applySetup: (agentId: string, setup: AgentGuidedSetup) => Promise<void>;
  upsertPending: (agentId: string, setup: AgentGuidedSetup) => void;
  removePending: (agentId: string) => void;
  setQueuedBlock: (params: { agentName: string; startedAt: number }) => void;
  setCreatingBlock: (agentName: string) => void;
  setApplyingSetupBlock: (params: { agentName: string; agentId: string }) => void;
  onCompletion: (completion: GuidedCreateCompletion) => Promise<void> | void;
  setCreateAgentModalOpen: (open: boolean) => void;
  setCreateAgentModalError: (message: string | null) => void;
  setCreateAgentBusy: (busy: boolean) => void;
  clearCreateBlock: () => void;
  onError: (message: string) => void;
  now?: () => number;
};

export const runCreateAgentMutationLifecycle = async (
  params: {
    payload: AgentCreateModalSubmitPayload;
    status: "connected" | "connecting" | "disconnected";
    hasCreateBlock: boolean;
    hasRenameBlock: boolean;
    hasDeleteBlock: boolean;
    createAgentBusy: boolean;
    isLocalGateway: boolean;
  },
  deps: CreateAgentMutationLifecycleDeps
): Promise<boolean> => {
  if (params.createAgentBusy) return false;
  const guard = resolveMutationStartGuard({
    status: params.status,
    hasCreateBlock: params.hasCreateBlock,
    hasRenameBlock: params.hasRenameBlock,
    hasDeleteBlock: params.hasDeleteBlock,
  });
  if (guard.kind === "deny") {
    if (guard.reason === "not-connected") {
      deps.setCreateAgentModalError("Connect to gateway before creating an agent.");
    }
    return false;
  }

  const name = params.payload.name.trim();
  if (!name) {
    deps.setCreateAgentModalError("Agent name is required.");
    return false;
  }

  const compiled = compileGuidedAgentCreation({ name, draft: params.payload.draft });
  if (compiled.validation.errors.length > 0) {
    deps.setCreateAgentModalError(compiled.validation.errors[0] ?? "Guided setup is incomplete.");
    return false;
  }
  const setup: AgentGuidedSetup = {
    agentOverrides: compiled.agentOverrides,
    files: compiled.files,
    execApprovals: compiled.execApprovals,
  };

  deps.setCreateAgentBusy(true);
  deps.setCreateAgentModalError(null);
  const startedAt = (deps.now ?? Date.now)();
  deps.setQueuedBlock({ agentName: name, startedAt });
  const avatarSeed = params.payload.avatarSeed?.trim() ?? null;
  try {
    const queuedMutation = deps.enqueueConfigMutation({
      kind: "create-agent",
      label: `Create ${name}`,
      run: async () => {
        deps.setCreatingBlock(name);
        const result = await runGuidedCreateWorkflow(
          {
            name,
            setup,
            isLocalGateway: params.isLocalGateway,
          },
          {
            createAgent: async (agentName) => {
              return await deps.createAgent(agentName, avatarSeed);
            },
            applySetup: async (agentId, nextSetup) => {
              deps.setApplyingSetupBlock({ agentName: name, agentId });
              await deps.applySetup(agentId, nextSetup);
            },
            upsertPending: deps.upsertPending,
            removePending: deps.removePending,
          }
        );
        await deps.onCompletion(
          resolveGuidedCreateCompletion({
            agentName: name,
            result,
          })
        );
      },
    });
    deps.setCreateAgentModalOpen(false);
    await queuedMutation;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create agent.";
    deps.clearCreateBlock();
    deps.setCreateAgentModalError(message);
    deps.onError(message);
    return false;
  } finally {
    deps.setCreateAgentBusy(false);
  }
};

export const runPendingCreateSetupRetryLifecycle = async (params: {
  agentId: string;
  source: "auto" | "manual";
  retryBusyAgentId: string | null;
  inFlightAgentIds: Set<string>;
  pendingSetupsByAgentId: Record<string, AgentGuidedSetup>;
  setRetryBusyAgentId: SetState<string | null>;
  applyPendingSetup: (agentId: string) => Promise<{ applied: boolean }>;
  removePending: (agentId: string) => void;
  isDisconnectLikeError: (error: unknown) => boolean;
  resolveAgentName: (agentId: string) => string;
  onApplied: () => Promise<void> | void;
  onError: (message: string) => void;
}): Promise<boolean> => {
  return await applyPendingGuidedSetupRetryViaStudio({
    agentId: params.agentId,
    source: params.source,
    retryBusyAgentId: params.retryBusyAgentId,
    inFlightAgentIds: params.inFlightAgentIds,
    pendingSetupsByAgentId: params.pendingSetupsByAgentId,
    setRetryBusyAgentId: params.setRetryBusyAgentId,
    executeRetry: async (agentId) =>
      runGuidedRetryWorkflow(agentId, {
        applyPendingSetup: params.applyPendingSetup,
        removePending: params.removePending,
      }),
    isDisconnectLikeError: params.isDisconnectLikeError,
    resolveAgentName: params.resolveAgentName,
    onApplied: params.onApplied,
    onError: params.onError,
  });
};

export const isCreateBlockTimedOut = (params: {
  block: CreateAgentBlockState | null;
  nowMs: number;
  maxWaitMs: number;
}): boolean => {
  if (!params.block || params.block.phase === "queued") {
    return false;
  }
  const timeoutIntent = resolveMutationTimeoutIntent({
    block: {
      kind: "create-agent",
      agentId: params.block.agentId ?? "",
      agentName: params.block.agentName,
      phase: "mutating",
      startedAt: params.block.startedAt,
      sawDisconnect: false,
    },
    nowMs: params.nowMs,
    maxWaitMs: params.maxWaitMs,
  });
  return timeoutIntent.kind === "timeout" && timeoutIntent.reason === "create-timeout";
};
