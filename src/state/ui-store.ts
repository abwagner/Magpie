// Ephemeral UI state shared across the shell. Persisted to
// localStorage so workspace + theme survive a refresh. The trading
// state from /ws/state is kept separately in StateProvider — that
// stream is canonical and should not double-buffer through here.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Theme = "dark" | "dark-hc" | "light";
export type WorkspaceId =
  | "operate"
  | "investigate"
  | "build"
  | "strategies"
  | "research"
  | "settings";

// One leg of a multi-leg ticket draft. The Greek Builder's LP
// solver emits these from a chain row; the Order Ticket drawer
// renders them as a "staged legs" grid.
export interface OrderTicketLeg {
  symbol: string;
  direction: "Long" | "Short";
  quantity: number;
  side?: "call" | "put";
  strike?: number;
  expiration?: string;
  premium?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

// Aggregate Greeks + cost summary shown above the legs grid.
export interface OrderTicketTotals {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  cost?: number;
  margin?: number;
  contracts?: number;
}

// Draft passed into the Order Ticket flow. Kept lightweight on
// purpose — the consumer renders a confirmation surface; a future
// ticket schema can be wired without touching the consumer.
export interface OrderTicketDraft {
  symbol: string;
  direction: "Long" | "Short" | "close";
  quantity: number;
  // Optional context strings shown read-only in the drawer.
  strategy?: string;
  reason?: string;
  // "paper" gates the FIRE word (paper submits with Submit; live
  // requires typing FIRE). Defaults to the current trading_mode in
  // the system block at submit time when this is not set.
  mode?: "paper" | "live";
  // Multi-leg breakdown (Greek Builder, future complex strategies).
  // When present, the Order Ticket renders the legs grid + totals.
  legs?: OrderTicketLeg[];
  totals?: OrderTicketTotals;
}

export interface UIState {
  workspace: WorkspaceId;
  theme: Theme;
  paletteOpen: boolean;
  killArmed: boolean;
  orderTicket: OrderTicketDraft | null;
  // Selected Schwab account hashValue. Drives broker-position
  // queries in the Header dropdown + BrokerPositionsPanel.
  // Empty string = no selection / all accounts.
  selectedAccount: string;
  // QF-228 — deep-link target inside the Settings workspace. The
  // QuoteUnavailableBanner CTA sets this to "mdHealth"; SettingsShell
  // reads it for the initial active section. Empty string = no
  // override (SettingsShell uses its own default).
  settingsSection: string;
  setWorkspace: (id: WorkspaceId) => void;
  setTheme: (theme: Theme) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setKillArmed: (armed: boolean) => void;
  openOrderTicket: (draft: OrderTicketDraft) => void;
  closeOrderTicket: () => void;
  setSelectedAccount: (hashValue: string) => void;
  setSettingsSection: (section: string) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      workspace: "operate",
      theme: "dark",
      paletteOpen: false,
      killArmed: false,
      orderTicket: null,
      selectedAccount: "",
      settingsSection: "",
      setWorkspace: (id) => set({ workspace: id }),
      setTheme: (theme) => {
        set({ theme });
        if (typeof document !== "undefined") {
          document.body.dataset.theme = theme;
        }
      },
      openPalette: () => set({ paletteOpen: true }),
      closePalette: () => set({ paletteOpen: false }),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setKillArmed: (armed) => set({ killArmed: armed }),
      openOrderTicket: (draft) => set({ orderTicket: draft }),
      closeOrderTicket: () => set({ orderTicket: null }),
      setSelectedAccount: (hashValue) => set({ selectedAccount: hashValue }),
      setSettingsSection: (section) => set({ settingsSection: section }),
    }),
    {
      name: "qf-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        workspace: state.workspace,
        theme: state.theme,
        selectedAccount: state.selectedAccount,
      }),
    },
  ),
);

// Re-apply the persisted theme to <body> when the store rehydrates.
// Without this, on hard refresh the data-theme attribute stays at
// its index.html default until the user touches a control.
if (typeof window !== "undefined") {
  const applyTheme = () => {
    const t = useUI.getState().theme;
    document.body.dataset.theme = t;
  };
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  } else {
    applyTheme();
  }
}
