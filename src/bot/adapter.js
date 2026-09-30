// Delad adapter. Både /api/messages och den proaktiva sändningen använder samma instans,
// så att autentiseringen läses en gång ur app settings (MicrosoftApp*).
const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require("botbuilder");

const auth = new ConfigurationBotFrameworkAuthentication(process.env);
const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  console.error("onTurnError", error);
  try { await context.sendActivity("Något gick fel i boten."); } catch { /* kanalen kan vara stängd */ }
};

module.exports = { adapter };
