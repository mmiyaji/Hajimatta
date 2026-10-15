const ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions";

async function listSubscriptions(request) {
  const data = [];
  const cursors = new Set();
  let cursor;
  let totals;
  do {
    const url = new URL(ENDPOINT);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);
    const response = await request(url.toString());
    if (!response.ok) throw new Error(`EventSub diagnostics list failed: HTTP ${response.status}`);
    const page = await response.json();
    totals ||= { total: page.total ?? null, totalCost: page.total_cost ?? null, maxTotalCost: page.max_total_cost ?? null };
    data.push(...(page.data || []));
    cursor = page.pagination?.cursor;
    if (cursor && cursors.has(cursor)) throw new Error("EventSub pagination repeated a cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { ...totals, data };
}

function summarizeSubscriptions(snapshot, broadcasters, types, sessionId = null, userId = null) {
  const rows = snapshot.data.map(subscription => ({
    id: subscription.id, type: subscription.type, version: subscription.version,
    broadcasterId: subscription.condition?.broadcaster_user_id ?? null,
    userId: subscription.condition?.user_id ?? null,
    status: subscription.status, cost: subscription.cost ?? null,
    method: subscription.transport?.method,
    sessionId: subscription.transport?.session_id ?? null,
  }));
  const active = rows.filter(row => row.method === "websocket" && row.status === "enabled");
  const coverage = broadcasters.flatMap(broadcaster => types.map(type => {
    const matches = active.filter(row => row.broadcasterId === broadcaster.id && row.type === type && row.version === "1"
      && (type !== "channel.chat_settings.update" || row.userId === userId));
    const current = matches.filter(row => !sessionId || row.sessionId === sessionId);
    return { login: broadcaster.login, broadcasterId: broadcaster.id, type,
      status: current.length ? "enabled" : matches.length ? "other_session" : "missing" };
  }));
  return {
    total: snapshot.total, totalCost: snapshot.totalCost, maxTotalCost: snapshot.maxTotalCost,
    enabledWebSockets: new Set(active.map(row => row.sessionId).filter(Boolean)).size,
    currentSessionId: sessionId, coverage, subscriptions: rows,
  };
}

module.exports = { listSubscriptions, summarizeSubscriptions };
