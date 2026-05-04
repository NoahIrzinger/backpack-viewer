export type DaemonState = "disabled";

export interface DaemonStatus {
  enabled: boolean;
  state: DaemonState;
  active_backpack_path: string | null;
  active_backpack_name: string | null;
  last_run_at: string | null;
  last_result: null;
  last_error: string | null;
  next_poll_at: string | null;
}

export interface DaemonDeps {
  getActiveEntry: () => { path: string; name: string; color?: string } | null;
  readAuth: () => Promise<{ token: string; relayUrl: string } | null>;
}

export class SyncDaemon {
  private deps: DaemonDeps;
  constructor(deps: DaemonDeps) { this.deps = deps; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async handleActiveBackpackSwitch(): Promise<void> {}
  async handleAuthChange(): Promise<void> {}
  status(): DaemonStatus {
    const entry = this.deps.getActiveEntry();
    return {
      enabled: false,
      state: "disabled",
      active_backpack_path: entry?.path ?? null,
      active_backpack_name: entry?.name ?? null,
      last_run_at: null,
      last_result: null,
      last_error: null,
      next_poll_at: null,
    };
  }
}
