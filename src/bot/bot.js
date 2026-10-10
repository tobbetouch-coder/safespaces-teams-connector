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
const { läge, aktivtLarm } = require("../store/mustering");
const { byggData } = require("../present/data");

// Demo-kund Noname. Måste matcha SITE/zonNyckel i scripts/seed.js, annars
// hittar routing-uppslaget ingen rad.
const SITE = process.env.DEMO_SITE ?? "noname-stockholm";
const ZON = process.env.DEMO_ZON ?? "lobby";

// Larmvarianterna. `clear` ligger med men behandlas särskilt i tolka().
//
// `scenario` är ett DATAFÄLT med låsta värden ur KONTRAKT.md avsnitt 2:
// brand · inrymning · utrymning · annat, i gemener. Demo-plats 1 (Noname
// Stockholm) är M1 = brand. Site Connect skickar samma ord genom bryggan, så
// tavlan, Teams och Pi-payloaden säger samma sak om samma larm.
//
// Tidigare stod här "Utrymning", "Övning" och "Förlarm och bekräftelse" — det
// är beskrivningar av läget, inte scenarier, och de skrevs rakt in i alarms.
// Läget framgår i stället av severity och test, som styr vilken mall som väljs.
// Versaliseringen på kortet görs av util/etiketter.js.
const VARIANTER = {
  brandlarm: {
    scenario: "brand", severity: "active", test: false,
    ingress: "Lämna byggnaden nu.",
    instruktion: "Utrym via närmaste utrymningsväg och gå till återsamlingsplatsen. Svara nedan när du är i säkerhet.",
  },
  forlarm: {
    scenario: "brand", severity: "prealarm", test: false,
    instruktion: "Kamerazonen har gett förlarm. Bekräfta om det är skarpt, avfärda om det är falsklarm.",
  },
  trigger: {
    scenario: "brand", severity: "active", test: false,
    instruktion: "Lämna byggnaden via närmaste utrymningsväg.",
  },
  clear: { severity: "cleared", test: false, rollSomAgerade: "Säkerhetsansvarig" },
  ovning: {
    scenario: "brand", severity: "active", test: true,
    instruktion: "Detta är en övning. Följ ordinarie utrymningsrutin.",
  },
  // M2. Börjar som förlarm, precis som i verkligheten: kameran flaggar, en
  // människa bedömer, och först Bekräfta utlöser inrymningen.
  inrymning: {
    scenario: "inrymning", severity: "prealarm", test: false,
    kalla: "api",
  },
  // Kameraanalysens egen flagga. Syns på tavlan och på skärmarna, men ger
  // inget Teams-kort — se render.js UTAN_KORT.
  fara: {
    scenario: "fara", severity: "active", test: false,
    kalla: "api",
  },
};

const INFOKOMMANDON = ["status"];

const HJÄLPTEXT =
  "Använd ett kommando i taget: `simulera brandlarm` · `forlarm` · `trigger` · "
  + "`ovning` · `inrymning` · `fara` · `clear` · `status`.\n\n"
  + "`inrymning` ger ett förlarm som **Bekräfta** eskalerar till "
  + "inrymningskortet. `fara` syns på tavlan men ger inga Teams-kort.\n\n"
  + "Ett aktivt larm per zon: ett nytt trigger uppdaterar det pågående larmet, "
  + "det skapar inget andra. Blås av med `simulera clear`.";

/**
 * Tolkar "simulera …". Två regler, och de är medvetet osymmetriska:
 *
 *   Okända eller extra ord ger hjälptext — ALDRIG ett larm. Ett slarvigt
 *   skrivet kommando ska inte kunna fyra av en utrymning.
 *
 *   Står ordet `clear` någonstans i raden blir det en avblåsning. Att vägra
 *   släcka ett larm för att raden var otydlig är det enda felet som är värre
 *   än att släcka i onödan. Därför betyder `simulera brandlarm clear` clear.
 */
function tolka(text) {
  const ord = text.trim().split(/\s+/).slice(1).map((o) => o.toLowerCase()).filter(Boolean);
  if (!ord.length) return null;
  if (ord.includes("clear")) return "clear";
  if (ord.length === 1 && (VARIANTER[ord[0]] || INFOKOMMANDON.includes(ord[0]))) return ord[0];
  return null;
}

class SafeSpacesBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      await this.spara(context);
      const text = (context.activity.text ?? "").trim().toLowerCase().replace(/<[^>]+>/g, "").trim();

      if (text.startsWith("simulera")) await this.simulera(context, text);
      else if (text === "larmtest") await this.larmtest(context);
      else if (text === "läge" || text === "lage") {
        // Samma sak här: larmet hämtas ur zonen, inte ur processens minne.
        const { öppet } = await this.riggen();
        if (!öppet) await context.sendActivity("Inget pågående larm i zonen. Kör: simulera brandlarm");
        else {
          const l = await läge(öppet.correlation_id, (await allaPersoner()).length);
          await uppdateraLägeskort(öppet.correlation_id);
          await context.sendActivity(`Läge för ${öppet.larm_id}: ${l.säkra} i säkerhet, ${l.hjälp.length} behöver hjälp, ${l.utanSvar} utan svar. Lägeskortet i kanalen är uppdaterat.`);
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

  /** Riggen: routingraden för demo-siten plus zonens öppna larm, om det finns ett. */
  async riggen() {
    const rutt = await routing("COID", SITE);
    const zonNyckel = rutt?.zonNyckel || ZON;
    const öppet = await aktivtLarm(rutt?.byggnad, zonNyckel).catch((e) => {
      console.error("kunde inte läsa zonens öppna larm", e.message);
      return null;
    });
    return { rutt, zonNyckel, öppet };
  }

  /**
   * Simulatorn så att C är demobar utan Pi:n. Samma väg som BO-017 senare driver på riktigt.
   *   simulera brandlarm · forlarm · trigger · ovning · clear · status
   *
   * correlationId kommer ur zonens öppna larm, inte ur processens minne.
   * Tidigare låg det i `this.korrelation`, och Function-appen skalar till noll:
   * varje kall start hittade på ett nytt id, så andra `simulera brandlarm` la ett
   * andra larm bredvid det första och `simulera clear` blåste av ett tomt id i
   * stället för de larm som faktiskt stod röda. Databasen är det enda minne som
   * överlever en recykling.
   */
  async simulera(context, text) {
    const kommando = tolka(text);
    if (!kommando) { await context.sendActivity(HJÄLPTEXT); return; }

    const { rutt, zonNyckel, öppet } = await this.riggen();

    if (kommando === "status") {
      const plats = rutt
        ? `${rutt.byggnad} · ${rutt.zonEtikett} (\`${SITE}\` / \`${zonNyckel}\`)`
        : `ingen routingrad för \`${SITE}\` — kör scripts/seed.js`;
      const rader = öppet ? await inspelade(öppet.correlation_id) : [];
      const l = öppet ? await läge(öppet.correlation_id, (await allaPersoner()).length) : null;
      await context.sendActivity(
        `**Rigg:** ${plats}\n\n`
        + (öppet
          ? `**Öppet larm:** ${öppet.larm_id} · ${öppet.status} · ${öppet.scenario}`
            + ` · utlöst ${öppet.utlost_at}\n\n`
            + `**Mustering:** ${l.säkra} i säkerhet, ${l.hjälp.length} behöver hjälp, ${l.utanSvar} utan svar\n\n`
            + (rader.length
              ? `**Inspelade kommandon:**\n${rader.map((r) => `- ${r.topic} ${r.payload}`).join("\n")}`
              : "Inga kommandon inspelade.")
          : "**Öppet larm:** inget. Zonen är i normalläge."),
      );
      return;
    }

    // Avblåsning: hitta larmet som står öppet. Skapa aldrig något.
    if (kommando === "clear") {
      if (!öppet) {
        await context.sendActivity(
          `Inget aktivt larm i ${rutt?.zonEtikett || zonNyckel} att blåsa av. Ingenting gjordes.`);
        return;
      }
      // scenario skickas INTE med: avblåsningen ska inte skriva om vad larmet
      // handlade om. Kortet säger FARAN ÖVER, raden behåller "Utrymning".
      const res = await presentEvent({
        ...VARIANTER.clear,
        correlationId: öppet.correlation_id,
        tenant: "COID",
        site: SITE,
        zone: zonNyckel,
        occurredAt: new Date().toISOString(),
        kalla: öppet.kalla || rutt?.kalla,
      });
      await context.sendActivity(
        `Avblåst ${öppet.larm_id} (${öppet.scenario} — scenariot orört):`
        + ` ${res.uppdaterade} kort uppdaterade, ${res.nya} nya.`);
      return;
    }

    const v = VARIANTER[kommando];

    // Ett förlarm på ett redan aktivt larm skulle sätta status tillbaka till
    // forlarm, alltså nedgradera ett pågående larm. Det gör vi inte tyst.
    if (kommando === "forlarm" && öppet?.status === "aktivt") {
      await context.sendActivity(
        `${öppet.larm_id} är redan ett aktivt larm i ${rutt?.zonEtikett || zonNyckel}.`
        + " Ett förlarm kan inte läggas ovanpå. Blås av med `simulera clear` först.");
      return;
    }

    // Ett aktivt larm per zon: finns ett öppet larm återanvänds dess id, så
    // raden och de utskickade korten uppdateras i stället för att dubbleras.
    const korr = öppet?.correlation_id ?? `sim-${Date.now()}`;
    const res = await presentEvent({
      ...v,
      correlationId: korr,
      tenant: "COID",
      site: SITE,
      zone: zonNyckel,
      occurredAt: öppet?.utlost_at ?? new Date().toISOString(),
      // Variantens egen källa vinner: inrymning och fara kommer från
      // kameraanalysen (`api`), inte från brandlarmcentralen.
      kalla: v.kalla ?? process.env.DEMO_KALLA ?? rutt?.kalla ?? "Brandlarmcentral",
    });
    await context.sendActivity(
      `${öppet ? "Uppdaterade" : "Simulerade"} ${kommando} — larm ${res.larmId}`
      + ` i ${rutt?.zonEtikett || zonNyckel}: mall ${res.mall},`
      + ` ${res.nya} nya kort och ${res.uppdaterade} uppdaterade.`);
  }
}

// tolka exporteras for att den ska ga att testa utan en Teams-tur.
module.exports = { SafeSpacesBot, tolka, VARIANTER };
