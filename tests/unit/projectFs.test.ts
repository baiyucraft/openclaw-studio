import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deleteDirIfExists } from "@/lib/projects/fs.server";
import { resolveStateDir, resolveUserPath } from "@/lib/clawdbot/paths";
import { resolveAgentCanvasDir } from "@/lib/projects/agentWorkspace";

let tempDir: string | null = null;

const cleanup = () => {
  if (!tempDir) return;
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
};

afterEach(cleanup);

describe("projectFs", () => {
  it("resolvesUserPathVariants", () => {
    const home = path.join(os.tmpdir(), "clawdbot-test-home");
    expect(resolveUserPath("~", () => home)).toBe(home);
    expect(resolveUserPath("~/foo", () => home)).toBe(path.join(home, "foo"));
    expect(resolveUserPath("/tmp/x", () => home)).toBe("/tmp/x");
  });

  it("resolvesStateDirFromEnv", () => {
    const home = path.join(os.tmpdir(), "clawdbot-test-home");
    const env = { CLAWDBOT_STATE_DIR: "~/state-test" } as unknown as NodeJS.ProcessEnv;
    expect(resolveStateDir(env, () => home)).toBe(path.join(home, "state-test"));
  });

  it("prefersMoltbotWhenLegacyMissing", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-projectfs-"));
    const home = tempDir;
    const moltbotDir = path.join(home, ".moltbot");
    fs.mkdirSync(moltbotDir, { recursive: true });
    const env = {} as unknown as NodeJS.ProcessEnv;
    expect(resolveStateDir(env, () => home)).toBe(moltbotDir);
  });

  it("resolvesAgentCanvasDirFromEnv", () => {
    const home = path.join(os.tmpdir(), "clawdbot-test-home");
    const env = { MOLTBOT_STATE_DIR: "~/state-test" } as unknown as NodeJS.ProcessEnv;
    expect(resolveAgentCanvasDir(env, () => home)).toBe(
      path.join(home, "state-test", "agent-canvas")
    );
  });

  it("resolvesAgentCanvasDirPrefersMoltbot", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-projectfs-"));
    const home = tempDir;
    const moltbotDir = path.join(home, ".moltbot");
    fs.mkdirSync(moltbotDir, { recursive: true });
    const env = {} as unknown as NodeJS.ProcessEnv;
    expect(resolveAgentCanvasDir(env, () => home)).toBe(
      path.join(moltbotDir, "agent-canvas")
    );
  });

  it("deleteDirIfExistsRemovesDirectory", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-projectfs-"));
    const warnings: string[] = [];
    deleteDirIfExists(tempDir, "Temp dir", warnings);
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(warnings).toEqual([]);
  });
});
