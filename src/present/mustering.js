// Ritar om lägeskortet i kanalen när någon svarat. Manuell eller anropad refresh —
// ingen automatisk tiovärdig uppdatering, den ligger efter SKYDD.
const { CardFactory } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const { routing, allaPersoner } = require("../store/config");
const { getByChannel } = require("../store/refs");
const { hämtaFörKorrelation, hämtaEvent, spara } = require("../store/cards");
const { hämtaLarm } = require("../store/mustering");
const { byggLägeskort, nyckel } = require("./presentEvent");
const { byggData } = require("./data");
const { medBackoff } = require("../util/retry");

/** Uppdaterar kanalens lägeskort in-place. Gör inget om kortet inte finns. */
async function uppdateraLägeskort(correlationId) {
  const event = await hämtaEvent(correlationId);
  if (!event) return { uppdaterat: false, skäl: "inget event" };
  const rutt = await routing("COID", event.site);
  if (!rutt?.channelId) return { uppdaterat: false, skäl: "ingen routing" };

  const ref = await getByChannel(rutt.channelId);
  if (!ref) return { uppdaterat: false, skäl: "ingen kanalreferens" };

  const rader = await hämtaFörKorrelation(correlationId);
  const kanalrad = rader.find((r) => r.rowKey === nyckel(rutt.channelId));
  const larm = await hämtaLarm(correlationId).catch(() => null);
  const data = byggData(event, rutt, larm);
  const kort = await byggLägeskort(data, (await allaPersoner()).length);

  await medBackoff(() => adapter.continueConversationAsync(process.env.MicrosoftAppId, ref, async (context) => {
    const aktivitet = { attachments: [CardFactory.adaptiveCard(kort)] };
    if (kanalrad?.activityId) await context.updateActivity({ ...aktivitet, id: kanalrad.activityId, type: "message" });
    else {
      const svar = await context.sendActivity(aktivitet);
      await spara(correlationId, rutt.channelId, svar?.id, "lageskort");
    }
  }), { namn: "lägeskort" });

  return { uppdaterat: true };
}

module.exports = { uppdateraLägeskort };
