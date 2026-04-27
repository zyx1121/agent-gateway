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
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

interface UserState {
  sessions: AgentSession[];
  activeId: string | null;
}

const state = new Map<number, UserState>();
const busy = new Map<string, AbortController>(); // sessionId -> abort controller
let dirty = false;

export async function loadAll(): Promise<void> {
  try {
    const raw = await readFile(config.sessionsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, UserState>;
    for (const [k, v] of Object.entries(parsed)) {
      // backfill missing fields on older entries
      for (const s of v.sessions) {
        s.lastActivityAt ??= s.createdAt;
        s.description ??= undefined;
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

setInterval(() => {
  void persist();
}, 5_000).unref();

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
  };
  s.sessions.push(session);
  s.activeId = id;
  dirty = true;
  return session;
}

export function clearActive(uid: number): AgentSession | null {
  const s = ensure(uid);
  const cur = s.sessions.find((x) => x.id === s.activeId);
  if (!cur) return null;
  s.activeId = null;
  dirty = true;
  return cur;
}

export function deleteSession(
  uid: number,
  sid8Prefix: string,
): AgentSession | null {
  const s = ensure(uid);
  const idx = s.sessions.findIndex((x) => x.id.startsWith(sid8Prefix));
  if (idx < 0) return null;
  const [removed] = s.sessions.splice(idx, 1);
  if (s.activeId === removed.id) s.activeId = null;
  dirty = true;
  return removed;
}

export function switchTo(uid: number, sid8: string): AgentSession | null {
  const s = ensure(uid);
  const found = s.sessions.find((x) => x.id.startsWith(sid8));
  if (!found) return null;
  s.activeId = found.id;
  dirty = true;
  return found;
}

export function bumpTurn(uid: number): void {
  const a = activeSession(uid);
  if (a) {
    a.turnCount++;
    a.lastActivityAt = Date.now();
    dirty = true;
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
    dirty = true;
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

export const sid8 = (id: string): string => id.slice(0, 8);
