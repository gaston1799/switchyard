const { readFile, mkdir, rename, writeFile, stat } = require('node:fs/promises');
const { join, resolve, basename } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const key = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const identity = (workspace, coordDir) => createHash('sha256').update(`${key(workspace)}\n${key(coordDir)}`).digest('hex').slice(0, 24);

function createProjectStore(dataRoot) {
  const file = join(dataRoot, 'projects.json');
  let queue = Promise.resolve();
  const serialized = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  async function read() {
    try { const data = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(data.projects)) throw new Error('Invalid project registry'); return data.projects; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function save(projects) {
    await mkdir(dataRoot, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, projects }, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); return; }
      catch (error) { if (attempt >= 7 || !['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error; await new Promise(done => setTimeout(done, 25 * (attempt + 1))); }
    }
  }
  const make = (workspace, coordDir) => ({ id: identity(workspace, coordDir), name: String(workspace).replace(/\\/g, '/').split('/').filter(Boolean).pop() || basename(workspace), workspace, coordDir });
  return {
    list: read,
    importSessions: sessions => serialized(async () => {
      const projects = await read();
      let changed = false;
      for (const session of sessions) {
        if (!session.workspace || !session.coordDir) continue;
        const project = make(session.workspace, session.coordDir);
        if (!projects.some(item => item.id === project.id)) { projects.push(project); changed = true; }
      }
      if (changed) await save(projects);
      return projects;
    }),
    add: workspace => serialized(async () => {
      workspace = resolve(workspace);
      if (!(await stat(workspace)).isDirectory()) throw new Error('Choose a working directory.');
      const projects = await read();
      const existing = projects.find(item => key(item.workspace) === key(workspace));
      if (existing) return existing;
      const hash = createHash('sha256').update(workspace.toLowerCase()).digest('hex').slice(0, 16);
      const project = make(workspace, join(dataRoot, 'coordination', 'workspaces', hash));
      projects.push(project); await save(projects); return project;
    }),
    get: async id => {
      const project = (await read()).find(item => item.id === id);
      if (!project) throw new Error('Choose a saved project before sending.');
      if (!(await stat(project.workspace)).isDirectory()) throw new Error('The project working directory is unavailable.');
      return project;
    }
  };
}
module.exports = { createProjectStore, projectIdentity: identity, pathKey: key };
