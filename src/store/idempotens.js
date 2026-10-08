// Loppet mellan de två vägarna.
//
// Direktvägen (simulera / knapparna -> presentEvent) och webhooken kan båda
// vilja skicka kort för samma övergång: simulatorn skriver raden i Supabase och
// skickar korten, och samma skrivning triggar webhooken, som vill skicka dem
// igen. Resultatet vore två uppsättningar kort i varje chatt.
//
// Lösningen är en nyckel per (correlation_id, status) i Table Storage. Insert i
// Azure Tables är atomisk — finns raden redan svarar tjänsten 409, och det är
// hela låset. Den som får nyckeln skickar korten; den andra avslutar tyst.
//
// Nyckeln är medvetet (correlation_id, status), inte (correlation_id, mall):
// det är statusövergången som ska ge EN kortuppsättning. Ett andra
// "simulera brandlarm" på samma incident skickar alltså inga nya kort — de är
// redan ute, och raden är redan aktiv.
const { TableClient } = require("@azure/data-tables");
const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");

const TABELL = "kortlas";
const konto = process.env.AzureWebJobsStorage__accountName;
const clientId = process.env.AzureWebJobsStorage__clientId;

let klient = null;
function tabell() {
  if (!klient) {
    if (!konto) throw new Error("AzureWebJobsStorage__accountName saknas");
    const cred = clientId ? new ManagedIdentityCredential(clientId) : new DefaultAzureCredential();
    klient = new TableClient(`https://${konto}.table.core.windows.net`, TABELL, cred);
  }
  return klient;
}

const nyckel = (v) => String(v ?? "").replace(/[/\\#?]/g, "_") || "-";

/**
 * Försöker ta nyckeln för (correlationId, status).
 *
 * @returns {Promise<boolean>} true om vi fick den och ska skicka korten.
 *
 * Kan nyckeln inte skrivas alls — tabellen saknas och går inte att skapa,
 * lagringen är nere — returnerar vi **true**. Hellre två kort än inget kort:
 * en dubblett är pinsam, ett uteblivet utrymningslarm är farligt.
 */
async function taNyckel(correlationId, status, vem) {
  const rad = {
    partitionKey: nyckel(correlationId),
    rowKey: nyckel(status),
    vem: vem ?? "",
    nar: new Date().toISOString(),
  };
  try {
    await tabell().createEntity(rad);
    return true;
  } catch (e) {
    if (e.statusCode === 409) {
      console.log(`kortlås: ${correlationId}/${status} var redan taget, ${vem} avstår`);
      return false;
    }
    if (e.statusCode === 404) {
      // Tabellen finns inte än. Skapa och försök igen, en gång.
      try {
        await tabell().createTable();
        await tabell().createEntity(rad);
        return true;
      } catch (e2) {
        if (e2.statusCode === 409) return false;
        console.error("kortlås kunde inte skapas, skickar ändå:", e2.message);
        return true;
      }
    }
    console.error("kortlås gick inte att läsa, skickar ändå:", e.message);
    return true;
  }
}

/** Släpper nyckeln. Används när sändningen föll och någon annan bör få försöka. */
async function slappNyckel(correlationId, status) {
  try {
    await tabell().deleteEntity(nyckel(correlationId), nyckel(status));
  } catch (e) {
    if (e.statusCode !== 404) console.error("kortlåset gick inte att släppa:", e.message);
  }
}

module.exports = { taNyckel, slappNyckel };
