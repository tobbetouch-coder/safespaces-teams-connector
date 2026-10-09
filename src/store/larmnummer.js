// Högvattenmärket för dygnets larmnummer.
//
// `larm_id` räknades ur alarms-tabellen, och då är numret bara så högt som
// raderna som råkar finnas kvar. Raderas den senaste raden sjunker maxvärdet
// och nästa larm får samma nummer igen — två olika incidenter med samma id i
// Teams och på tavlan. Det inträffade 8 oktober: jag raderade 261008-007 och
// nästa larm blev 261008-007.
//
// Att räkna max i stället för antal löser bara halva problemet (en raderad rad
// i mitten). Den här tabellen löser resten: ett tal per dygn som bara kan gå
// uppåt, oavsett vad som händer i alarms.
//
// Skrivningen är optimistiskt låst på etag. Två larm i samma sekund ger 412
// Precondition Failed på den ena, som då läser om och försöker igen.
//
// Databasen förblir golvet: finns där ett högre nummer än märket vinner det.
// Tappas den här tabellen börjar vi alltså inte om från 001.
const { TableClient } = require("@azure/data-tables");
const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");

const TABELL = "larmnummer";
const PARTITION = "COID";
const FORSOK = 5;

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

async function las(dag) {
  try {
    return await tabell().getEntity(PARTITION, dag);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

/**
 * Nästa nummer för dygnet, aldrig lägre än `golv`.
 *
 * @param {string} dag  YYMMDD
 * @param {number} golv högsta numret som redan finns i alarms samma dygn
 * @returns {Promise<number>}
 *
 * Kan märket inte skrivas alls returneras `golv + 1` och felet loggas. Ett larm
 * får aldrig stoppas av att en räknare krånglar — ett återanvänt nummer är
 * förvirrande, ett uteblivet larm är farligt.
 */
async function nastaNummer(dag, golv) {
  for (let n = 1; n <= FORSOK; n++) {
    try {
      const rad = await las(dag);
      const senaste = Number.isFinite(rad?.senaste) ? rad.senaste : 0;
      const nytt = Math.max(senaste, golv) + 1;

      if (rad) {
        await tabell().updateEntity(
          { partitionKey: PARTITION, rowKey: dag, senaste: nytt },
          "Merge",
          { etag: rad.etag },
        );
      } else {
        await tabell().createEntity({ partitionKey: PARTITION, rowKey: dag, senaste: nytt });
      }
      return nytt;
    } catch (e) {
      // 412: någon annan hann skriva mellan läsningen och vår skrivning.
      // 409: raden skapades av någon annan precis nu. Båda: läs om, försök igen.
      if (e.statusCode === 412 || e.statusCode === 409) continue;
      if (e.statusCode === 404) {
        // Tabellen finns inte än.
        try { await tabell().createTable(); continue; } catch { /* nästa varv */ }
        continue;
      }
      console.error("larmnummer kunde inte skrivas, faller tillbaka på databasen:", e.message);
      return golv + 1;
    }
  }
  console.error(`larmnummer: gav upp efter ${FORSOK} försök, faller tillbaka på databasen`);
  return golv + 1;
}

module.exports = { nastaNummer };
