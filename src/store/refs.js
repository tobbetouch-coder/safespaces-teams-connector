// Conversation-reference store i Azure Table. Identitetsbaserad åtkomst med samma
// användartilldelade identitet som resten av appen — ingen nyckel, ingen hemlighet.
// En rad per konversation: PartitionKey = tenantId, RowKey = conversationId.
const { TableClient } = require("@azure/data-tables");
const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");
const { TurnContext } = require("botbuilder");

const TABELL = "refs";
const konto = process.env.AzureWebJobsStorage__accountName;
const clientId = process.env.AzureWebJobsStorage__clientId;

let klient;
let tabellFinns;
function hämtaKlient() {
  if (!klient) {
    if (!konto) throw new Error("AzureWebJobsStorage__accountName saknas");
    const cred = clientId ? new ManagedIdentityCredential(clientId) : new DefaultAzureCredential();
    klient = new TableClient(`https://${konto}.table.core.windows.net`, TABELL, cred);
  }
  return klient;
}
async function säkraTabell() {
  if (tabellFinns) return;
  try { await hämtaKlient().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
  tabellFinns = true;
}

// RowKey tål inte / \ # ? — Teams-id:n innehåller dem inte, men vi tar det säkra före det osäkra.
const nyckel = (v) => String(v ?? "").replace(/[/\\#?]/g, "_");

function härled(activity) {
  const kanalData = activity.channelData ?? {};
  const kind = kanalData.team?.id || activity.conversation?.conversationType === "channel" ? "channel" : "personal";
  return {
    kind,
    aadObjectId: kind === "personal" ? activity.from?.aadObjectId ?? "" : "",
    teamId: kanalData.team?.id ?? "",
    channelId: kanalData.channel?.id ?? (kind === "channel" ? activity.conversation?.id ?? "" : ""),
  };
}

/**
 * Sparar eller uppdaterar referensen för aktivitetens konversation. Idempotent på conversationId.
 * Returnerar även om raden redan var välkomnad, så att välkomstkortet kan skickas exakt en gång —
 * install fyrar både installationUpdate och conversationUpdate.
 */
async function upsertRef(activity) {
  await säkraTabell();
  const reference = TurnContext.getConversationReference(activity);
  const { kind, aadObjectId, teamId, channelId } = härled(activity);
  const partitionKey = nyckel(activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? "okand");
  const rowKey = nyckel(activity.conversation?.id);

  let befintlig = null;
  try { befintlig = await hämtaKlient().getEntity(partitionKey, rowKey); }
  catch (e) { if (e.statusCode !== 404) throw e; }

  const rad = {
    partitionKey, rowKey, kind, aadObjectId, teamId, channelId,
    reference: JSON.stringify(reference),
    updatedAt: new Date().toISOString(),
    welcomed: befintlig?.welcomed === true,
  };
  // Merge, inte Replace: ingen create/update-gren, inga 409 vid samtidiga leveranser.
  await hämtaKlient().upsertEntity(rad, "Merge");
  return { ...rad, ny: !befintlig };
}

/** Markerar raden som välkomnad. Gör välkomstkortet idempotent, precis som lagringen. */
async function markWelcomed(partitionKey, rowKey) {
  await säkraTabell();
  // upsert-merge i stället för strikt update: kan inte etag-krocka och kan inte ge 404.
  await hämtaKlient().upsertEntity({ partitionKey, rowKey, welcomed: true }, "Merge");
}

async function* alla(filter) {
  await säkraTabell();
  for await (const rad of hämtaKlient().listEntities({ queryOptions: { filter } })) yield rad;
}

/** Referensen till en persons personliga chatt, uppslagen på Entra-objekt-id. */
async function getByAad(aadObjectId) {
  for await (const rad of alla(`aadObjectId eq '${nyckel(aadObjectId)}'`)) return JSON.parse(rad.reference);
  return null;
}

/** Referensen till en kanal, uppslagen på kanal-id. BO-016:s routing ger sajt till kanal. */
async function getByChannel(channelId) {
  for await (const rad of alla(`channelId eq '${nyckel(channelId)}'`)) return JSON.parse(rad.reference);
  return null;
}

/** Alla kanalreferenser, används av demokommandot innan BO-016:s routing finns. */
async function allaKanaler() {
  const ut = [];
  for await (const rad of alla("kind eq 'channel'")) ut.push(JSON.parse(rad.reference));
  return ut;
}

module.exports = { upsertRef, markWelcomed, getByAad, getByChannel, allaKanaler, TABELL };
