// Isolated T05 fixture: real inference relay with bounded fault injection.
// No published port, document logging, credentials, fake vectors or fake answers.
const http = require("node:http");
const state = {
  embed: 0,
  chat: 0,
  tags: 0,
  failures: 0,
  failEmbedAfter: null,
  failChat: false,
};
http
  .createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    try {
      if (req.url === "/test/status") return res.end(JSON.stringify(state));
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1000000) throw Error("request limit");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (req.url === "/test/control" && req.method === "POST") {
        const control = JSON.parse(body.toString());
        if (control.failEmbedAfter !== undefined)
          state.failEmbedAfter = control.failEmbedAfter;
        if (control.failChat !== undefined)
          state.failChat = control.failChat === true;
        return res.end(JSON.stringify(state));
      }
      if (!["/api/embed", "/api/chat", "/api/tags"].includes(req.url)) {
        res.statusCode = 404;
        return res.end("{}");
      }
      if (
        (req.url === "/api/embed" &&
          state.failEmbedAfter !== null &&
          state.embed >= state.failEmbedAfter) ||
        (req.url === "/api/chat" && state.failChat)
      ) {
        if (req.url === "/api/embed") state.failEmbedAfter = null;
        state.failures++;
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "isolated test outage" }));
      }
      const key = req.url.slice(5);
      const upstream = await fetch(
        "http://host.docker.internal:11434" + req.url,
        {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: body.length ? body : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        },
      );
      state[key]++;
      res.statusCode = upstream.status;
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: "isolated relay unavailable" }));
    }
  })
  .listen(11434, "0.0.0.0");
