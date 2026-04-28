/**
 * Auto-sync daemon — deterministic background worker.
 *
 * NOT an LLM agent. A plain Node.js loop that watches the active local
 * backpack folder and periodically calls SyncClient.sync() so changes
 * flow between the local Google Drive folder and app.backpackontology.com
 * without the user having to click "Sync now" on either side.
 *
 * State machine (per active backpack):
 *
 *   disabled        Daemon is off (no signed-in user, no registered sync).
 *   idle            Watching, no work pending.
 *   syncing         A sync() call is in flight.
 *   backoff         Last attempt failed; exponential backoff sleep.
 *   auth_required   Relay returned 401. Daemon halts until UI re-arms it.
 *
 * Triggers:
 *   * Local FS change (debounced 2s) → sync()
 *   * Remote poll tick (every POLL_INTERVAL_MS) → sync()
 *
 * Concurrency: at most one sync() in flight per backpack. Triggers
 * during a sync queue once and run after.
 */

import fs from "node:fs";
import path from "node:path";
import { SyncClient, SyncRelayClient, readSyncState } from "backpack-ontology";
import type { SyncRunResult } from "backpack-ontology";

const FS_DEBOUNCE_MS = 2_000;
const POLL_INTERVAL_MS = 30_000;
const BACKOFF_STEPS_MS = [5_000, 30_000, 60_000, 300_000];

export type DaemonState =
  | "disabled"
  | "idle"
  | "syncing"
  | "backoff"
  | "auth_required";

export interface DaemonStatus {
  enabled: boolean;
  state: DaemonState;
  active_backpack_path: string | null;
  active_backpack_name: string | null;
  last_run_at: string | null;
  last_result: {
    pushed: number;
    pulled: number;
    conflicts: number;
    skipped: number;
    errors: number;
  } | null;
  last_error: string | null;
  next_poll_at: string | null;
}

export interface DaemonDeps {
  /** Returns the current active backpack entry (path + name + color). */
  getActiveEntry: () => { path: string; name: string; color?: string } | null;
  /** Reads the share extension's relay token + base URL. Null if signed out. */
  readAuth: () => Promise<{ token: string; relayUrl: string } | null>;
}

export class SyncDaemon {
  private deps: DaemonDeps;
  private state: DaemonState = "disabled";
  private fsWatcher: fs.FSWatcher | null = null;
  private fsDebounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private nextRunQueued = false;
  private backoffStep = 0;
  private currentBackpackPath: string | null = null;
  private lastRunAt: string | null = null;
  private lastResult: DaemonStatus["last_result"] = null;
  private lastError: string | null = null;
  private nextPollAt: string | null = null;
  private stopping = false;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
  }

  /**
   * Start the daemon (or re-evaluate after a backpack switch / sign-in).
   * Idempotent — calling start() repeatedly is safe.
   */
  async start(): Promise<void> {
    if (this.stopping) return;
    const entry = this.deps.getActiveEntry();
    const auth = await this.deps.readAuth();

    // Cloud-mode backpacks have nothing to sync (the cloud IS the source
    // of truth). Daemon stays off.
    if (!entry || entry.path.startsWith("cloud://")) {
      this.transitionToDisabled("no_local_active");
      return;
    }
    if (!auth) {
      this.transitionToDisabled("not_signed_in");
      return;
    }

    // Sync state must already exist — daemon doesn't auto-register.
    // If the user hasn't clicked "Enable cloud sync" yet, stay off so
    // we don't surprise-create cloud containers from a folder they
    // haven't opted in to syncing.
    const syncState = await readSyncState(entry.path);
    if (!syncState) {
      this.transitionToDisabled("not_registered");
      return;
    }

    // Same backpack as before? Already wired up.
    if (this.currentBackpackPath === entry.path && this.state !== "disabled") {
      return;
    }

    this.currentBackpackPath = entry.path;
    this.state = "idle";
    this.backoffStep = 0;
    this.lastError = null;
    this.armWatcher(entry.path);
    this.armPoll();
    // First sync is immediate so the user sees activity right away
    // after enabling.
    this.trigger("startup");
  }

  /** Stop everything. Called from server shutdown or sign-out. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.disarmWatcher();
    this.disarmPoll();
    if (this.inflight) {
      try {
        await this.inflight;
      } catch { /* swallow — we are tearing down */ }
    }
    this.state = "disabled";
    this.currentBackpackPath = null;
  }

  /**
   * Called by the API context's onActiveBackpackChange hook. Treat as a
   * full restart so the watcher re-targets the new folder.
   */
  async handleActiveBackpackSwitch(): Promise<void> {
    this.disarmWatcher();
    this.disarmPoll();
    this.currentBackpackPath = null;
    this.state = "disabled";
    await this.start();
  }

  /**
   * Re-evaluate after the user signed in / out. The sidebar dispatches
   * a `backpack-auth-changed` event we can't catch from here; the
   * server-side endpoint handler calls this directly.
   */
  async handleAuthChange(): Promise<void> {
    if (this.state === "auth_required") this.state = "disabled";
    await this.start();
  }

  status(): DaemonStatus {
    const entry = this.deps.getActiveEntry();
    return {
      enabled: this.state !== "disabled",
      state: this.state,
      active_backpack_path: entry?.path ?? null,
      active_backpack_name: entry?.name ?? null,
      last_run_at: this.lastRunAt,
      last_result: this.lastResult,
      last_error: this.lastError,
      next_poll_at: this.nextPollAt,
    };
  }

  // --- Internal scheduling ---

  private trigger(reason: string): void {
    if (this.state === "disabled" || this.state === "auth_required") return;
    if (this.inflight) {
      // Coalesce: at most one queued run beyond the current one.
      this.nextRunQueued = true;
      return;
    }
    this.inflight = this.runOnce(reason).finally(() => {
      this.inflight = null;
      if (this.nextRunQueued) {
        this.nextRunQueued = false;
        this.trigger("queued");
      }
    });
  }

  private async runOnce(_reason: string): Promise<void> {
    if (this.stopping) return;
    const entry = this.deps.getActiveEntry();
    const auth = await this.deps.readAuth();
    if (!entry || !auth || entry.path !== this.currentBackpackPath) {
      // Conditions changed under us. Fold to disabled and let start()
      // figure out what to do next.
      await this.handleActiveBackpackSwitch();
      return;
    }

    this.state = "syncing";
    try {
      const relay = new SyncRelayClient({ baseUrl: auth.relayUrl, token: auth.token });
      const client = new SyncClient({ backpackPath: entry.path, relay });
      const result: SyncRunResult = await client.sync();
      this.recordSuccess(result);
      this.state = "idle";
      this.backoffStep = 0;
    } catch (err) {
      this.recordFailure(err);
    }
  }

  private recordSuccess(result: SyncRunResult): void {
    this.lastRunAt = new Date().toISOString();
    this.lastResult = {
      pushed: result.pushed.length,
      pulled: result.pulled.length,
      conflicts: result.conflicts.length,
      skipped: (result.skipped ?? []).length,
      errors: result.errors.length,
    };
    this.lastError = null;
  }

  private recordFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = message;
    this.lastRunAt = new Date().toISOString();

    // Auth errors halt the daemon — looping on a rejected token is
    // pointless and noisy. UI must call handleAuthChange() to re-arm
    // after the user signs back in.
    if (/\b401\b|relay token rejected|unauthorized/i.test(message)) {
      this.state = "auth_required";
      this.disarmWatcher();
      this.disarmPoll();
      return;
    }

    // Network / server errors → exponential backoff.
    this.state = "backoff";
    const delay = BACKOFF_STEPS_MS[Math.min(this.backoffStep, BACKOFF_STEPS_MS.length - 1)];
    this.backoffStep += 1;
    this.disarmPoll();
    this.pollTimer = setTimeout(() => {
      this.state = "idle";
      this.armPoll();
      this.trigger("backoff_recovery");
    }, delay);
    this.nextPollAt = new Date(Date.now() + delay).toISOString();
  }

  // --- Watchers ---

  private armWatcher(backpackPath: string): void {
    this.disarmWatcher();
    try {
      // Recursive on macOS and Windows. On Linux this returns false
      // recursive support; the poll loop is the safety net.
      this.fsWatcher = fs.watch(
        backpackPath,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          // Ignore the daemon's own state writes and conflict files.
          const fname = String(filename);
          if (fname.startsWith(".sync") || fname.includes(".conflict-")) return;
          this.scheduleDebouncedSync();
        },
      );
      this.fsWatcher.on("error", () => {
        // fs.watch is fragile; on error fall back to polling-only.
        this.disarmWatcher();
      });
    } catch {
      // Recursive not supported (older Linux). Polling alone covers it.
    }
  }

  private disarmWatcher(): void {
    if (this.fsDebounceTimer) {
      clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = null;
    }
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch { /* ignore */ }
      this.fsWatcher = null;
    }
  }

  private scheduleDebouncedSync(): void {
    if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
    this.fsDebounceTimer = setTimeout(() => {
      this.fsDebounceTimer = null;
      this.trigger("fs_change");
    }, FS_DEBOUNCE_MS);
  }

  private armPoll(): void {
    this.disarmPoll();
    const tick = () => {
      this.trigger("poll");
      this.nextPollAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
      this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    this.nextPollAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
    this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  private disarmPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.nextPollAt = null;
  }

  private transitionToDisabled(_reason: string): void {
    this.disarmWatcher();
    this.disarmPoll();
    this.state = "disabled";
    this.currentBackpackPath = null;
  }
}
