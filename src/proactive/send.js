// Proaktiv sändning. Röret som Milestone C:s presentEvent står på.
// Kortet är en platshållare i B — BO-016 levererar de riktiga mallarna.
const { CardFactory } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const platshallare = require("../cards/placeholder.json");

/**
 * Skickar ett Adaptive Card till en sparad conversation reference.
 * @param {object} reference conversation reference ur store:t
 * @param {object} [card] kortdefinition, platshållaren om inget anges
 */
async function sendCard(reference, card = platshallare) {
  if (!reference) throw new Error("ingen referens");
  await adapter.continueConversationAsync(process.env.MicrosoftAppId, reference, async (context) => {
    await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
  });
}

module.exports = { sendCard, platshallare };
