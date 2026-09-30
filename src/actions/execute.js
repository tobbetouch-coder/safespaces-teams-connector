// C4: knapptrycket. Tenant-verify, rollgrind och pending-kort. Aldrig terminalläge här —
// utfallet ägs av Site Connect och kommer tillbaka som ett event via presentEvent.
const { CardFactory } = require("botbuilder");
const { rollFörPerson, fårGöra } = require("../store/config");
const { emitCommand } = require("../bridge/stub");
const { statuskort } = require("../cards/render");

const COID = process.env.MicrosoftAppTenantId;
const ETIKETT = {
  confirm: "Bekräftelse", dismiss: "Avfärdande", standdown: "Avblåsning",
};

/** Svar som ersätter kortet i stället för att posta en bubbla. */
const kortsvar = (kort) => ({
  statusCode: 200,
  type: "application/vnd.microsoft.card.adaptive",
  value: kort,
});

async function hanteraExecute(context) {
  const data = context.activity.value?.action?.data ?? context.activity.value?.data ?? {};
  const { correlationId, zone, site, action } = data;

  // 1. Tenant-verify utöver adapterns JWT-kontroll.
  const tenant = context.activity.channelData?.tenant?.id;
  if (COID && tenant && tenant !== COID) {
    console.warn(`Action.Execute från främmande tenant ${tenant}, avvisat`);
    return kortsvar(statuskort("Avvisat", "Kommandot kom från en annan organisation och utfördes inte.", data));
  }

  const aad = context.activity.from?.aadObjectId;
  const roll = aad ? await rollFörPerson(aad) : null;

  // 3. Default deny: okänd identitet eller roll utan rätt till åtgärden.
  if (!roll || !(await fårGöra(roll, action))) {
    console.warn(`nekad: aad=${aad ?? "okänd"} roll=${roll ?? "okänd"} action=${action}`);
    return kortsvar(statuskort(
      "Du får inte göra detta",
      roll
        ? `Din roll (${roll}) har inte behörighet att utföra ${ETIKETT[action] ?? action}. Inget kommando skickades.`
        : "Din identitet finns inte i behörighetslistan. Inget kommando skickades.",
      data));
  }

  // Auktoriserad: skicka kommandot och sätt kortet i väntläge.
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
