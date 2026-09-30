// Botens beteende. TeamsActivityHandler ger onAdaptiveCardInvoke, alltså knapptrycket.
const { TeamsActivityHandler, TurnContext, CardFactory } = require("botbuilder");
const { upsertRef, markWelcomed, getByAad, allaKanaler } = require("../store/refs");
const { sendCard } = require("../proactive/send");
const { hanteraExecute } = require("../actions/execute");
const { presentEvent } = require("../present/presentEvent");
const { rollFörPerson, routing, allaPersoner, personFörAad } = require("../store/config");
const { rendera } = require("../cards/render");
const { inspelade } = require("../bridge/stub");
const { uppdateraLägeskort } = require("../present/mustering");
const { läge } = require("../store/mustering");
const { byggData } = require("../present/data");

// Simulatorn: ett correlationId per körning, så att in-place-uppdateringen syns.
const SITE = process.env.DEMO_SITE ?? "hus-3-uppsala";
const ZON = process.env.DEMO_ZON ?? "plan-2-norr";

class SafeSpacesBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      await this.spara(context);
      const text = (context.activity.text ?? "").trim().toLowerCase().replace(/<[^>]+>/g, "").trim();

      if (text.startsWith("simulera")) await this.simulera(context, text);
      else if (text === "larmtest") await this.larmtest(context);
      else if (text === "läge" || text === "lage") {
        const korr = this.korrelation;
        if (!korr) await context.sendActivity("Inget pågående larm i simulatorn. Kör: simulera brandlarm");
        else {
          const l = await läge(korr, (await allaPersoner()).length);
          await uppdateraLägeskort(korr);
          await context.sendActivity(`Läge för ${korr}: ${l.säkra} i säkerhet, ${l.hjälp.length} behöver hjälp, ${l.utanSvar} utan svar. Lägeskortet i kanalen är uppdaterat.`);
        }
      }
      else if (text === "välkomst" || text === "valkomst") await this.visaVälkomst(context);
      else if (text === "vem är jag" || text === "vem ar jag") {
        const roll = await rollFörPerson(context.activity.from?.aadObjectId);
        await context.sendActivity(roll ? `Du är ${roll} i behörighetslistan.` : "Du finns inte i behörighetslistan (default deny).");
      } else await context.sendActivity(`echo: ${context.activity.text}`);

      await next();
    });

    this.onInstallationUpdate(async (context, next) => {
      if ((context.activity.action ?? "").toLowerCase() === "add") await this.välkomnaEnGång(context);
      await next();
    });

    this.onConversationUpdate(async (context, next) => {
      const botId = context.activity.recipient?.id;
      if ((context.activity.membersAdded ?? []).some((m) => m.id === botId)) await this.välkomnaEnGång(context);
      await next();
    });
  }

  /** C4: knapptrycket. Svaret ersätter kortet — aldrig en felbubbla. */
  async onAdaptiveCardInvoke(context) {
    return hanteraExecute(context);
  }

  async spara(context) {
    try { return await upsertRef(context.activity); }
    catch (err) { console.error("kunde inte spara referensen", err); return null; }
  }

  async välkomnaEnGång(context) {
    const rad = await this.spara(context);
    if (!rad || rad.welcomed) return;
    try {
      const aad = context.activity.from?.aadObjectId;
      const rutt = await routing("COID", SITE);
      const p = aad ? await personFörAad(aad) : null;
      const data = byggData({ correlationId: "valkomst", site: SITE, zone: rutt?.zonNyckel ?? ZON }, rutt, null);
      const kort = rendera("valkomst", { ...data, zon: p?.zon || data.zon }, []);
      await sendCard(TurnContext.getConversationReference(context.activity), kort);
      await markWelcomed(rad.partitionKey, rad.rowKey);
    } catch (err) { console.error("välkomstkortet gick inte fram", err); }
  }

  /** Välkomstkortet på begäran. välkomnaEnGång är en engångsspärr; det här är demovägen. */
  async visaVälkomst(context) {
    const rutt = await routing("COID", SITE);
    const aad = context.activity.from?.aadObjectId;
    const p = aad ? await personFörAad(aad) : null;
    const data = byggData({ correlationId: "valkomst", site: SITE, zone: rutt?.zonNyckel ?? ZON }, rutt, null);
    await context.sendActivity({ attachments: [CardFactory.adaptiveCard(rendera("valkomst", { ...data, zon: p?.zon || data.zon }, []))] });
  }

  async larmtest(context) {
    const kanaler = await allaKanaler();
    const egen = context.activity.from?.aadObjectId ? await getByAad(context.activity.from.aadObjectId) : null;
    for (const ref of kanaler) await sendCard(ref);
    if (egen) await sendCard(egen);
    await context.sendActivity(`Testkort skickat till ${kanaler.length} kanal(er) och ${egen ? "din personliga chatt" : "ingen personlig chatt"}.`);
  }

  /**
   * Simulatorn så att C är demobar utan Pi:n. Samma väg som BO-017 senare driver på riktigt.
   *   simulera forlarm · simulera trigger · simulera clear · simulera ovning · simulera status
   */
  async simulera(context, text) {
    const del = text.split(/\s+/)[1] ?? "";
    const korr = this.korrelation ?? (this.korrelation = `sim-${Date.now()}`);
    const bas = { correlationId: korr, tenant: "COID", site: SITE, zone: ZON, occurredAt: new Date().toISOString(), kalla: process.env.DEMO_KALLA ?? "Brandlarmcentral" };

    if (del === "status") {
      const rader = await inspelade(korr);
      await context.sendActivity(rader.length
        ? `Inspelade kommandon för ${korr}:\n${rader.map((r) => `- ${r.topic} ${r.payload}`).join("\n")}`
        : `Inga kommandon inspelade för ${korr}.`);
      return;
    }
    if (del === "nytt") { this.korrelation = `sim-${Date.now()}`; await context.sendActivity(`Nytt correlationId: ${this.korrelation}`); return; }

    const varianter = {
      brandlarm: { scenario: "Utrymning", severity: "active", test: false,
        ingress: "Lämna byggnaden nu.",
        instruktion: "Utrym via närmaste utrymningsväg och gå till återsamlingsplatsen. Svara nedan när du är i säkerhet." },
      forlarm: { scenario: "Förlarm och bekräftelse", severity: "prealarm", test: false, instruktion: "Kamerazonen har gett förlarm. Bekräfta om det är skarpt, avfärda om det är falsklarm." },
      trigger: { scenario: "Utrymning", severity: "active", test: false, instruktion: "Lämna byggnaden via närmaste utrymningsväg." },
      clear: { scenario: "Faran över", severity: "cleared", test: false, rollSomAgerade: "Säkerhetsansvarig" },
      ovning: { scenario: "Övning", severity: "active", test: true, instruktion: "Detta är en övning. Följ ordinarie utrymningsrutin." },
    };
    const v = varianter[del];
    if (!v) { await context.sendActivity("Använd: simulera brandlarm | forlarm | trigger | clear | ovning | status | nytt"); return; }

    const res = await presentEvent({ ...bas, ...v });
    await context.sendActivity(`Simulerat ${del} för ${korr} (larm ${res.larmId}): mall ${res.mall}, ${res.nya} nya kort och ${res.uppdaterade} uppdaterade.`);
  }
}

module.exports = { SafeSpacesBot };
