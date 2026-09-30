// /api/messages: HTTP-skalet. All logik ligger i botten; här bryggar vi bara
// Azure Functions v4:s fetch-liknande objekt till adapterns Express-liknande.
const { app } = require("@azure/functions");
const { adapter } = require("../bot/adapter");
const { SafeSpacesBot } = require("../bot/bot");

const bot = new SafeSpacesBot();

app.http("messages", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "messages",
  handler: async (request, context) => {
    const body = await request.json().catch(() => ({}));
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return this; },
      send(data) { payload = data; return this; },
      json(data) { payload = data; return this; },
      end(data) { if (data !== undefined) payload = data; return this; },
      setHeader() { return this; },
      header() { return this; },
    };

    try {
      await adapter.process({ body, headers, method: "POST" }, res, (turnContext) => bot.run(turnContext));
    } catch (err) {
      context.error("adapter.process kastade", err);
      return { status: 500, jsonBody: { error: "adapter" } };
    }
    return payload === undefined ? { status } : { status, jsonBody: payload };
  },
});
