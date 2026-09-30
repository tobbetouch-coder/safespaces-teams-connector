// BO-015 Milestone A: /api/messages tar emot aktiviteter från Bot Service och ekar texten.
// Autentiseringen läses ur app settings (MicrosoftAppId/Password/Type/TenantId) — aldrig ur kod.
// Hemligheten kommer från Key Vault via referensen i MicrosoftAppPassword.
const { app } = require("@azure/functions");
const { CloudAdapter, ConfigurationBotFrameworkAuthentication, ActivityHandler } = require("botbuilder");

const auth = new ConfigurationBotFrameworkAuthentication(process.env);
const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  // Loggas till App Insights (ai-safespaces-demo) så att tysta auth-fel syns.
  console.error("onTurnError", error);
  await context.sendActivity("Något gick fel i boten.");
};

const bot = new ActivityHandler();
bot.onMessage(async (context, next) => {
  await context.sendActivity(`echo: ${context.activity.text}`);
  await next();
});
bot.onMembersAdded(async (context, next) => {
  for (const m of context.activity.membersAdded ?? []) {
    if (m.id !== context.activity.recipient.id) await context.sendActivity("Safe Spaces-boten är uppe. Skriv något så ekar jag det.");
  }
  await next();
});

// CloudAdapter.process vill ha Express-liknande req/res. Azure Functions v4 ger fetch-liknande
// objekt, så vi bryggar över med ett minimalt skal.
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
