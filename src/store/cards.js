// cards-tabellen: ett kort per correlationId och mottagare, så att upprepade events
// uppdaterar samma aktivitet i stället för att skapa ett nytt kort.
// PartitionKey = correlationId, RowKey = mottagarnyckel (aadObjectId eller channelId).
const { tabell, säkra, lista } = require("./config");

const T = "cards";
const nyckel = (v) => String(v ?? "").replace(/[/\\#?]/g, "_");

async function hämtaFörKorrelation(correlationId) {
  await säkra(T);
  return lista(T, `PartitionKey eq '${nyckel(correlationId)}'`);
}

async function spara(correlationId, recipientKey, activityId, mall) {
  await säkra(T);
  await tabell(T).upsertEntity({
    partitionKey: nyckel(correlationId),
    rowKey: nyckel(recipientKey),
    activityId,
    mall,
    updatedAt: new Date().toISOString(),
  }, "Merge");
}

module.exports = { hämtaFörKorrelation, spara, T };

// Eventets kontext sparas på samma partition, så att lägeskortet kan ritas om
// utan att originaleventet finns till hands.
const EVENT_RK = "__event";

async function sparaEvent(correlationId, event) {
  await säkra(T);
  await tabell(T).upsertEntity({
    partitionKey: nyckel(correlationId),
    rowKey: EVENT_RK,
    event: JSON.stringify(event),
    updatedAt: new Date().toISOString(),
  }, "Merge");
}

async function hämtaEvent(correlationId) {
  await säkra(T);
  try {
    const r = await tabell(T).getEntity(nyckel(correlationId), EVENT_RK);
    return JSON.parse(r.event);
  } catch (e) { if (e.statusCode === 404) return null; throw e; }
}

module.exports.sparaEvent = sparaEvent;
module.exports.hämtaEvent = hämtaEvent;
module.exports.EVENT_RK = EVENT_RK;
