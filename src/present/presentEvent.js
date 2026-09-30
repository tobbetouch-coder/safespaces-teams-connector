// C3: presentEvent. Tar ett event, routar det, renderar per mottagare och är idempotent
// på correlationId — andra eventet uppdaterar samma kort i stället för att skapa ett nytt.
const { CardFactory, TurnContext } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const { routing, rollerSomFår, personerIRoller } = require("../store/config");
const { getByAad, getByChannel } = require("../store/refs");
const { hämtaFörKorrelation, spara } = require("../store/cards");
const { rendera, väljMall } = require("../cards/render");
const { medBackoff } = require("../util/retry");

const COID = process.env.MicrosoftAppTenantId;

/**
 * @param {{correlationId:string, tenant:string, site:string, zone:string, scenario:string,
 *          severity:string, test:boolean, occurredAt:string, instruktion?:string,
 *          plats?:string, rollSomAgerade?:string, larmintervall?:string}} event
 */
async function presentEvent(event) {
  // 1. Tenant-verify. Främmande tenant ignoreras, default deny.
  if (COID && event.tenant && event.tenant !== COID && event.tenant !== "COID") {
    console.warn(`presentEvent: främmande tenant ${event.tenant}, ignorerat`);
    return { ignorerat: true, skäl: "tenant" };
  }

  const mallNamn = väljMall(event);
  const rutt = await routing("COID", event.site);
  if (!rutt) console.warn(`presentEvent: ingen routing för site ${event.site}`);

  const data = {
    correlationId: event.correlationId,
    scenario: event.scenario ?? "",
    zon: event.zone ?? "",
    site: event.site ?? "",
    plats: event.plats ?? event.site ?? "",
    klockslag: (event.occurredAt ?? new Date().toISOString()).slice(11, 16),
    instruktion: event.instruktion ?? "",
    status: event.severity ?? "",
    rollSomAgerade: event.rollSomAgerade ?? "",
    larmintervall: event.larmintervall ?? "",
  };

  // 3. Vilka roller får agera på det här kortet, och vilka personer bär rollerna.
  const actionsFörMall = mallNamn === "forlarm" ? ["confirm", "dismiss"] : mallNamn === "avblast" ? [] : ["standdown"];
  const rollerPerAction = {};
  for (const a of actionsFörMall) rollerPerAction[a] = await rollerSomFår(a);
  const berördaRoller = [...new Set(Object.values(rollerPerAction).flat())];
  const personer = await personerIRoller(berördaRoller);

  const tidigare = await hämtaFörKorrelation(event.correlationId);
  const karta = new Map(tidigare.map((r) => [r.rowKey, r]));
  const resultat = { mall: mallNamn, nya: 0, uppdaterade: 0, mottagare: [] };

  // Kanalen får kortet utan knappar: den är anslagstavla, inte beslutsyta.
  if (rutt?.channelId) {
    const ref = await getByChannel(rutt.channelId);
    if (ref) await leverera(ref, rutt.channelId, rendera(mallNamn, data, []), resultat, karta, event, mallNamn);
    else console.warn(`presentEvent: ingen referens för kanal ${rutt.channelId}`);
  }

  // Personerna får knappar efter sin egen roll.
  for (const p of personer) {
    const ref = await getByAad(p.aadObjectId);
    if (!ref) { console.warn(`presentEvent: ingen referens för ${p.aadObjectId}`); continue; }
    const mina = actionsFörMall.filter((a) => (rollerPerAction[a] ?? []).includes(p.role));
    await leverera(ref, p.aadObjectId, rendera(mallNamn, data, mina), resultat, karta, event, mallNamn);
  }

  if (event.test === true) console.log(`ÖVNING presentEvent ${event.correlationId} mall=${mallNamn} mottagare=${resultat.mottagare.length}`);
  else console.log(`presentEvent ${event.correlationId} mall=${mallNamn} nya=${resultat.nya} uppdaterade=${resultat.uppdaterade}`);
  return resultat;
}

async function leverera(reference, mottagarnyckel, kort, resultat, karta, event, mallNamn) {
  const befintlig = karta.get(String(mottagarnyckel).replace(/[/\\#?]/g, "_"));
  await medBackoff(() => adapter.continueConversationAsync(process.env.MicrosoftAppId, reference, async (context) => {
    const aktivitet = { attachments: [CardFactory.adaptiveCard(kort)] };
    if (befintlig?.activityId) {
      // 5. In-place: samma correlationId och mottagare uppdaterar kortet.
      await context.updateActivity({ ...aktivitet, id: befintlig.activityId, type: "message" });
      resultat.uppdaterade++;
    } else {
      const svar = await context.sendActivity(aktivitet);
      await spara(event.correlationId, mottagarnyckel, svar?.id, mallNamn);
      resultat.nya++;
    }
  }), { namn: `presentEvent:${mottagarnyckel}` });
  resultat.mottagare.push(mottagarnyckel);
}

module.exports = { presentEvent };
