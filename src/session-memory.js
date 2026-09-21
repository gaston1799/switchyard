import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const SESSION_DIR = ".deepseek-watch/sessions";

export function sessionPath(path) {
  return resolve(path || newSessionPath());
}

export function newSessionPath(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return join(SESSION_DIR, `${stamp}-${suffix}.json`);
}

export async function readSession(path) {
  const text = await readFile(resolve(path), "utf8");
  return JSON.parse(text);
}

export async function writeSession(path, session) {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function listSessions(dir = SESSION_DIR) {
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
