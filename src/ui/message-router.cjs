const { mkdir, readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
async function saveReceipt(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, file); return; }
    catch (error) { if (attempt >= 7 || !['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error; await new Promise(done => setTimeout(done, 25 * (attempt + 1))); }
  }
}

// One desktop instance owns dispatch. Persist the request before launching so a
// retry after a lost IPC reply retains the same session and inbox message ID.
function createMessageRouter(dataRoot, dispatch) {
  let tail = Promise.resolve();
  return input => {
    const next = tail.then(async () => {
      if (!/^\d{13}-[a-f0-9-]{36}$/i.test(input.requestId || '')) throw new Error('A valid message request ID is required.');
      const folder = join(dataRoot, 'ui', 'deliveries');
      await mkdir(folder, { recursive: true });
      const file = join(folder, `${input.requestId}.json`);
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      let receipt;
      try { receipt = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt && receipt.fingerprint !== fingerprint) throw new Error('This message ID was already used for another message.');
      if (receipt?.result) return receipt.result;
      receipt ||= { fingerprint, sessionPath: input.sessionPath || join(dataRoot, 'sessions', `${input.requestId}.json`) };
      await saveReceipt(file, receipt);
      const result = await dispatch({ ...input, sessionPath: receipt.sessionPath, newSession: !input.sessionPath });
      await saveReceipt(file, { ...receipt, result });
      return result;
    });
    tail = next.catch(() => {});
    return next;
  };
}
module.exports = { createMessageRouter };
