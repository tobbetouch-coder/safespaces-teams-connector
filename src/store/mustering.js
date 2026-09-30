// Musteringstabellen: vem har svarat vad på ett larm.
// PartitionKey = correlationId, RowKey = aadObjectId. Idempotent — samma person som
// svarar igen skriver över sitt eget svar, aldrig en ny rad.
const { tabell, säkra, lista } = require("./config");

const T = "mustering";
const nyckel = (v) => String(v ?? "").replace(/[/\\#?]/g, "_");

/** status: "safe" | "help" */
async function registrera(correlationId, aadObjectId, status, namn) {
  await säkra(T);
  const rad = {
    partitionKey: nyckel(correlationId),
    rowKey: nyckel(aadObjectId),
    status,
    namn: namn ?? "",
    tid: new Date().toISOString(),
  };
  await tabell(T).upsertEntity(rad, "Merge");
  return rad;
}

async function svar(correlationId) {
  await säkra(T);
  return lista(T, `PartitionKey eq '${nyckel(correlationId)}'`);
}

/** Läget för lägeskortet: totaler och vilka som behöver hjälp. */
async function läge(correlationId, antalBerörda) {
  const rader = await svar(correlationId);
  const säkra_ = rader.filter((r) => r.status === "safe");
  const hjälp = rader.filter((r) => r.status === "help");
  return {
    berörda: antalBerörda,
    svarat: rader.length,
    säkra: säkra_.length,
    hjälp: hjälp.map((r) => ({ aadObjectId: r.rowKey, namn: r.namn, tid: r.tid })),
    utanSvar: Math.max(0, antalBerörda - rader.length),
  };
}

module.exports = { registrera, svar, läge, T };
