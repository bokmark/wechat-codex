const MAX_INBOX_ITEMS = 1000;

export function recordInbox(state, entry) {
  state.inbox ||= [];
  state.nextInboxId ||= 1;
  const existing = state.inbox.find((item) => item.key === entry.key);
  if (existing) return existing.id;
  const id = state.nextInboxId++;
  state.inbox.push({
    id,
    readAt: null,
    sentAt: null,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  if (state.inbox.length > MAX_INBOX_ITEMS) {
    const read = state.inbox.filter((item) => item.readAt);
    const unread = state.inbox.filter((item) => !item.readAt);
    state.inbox = [...read.slice(-Math.max(0, MAX_INBOX_ITEMS - unread.length)), ...unread].slice(-MAX_INBOX_ITEMS);
  }
  return id;
}

export function markInboxSent(state, key) {
  const item = (state.inbox || []).find((candidate) => candidate.key === key);
  if (item && !item.sentAt) item.sentAt = new Date().toISOString();
}

export function markInboxRead(state, userId, selector) {
  const now = new Date().toISOString();
  let count = 0;
  for (const item of state.inbox || []) {
    if (item.userId !== userId || item.readAt) continue;
    if (selector !== "all" && item.id !== selector) continue;
    item.readAt = now;
    count += 1;
  }
  return count;
}

export function unreadInbox(state, userId) {
  return (state.inbox || []).filter((item) => item.userId === userId && !item.readAt).sort((a, b) => b.id - a.id);
}
