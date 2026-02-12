import { describe, expect, it } from "vitest";
import {
  compileGuidedAgentCreation,
  createDefaultGuidedDraft,
  deriveGuidedPresetCapabilitySummary,
  resolveGuidedControlsForPreset,
  resolveGuidedDraftFromPresetBundle,
} from "@/features/agents/creation/compiler";
import type { GuidedAgentCreationDraft } from "@/features/agents/creation/types";

const createDraft = (): GuidedAgentCreationDraft => {
  const draft = createDefaultGuidedDraft();
  return {
    ...draft,
    starterKit: "engineer",
    controlLevel: "balanced",
    firstTask: "Refactor React components and open small diffs.",
    customInstructions: "Prefer minimal, test-backed diffs.",
    userProfile: "Product engineer who prefers concise summaries.",
    toolNotes: "Use git history and markdown formatting conventions.",
    memoryNotes: "Remember recurring formatting preferences.",
    heartbeatEnabled: true,
    heartbeatChecklist: ["Check stale release notes.", "Confirm source links.", "Report only blockers."],
  };
};

describe("compileGuidedAgentCreation", () => {
  it("compiles default starter draft without legacy outcome-form errors", () => {
    const result = compileGuidedAgentCreation({
      name: "Agent",
      draft: createDefaultGuidedDraft(),
    });
    expect(result.validation.errors).toEqual([]);
  });

  it("maps researcher + conservative to safe defaults", () => {
    const draft = createDraft();
    draft.starterKit = "researcher";
    draft.controlLevel = "conservative";
    draft.controls = resolveGuidedControlsForPreset({
      starterKit: draft.starterKit,
      controlLevel: draft.controlLevel,
    });
    const result = compileGuidedAgentCreation({
      name: "Research Agent",
      draft,
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.agentOverrides.sandbox).toEqual({
      mode: "non-main",
      workspaceAccess: "ro",
    });
    expect(result.agentOverrides.tools?.profile).toBe("minimal");
    expect(result.agentOverrides.tools?.allow).toBeUndefined();
    expect(result.agentOverrides.tools?.alsoAllow).toContain("group:web");
    expect(result.agentOverrides.tools?.deny).toContain("group:runtime");
    expect(result.execApprovals).toBeNull();
  });

  it("maps engineer + balanced to coding defaults with runtime enabled", () => {
    const draft = createDraft();
    draft.starterKit = "engineer";
    draft.controlLevel = "balanced";
    draft.controls = resolveGuidedControlsForPreset({
      starterKit: draft.starterKit,
      controlLevel: draft.controlLevel,
    });
    const result = compileGuidedAgentCreation({
      name: "Engineer Agent",
      draft,
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.files["AGENTS.md"]).toContain("First Task");
    expect(result.files["AGENTS.md"]).toContain("Refactor React components");
    expect(result.agentOverrides.tools?.profile).toBe("coding");
    expect(result.agentOverrides.tools?.alsoAllow).toContain("group:runtime");
    expect(result.agentOverrides.tools?.deny).not.toContain("group:runtime");
    expect(result.execApprovals).toEqual({
      security: "allowlist",
      ask: "on-miss",
      allowlist: [],
    });
  });

  it("maps marketer + conservative to messaging defaults", () => {
    const draft = createDraft();
    draft.starterKit = "marketer";
    draft.controlLevel = "conservative";
    draft.controls = resolveGuidedControlsForPreset({
      starterKit: draft.starterKit,
      controlLevel: draft.controlLevel,
    });
    const result = compileGuidedAgentCreation({
      name: "Marketing Agent",
      draft,
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.agentOverrides.tools?.profile).toBe("messaging");
    expect(result.agentOverrides.tools?.alsoAllow).toContain("group:web");
    expect(result.agentOverrides.tools?.deny).toContain("group:runtime");
    expect(result.execApprovals).toBeNull();
  });

  it("keeps contradiction validation for manual control overrides", () => {
    const draft = createDraft();
    draft.controlLevel = "autopilot";
    draft.controls = resolveGuidedControlsForPreset({
      starterKit: draft.starterKit,
      controlLevel: draft.controlLevel,
    });
    draft.controls.allowExec = false;

    const result = compileGuidedAgentCreation({
      name: "Broken Agent",
      draft,
    });

    expect(result.validation.errors).toContain("Auto exec requires runtime tools to be enabled.");
  });

  it("maps PR Engineer bundle to engineer + balanced defaults", () => {
    const draft = resolveGuidedDraftFromPresetBundle({
      bundle: "pr-engineer",
      seed: createDefaultGuidedDraft(),
    });

    expect(draft.starterKit).toBe("engineer");
    expect(draft.controlLevel).toBe("balanced");
    expect(draft.controls.toolsProfile).toBe("coding");
    expect(draft.controls.allowExec).toBe(true);
    expect(draft.controls.sandboxMode).toBe("non-main");
    expect(draft.controls.workspaceAccess).toBe("ro");
    expect(draft.heartbeatEnabled).toBe(false);
  });

  it("maps Autonomous Engineer bundle to engineer + autopilot defaults", () => {
    const draft = resolveGuidedDraftFromPresetBundle({
      bundle: "autonomous-engineer",
      seed: createDefaultGuidedDraft(),
    });

    expect(draft.starterKit).toBe("engineer");
    expect(draft.controlLevel).toBe("autopilot");
    expect(draft.controls.allowExec).toBe(true);
    expect(draft.controls.execAutonomy).toBe("auto");
    expect(draft.controls.fileEditAutonomy).toBe("auto-edit");
    expect(draft.controls.sandboxMode).toBe("all");
    expect(draft.controls.workspaceAccess).toBe("rw");
  });

  it("derives capability chips from controls", () => {
    const draft = resolveGuidedDraftFromPresetBundle({
      bundle: "pr-engineer",
      seed: createDefaultGuidedDraft(),
    });
    const capability = deriveGuidedPresetCapabilitySummary({
      controls: draft.controls,
      heartbeatEnabled: draft.heartbeatEnabled,
    });

    expect(capability.risk).toBe("moderate");
    expect(capability.chips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "exec", label: "Exec", enabled: true, value: "On" }),
        expect.objectContaining({ id: "internet", label: "Internet", enabled: false, value: "Off" }),
        expect.objectContaining({
          id: "filesystem",
          label: "File tools",
          enabled: true,
          value: "On",
        }),
        expect.objectContaining({
          id: "sandbox",
          label: "Sandbox",
          enabled: true,
          value: "non-main",
        }),
        expect.objectContaining({
          id: "heartbeat",
          label: "Heartbeat",
          enabled: false,
          value: "Off",
        }),
      ])
    );
  });

  it("flags main-session caveat when sandbox mode is non-main", () => {
    const draft = resolveGuidedDraftFromPresetBundle({
      bundle: "research-analyst",
      seed: createDefaultGuidedDraft(),
    });
    const capability = deriveGuidedPresetCapabilitySummary({
      controls: draft.controls,
      heartbeatEnabled: draft.heartbeatEnabled,
    });

    expect(capability.caveats).toContain(
      "Sandbox mode non-main does not sandbox the agent main session."
    );
  });
});
