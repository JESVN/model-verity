export type RunLifecycle = { id: string; status: string };

type Timer = ReturnType<typeof setTimeout>;

export interface RunStatusPollerOptions<Run extends RunLifecycle> {
  fetchRun: (id: string) => Promise<Run>;
  onUpdate: (run: Run) => void;
  onSyncError: (message: string | null) => void;
  isActive: (status: string) => boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}

/** Keeps a browser view converging on the server-owned run state after interruptions. */
export class RunStatusPoller<Run extends RunLifecycle> {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly cancel: (timer: Timer) => void;
  private activeId: string | null = null;
  private timer: Timer | null = null;
  private inFlight = false;
  private refreshPending = false;
  private retryDelayMs: number;

  constructor(private readonly options: RunStatusPollerOptions<Run>) {
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.retryDelayMs = this.baseDelayMs;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  start(id: string): void {
    if (this.activeId !== id) this.clearTimer();
    this.activeId = id;
    this.retryDelayMs = this.baseDelayMs;
    if (this.inFlight) {
      this.refreshPending = true;
      return;
    }
    this.request();
  }

  refresh(): void {
    if (!this.activeId) return;
    if (this.inFlight) {
      this.refreshPending = true;
      return;
    }
    this.clearTimer();
    this.request();
  }

  stop(id?: string): void {
    if (id && this.activeId !== id) return;
    this.activeId = null;
    this.refreshPending = false;
    this.clearTimer();
  }

  private async request(): Promise<void> {
    const id = this.activeId;
    if (!id || this.inFlight) return;
    this.inFlight = true;
    try {
      const run = await this.options.fetchRun(id);
      if (this.activeId !== id) return;
      this.options.onUpdate(run);
      if (!this.options.isActive(run.status)) {
        this.stop(id);
        this.options.onSyncError(null);
        return;
      }
      this.retryDelayMs = this.baseDelayMs;
      this.options.onSyncError(null);
      this.queue(this.baseDelayMs);
    } catch {
      if (this.activeId !== id) return;
      this.options.onSyncError("进度同步暂时失败，正在自动重连。");
      const delayMs = this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxDelayMs);
      this.queue(delayMs);
    } finally {
      this.inFlight = false;
      if (this.refreshPending && this.activeId) {
        this.refreshPending = false;
        this.clearTimer();
        this.request();
      }
    }
  }

  private queue(delayMs: number): void {
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.request();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
