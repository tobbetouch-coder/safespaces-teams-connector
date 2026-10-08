// C4, reviderad mot BO-016:s manus. Tre sorters tryck:
//   musteringssvar (muster.safe, muster.help, muster.andra) — alla i zonen, ingen rollgrind
//   lägeskortets skötsel (muster.refresh, muster.paminn) och kommandon (confirm,
//   dismiss, standdown) — rollgate:ade via authority-tabellen
//   välkomstkortets test.larm — alltid tillåtet, går bara till en själv
// Ett tryck sätter aldrig terminalläge. Faran över kommer via clear-eventet.
const { rollFörPerson, fårGöra, routing, allaPersoner, personFörAad } = require("../store/config");
const { emitCommand } = require("../bridge/stub");
const { statuskort, rendera, väljMall } = require("../cards/render");
const { registrera, läge, hämtaLarm } = require("../store/mustering");
const { hämtaEvent } = require("../store/cards");
const { getByAad } = require("../store/refs");
const { uppdateraLägeskort } = require("../present/mustering");
const { botrad } = require("../present/presentEvent");
const { byggData, klocka } = require("../present/data");

const COID = process.env.MicrosoftAppTenantId;
const ETIKETT = { confirm: "Bekräftelse", dismiss: "Avfärdande", standdown: "Avblåsning", "muster.paminn": "Påminnelse" };
const TACK = "Tack. Säkerhetsansvarig ser att du är i säkerhet. Du får ett nytt meddelande när faran är över.";

const kortsvar = (kort) => ({ statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: kort });
const textsvar = (text) => ({ statusCode: 200, type: "application/vnd.microsoft.activity.message", value: text });

/** Eventet, routingen och larmraden bakom ett correlationId — allt korten behöver. */
async function sammanhang(correlationId) {
  const event = await hämtaEvent(correlationId);
  if (!event) return null;
  const rutt = await routing("COID", event.site);
  const larm = await hämtaLarm(correlationId).catch(() => null);
  return { event, rutt, data: byggData(event, rutt, larm) };
}

async function hanteraExecute(context) {
  const d = context.activity.value?.action?.data ?? context.activity.value?.data ?? {};
  const { correlationId, zone, site, action } = d;

  // Tenant-verify utöver adapterns JWT-kontroll. Gäller alla sorters tryck.
  const tenant = context.activity.channelData?.tenant?.id;
  if (COID && tenant && tenant !== COID) {
    console.warn(`Action.Execute från främmande tenant ${tenant}, avvisat`);
    return kortsvar(statuskort("Avvisat", "Kommandot kom från en annan organisation och utfördes inte.", d));
  }

  const aad = context.activity.from?.aadObjectId;
  const namn = context.activity.from?.name ?? "";

  // --- Välkomstkortets testlarm: bara till en själv, rör inget skarpt larm ---
  if (action === "test.larm") return testlarm(context, aad);

  // --- Musteringssvar: öppna för alla i zonen ---
  if (action === "muster.safe" || action === "muster.help") {
    const status = action === "muster.safe" ? "safe" : "help";

    // Musteringsläget stängs när larmet blåses av. Ett tryck på ett gammalt
    // kort efter Faran över ska inte skriva en ny rad i musteringen — då hade
    // lägeskortet och tavlan börjat röra sig igen för ett avslutat larm.
    // Korten byts ut vid avblåsning, men ett kort som inte hann uppdateras
    // ligger kvar i chatten och går att trycka på.
    const larmnu = await hämtaLarm(correlationId).catch(() => null);
    if (larmnu && larmnu.status === "avblast") {
      return kortsvar(statuskort(
        "Larmet är avblåst",
        `${larmnu.larm_id} blåstes av ${klocka(larmnu.avblast_at)}. Musteringen är stängd och ditt svar registrerades inte.`,
        d));
    }

    const p = aad ? await personFörAad(aad) : null;
    const sam = await sammanhang(correlationId);
    const rad = await registrera(correlationId, aad, status, namn || p?.namn, p?.zon || sam?.data.zon || zone, p?.upn);
    console.log(`mustering ${status} ${aad} för ${correlationId}`);
    // Lägeskortet i kanalen ritas om direkt, så ledningen ser svaret.
    uppdateraLägeskort(correlationId).catch((e) => console.error("lägeskortet kunde inte uppdateras", e));
    // Manuset vill ha tack-texten som egen bot-rad under kortet, inte inuti det.
    if (status === "safe") context.sendActivity(TACK).catch((e) => console.error("tack-raden gick inte fram", e));
    const data = { ...(sam?.data ?? { correlationId }), svarstid: klocka(rad.tid), zon: p?.zon || sam?.data.zon || zone };
    return kortsvar(rendera(status === "safe" ? "svar-sakerhet" : "svar-hjalp", data, []));
  }

  // --- Ändra mitt svar: tillbaka till larmkortet, svaret skrivs över vid nästa tryck ---
  if (action === "muster.andra") {
    const sam = await sammanhang(correlationId);
    if (!sam) return kortsvar(statuskort("Larmet hittades inte", "Det går inte att ändra svaret på ett larm som inte längre finns.", d));
    const p = aad ? await personFörAad(aad) : null;
    const mall = väljMall(sam.event) === "ovning" ? "ovning" : "larm-mottagare";
    return kortsvar(rendera(mall, { ...sam.data, zon: p?.zon || sam.data.zon }, []));
  }

  if (action === "muster.refresh") {
    const res = await uppdateraLägeskort(correlationId);
    if (res.uppdaterat) return textsvar("Läget uppdaterat.");
    return kortsvar(statuskort("Kunde inte uppdatera", `Läget gick inte att hämta: ${res.skäl}.`, d));
  }

  // --- Rollgate:ade tryck: påminnelse och kommandon ---
  const roll = aad ? await rollFörPerson(aad) : null;
  if (!roll || !(await fårGöra(roll, action))) {
    console.warn(`nekad: aad=${aad ?? "okänd"} roll=${roll ?? "okänd"} action=${action}`);
    return kortsvar(statuskort(
      "Du får inte göra detta",
      roll
        ? `Din roll (${roll}) har inte behörighet att utföra ${ETIKETT[action] ?? action}. Inget kommando skickades.`
        : "Din identitet finns inte i behörighetslistan. Inget kommando skickades.",
      d));
  }

  if (action === "muster.paminn") return påminn(correlationId);

  try {
    await emitCommand({ tenant: "COID", site, zone, correlationId, actorEntraId: aad, action });
  } catch (err) {
    console.error("emitCommand misslyckades", err);
    return kortsvar(statuskort("Kunde inte skicka", "Kommandot gick inte fram. Försök igen.", d));
  }

  return kortsvar(statuskort(
    `${ETIKETT[action] ?? action} skickad`,
    "Inväntar bekräftelse från anläggningen. Kortet uppdateras när läget ändras.",
    d));
}

/**
 * Påminnelsen är en ny bot-rad till var och en som inte svarat. Den ritar inte om
 * deras larmkort — en in-place-uppdatering ger ingen notis, och poängen är notisen.
 */
async function påminn(correlationId) {
  const personer = await allaPersoner();
  const l = await läge(correlationId, personer.length);
  const svarat = new Set(l.svarande);
  const kvar = personer.filter((p) => !svarat.has(p.aadObjectId));
  if (!kvar.length) return textsvar("Alla har svarat. Ingen påminnelse skickad.");

  let nådda = 0;
  for (const p of kvar) {
    const ref = await getByAad(p.aadObjectId);
    if (!ref) continue;
    try {
      await botrad(ref, "Påminnelse: du har inte svarat på brandlarmet. Svara på kortet i den här chatten så att säkerhetsansvarig vet att du är i säkerhet.");
      nådda++;
    } catch (e) { console.error(`påminnelsen nådde inte ${p.aadObjectId}`, e.message); }
  }
  console.log(`påminnelse för ${correlationId}: ${nådda} av ${kvar.length}`);
  return textsvar(`Påminnelse skickad till ${nådda} av ${kvar.length} som inte svarat.`);
}

/** Välkomstkortets testlarm: ett övningskort i den egna chatten, aldrig i kanalen. */
async function testlarm(context, aad) {
  const p = aad ? await personFörAad(aad) : null;
  const site = process.env.DEMO_SITE ?? "noname-stockholm";
  const rutt = await routing("COID", site);
  const data = byggData({
    correlationId: `test-${Date.now()}`, site, zone: rutt?.zonNyckel, test: true,
    occurredAt: new Date().toISOString(),
  }, rutt, null);
  data.larmId = "TESTLARM";
  try {
    await context.sendActivity({ attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: rendera("ovning", { ...data, zon: p?.zon || data.zon }, []) }] });
    return textsvar("Testlarm skickat till dig.");
  } catch (e) {
    console.error("testlarmet gick inte fram", e);
    return textsvar("Testlarmet gick inte fram. Försök igen.");
  }
}

module.exports = { hanteraExecute, kortsvar, textsvar };
