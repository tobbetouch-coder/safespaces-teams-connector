// C5: seam mot BO-017. Connectorn publicerar ALDRIG MQTT själv och rör aldrig
// trigger/{zone} eller clear/{zone} — bara confirm/{zone}. I Milestone C spelar den
// här stubben in kommandot i tabellen "commands" så att det går att verifiera.
// BO-017 byter ut stubben mot den riktiga bron utan att kontraktet ändras.
const { tabell, säkra } = require("../store/config");
const { medBackoff } = require("../util/retry");

const T = "commands";
const nyckel = (v) => String(v ?? "").replace(/[/\\#?]/g, "_");
const TILLÅTNA = ["confirm", "dismiss", "standdown"];

/**
 * @param {{tenant:string, site:string, zone:string, correlationId:string, actorEntraId:string, action:string}} cmd
 * @returns {Promise<{topic:string, payload:object}>}
 */
async function emitCommand(cmd) {
  if (!TILLÅTNA.includes(cmd.action)) throw new Error(`otillåten action: ${cmd.action}`);
  const topic = `safespaces/${cmd.tenant}/${cmd.site}/confirm/${cmd.zone}`;
  // Frozen contract: ingen role, ingen signature. Site Connect härleder rollen själv.
  const payload = {
    schema: "safespaces.action/1.0",
    correlationId: cmd.correlationId,
    zone: cmd.zone,
    actorEntraId: cmd.actorEntraId,
    action: cmd.action,
    issuedAt: new Date().toISOString(),
  };
  await säkra(T);
  await medBackoff(() => tabell(T).upsertEntity({
    partitionKey: nyckel(cmd.correlationId),
    rowKey: nyckel(`${payload.issuedAt}-${cmd.action}`),
    topic,
    payload: JSON.stringify(payload),
    levererad: false, // stubben levererar inte, den spelar in
  }, "Merge"), { namn: "emitCommand" });
  console.log(`emitCommand ${topic} ${JSON.stringify(payload)}`);
  return { topic, payload };
}

async function inspelade(correlationId) {
  await säkra(T);
  const ut = [];
  for await (const r of tabell(T).listEntities({ queryOptions: { filter: `PartitionKey eq '${nyckel(correlationId)}'` } })) ut.push(r);
  return ut;
}

module.exports = { emitCommand, inspelade, T };
