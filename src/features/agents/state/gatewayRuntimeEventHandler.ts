import type { AgentState } from "@/features/agents/state/store";
import {
  classifyGatewayEventKind,
  dedupeRunLines,
  getAgentSummaryPatch,
  getChatSummaryPatch,
  isReasoningRuntimeAgentStream,
  mergeRuntimeStream,
  resolveLifecyclePatch,
  resolveAssistantCompletionTimestamp,
  shouldPublishAssistantStream,
  type AgentEventPayload,
  type ChatEventPayload,
} from "@/features/agents/state/runtimeEventBridge";
import { type EventFrame, isSameSessionKey } from "@/lib/gateway/GatewayClient";
import {
  extractText,
  extractThinking,
  extractThinkingFromTaggedStream,
  extractToolLines,
  formatThinkingMarkdown,
  formatToolCallMarkdown,
  isTraceMarkdown,
  isUiMetadataPrefix,
  stripUiMetadata,
} from "@/lib/text/message-extract";

type RuntimeDispatchAction =
  | { type: "updateAgent"; agentId: string; patch: Partial<AgentState> }
  | { type: "appendOutput"; agentId: string; line: string }
  | { type: "markActivity"; agentId: string; at?: number };

export type GatewayRuntimeEventHandlerDeps = {
  getStatus: () => "disconnected" | "connecting" | "connected";
  getAgents: () => AgentState[];
  dispatch: (action: RuntimeDispatchAction) => void;
  queueLivePatch: (agentId: string, patch: Partial<AgentState>) => void;
  now?: () => number;

  loadSummarySnapshot: () => Promise<void>;
  loadAgentHistory: (agentId: string) => Promise<void>;
  refreshHeartbeatLatestUpdate: () => void;
  bumpHeartbeatTick: () => void;

  setTimeout: (fn: () => void, delayMs: number) => number;
  clearTimeout: (id: number) => void;

  isDisconnectLikeError: (err: unknown) => boolean;
  logWarn?: (message: string, meta?: unknown) => void;

  updateSpecialLatestUpdate: (agentId: string, agent: AgentState, message: string) => void;
};

export type GatewayRuntimeEventHandler = {
  handleEvent: (event: EventFrame) => void;
  dispose: () => void;
};

const findAgentBySessionKey = (agents: AgentState[], sessionKey: string): string | null => {
  const exact = agents.find((agent) => isSameSessionKey(agent.sessionKey, sessionKey));
  return exact ? exact.agentId : null;
};

const findAgentByRunId = (agents: AgentState[], runId: string): string | null => {
  const match = agents.find((agent) => agent.runId === runId);
  return match ? match.agentId : null;
};

const resolveRole = (message: unknown) =>
  message && typeof message === "object"
    ? (message as Record<string, unknown>).role
    : null;

const summarizeThinkingMessage = (message: unknown) => {
  if (!message || typeof message !== "object") {
    return { type: typeof message };
  }
  const record = message as Record<string, unknown>;
  const summary: Record<string, unknown> = { keys: Object.keys(record) };
  const content = record.content;
  if (Array.isArray(content)) {
    summary.contentTypes = content.map((item) => {
      if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        return typeof entry.type === "string" ? entry.type : "object";
      }
      return typeof item;
    });
  } else if (typeof content === "string") {
    summary.contentLength = content.length;
  }
  if (typeof record.text === "string") {
    summary.textLength = record.text.length;
  }
  for (const key of ["analysis", "reasoning", "thinking"]) {
    const value = record[key];
    if (typeof value === "string") {
      summary[`${key}Length`] = value.length;
    } else if (value && typeof value === "object") {
      summary[`${key}Keys`] = Object.keys(value as Record<string, unknown>);
    }
  }
  return summary;
};

const extractReasoningBody = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^reasoning:\s*([\s\S]*)$/i);
  if (!match) return null;
  const body = (match[1] ?? "").trim();
  return body || null;
};

const resolveThinkingFromAgentStream = (
  data: Record<string, unknown> | null,
  rawStream: string,
  opts?: { treatPlainTextAsThinking?: boolean }
): string | null => {
  if (data) {
    const extracted = extractThinking(data);
    if (extracted) return extracted;
    const text = typeof data.text === "string" ? data.text : "";
    const delta = typeof data.delta === "string" ? data.delta : "";
    const prefixed = extractReasoningBody(text) ?? extractReasoningBody(delta);
    if (prefixed) return prefixed;
    if (opts?.treatPlainTextAsThinking) {
      const cleanedDelta = delta.trim();
      if (cleanedDelta) return cleanedDelta;
      const cleanedText = text.trim();
      if (cleanedText) return cleanedText;
    }
  }
  const tagged = extractThinkingFromTaggedStream(rawStream);
  return tagged || null;
};

export function createGatewayRuntimeEventHandler(
  deps: GatewayRuntimeEventHandlerDeps
): GatewayRuntimeEventHandler {
  const now = deps.now ?? (() => Date.now());
  const chatRunSeen = new Set<string>();
  const assistantStreamByRun = new Map<string, string>();
  const thinkingStreamByRun = new Map<string, string>();
  const toolLinesSeenByRun = new Map<string, Set<string>>();
  const thinkingDebugBySession = new Set<string>();
  const lastActivityMarkByAgent = new Map<string, number>();

  let summaryRefreshTimer: number | null = null;

  const appendUniqueToolLines = (agentId: string, runId: string | null | undefined, lines: string[]) => {
    if (lines.length === 0) return;
    if (!runId) {
      for (const line of lines) {
        deps.dispatch({ type: "appendOutput", agentId, line });
      }
      return;
    }
    const current = toolLinesSeenByRun.get(runId) ?? new Set<string>();
    const { appended, nextSeen } = dedupeRunLines(current, lines);
    toolLinesSeenByRun.set(runId, nextSeen);
    for (const line of appended) {
      deps.dispatch({ type: "appendOutput", agentId, line });
    }
  };

  const clearRunTracking = (runId?: string | null) => {
    if (!runId) return;
    chatRunSeen.delete(runId);
    assistantStreamByRun.delete(runId);
    thinkingStreamByRun.delete(runId);
    toolLinesSeenByRun.delete(runId);
  };

  const markActivityThrottled = (agentId: string, at: number = now()) => {
    const lastAt = lastActivityMarkByAgent.get(agentId) ?? 0;
    if (at - lastAt < 300) return;
    lastActivityMarkByAgent.set(agentId, at);
    deps.dispatch({ type: "markActivity", agentId, at });
  };

  const logWarn =
    deps.logWarn ??
    ((message: string, meta?: unknown) => {
      console.warn(message, meta);
    });

  const dispose = () => {
    if (summaryRefreshTimer !== null) {
      deps.clearTimeout(summaryRefreshTimer);
      summaryRefreshTimer = null;
    }
    chatRunSeen.clear();
    assistantStreamByRun.clear();
    thinkingStreamByRun.clear();
    toolLinesSeenByRun.clear();
    thinkingDebugBySession.clear();
    lastActivityMarkByAgent.clear();
  };

  const handleRuntimeChatEvent = (payload: ChatEventPayload) => {
    if (!payload.sessionKey) return;

    if (payload.runId) {
      chatRunSeen.add(payload.runId);
    }

    const agentsSnapshot = deps.getAgents();
    const agentId = findAgentBySessionKey(agentsSnapshot, payload.sessionKey);
    if (!agentId) return;
    const agent = agentsSnapshot.find((entry) => entry.agentId === agentId);

    const role = resolveRole(payload.message);
    const summaryPatch = getChatSummaryPatch(payload, now());
    if (summaryPatch) {
      deps.dispatch({
        type: "updateAgent",
        agentId,
        patch: {
          ...summaryPatch,
          sessionCreated: true,
        },
      });
    }

    if (role === "user" || role === "system") {
      return;
    }

    markActivityThrottled(agentId);

    const nextTextRaw = extractText(payload.message);
    const nextText = nextTextRaw ? stripUiMetadata(nextTextRaw) : null;
    const nextThinking = extractThinking(payload.message ?? payload);
    const toolLines = extractToolLines(payload.message ?? payload);
    const isToolRole = role === "tool" || role === "toolResult";

    if (payload.state === "delta") {
      if (typeof nextTextRaw === "string" && isUiMetadataPrefix(nextTextRaw.trim())) {
        return;
      }
      appendUniqueToolLines(agentId, payload.runId ?? null, toolLines);
      const patch: Partial<AgentState> = {};
      if (nextThinking) {
        patch.thinkingTrace = nextThinking;
        patch.status = "running";
      }
      if (typeof nextText === "string") {
        patch.streamText = nextText;
        patch.status = "running";
      }
      if (Object.keys(patch).length > 0) {
        deps.queueLivePatch(agentId, patch);
      }
      return;
    }

    if (payload.state === "final") {
      clearRunTracking(payload.runId ?? null);
      if (!nextThinking && role === "assistant" && !thinkingDebugBySession.has(payload.sessionKey)) {
        thinkingDebugBySession.add(payload.sessionKey);
        logWarn("No thinking trace extracted from chat event.", {
          sessionKey: payload.sessionKey,
          message: summarizeThinkingMessage(payload.message ?? payload),
        });
      }
      const thinkingText = nextThinking ?? agent?.thinkingTrace ?? null;
      const thinkingLine = thinkingText ? formatThinkingMarkdown(thinkingText) : "";
      if (thinkingLine) {
        deps.dispatch({
          type: "appendOutput",
          agentId,
          line: thinkingLine,
        });
      }
      appendUniqueToolLines(agentId, payload.runId ?? null, toolLines);
      if (
        !thinkingLine &&
        role === "assistant" &&
        agent &&
        !agent.outputLines.some((line) => isTraceMarkdown(line.trim()))
      ) {
        void deps.loadAgentHistory(agentId);
      }
      if (!isToolRole && typeof nextText === "string") {
        deps.dispatch({
          type: "appendOutput",
          agentId,
          line: nextText,
        });
        deps.dispatch({
          type: "updateAgent",
          agentId,
          patch: { lastResult: nextText },
        });
      }
      if (agent?.lastUserMessage && !agent.latestOverride) {
        void deps.updateSpecialLatestUpdate(agentId, agent, agent.lastUserMessage);
      }
      const assistantCompletionAt = resolveAssistantCompletionTimestamp({
        role,
        state: payload.state,
        message: payload.message,
        now: now(),
      });
      deps.dispatch({
        type: "updateAgent",
        agentId,
        patch: {
          streamText: null,
          thinkingTrace: null,
          ...(typeof assistantCompletionAt === "number"
            ? { lastAssistantMessageAt: assistantCompletionAt }
            : {}),
        },
      });
      return;
    }

    if (payload.state === "aborted") {
      clearRunTracking(payload.runId ?? null);
      deps.dispatch({
        type: "appendOutput",
        agentId,
        line: "Run aborted.",
      });
      deps.dispatch({
        type: "updateAgent",
        agentId,
        patch: { streamText: null, thinkingTrace: null },
      });
      return;
    }

    if (payload.state === "error") {
      clearRunTracking(payload.runId ?? null);
      deps.dispatch({
        type: "appendOutput",
        agentId,
        line: payload.errorMessage ? `Error: ${payload.errorMessage}` : "Run error.",
      });
      deps.dispatch({
        type: "updateAgent",
        agentId,
        patch: { streamText: null, thinkingTrace: null },
      });
    }
  };

  const handleRuntimeAgentEvent = (payload: AgentEventPayload) => {
    if (!payload.runId) return;
    const agentsSnapshot = deps.getAgents();
    const directMatch = payload.sessionKey ? findAgentBySessionKey(agentsSnapshot, payload.sessionKey) : null;
    const match = directMatch ?? findAgentByRunId(agentsSnapshot, payload.runId);
    if (!match) return;
    const agent = agentsSnapshot.find((entry) => entry.agentId === match);
    if (!agent) return;

    markActivityThrottled(match);
    const stream = typeof payload.stream === "string" ? payload.stream : "";
    const data =
      payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : null;
    const hasChatEvents = chatRunSeen.has(payload.runId);

    if (isReasoningRuntimeAgentStream(stream)) {
      const rawText = typeof data?.text === "string" ? (data.text as string) : "";
      const rawDelta = typeof data?.delta === "string" ? (data.delta as string) : "";
      const previousRaw = thinkingStreamByRun.get(payload.runId) ?? "";
      let mergedRaw = previousRaw;
      if (rawText) {
        mergedRaw = rawText;
      } else if (rawDelta) {
        mergedRaw = mergeRuntimeStream(previousRaw, rawDelta);
      }
      if (mergedRaw) {
        thinkingStreamByRun.set(payload.runId, mergedRaw);
      }
      const liveThinking =
        resolveThinkingFromAgentStream(data, mergedRaw, { treatPlainTextAsThinking: true }) ??
        (mergedRaw.trim() ? mergedRaw.trim() : null);
      if (liveThinking) {
        deps.queueLivePatch(match, {
          status: "running",
          runId: payload.runId,
          sessionCreated: true,
          lastActivityAt: now(),
          thinkingTrace: liveThinking,
        });
      }
      return;
    }

    if (stream === "assistant") {
      const rawText = typeof data?.text === "string" ? data.text : "";
      const rawDelta = typeof data?.delta === "string" ? data.delta : "";
      const previousRaw = assistantStreamByRun.get(payload.runId) ?? "";
      let mergedRaw = previousRaw;
      if (rawText) {
        mergedRaw = rawText;
      } else if (rawDelta) {
        mergedRaw = mergeRuntimeStream(previousRaw, rawDelta);
      }
      if (mergedRaw) {
        assistantStreamByRun.set(payload.runId, mergedRaw);
      }
      const liveThinking = resolveThinkingFromAgentStream(data, mergedRaw);
      const patch: Partial<AgentState> = {
        status: "running",
        runId: payload.runId,
        lastActivityAt: now(),
        sessionCreated: true,
      };
      if (liveThinking) {
        patch.thinkingTrace = liveThinking;
      }
      if (mergedRaw && (!rawText || !isUiMetadataPrefix(rawText.trim()))) {
        const visibleText = extractText({ role: "assistant", content: mergedRaw }) ?? mergedRaw;
        const cleaned = stripUiMetadata(visibleText);
        if (
          cleaned &&
          shouldPublishAssistantStream({
            mergedRaw,
            rawText,
            hasChatEvents,
            currentStreamText: agent.streamText ?? null,
          })
        ) {
          patch.streamText = cleaned;
        }
      }
      deps.queueLivePatch(match, patch);
      return;
    }

    if (stream === "tool") {
      const phase = typeof data?.phase === "string" ? data.phase : "";
      const name = typeof data?.name === "string" ? data.name : "tool";
      const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
      if (phase && phase !== "result") {
        const args =
          (data?.arguments as unknown) ??
          (data?.args as unknown) ??
          (data?.input as unknown) ??
          (data?.parameters as unknown) ??
          null;
        const line = formatToolCallMarkdown({
          id: toolCallId || undefined,
          name,
          arguments: args,
        });
        if (line) {
          appendUniqueToolLines(match, payload.runId, [line]);
        }
        return;
      }
      if (phase !== "result") return;
      const result = data?.result;
      const isError = typeof data?.isError === "boolean" ? data.isError : undefined;
      const resultRecord =
        result && typeof result === "object" ? (result as Record<string, unknown>) : null;
      const details = resultRecord && "details" in resultRecord ? resultRecord.details : undefined;
      let content: unknown = result;
      if (resultRecord) {
        if (Array.isArray(resultRecord.content)) {
          content = resultRecord.content;
        } else if (typeof resultRecord.text === "string") {
          content = resultRecord.text;
        }
      }
      const message = {
        role: "tool",
        toolName: name,
        toolCallId,
        isError,
        details,
        content,
      };
      appendUniqueToolLines(match, payload.runId, extractToolLines(message));
      return;
    }

    if (stream !== "lifecycle") return;
    const summaryPatch = getAgentSummaryPatch(payload, now());
    if (!summaryPatch) return;
    const phase = typeof data?.phase === "string" ? data.phase : "";
    if (phase !== "start" && phase !== "end" && phase !== "error") return;
    const transition = resolveLifecyclePatch({
      phase,
      incomingRunId: payload.runId,
      currentRunId: agent.runId,
      lastActivityAt: summaryPatch.lastActivityAt ?? now(),
    });
    if (transition.kind === "ignore") return;
    if (phase === "end" && !hasChatEvents) {
      const finalText = agent.streamText?.trim();
      if (finalText) {
        const assistantCompletionAt = now();
        deps.dispatch({
          type: "appendOutput",
          agentId: match,
          line: finalText,
        });
        deps.dispatch({
          type: "updateAgent",
          agentId: match,
          patch: {
            lastResult: finalText,
            lastAssistantMessageAt: assistantCompletionAt,
          },
        });
      }
    }
    if (transition.clearRunTracking) {
      clearRunTracking(payload.runId);
    }
    deps.dispatch({
      type: "updateAgent",
      agentId: match,
      patch: transition.patch,
    });
  };

  const handleEvent = (event: EventFrame) => {
    const eventKind = classifyGatewayEventKind(event.event);
    if (eventKind === "runtime-chat") {
      const payload = event.payload as ChatEventPayload | undefined;
      if (!payload) return;
      handleRuntimeChatEvent(payload);
      return;
    }
    if (eventKind === "runtime-agent") {
      const payload = event.payload as AgentEventPayload | undefined;
      if (!payload) return;
      handleRuntimeAgentEvent(payload);
      return;
    }
  };

  return { handleEvent, dispose };
}
