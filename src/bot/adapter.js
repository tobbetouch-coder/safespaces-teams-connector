// Delad adapter. Både /api/messages och den proaktiva sändningen använder samma instans,
// så att autentiseringen läses en gång ur app settings (MicrosoftApp*).
const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require("botbuilder");

const auth = new ConfigurationBotFrameworkAuthentication(process.env);
const adapter = new CloudAdapter(auth);

// Logga, men posta aldrig en felbubbla till användaren. En dubblettleverans eller en
// godartad storage-race ska inte synas som "Något gick fel" i chatten.
adapter.onTurnError = async (context, error) => {
  console.error("onTurnError", error?.stack ?? error);
};

module.exports = { adapter };
