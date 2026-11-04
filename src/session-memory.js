import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { sessionDirectory } from "./data-store.js";

export const SESSION_DIR = sessionDirectory();
const sessionWriteQueues = new Map();

export function sessionPath(path) {
  return resolve(path || newSessionPath());
}

export function newSessionPath(date = new Date(), dir = sessionDirectory()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return join(dir, `${stamp}-${suffix}.json`);
}

export async function readSession(path) {
  const text = await readFile(resolve(path), "utf8");
  return JSON.parse(text);
}

export async function writeSession(path, session) {
  const file = resolve(path);
  const content = `${JSON.stringify(session, null, 2)}\n`;
  const previous = sessionWriteQueues.get(file) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, "utf8");
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, file);
          break;
        } catch (error) {
          const transientWindowsReplace = process.platform === "win32" && ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error?.code);
          if (!transientWindowsReplace || attempt >= 7) throw error;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25 * (2 ** attempt), 500)));
        }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  });
  sessionWriteQueues.set(file, write);
  try { await write; }
  finally { if (sessionWriteQueues.get(file) === write) sessionWriteQueues.delete(file); }
}

export async function listSessions(dir = sessionDirectory()) {
  const root = resolve(dir);
  let names;
  try {
    names = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const sessions = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = join(root, name);
    try {
      const session = await readSession(file);
      sessions.push({
        path: file,
        updatedAt: session.updatedAt || session.createdAt || "",
        createdAt: session.createdAt || "",
        workspace: session.workspace || "",
        title: session.title || "",
        permission: session.config?.permission || "",
        backend: session.config?.backend || "api",
        agentId: session.config?.agentId || "",
        firstUserPrompt: session.messages?.find((message) => message.role === "user")?.content || ""
      });
    } catch {
      // Ignore malformed session files in the picker.
    }
  }

  return sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function newSession({ provider, model, baseUrl, workspace, systemPrompt, userPrompt, config = {} }) {
  const now = new Date().toISOString();
  return {
    version: 1,
    provider,
    createdAt: now,
    updatedAt: now,
    model,
    baseUrl,
    workspace,
    config,
    messages: [
      { role: "system", content: systemPrompt },
      ...(userPrompt ? [{ role: "user", content: userPrompt }] : [])
    ]
  };
}

export function touchSession(session) {
  session.updatedAt = new Date().toISOString();
  return session;
}

export function fallbackSessionTitle(value, max = 64) {
  const text = Array.isArray(value)
    ? value.map((part) => typeof part === "string" ? part : part?.text || "").join(" ")
    : String(value || "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const prefix = normalized.slice(0, Math.max(1, max - 3)).trimEnd();
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary >= Math.floor(max / 2) ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}
