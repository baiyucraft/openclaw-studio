import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import { Brain, Plug } from "lucide-react";

type HeaderBarProps = {
  status: GatewayStatus;
  onConnectionSettings: () => void;
  onBrainFiles: () => void;
  brainFilesOpen: boolean;
  brainDisabled?: boolean;
  showConnectionSettings?: boolean;
};

export const HeaderBar = ({
  status,
  onConnectionSettings,
  onBrainFiles,
  brainFilesOpen,
  brainDisabled = false,
  showConnectionSettings = true,
}: HeaderBarProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="glass-panel fade-up relative z-[180] px-4 py-2">
      <div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="console-title text-2xl leading-none text-foreground sm:text-3xl">
            OpenClaw Studio
          </p>
        </div>

        <div className="flex items-center justify-end gap-2">
          {status === "connecting" ? (
            <span
              className="inline-flex items-center rounded-md border border-border/70 bg-secondary px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-secondary-foreground"
              data-testid="gateway-connecting-indicator"
            >
              Connecting
            </span>
          ) : null}
          <ThemeToggle />
          <button
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition ${
              brainFilesOpen
                ? "border-border bg-surface-2 text-foreground"
                : "border-input/90 bg-surface-3 text-foreground hover:border-border hover:bg-surface-2"
            }`}
            type="button"
            onClick={onBrainFiles}
            data-testid="brain-files-toggle"
            disabled={brainDisabled}
          >
            <Brain className="h-4 w-4" />
            Brain
          </button>
          {showConnectionSettings ? (
            <div className="relative z-[210]" ref={menuRef}>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-input/80 bg-surface-3 text-muted-foreground transition hover:border-border hover:bg-surface-2 hover:text-foreground"
                data-testid="studio-menu-toggle"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((prev) => !prev)}
              >
                <Plug className="h-4 w-4" />
                <span className="sr-only">Open studio menu</span>
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-11 z-[260] min-w-44 rounded-md border border-border/80 bg-popover p-1">
                  <button
                    className="w-full rounded-sm px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.1em] text-foreground transition hover:bg-muted"
                    type="button"
                    onClick={() => {
                      onConnectionSettings();
                      setMenuOpen(false);
                    }}
                    data-testid="gateway-settings-toggle"
                  >
                    Gateway Connection
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
