import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RunStatusPoller } from "../src/web/src/app/run-status-poller.js";

type Run = { id: string; status: string };
type Task = { callback: () => void; delayMs: number; cancelled: boolean };

function scheduler() {
  const tasks: Task[] = [];
  return {
    tasks,
    schedule: (callback: () => void, delayMs: number) => {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return task as never;
    },
    cancel: (task: unknown) => { (task as Task).cancelled = true; },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("run status polling retries transient failures and reaches the server terminal state", async () => {
  const clock = scheduler();
  const updates: string[] = [];
  const syncMessages: Array<string | null> = [];
  let request = 0;
  const poller = new RunStatusPoller<Run>({
    fetchRun: async () => {
      request += 1;
      if (request === 1) throw new Error("network interrupted");
      return { id: "run-1", status: request === 2 ? "running" : "completed" };
    },
    onUpdate: (run) => updates.push(run.status),
    onSyncError: (message) => syncMessages.push(message),
    isActive: (status) => ["queued", "running"].includes(status),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  poller.start("run-1");
  await settle();
  assert.deepEqual(syncMessages, ["进度同步暂时失败，正在自动重连。"]);
  assert.equal(clock.tasks[0]?.delayMs, 500);

  clock.tasks[0]!.callback();
  await settle();
  assert.deepEqual(updates, ["running"]);
  assert.equal(clock.tasks[1]?.delayMs, 500);

  clock.tasks[1]!.callback();
  await settle();
  assert.deepEqual(updates, ["running", "completed"]);
  assert.equal(clock.tasks.length, 2);
  assert.equal(syncMessages.at(-1), null);
});

test("an explicit refresh waits for one in-flight request then immediately resynchronizes", async () => {
  const clock = scheduler();
  const updates: string[] = [];
  let resolveFirst: ((run: Run) => void) | undefined;
  let request = 0;
  const poller = new RunStatusPoller<Run>({
    fetchRun: () => {
      request += 1;
      if (request === 1) return new Promise<Run>((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ id: "run-1", status: "completed" });
    },
    onUpdate: (run) => updates.push(run.status),
    onSyncError: () => undefined,
    isActive: (status) => status === "running",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  poller.start("run-1");
  poller.refresh();
  resolveFirst?.({ id: "run-1", status: "running" });
  await settle();

  assert.equal(request, 2);
  assert.deepEqual(updates, ["running", "completed"]);
  assert.equal(clock.tasks[0]?.cancelled, true);
});

test("a newly tracked run starts after an older in-flight request settles", async () => {
  const clock = scheduler();
  const updates: Run[] = [];
  let resolveFirst: ((run: Run) => void) | undefined;
  const requests: string[] = [];
  const poller = new RunStatusPoller<Run>({
    fetchRun: (id) => {
      requests.push(id);
      if (id === "run-1") return new Promise<Run>((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ id, status: "completed" });
    },
    onUpdate: (run) => updates.push(run),
    onSyncError: () => undefined,
    isActive: (status) => status === "running",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  poller.start("run-1");
  poller.start("run-2");
  resolveFirst?.({ id: "run-1", status: "running" });
  await settle();

  assert.deepEqual(requests, ["run-1", "run-2"]);
  assert.deepEqual(updates, [{ id: "run-2", status: "completed" }]);
});

test("verification workspace resynchronizes when the page becomes visible or reconnects", async () => {
  const [workspace, panel] = await Promise.all([
    readFile(new URL("../src/web/src/app/V2Workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/components/RunningPanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /visibilitychange/);
  assert.match(workspace, /window\.addEventListener\("focus",resume\)/);
  assert.match(workspace, /window\.addEventListener\("online",resume\)/);
  assert.match(workspace, /RunStatusPoller/);
  assert.match(panel, /syncMessage/);
  assert.match(panel, /立即刷新/);
});
