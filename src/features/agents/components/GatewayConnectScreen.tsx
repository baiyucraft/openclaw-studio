import { useMemo, useState } from "react";

import { ConnectionPanel } from "@/features/agents/components/ConnectionPanel";
import { EmptyStatePanel } from "@/features/agents/components/EmptyStatePanel";
import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";

type GatewayConnectScreenProps = {
  gatewayUrl: string;
  token: string;
  status: GatewayStatus;
  error: string | null;
  onGatewayUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

const resolveLocalGatewayPort = (gatewayUrl: string): number => {
  try {
    const parsed = new URL(gatewayUrl);
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {}
  return 18789;
};

export const GatewayConnectScreen = ({
  gatewayUrl,
  token,
  status,
  error,
  onGatewayUrlChange,
  onTokenChange,
  onConnect,
  onDisconnect,
}: GatewayConnectScreenProps) => {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const isLocal = useMemo(() => isLocalGatewayUrl(gatewayUrl), [gatewayUrl]);
  const localGatewayCommand = useMemo(() => {
    const port = resolveLocalGatewayPort(gatewayUrl);
    return `openclaw gateway run --bind loopback --port ${port} --verbose`;
  }, [gatewayUrl]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="w-full">
        <div className="glass-panel px-4 py-4 sm:px-6 sm:py-6">
          <EmptyStatePanel
            label="Gateway"
            title="Not connected"
            description={
              isLocal
                ? "Studio couldn’t reach your local OpenClaw gateway. Start it below, then click Connect."
                : "Studio couldn’t reach your OpenClaw gateway. Check the URL/token below, then click Connect."
            }
            detail={error ?? undefined}
            className="border-0 bg-transparent p-0 text-left"
          />
        </div>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
        <div className="glass-panel flex flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Local gateway
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {isLocal
                ? "Run this on the same machine as Studio:"
                : "Want to run a local gateway instead? Start one on this machine:"}
            </p>
          </div>
          <div className="rounded-md border border-border/80 bg-background/75 px-4 py-3 font-mono text-[12px] text-foreground">
            {localGatewayCommand}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-input/90 bg-background/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition hover:border-border hover:bg-muted/65 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(localGatewayCommand);
                  setCopyStatus("copied");
                  window.setTimeout(() => setCopyStatus("idle"), 1200);
                } catch {
                  setCopyStatus("failed");
                  window.setTimeout(() => setCopyStatus("idle"), 1800);
                }
              }}
            >
              {copyStatus === "copied"
                ? "Copied"
                : copyStatus === "failed"
                  ? "Copy failed"
                  : "Copy command"}
            </button>
            <button
              type="button"
              className="rounded-md border border-input/90 bg-background/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition hover:border-border hover:bg-muted/65 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={onConnect}
              disabled={status === "connecting"}
            >
              Retry connect
            </button>
          </div>
        </div>

        <div className="glass-panel px-4 py-4 sm:px-6 sm:py-6">
          <ConnectionPanel
            gatewayUrl={gatewayUrl}
            token={token}
            status={status}
            error={null}
            onGatewayUrlChange={onGatewayUrlChange}
            onTokenChange={onTokenChange}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        </div>
      </div>
    </div>
  );
};
