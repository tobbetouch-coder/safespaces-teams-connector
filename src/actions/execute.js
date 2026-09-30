// C4, reviderad. Två sorters tryck:
//   musteringssvar (muster.safe, muster.help, muster.refresh) — alla i zonen, ingen rollgrind
//   kommandon (confirm, dismiss, standdown) — rollgate:ade och skickas till bridgen
// Ett tryck sätter aldrig terminalläge. Faran över kommer via clear-eventet.
const { rollFörPerson, fårGöra } = require("../store/config");
const { emitCommand } = require("../bridge/stub");
const { statuskort, rendera } = require("../cards/render");
const { registrera } = require("../store/mustering");
const { uppdateraLägeskort } = require("../present/mustering");

const COID = process.env.MicrosoftAppTenantId;
const ETIKETT = { confirm: "Bekräftelse", dismiss: "Avfärdande", standdown: "Avblåsning" };

const kortsvar = (kort) => ({
  statusCode: 200,
  type: "application/vnd.microsoft.card.adaptive",
  value: kort,
});

async function hanteraExecute(context) {
  const data = context.activity.value?.action?.data ?? context.activity.value?.data ?? {};
  const { correlationId, zone, site, action } = data;

  // Tenant-verify utöver adapterns JWT-kontroll. Gäller båda sorternas tryck.
  const tenant = context.activity.channelData?.tenant?.id;
  if (COID && tenant && tenant !== COID) {
    console.warn(`Action.Execute från främmande tenant ${tenant}, avvisat`);
    return kortsvar(statuskort("Avvisat", "Kommandot kom från en annan organisation och utfördes inte.", data));
  }

  const aad = context.activity.from?.aadObjectId;
  const namn = context.activity.from?.name ?? "";

  // --- Musteringssvar: öppna för alla i zonen ---
  if (action === "muster.safe" || action === "muster.help") {
    const status = action === "muster.safe" ? "safe" : "help";
    const rad = await registrera(correlationId, aad, status, namn, zone);
    console.log(`mustering ${status} ${aad} för ${correlationId}`);
    // Lägeskortet i kanalen ritas om direkt, så ledningen ser svaret.
    uppdateraLägeskort(correlationId).catch((e) => console.error("lägeskortet kunde inte uppdateras", e));
    const svarstid = rad.tid.slice(11, 16);
    return kortsvar(rendera(status === "safe" ? "svar-sakerhet" : "svar-hjalp", { correlationId, svarstid }, []));
  }

  if (action === "muster.refresh") {
    const res = await uppdateraLägeskort(correlationId);
    if (res.uppdaterat) return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: "Läget uppdaterat." };
    return kortsvar(statuskort("Kunde inte uppdatera", `Läget gick inte att hämta: ${res.skäl}.`, data));
  }

  // --- Kommandon: rollgate:ade ---
  const roll = aad ? await rollFörPerson(aad) : null;
  if (!roll || !(await fårGöra(roll, action))) {
    console.warn(`nekad: aad=${aad ?? "okänd"} roll=${roll ?? "okänd"} action=${action}`);
    return kortsvar(statuskort(
      "Du får inte göra detta",
      roll
        ? `Din roll (${roll}) har inte behörighet att utföra ${ETIKETT[action] ?? action}. Inget kommando skickades.`
        : "Din identitet finns inte i behörighetslistan. Inget kommando skickades.",
      data));
  }

  try {
    await emitCommand({ tenant: "COID", site, zone, correlationId, actorEntraId: aad, action });
  } catch (err) {
    console.error("emitCommand misslyckades", err);
    return kortsvar(statuskort("Kunde inte skicka", "Kommandot gick inte fram. Försök igen.", data));
  }

  return kortsvar(statuskort(
    `${ETIKETT[action] ?? action} skickad`,
    "Inväntar bekräftelse från anläggningen. Kortet uppdateras när läget ändras.",
    data));
}

module.exports = { hanteraExecute, kortsvar };
