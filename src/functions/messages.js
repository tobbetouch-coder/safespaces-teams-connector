// BO-015 Milestone B: /api/messages tar emot aktiviteter, sparar conversation references
// och kan skicka proaktiva kort. Autentiseringen läses ur app settings — aldrig ur kod.
const { app } = require("@azure/functions");
const { ActivityHandler, TurnContext } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const { upsertRef, markWelcomed, getByAad, allaKanaler } = require("../store/refs");
const { sendCard } = require("../proactive/send");

const bot = new ActivityHandler();

// Bälte och hängslen: varje meddelande uppdaterar referensen, om install-eventet missades.
bot.onMessage(async (context, next) => {
  await spara(context);
  const text = (context.activity.text ?? "").trim().toLowerCase();

  if (text === "larmtest") {
    // Demoväg tills BO-016:s routing finns: kortet går till alla kända kanaler och till avsändaren.
    const kanaler = await allaKanaler();
    const egen = context.activity.from?.aadObjectId ? await getByAad(context.activity.from.aadObjectId) : null;
    let skickade = 0;
    for (const ref of kanaler) { await sendCard(ref); skickade++; }
    if (egen) { await sendCard(egen); skickade++; }
    await context.sendActivity(`Testkort skickat till ${kanaler.length} kanal(er) och ${egen ? "din personliga chatt" : "ingen personlig chatt (referens saknas)"}. Totalt ${skickade}.`);
  } else {
    await context.sendActivity(`echo: ${context.activity.text}`);
  }
  await next();
});

// Appen installeras för en person eller ett team.
bot.onInstallationUpdate(async (context, next) => {
  if ((context.activity.action ?? "").toLowerCase() === "add") await välkomnaEnGång(context);
  await next();
});

// Boten läggs i en konversation.
bot.onConversationUpdate(async (context, next) => {
  const botId = context.activity.recipient?.id;
  const lades = (context.activity.membersAdded ?? []).some((m) => m.id === botId);
  if (lades) {
    const rad = await spara(context);
    await välkomna(context, rad);
  }
  await next();
});

async function spara(context) {
  try {
    const rad = await upsertRef(context.activity);
    console.log(`ref sparad: ${rad.kind} ${rad.rowKey}`);
    return rad;
  } catch (err) {
    console.error("kunde inte spara referensen", err);
    return null;
  }
}

// Välkomstkortet bevisar hela kedjan: install fångar referensen, och referensen bär ett kort.
// Skickas exakt en gång per konversation — install fyrar både installationUpdate och
// conversationUpdate, och utan grinden kom kortet i dubbel uppsättning.
async function välkomnaEnGång(context) {
  const rad = await spara(context);
  if (!rad || rad.welcomed) return;
  try {
    await sendCard(TurnContext.getConversationReference(context.activity));
    await markWelcomed(rad.partitionKey, rad.rowKey);
    console.log(`välkomst skickad en gång: ${rad.kind} ${rad.rowKey}`);
  } catch (err) {
    console.error("välkomstkortet gick inte fram", err);
  }
}

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
