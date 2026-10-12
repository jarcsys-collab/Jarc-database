// TEST-ONLY: reads a Server-Sent Events stream with fetch (Node), collecting { event, id, data } messages.
async function openStream(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { Accept: "text/event-stream", ...headers }, signal: controller.signal });
  const messages = [];
  let ended = false, buffer = "";
  const done = (async () => {
    if (!res.ok || !res.body) { ended = true; return; }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const message = { event: "message", id: null, data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const [field, ...rest] = line.split(":"); const value = rest.join(":").replace(/^ /, "");
            if (field === "event") message.event = value; else if (field === "id") message.id = value; else if (field === "data") message.data += value;
          }
          if (message.data) { try { message.data = JSON.parse(message.data); } catch { /* keep text */ } messages.push(message); }
        }
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  const waitFor = async (predicate, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = messages.find(predicate); if (hit) return hit; if (ended) break; await new Promise((r) => setTimeout(r, 25)); }
    return messages.find(predicate) || null;
  };
  return { res, messages, waitFor, get ended() { return ended; }, close: () => { controller.abort(); return done; }, done };
}
module.exports = { openStream };
