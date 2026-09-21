export function isCompactionSummary(message) {
  return message?.role === "user" && (message.compactionSummary === true || /^<context_compaction\b/.test(String(message.content || "")));
}

// One model turn is an assistant response plus ALL of its tool results, with
// preceding user input. This also permits compaction inside a long coding task.
// An unfinished suffix (including outstanding parallel calls) is retained in full.
export function conversationTurns(messages) {
  let first = 0;
  while (first < messages.length && ["system", "developer"].includes(messages[first].role)) first++;
  const instructionsEnd = first;
  while (isCompactionSummary(messages[first])) first++;
  let start = first;
  const complete = [];
  const pending = new Set();
  for (let i = first; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw new Error(`Invalid tool history: unmatched result ${message.tool_call_id}`);
      if (pending.size === 0) {
        complete.push({ start, end: i + 1 });
        start = i + 1;
      }
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls || []) {
        if (!call.id || pending.has(call.id)) throw new Error("Invalid tool history: missing or duplicate call ID");
        pending.add(call.id);
      }
      if (!message.tool_calls?.length && pending.size === 0 && !message.interrupted) {
        complete.push({ start, end: i + 1 });
        start = i + 1;
      }
    }
  }
  return { instructionsEnd, first, complete, activeStart: start < messages.length ? start : null };
}
