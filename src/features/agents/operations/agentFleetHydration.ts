import { buildAgentMainSessionKey, isSameSessionKey } from "@/lib/gateway/GatewayClient";
import { resolveConfiguredModelKey, type GatewayModelPolicySnapshot } from "@/lib/gateway/models";
import { resolveAgentAvatarSeed, type StudioSettings } from "@/lib/studio/settings";
import {
  buildSummarySnapshotPatches,
  type SummaryPreviewSnapshot,
  type SummarySnapshotAgent,
  type SummarySnapshotPatch,
  type SummaryStatusSnapshot,
} from "@/features/agents/state/runtimeEventBridge";
import type { AgentStoreSeed } from "@/features/agents/state/store";

type GatewayClientLike = {
  call: (method: string, params: unknown) => Promise<unknown>;
};

type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope?: string;
  agents: Array<{
    id: string;
    name?: string;
    identity?: {
      name?: string;
      theme?: string;
      emoji?: string;
      avatar?: string;
      avatarUrl?: string;
    };
  }>;
};

type SessionsListEntry = {
  key: string;
  updatedAt?: number | null;
  displayName?: string;
  origin?: { label?: string | null; provider?: string | null } | null;
  thinkingLevel?: string;
  modelProvider?: string;
  model?: string;
  execHost?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
};

type SessionsListResult = {
  sessions?: SessionsListEntry[];
};

type ExecHost = "sandbox" | "gateway" | "node";
type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";

type ExecApprovalsSnapshot = {
  file?: {
    agents?: Record<string, { security?: string | null; ask?: string | null }>;
  };
};

type ExecPolicyEntry = {
  security?: ExecSecurity;
  ask?: ExecAsk;
};

const normalizeExecHost = (raw: string | null | undefined): ExecHost | undefined => {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return undefined;
};

const normalizeExecSecurity = (raw: string | null | undefined): ExecSecurity | undefined => {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
};

const normalizeExecAsk = (raw: string | null | undefined): ExecAsk | undefined => {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return undefined;
};

const resolveAgentName = (agent: AgentsListResult["agents"][number]) => {
  const fromList = typeof agent.name === "string" ? agent.name.trim() : "";
  if (fromList) return fromList;
  const fromIdentity = typeof agent.identity?.name === "string" ? agent.identity.name.trim() : "";
  if (fromIdentity) return fromIdentity;
  return agent.id;
};

const resolveAgentAvatarUrl = (agent: AgentsListResult["agents"][number]) => {
  const candidate = agent.identity?.avatarUrl ?? agent.identity?.avatar ?? null;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("data:image/")) return trimmed;
  return null;
};

const resolveDefaultModelForAgent = (
  agentId: string,
  snapshot: GatewayModelPolicySnapshot | null
): string | null => {
  const resolvedAgentId = agentId.trim();
  if (!resolvedAgentId) return null;
  const defaults = snapshot?.config?.agents?.defaults;
  const modelAliases = defaults?.models;
  const agentEntry =
    snapshot?.config?.agents?.list?.find((entry) => entry?.id?.trim() === resolvedAgentId) ??
    null;
  const agentModel = agentEntry?.model;
  let raw: string | null = null;
  if (typeof agentModel === "string") {
    raw = agentModel;
  } else if (agentModel && typeof agentModel === "object") {
    raw = agentModel.primary ?? null;
  }
  if (!raw) {
    const defaultModel = defaults?.model;
    if (typeof defaultModel === "string") {
      raw = defaultModel;
    } else if (defaultModel && typeof defaultModel === "object") {
      raw = defaultModel.primary ?? null;
    }
  }
  if (!raw) return null;
  return resolveConfiguredModelKey(raw, modelAliases);
};

export type HydrateAgentFleetResult = {
  seeds: AgentStoreSeed[];
  sessionCreatedAgentIds: string[];
  sessionSettingsSyncedAgentIds: string[];
  summaryPatches: SummarySnapshotPatch[];
  suggestedSelectedAgentId: string | null;
  configSnapshot: GatewayModelPolicySnapshot | null;
};

export async function hydrateAgentFleetFromGateway(params: {
  client: GatewayClientLike;
  gatewayUrl: string;
  cachedConfigSnapshot: GatewayModelPolicySnapshot | null;
  loadStudioSettings: () => Promise<StudioSettings | null>;
  isDisconnectLikeError: (err: unknown) => boolean;
  logError?: (message: string, error: unknown) => void;
}): Promise<HydrateAgentFleetResult> {
  const logError = params.logError ?? ((message, error) => console.error(message, error));

  let configSnapshot = params.cachedConfigSnapshot;
  if (!configSnapshot) {
    try {
      configSnapshot = (await params.client.call(
        "config.get",
        {}
      )) as GatewayModelPolicySnapshot;
    } catch (err) {
      if (!params.isDisconnectLikeError(err)) {
        logError("Failed to load gateway config while loading agents.", err);
      }
    }
  }

  const gatewayKey = params.gatewayUrl.trim();
  let settings: StudioSettings | null = null;
  if (gatewayKey) {
    try {
      settings = await params.loadStudioSettings();
    } catch (err) {
      logError("Failed to load studio settings while loading agents.", err);
    }
  }

  let execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  try {
    execApprovalsSnapshot = (await params.client.call(
      "exec.approvals.get",
      {}
    )) as ExecApprovalsSnapshot;
  } catch (err) {
    if (!params.isDisconnectLikeError(err)) {
      logError("Failed to load exec approvals while loading agents.", err);
    }
  }
  const execPolicyByAgentId = new Map<string, ExecPolicyEntry>();
  const execAgents = execApprovalsSnapshot?.file?.agents ?? {};
  for (const [agentId, entry] of Object.entries(execAgents)) {
    const normalizedSecurity = normalizeExecSecurity(entry?.security);
    const normalizedAsk = normalizeExecAsk(entry?.ask);
    if (!normalizedSecurity && !normalizedAsk) continue;
    execPolicyByAgentId.set(agentId, {
      security: normalizedSecurity,
      ask: normalizedAsk,
    });
  }

  const agentsResult = (await params.client.call("agents.list", {})) as AgentsListResult;
  const mainKey = agentsResult.mainKey?.trim() || "main";

  const mainSessionKeyByAgent = new Map<string, SessionsListEntry | null>();
  await Promise.all(
    agentsResult.agents.map(async (agent) => {
      try {
        const expectedMainKey = buildAgentMainSessionKey(agent.id, mainKey);
        const sessions = (await params.client.call("sessions.list", {
          agentId: agent.id,
          includeGlobal: false,
          includeUnknown: false,
          search: expectedMainKey,
          limit: 4,
        })) as SessionsListResult;
        const entries = Array.isArray(sessions.sessions) ? sessions.sessions : [];
        const mainEntry =
          entries.find((entry) => isSameSessionKey(entry.key ?? "", expectedMainKey)) ?? null;
        mainSessionKeyByAgent.set(agent.id, mainEntry);
      } catch (err) {
        if (!params.isDisconnectLikeError(err)) {
          logError("Failed to list sessions while resolving agent session.", err);
        }
        mainSessionKeyByAgent.set(agent.id, null);
      }
    })
  );

  const needsSessionSettingsSync = new Set<string>();
  const seeds: AgentStoreSeed[] = agentsResult.agents.map((agent) => {
    const persistedSeed = settings && gatewayKey ? resolveAgentAvatarSeed(settings, gatewayKey, agent.id) : null;
    const avatarSeed = persistedSeed ?? agent.id;
    const avatarUrl = resolveAgentAvatarUrl(agent);
    const name = resolveAgentName(agent);
    const mainSession = mainSessionKeyByAgent.get(agent.id) ?? null;
    const modelProvider = typeof mainSession?.modelProvider === "string" ? mainSession.modelProvider.trim() : "";
    const modelId = typeof mainSession?.model === "string" ? mainSession.model.trim() : "";
    const model =
      modelProvider && modelId
        ? `${modelProvider}/${modelId}`
        : resolveDefaultModelForAgent(agent.id, configSnapshot);
    const thinkingLevel = typeof mainSession?.thinkingLevel === "string" ? mainSession.thinkingLevel : null;
    const sessionExecHost = normalizeExecHost(mainSession?.execHost);
    const sessionExecSecurity = normalizeExecSecurity(mainSession?.execSecurity);
    const sessionExecAsk = normalizeExecAsk(mainSession?.execAsk);
    const policy = execPolicyByAgentId.get(agent.id);
    const resolvedExecSecurity = sessionExecSecurity ?? policy?.security;
    const resolvedExecAsk = sessionExecAsk ?? policy?.ask;
    const resolvedExecHost =
      sessionExecHost ?? (resolvedExecSecurity || resolvedExecAsk ? "gateway" : undefined);
    const expectsExecOverrides = Boolean(resolvedExecHost || resolvedExecSecurity || resolvedExecAsk);
    const hasMatchingExecOverrides =
      sessionExecHost === resolvedExecHost &&
      sessionExecSecurity === resolvedExecSecurity &&
      sessionExecAsk === resolvedExecAsk;
    if (expectsExecOverrides && !hasMatchingExecOverrides) {
      needsSessionSettingsSync.add(agent.id);
    }
    return {
      agentId: agent.id,
      name,
      sessionKey: buildAgentMainSessionKey(agent.id, mainKey),
      avatarSeed,
      avatarUrl,
      model,
      thinkingLevel,
      sessionExecHost: resolvedExecHost,
      sessionExecSecurity: resolvedExecSecurity,
      sessionExecAsk: resolvedExecAsk,
    };
  });

  const sessionCreatedAgentIds: string[] = [];
  const sessionSettingsSyncedAgentIds: string[] = [];
  for (const seed of seeds) {
    const mainSession = mainSessionKeyByAgent.get(seed.agentId) ?? null;
    if (!mainSession) continue;
    sessionCreatedAgentIds.push(seed.agentId);
    if (!needsSessionSettingsSync.has(seed.agentId)) {
      sessionSettingsSyncedAgentIds.push(seed.agentId);
    }
  }

  let summaryPatches: SummarySnapshotPatch[] = [];
  let suggestedSelectedAgentId: string | null = null;
  try {
    const activeAgents: SummarySnapshotAgent[] = [];
    for (const seed of seeds) {
      const mainSession = mainSessionKeyByAgent.get(seed.agentId) ?? null;
      if (!mainSession) continue;
      activeAgents.push({
        agentId: seed.agentId,
        sessionKey: seed.sessionKey,
        status: "idle",
      });
    }
    const sessionKeys = Array.from(
      new Set(
        activeAgents
          .map((agent) => agent.sessionKey)
          .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
      )
    ).slice(0, 64);
    if (sessionKeys.length > 0) {
      const [statusSummary, previewResult] = await Promise.all([
        params.client.call("status", {}) as Promise<SummaryStatusSnapshot>,
        params.client.call("sessions.preview", {
          keys: sessionKeys,
          limit: 8,
          maxChars: 240,
        }) as Promise<SummaryPreviewSnapshot>,
      ]);
      summaryPatches = buildSummarySnapshotPatches({
        agents: activeAgents,
        statusSummary,
        previewResult,
      });

      const assistantAtByAgentId = new Map<string, number>();
      for (const entry of summaryPatches) {
        if (typeof entry.patch.lastAssistantMessageAt === "number") {
          assistantAtByAgentId.set(entry.agentId, entry.patch.lastAssistantMessageAt);
        }
      }

      let bestAgentId: string | null = seeds[0]?.agentId ?? null;
      let bestTs = bestAgentId ? (assistantAtByAgentId.get(bestAgentId) ?? 0) : 0;
      for (const seed of seeds) {
        const ts = assistantAtByAgentId.get(seed.agentId) ?? 0;
        if (ts <= bestTs) continue;
        bestTs = ts;
        bestAgentId = seed.agentId;
      }
      suggestedSelectedAgentId = bestAgentId;
    }
  } catch (err) {
    if (!params.isDisconnectLikeError(err)) {
      logError("Failed to load initial summary snapshot.", err);
    }
  }

  return {
    seeds,
    sessionCreatedAgentIds,
    sessionSettingsSyncedAgentIds,
    summaryPatches,
    suggestedSelectedAgentId,
    configSnapshot: configSnapshot ?? null,
  };
}
