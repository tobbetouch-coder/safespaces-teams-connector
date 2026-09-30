// BO-016:s konfigurationstabeller: routing, roles, membership, authority.
// Byt en rad i tabellen → annan routing eller behörighet, utan kodändring.
const { TableClient } = require("@azure/data-tables");
const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");

const konto = process.env.AzureWebJobsStorage__accountName;
const clientId = process.env.AzureWebJobsStorage__clientId;
const klienter = new Map();

function tabell(namn) {
  if (!klienter.has(namn)) {
    if (!konto) throw new Error("AzureWebJobsStorage__accountName saknas");
    const cred = clientId ? new ManagedIdentityCredential(clientId) : new DefaultAzureCredential();
    klienter.set(namn, new TableClient(`https://${konto}.table.core.windows.net`, namn, cred));
  }
  return klienter.get(namn);
}

async function säkra(namn) {
  try { await tabell(namn).createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

async function hämta(namn, partitionKey, rowKey) {
  try { return await tabell(namn).getEntity(partitionKey, rowKey); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}

async function lista(namn, filter) {
  const ut = [];
  for await (const r of tabell(namn).listEntities(filter ? { queryOptions: { filter } } : undefined)) ut.push(r);
  return ut;
}

/** site → { teamId, channelId }. Ingen hårdkodad routing i koden. */
async function routing(tenant, site) {
  return hämta("routing", tenant, site);
}

/** aadObjectId → roll. Membership är runtime-sanningen, seedad statiskt för demon. */
async function rollFörPerson(aadObjectId) {
  const rad = await hämta("membership", "COID", aadObjectId);
  return rad?.role ?? null;
}

/** roll → tillåtna åtgärder. Saknad roll eller saknad rad = default deny. */
async function tillåtnaÅtgärder(role) {
  if (!role) return [];
  const rad = await hämta("authority", "COID", role);
  return (rad?.actions ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function fårGöra(role, action) {
  return (await tillåtnaÅtgärder(role)).includes(action);
}

/** Alla roller som får en viss åtgärd — styr vilka personer som ska få knappar. */
async function rollerSomFår(action) {
  const rader = await lista("authority");
  return rader.filter((r) => (r.actions ?? "").split(",").map((s) => s.trim()).includes(action)).map((r) => r.rowKey);
}

/** Alla personer i en uppsättning roller. */
async function personerIRoller(roller) {
  if (!roller.length) return [];
  const rader = await lista("membership");
  return rader.filter((r) => roller.includes(r.role)).map((r) => ({ aadObjectId: r.rowKey, role: r.role }));
}

async function allaPersoner() {
  return (await lista("membership")).map((r) => ({ aadObjectId: r.rowKey, role: r.role }));
}

module.exports = { tabell, säkra, hämta, lista, routing, rollFörPerson, tillåtnaÅtgärder, fårGöra, rollerSomFår, personerIRoller, allaPersoner };
