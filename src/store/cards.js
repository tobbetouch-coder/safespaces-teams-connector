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
