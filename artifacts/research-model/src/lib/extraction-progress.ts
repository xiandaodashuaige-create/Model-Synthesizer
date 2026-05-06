import { useSyncExternalStore } from "react";

export type ExtractionProgress = { done: number; total: number } | null;

type Entry = { runId: number; progress: ExtractionProgress };

const bySession = new Map<number, Entry>();
const listeners = new Set<() => void>();
let nextRunId = 1;

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function beginExtraction(sessionId: number, total: number): number {
  const runId = nextRunId++;
  bySession.set(sessionId, { runId, progress: { done: 0, total } });
  notify();
  return runId;
}

export function updateExtraction(sessionId: number, runId: number, done: number, total: number): void {
  const cur = bySession.get(sessionId);
  if (!cur || cur.runId !== runId) return;
  bySession.set(sessionId, { runId, progress: { done, total } });
  notify();
}

export function endExtraction(sessionId: number, runId: number): void {
  const cur = bySession.get(sessionId);
  if (!cur || cur.runId !== runId) return;
  bySession.delete(sessionId);
  notify();
}

function getSnapshot(sessionId: number): ExtractionProgress {
  return bySession.get(sessionId)?.progress ?? null;
}

export function useExtractionProgress(sessionId: number): ExtractionProgress {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(sessionId),
    () => getSnapshot(sessionId),
  );
}
