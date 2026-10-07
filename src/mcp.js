import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { readConfig, writeConfig } from "./config.js";

const TOOL_PREFIX = "mcp_";
const MAX_RESULT_CHARS = 60000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds.`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function safeName(value) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name)) throw new Error("MCP server names may contain letters, numbers, _ and - (up to 48 characters).");
  if (["__proto__", "prototype", "constructor"].includes(name.toLowerCase())) throw new Error("That MCP server name is reserved.");
  return name;
}

function resolveEnvRefs(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const match = value.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) throw new Error(`${label} must use an environment reference such as \"\${env:API_TOKEN}\".`);
  const secret = process.env[match[1]];
  if (!secret) throw new Error(`Environment variable ${match[1]} (referenced by ${label}) is not set.`);
  return secret;
}

export async function getMcpServers() {
  const config = await readConfig();
  return config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
}

export async function saveMcpServer(name, server) {
  name = safeName(name);
  const config = await readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) config.mcpServers = {};
  config.mcpServers[name] = server;
  await writeConfig(config);
}

export async function removeMcpServer(name) {
  name = safeName(name);
  const config = await readConfig();
  if (!config.mcpServers || !Object.hasOwn(config.mcpServers, name)) return false;
  delete config.mcpServers[name];
  await writeConfig(config);
  return true;
}

function toolAlias(server, tool) {
  const alias = `${TOOL_PREFIX}${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return alias.length <= 64 ? alias : `${alias.slice(0, 55)}_${Buffer.from(`${server}:${tool}`).toString("hex").slice(0, 8)}`;
}

async function connectClient(name, server) {
  if (!server || typeof server !== "object") throw new Error(`Invalid MCP server configuration: ${name}`);
  const client = new Client({ name: "switchyard", version: "0.3.0" });
  let transport;
  if (server.type === "stdio") {
    if (!server.command || typeof server.command !== "string") throw new Error(`MCP server ${name} needs a command.`);
    const env = { ...getDefaultEnvironment() };
    for (const [key, value] of Object.entries(server.env || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name in MCP server ${name}.`);
      env[key] = resolveEnvRefs(value, `${name}.env.${key}`);
    }
    transport = new StdioClientTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      cwd: server.cwd || process.cwd(),
      env,
      stderr: "inherit"
    });
  } else if (server.type === "http") {
    let url;
    try { url = new URL(server.url); } catch { throw new Error(`MCP server ${name} has an invalid URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`MCP server ${name} URL must be HTTP(S) without embedded credentials.`);
    const headers = {};
    for (const [key, value] of Object.entries(server.headers || {})) {
      if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`Invalid HTTP header name in MCP server ${name}.`);
      headers[key] = resolveEnvRefs(value, `${name}.headers.${key}`);
    }
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  } else throw new Error(`MCP server ${name} type must be stdio or http.`);

  try {
    await withTimeout(client.connect(transport), 15000, `MCP ${name} connection`);
    const result = await withTimeout(client.listTools(), 15000, `MCP ${name} tool discovery`);
    return { client, transport, tools: result.tools || [], instructions: result.instructions || "" };
  } catch (error) {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
    throw error;
  }
}

export async function createMcpManager({ permission: initialPermission = "ask", approve = async () => false, onNotice = () => {} } = {}) {
  let permission = initialPermission;
  const manager = { connections: new Map(), tools: new Map(), servers: new Map(), async close() {
    await Promise.allSettled([...this.connections.values()].map(({ client, transport }) => client.close().catch(() => transport.close().catch(() => {}))));
    this.connections.clear(); this.tools.clear(); this.servers.clear();
  }, has(name) { return this.tools.has(name); }, schemas() {
    return [...this.tools.values()].filter(({ tool }) => permission !== "review" || tool.annotations?.readOnlyHint === true).map(({ alias, tool, serverName }) => ({
      type: "function", function: {
        name: alias,
        description: `[MCP ${serverName}] ${String(tool.description || tool.name).slice(0, 1000)}${tool.annotations?.readOnlyHint ? " (server marks this read-only)" : ""}`,
        parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }
      }
    }));
  }, async call(name, args) {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown MCP tool: ${name}`);
    if (permission === "review" && entry.tool.annotations?.readOnlyHint !== true) throw new Error("Blocked by review permission: MCP tool is not explicitly marked read-only.");
    if (permission === "ask" && !await approve({ server: entry.serverName, tool: entry.tool.name, args })) return "MCP tool call declined.";
    const result = await withTimeout(entry.client.callTool({ name: entry.tool.name, arguments: args || {} }, { timeout: 120000 }), 125000, `MCP tool ${name}`);
    const serialized = JSON.stringify(result, null, 2);
    return serialized.length > MAX_RESULT_CHARS ? `${serialized.slice(0, MAX_RESULT_CHARS)}\n[Result truncated by Switchyard.]` : serialized;
  }, managementSchemas() {
    const schemas = [{
      type: "function", function: {
        name: "mcp_server_list",
        description: "List configured MCP servers and their currently connected tools. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    }];
    if (permission !== "review") schemas.push(
      {
        type: "function", function: {
          name: "mcp_server_add",
          description: "Set up and connect an MCP server now. Provide name and server config: {type:'stdio',command,args?,cwd?,env?} for a local process, or {type:'http',url,headers?} for Streamable HTTP. Secret values must be exact \${env:VARIABLE} references. A successful call makes that server's tools available to you on your next model turn without restarting Switchyard.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short identifier for this configured server." },
              server: { type: "object", description: "MCP server config. Use type stdio with command/args, or type http with url/headers.", additionalProperties: true }
            },
            required: ["name", "server"], additionalProperties: false
          }
        }
      },
      {
        type: "function", function: {
          name: "mcp_server_remove",
          description: "Disconnect and remove a configured MCP server and its tools.",
          parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }
        }
      }
    );
    return schemas;
  }, async manage(name, args = {}) {
    if (name === "mcp_server_list") {
      return JSON.stringify([...this.servers.entries()].map(([serverName, server]) => ({
        name: serverName, type: server.type, connected: this.connections.has(serverName),
        tools: [...this.tools.values()].filter(tool => tool.serverName === serverName).map(({ tool }) => tool.name)
      })), null, 2);
    }
    if (permission === "review") throw new Error("MCP server configuration is blocked by review permission.");
    if (name === "mcp_server_add") {
      const serverName = safeName(args.name);
      const server = args.server;
      if (permission === "ask" && !await approve({ server: serverName, tool: "(configure MCP server)", args: server })) return "MCP server setup declined.";
      const staged = await connectClient(serverName, server);
      const stagedTools = staged.tools.map(tool => ({ alias: toolAlias(serverName, tool.name), serverName, tool, client: staged.client }));
      const aliases = new Set(stagedTools.map(entry => entry.alias));
      if (aliases.size !== stagedTools.length || stagedTools.some(entry => this.tools.has(entry.alias) && this.tools.get(entry.alias).serverName !== serverName)) {
        await staged.client.close().catch(() => staged.transport.close().catch(() => {}));
        throw new Error(`MCP tool name collision while adding server ${serverName}.`);
      }
      try { await saveMcpServer(serverName, server); } catch (error) {
        await staged.client.close().catch(() => staged.transport.close().catch(() => {}));
        throw error;
      }
      const old = this.connections.get(serverName);
      if (old) await old.client.close().catch(() => old.transport.close().catch(() => {}));
      for (const [alias, entry] of this.tools) if (entry.serverName === serverName) this.tools.delete(alias);
      this.connections.set(serverName, staged);
      this.servers.set(serverName, server);
      for (const entry of stagedTools) this.tools.set(entry.alias, entry);
      onNotice(`MCP ${serverName}: connected (${staged.tools.length} tools).`);
      return `Connected MCP server ${serverName}. Tools available next turn: ${staged.tools.map(tool => tool.name).join(", ") || "(none)"}.`;
    }
    if (name === "mcp_server_remove") {
      const serverName = safeName(args.name);
      if (!this.servers.has(serverName)) return `No MCP server named ${serverName} is configured in this session.`;
      if (permission === "ask" && !await approve({ server: serverName, tool: "(remove MCP server)", args: { name: serverName } })) return "MCP server removal declined.";
      await removeMcpServer(serverName);
      const connection = this.connections.get(serverName);
      if (connection) await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
      this.connections.delete(serverName);
      this.servers.delete(serverName);
      for (const [alias, entry] of this.tools) if (entry.serverName === serverName) this.tools.delete(alias);
      onNotice(`MCP ${serverName}: disconnected and removed.`);
      return `Removed MCP server ${serverName}. Its tools are no longer available.`;
    }
    throw new Error(`Unknown MCP management tool: ${name}`);
  }, setPermission(value) {
    if (!["review", "ask", "full", "yolo"].includes(value)) throw new Error("Invalid MCP permission mode.");
    permission = value;
  }, isManagement(name) { return ["mcp_server_list", "mcp_server_add", "mcp_server_remove"].includes(name); } };
  const servers = await getMcpServers();
  for (const [rawName, config] of Object.entries(servers)) {
    const name = safeName(rawName);
    manager.servers.set(name, config);
    if (config?.enabled === false) continue;
    try {
      const connection = await connectClient(name, config);
      manager.connections.set(name, connection);
      for (const tool of connection.tools) {
        const alias = toolAlias(name, tool.name);
        if (manager.tools.has(alias)) throw new Error(`MCP tool name collision: ${alias}`);
        manager.tools.set(alias, { alias, serverName: name, tool, client: connection.client });
      }
      onNotice(`MCP ${name}: connected (${connection.tools.length} tools).`);
    } catch (error) { onNotice(`MCP ${name}: connection failed: ${error.message}`); }
  }
  return manager;
}

export async function inspectMcpServer(name) {
  const server = (await getMcpServers())[safeName(name)];
  if (!server) throw new Error(`No MCP server named ${name}.`);
  const connection = await connectClient(name, server);
  try { return connection.tools; } finally {
    await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
  }
}
