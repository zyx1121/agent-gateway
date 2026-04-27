import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";

export interface AgentSession {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  turnCount: number;
  /** True once Claude side acknowledged the session (init event arrived). */
  initialized?: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

interface UserState {
  sessions: AgentSession[];
  activeId: string | null;
}

export type MatchResult<T> =
  | { kind: "found"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

const state = new Map<number, UserState>();
const busy = new Map<string, AbortController>();
let dirty = false;
let persistTimer: NodeJS.Timeout | null = null;
const PERSIST_DEBOUNCE_MS = 200;

export async function loadAll(): Promise<void> {
  try {
    const raw = await readFile(config.sessionsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, UserState>;
    for (const [k, v] of Object.entries(parsed)) {
      for (const s of v.sessions) {
        s.lastActivityAt ??= s.createdAt;
        s.description ??= undefined;
        s.initialized ??= s.turnCount > 0;
      }
      state.set(Number(k), v);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn("[session] load failed:", err);
  }
}

async function persist(): Promise<void> {
  if (!dirty) return;
  const obj: Record<string, UserState> = {};
  for (const [k, v] of state.entries()) obj[String(k)] = v;
  await writeFile(config.sessionsFile, JSON.stringify(obj, null, 2));
  dirty = false;
}

function markDirty(): void {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

export async function flushNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persist();
}

const ensure = (uid: number): UserState => {
  let s = state.get(uid);
  if (!s) {
    s = { sessions: [], activeId: null };
    state.set(uid, s);
  }
  return s;
};

export function listSessions(uid: number): AgentSession[] {
  return ensure(uid).sessions;
}

export function activeSession(uid: number): AgentSession | null {
  const s = ensure(uid);
  return s.sessions.find((x) => x.id === s.activeId) ?? null;
}

export interface CreateOpts {
  cwdOverride?: string;
  description?: string;
}

export function createSession(
  uid: number,
  name: string,
  opts: CreateOpts = {},
): AgentSession {
  const s = ensure(uid);
  const id = randomUUID();
  const cwd = opts.cwdOverride ?? `${config.agentHome}/${uid}/${id}`;
  const now = Date.now();
  const session: AgentSession = {
    id,
    name,
    description: opts.description,
    cwd,
    createdAt: now,
    lastActivityAt: now,
    turnCount: 0,
    initialized: false,
  };
  s.sessions.push(session);
  s.activeId = id;
  markDirty();
  return session;
}

export function clearActive(uid: number): AgentSession | null {
  const s = ensure(uid);
  const cur = s.sessions.find((x) => x.id === s.activeId);
  if (!cur) return null;
  s.activeId = null;
  markDirty();
  return cur;
}

function findMatching(uid: number, prefix: string): AgentSession[] {
  return ensure(uid).sessions.filter((x) => x.id.startsWith(prefix));
}

export function deleteByPrefix(
  uid: number,
  prefix: string,
): MatchResult<AgentSession> {
  const matches = findMatching(uid, prefix);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  const s = ensure(uid);
  const target = matches[0];
  s.sessions = s.sessions.filter((x) => x.id !== target.id);
  if (s.activeId === target.id) s.activeId = null;
  markDirty();
  return { kind: "found", session: target };
}

export function switchTo(
  uid: number,
  prefix: string,
): MatchResult<AgentSession> {
  const matches = findMatching(uid, prefix);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  const s = ensure(uid);
  s.activeId = matches[0].id;
  markDirty();
  return { kind: "found", session: matches[0] };
}

export function bumpTurn(uid: number): void {
  const a = activeSession(uid);
  if (a) {
    a.turnCount++;
    a.lastActivityAt = Date.now();
    markDirty();
  }
}

export function markInitialized(sessionId: string): void {
  for (const v of state.values()) {
    const s = v.sessions.find((x) => x.id === sessionId);
    if (s && !s.initialized) {
      s.initialized = true;
      markDirty();
      return;
    }
  }
}

export function addUsage(
  uid: number,
  input: number,
  output: number,
): void {
  const a = activeSession(uid);
  if (a) {
    a.totalInputTokens = (a.totalInputTokens ?? 0) + input;
    a.totalOutputTokens = (a.totalOutputTokens ?? 0) + output;
    markDirty();
  }
}

export function isBusy(sessionId: string): boolean {
  return busy.has(sessionId);
}

export function setBusy(
  sessionId: string,
  controller: AbortController,
): void {
  busy.set(sessionId, controller);
}

export function clearBusy(sessionId: string): void {
  busy.delete(sessionId);
}

export function cancel(sessionId: string): boolean {
  const ac = busy.get(sessionId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function cancelAll(): number {
  let n = 0;
  for (const ac of busy.values()) {
    ac.abort();
    n++;
  }
  return n;
}

export const sid8 = (id: string): string => id.slice(0, 8);
