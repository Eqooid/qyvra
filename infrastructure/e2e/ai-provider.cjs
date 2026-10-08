// Deterministic HTTP provider fixture ONLY for the isolated browser test stack.
// API/worker still use their production native adapters. No production mock switch.
const { createServer } = require("node:http");
const stats = {
  embeddingRequests: 0,
  embeddingInputs: 0,
  generationRequests: 0,
};
createServer(async (req, res) => {
  try {
    if (req.method === "GET" && ["/health", "/stats"].includes(req.url)) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/stats" ? stats : { healthy: true }));
      return;
    }
    const parts = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 1048576) throw Error();
      parts.push(part);
    }
    const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/embeddings") {
      stats.embeddingRequests++;
      stats.embeddingInputs += body.input.length;
      res.end(
        JSON.stringify({
          model: body.model,
          data: body.input.map((text, index) => ({
            index,
            embedding: text.includes("unrelated")
              ? [-1, -2, -3]
              : text.includes("Hello")
                ? [1, 2, 2]
                : [1, 2, 3],
          })),
        }),
      );
    } else if (req.url === "/chat/completions") {
      stats.generationRequests++;
      const context = JSON.parse(body.messages[1].content);
      const source = context.sources[0];
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  outcome: "answered",
                  claims: [
                    {
                      text: Array.from(source.text).slice(0, 256).join(""),
                      sourceTokens: [source.sourceToken],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  } catch {
    res.statusCode = 400;
    res.end("{}");
  }
}).listen(8080, "0.0.0.0");
