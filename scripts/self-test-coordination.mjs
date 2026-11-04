import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeAgentMessages,
  claimTask,
  completeTask,
  createAgentRuntime,
  createTask,
  formatAgentMessages,
  listAgents,
  listAgentMessages,
  listCoordinationEvents,
  listTasks,
  readAgentInbox,
  sendAgentMessage,
  validateAgentId,
  waitForAgentMessages
} from "../src/agent-coordination.js";

const root = await mkdtemp(join(tmpdir(), "dsw-coordination-test-"));
let coordinator;
let worker;

try {
  assert.throws(() => validateAgentId("../escape"), /agent id/);

  coordinator = await createAgentRuntime(root, {
    agentId: "coordinator",
    displayName: "Switchyard Coordinator",
    role: "coordinator",
    mission: "Coordinate the test project.",
    workspace: root,
    session: join(root, "coordinator-session.json"),
    heartbeatMs: 250
  });
  worker = await createAgentRuntime(root, {
    agentId: "worker-1",
    displayName: "Storage Worker",
    coordinatorId: "coordinator",
    role: "worker",
    mission: "Implement the bounded task.",
    workspace: root,
    session: join(root, "worker-session.json"),
    heartbeatMs: 250
  });

  const live = await listAgents(root);
  assert.deepEqual(live.map((agent) => agent.agentId), ["coordinator", "worker-1"]);
  assert.equal(live.every((agent) => agent.live), true);
  assert.equal(live[0].displayName, "Switchyard Coordinator");
  assert.equal(live[1].coordinatorId, "coordinator");

  await assert.rejects(
    createAgentRuntime(root, { agentId: "worker-1", role: "worker", workspace: root }),
    /already active/
  );

  const sent = await sendAgentMessage(root, {
    from: "coordinator",
    to: "worker-1",
    type: "task",
    taskId: "storage-warning",
    body: "Implement storage warning delivery."
  });
  const inbox = await readAgentInbox(root, "worker-1");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, sent.id);
  assert.match(formatAgentMessages(inbox), /<agent_message from="coordinator" type="task" task="storage-warning"/);
  assert.equal(await acknowledgeAgentMessages(root, "worker-1", inbox), 1);
  assert.equal((await readAgentInbox(root, "worker-1")).length, 0);

  const coordinatorMessage = await sendAgentMessage(root, {
    from: "worker-1",
    to: "coordinator",
    type: "progress",
    body: "The storage change is implemented; running focused checks."
  });
  const coordinatorInbox = await readAgentInbox(root, "coordinator");
  assert.equal(coordinatorInbox[0].id, coordinatorMessage.id);
  assert.equal(await acknowledgeAgentMessages(root, "coordinator", coordinatorInbox), 1);
  const coordinatorTranscript = await listAgentMessages(root, "coordinator");
  assert.equal(coordinatorTranscript.length, 1);
  assert.equal(coordinatorTranscript[0].deliveryState, "processed");
  assert.equal(coordinatorTranscript[0].from, "worker-1");

  const delayed = waitForAgentMessages(root, "worker-1", { timeoutMs: 2000, pollMs: 50 });
  setTimeout(() => {
    void sendAgentMessage(root, {
      from: "coordinator",
      to: "worker-1",
      type: "wake",
      body: "Dependency is ready; continue."
    });
  }, 100);
  const awakened = await delayed;
  assert.equal(awakened.timedOut, false);
  assert.equal(awakened.messages[0].type, "wake");
  await acknowledgeAgentMessages(root, "worker-1", awakened.messages);

  const timedOut = await waitForAgentMessages(root, "worker-1", { timeoutMs: 100, pollMs: 25 });
  assert.equal(timedOut.timedOut, true);

  await createTask(root, {
    taskId: "storage-warning",
    title: "Storage warning delivery",
    description: "Emit a warning at 80 percent capacity.",
    scope: ["src/storage"],
    acceptanceCriteria: ["Focused tests pass"],
    createdBy: "coordinator"
  });
  const claim = await claimTask(root, { taskId: "storage-warning", agentId: "worker-1", leaseSeconds: 60 });
  assert.equal(claim.agentId, "worker-1");
  await worker.addClaim("storage-warning");
  await assert.rejects(
    claimTask(root, { taskId: "storage-warning", agentId: "coordinator", leaseSeconds: 60 }),
    /already claimed/
  );
  const handoff = await completeTask(root, {
    taskId: "storage-warning",
    agentId: "worker-1",
    summary: "Implemented and tested.",
    status: "ready_for_review"
  });
  assert.equal(handoff.status, "ready_for_review");
  assert.equal((await listTasks(root))[0].claim.agentId, "worker-1");
  const eventSnapshot = await listCoordinationEvents(root, { max: 5 });
  assert.ok(eventSnapshot.total >= 7);
  assert.ok(eventSnapshot.todayTotal >= 7);
  assert.ok(eventSnapshot.events.some((event) => event.type === "message_sent"));

  await worker.stop("completed");
  worker = null;
  assert.deepEqual((await listAgents(root)).map((agent) => agent.agentId), ["coordinator"]);
  assert.equal((await listAgents(root, { includeStopped: true })).length, 2);

  process.stdout.write("coordination self-test: ok\n");
} finally {
  if (worker) await worker.stop("failed");
  if (coordinator) await coordinator.stop("completed");
  await rm(root, { recursive: true, force: true });
}
