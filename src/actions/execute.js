// C4, reviderad mot BO-016:s manus. Tre sorters tryck:
//   musteringssvar (muster.safe, muster.help, muster.andra) — alla i zonen, ingen rollgrind
//   lägeskortets skötsel (muster.refresh, muster.paminn) och kommandon (confirm,
//   dismiss, standdown) — rollgate:ade via authority-tabellen
//   välkomstkortets test.larm — alltid tillåtet, går bara till en själv
// Ett tryck sätter aldrig terminalläge. Faran över kommer via clear-eventet.
const { rollFörPerson, fårGöra, routing, allaPersoner, personFörAad } = require("../store/config");
const { emitCommand } = require("../bridge/stub");
const { statuskort, rendera, väljMall } = require("../cards/render");
const { registrera, läge, hämtaLarm, eskaleraLarm, avblåsLarm } = require("../store/mustering");
const { hämtaEvent } = require("../store/cards");
const { getByAad } = require("../store/refs");
const { uppdateraLägeskort } = require("../present/mustering");
const { botrad, presentEvent } = require("../present/presentEvent");
const { byggData, klocka } = require("../present/data");

const COID = process.env.MicrosoftAppTenantId;
const ETIKETT = { confirm: "Bekräftelse", dismiss: "Avfärdande", standdown: "Avblåsning", "muster.paminn": "Påminnelse" };
const TACK = "Tack. Säkerhetsansvarig ser att du är i säkerhet. Du får ett nytt meddelande när faran är över.";

const kortsvar = (kort) => ({ statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: kort });
const textsvar = (text) => ({ statusCode: 200, type: "application/vnd.microsoft.activity.message", value: text });

/**
 * Scenariot ur en larmrad, eller null om det saknas.
 *
 * Egen funktion för att den ska gå att prova: regeln är att Bekräfta aldrig
 * gissar. Kameran skriver `inrymning`, en knapp skriver `brand`, och det som
 * står i raden är det som ska ut. Tom sträng och whitespace räknas som att
 * det saknas.
 */
function scenarioFrån(larmrad) {
  const s = String(larmrad?.scenario ?? "").trim();
  return s === "" ? null : s;
}

/** Eventet, routingen och larmraden bakom ett correlationId — allt korten behöver. */
async function sammanhang(correlationId) {
  const event = await hämtaEvent(correlationId);
  if (!event) return null;
  const rutt = await routing("COID", event.site);
  const larm = await hämtaLarm(correlationId).catch(() => null);
  return { event, rutt, data: byggData(event, rutt, larm) };
}

async function hanteraExecute(context) {
  const d = context.activity.value?.action?.data ?? context.activity.value?.data ?? {};
  const { correlationId, zone, site, action } = d;

  // Tenant-verify utöver adapterns JWT-kontroll. Gäller alla sorters tryck.
  const tenant = context.activity.channelData?.tenant?.id;
  if (COID && tenant && tenant !== COID) {
    console.warn(`Action.Execute från främmande tenant ${tenant}, avvisat`);
    return kortsvar(statuskort("Avvisat", "Kommandot kom från en annan organisation och utfördes inte.", d));
  }

  const aad = context.activity.from?.aadObjectId;
  const namn = context.activity.from?.name ?? "";

  // --- Välkomstkortets testlarm: bara till en själv, rör inget skarpt larm ---
  if (action === "test.larm") return testlarm(context, aad);

  // --- Musteringssvar: öppna för alla i zonen ---
  if (action === "muster.safe" || action === "muster.help") {
    const status = action === "muster.safe" ? "safe" : "help";

    // Musteringsläget stängs när larmet blåses av. Ett tryck på ett gammalt
    // kort efter Faran över ska inte skriva en ny rad i musteringen — då hade
    // lägeskortet och tavlan börjat röra sig igen för ett avslutat larm.
    // Korten byts ut vid avblåsning, men ett kort som inte hann uppdateras
    // ligger kvar i chatten och går att trycka på.
    const larmnu = await hämtaLarm(correlationId).catch(() => null);
    if (larmnu && larmnu.status === "avblast") {
      return kortsvar(statuskort(
        "Larmet är avblåst",
        `${larmnu.larm_id} blåstes av ${klocka(larmnu.avblast_at)}. Musteringen är stängd och ditt svar registrerades inte.`,
        d));
    }

    const p = aad ? await personFörAad(aad) : null;
    const sam = await sammanhang(correlationId);
    const rad = await registrera(correlationId, aad, status, namn || p?.namn, p?.zon || sam?.data.zon || zone, p?.upn);
    console.log(`mustering ${status} ${aad} för ${correlationId}`);
    // Lägeskortet i kanalen ritas om direkt, så ledningen ser svaret.
    uppdateraLägeskort(correlationId).catch((e) => console.error("lägeskortet kunde inte uppdateras", e));
    // Manuset vill ha tack-texten som egen bot-rad under kortet, inte inuti det.
    if (status === "safe") context.sendActivity(TACK).catch((e) => console.error("tack-raden gick inte fram", e));
    // Larmets zon pa kortet; personens egen zon sparas i musteringsraden ovan.
    const data = { ...(sam?.data ?? { correlationId }), svarstid: klocka(rad.tid) };
    return kortsvar(rendera(status === "safe" ? "svar-sakerhet" : "svar-hjalp", data, []));
  }

  // --- Ändra mitt svar: tillbaka till larmkortet, svaret skrivs över vid nästa tryck ---
  if (action === "muster.andra") {
    const sam = await sammanhang(correlationId);
    if (!sam) return kortsvar(statuskort("Larmet hittades inte", "Det går inte att ändra svaret på ett larm som inte längre finns.", d));
    const mall = väljMall(sam.event) === "ovning" ? "ovning" : "larm-mottagare";
    return kortsvar(rendera(mall, sam.data, []));
  }

  if (action === "muster.refresh") {
    const res = await uppdateraLägeskort(correlationId);
    if (res.uppdaterat) return textsvar("Läget uppdaterat.");
    return kortsvar(statuskort("Kunde inte uppdatera", `Läget gick inte att hämta: ${res.skäl}.`, d));
  }

  // --- Rollgate:ade tryck: påminnelse och kommandon ---
  const roll = aad ? await rollFörPerson(aad) : null;
  if (!roll || !(await fårGöra(roll, action))) {
    console.warn(`nekad: aad=${aad ?? "okänd"} roll=${roll ?? "okänd"} action=${action}`);
    return kortsvar(statuskort(
      "Du får inte göra detta",
      roll
        ? `Din roll (${roll}) har inte behörighet att utföra ${ETIKETT[action] ?? action}. Inget kommando skickades.`
        : "Din identitet finns inte i behörighetslistan. Inget kommando skickades.",
      d));
  }

  if (action === "muster.paminn") return påminn(correlationId);

  // commands-tabellen är kvar som logg över vem som tryckte vad. Inget beror på
  // den längre: tidigare var den hela effekten av Bekräfta, och eftersom
  // ingenting konsumerade den hände det ingenting när man tryckte.
  try {
    await emitCommand({ tenant: "COID", site, zone, correlationId, actorEntraId: aad, action });
  } catch (err) {
    console.error("emitCommand misslyckades, fortsätter ändå", err.message);
  }

  const vem = namn || (aad ? (await personFörAad(aad))?.namn : "") || "Säkerhetsansvarig";

  // --- Bekräfta: förlarmet blir fullt larm. Samma rad, samma correlation_id. ---
  if (action === "confirm") {
    const larmnu = await hämtaLarm(correlationId).catch(() => null);
    if (!larmnu) {
      return kortsvar(statuskort("Larmet hittades inte", "Det finns ingen larmrad att bekräfta.", d));
    }
    if (larmnu.status === "aktivt") {
      return kortsvar(statuskort("Redan bekräftat", `${larmnu.larm_id} är redan ett aktivt larm.`, d));
    }
    if (larmnu.status !== "forlarm") {
      return kortsvar(statuskort("Går inte att bekräfta", `${larmnu.larm_id} har status ${larmnu.status}.`, d));
    }

    const eskalerat = await eskaleraLarm(correlationId);
    if (!eskalerat) {
      // Någon annan hann före mellan läsningen och skrivningen.
      return kortsvar(statuskort("Redan bekräftat", "Larmet hann bli aktivt under tiden.", d));
    }

    // Scenariot tas alltid ur förlarmet. Saknas det säger kortet ifrån i
    // stället för att gissa: en default till brand hade skickat ut en
    // utrymning för något som kanske var en inrymning, och då springer folk
    // ut genom den dörr de skulle ha låst.
    if (!scenarioFrån(eskalerat)) {
      console.warn(`confirm: larm ${correlationId} saknar scenario, eskalerar inte`);
      return kortsvar(statuskort(
        "Scenariot saknas",
        "Förlarmet har inget scenario, och då går det inte att veta vilket "
        + "larm som ska gå ut. Inget skickades. Avfärda förlarmet och utlös "
        + "larmet manuellt i stället.",
        d,
      ));
    }

    // Samma eskalering som "simulera brandlarm": larmkorten går ut till alla i
    // zonen. Webhooken gör samma sak när triggern är på plats; kortlåset
    // avgör vem som faktiskt skickar.
    const sam = await sammanhang(correlationId);
    const larmevent = {
      correlationId,
      tenant: "COID",
      site: sam?.event?.site ?? site,
      zone: eskalerat.zon_nyckel || zone,
      byggnad: eskalerat.byggnad,
      zonEtikett: eskalerat.zon,
      uppsamlingsplats: eskalerat.uppsamlingsplats,
      kalla: eskalerat.kalla,
      scenario: scenarioFrån(eskalerat),
      severity: "active",
      test: eskalerat.test === true,
      occurredAt: eskalerat.utlost_at,
      // Ingen mall anges: valjMall laser scenariot, sa en inrymning far
      // INRYMNING-kortet och ett brandlarm BRANDLARM. Scenariot bevaras
      // genom eskaleringen.
      instruktion: "Lämna byggnaden via närmaste utrymningsväg och gå till uppsamlingsplatsen.",
      avsandare: "knapp:confirm",
      // Bekräftelseraden följer med i UTSKICKET också, inte bara i svaret till
      // den som tryckte. Då blir de två skrivningarna identiska och ordningen
      // mellan dem slutar spela roll — raden försvann annars när utskicket
      // råkade landa sist. Att alla ser vem som bedömde förlarmet är dessutom
      // vettigt i sig: det säger att en människa tittat på det.
      bekraftelse: ` · Bekräftat av ${vem} ${klocka(new Date().toISOString())}`,
    };
    await presentEvent(larmevent)
      .catch((e) => console.error("eskaleringens kort gick inte ut", e.message));

    // Den som tryckte får SAMMA kort som alla andra — BRANDLARM eller
    // INRYMNING — med vem som bekräftade i sidfoten.
    //
    // Förut svarade vi med förlarmkortet märkt "Bekräftat av …". Då stod den
    // som bekräftat kvar utan utrymningsinstruktion, i samma byggnad som alla
    // andra fick den. Svaret på trycket landar dessutom sist och skrev över
    // eskaleringen presentEvent just gjort.
    //
    // Nu spelar ordningen ingen roll: båda skrivningarna ger samma kort, och
    // skulle sidfotsraden förloras i en kapplöpning är det bara den raden som
    // försvinner, aldrig larmet.
    const larmmall = väljMall(larmevent);
    const mottagarmall = { ovning: "ovning", inrymning: "inrymning" }[larmmall] ?? "larm-mottagare";
    return kortsvar(rendera(mottagarmall,
      byggData(larmevent, sam?.rutt ?? null, { larm_id: eskalerat.larm_id, utlost_at: eskalerat.utlost_at }),
      []));
  }

  // --- Avfärda: förlarmet var ofarligt. Avblåst, men INGET faran över. ---
  if (action === "dismiss") {
    const larmnu = await hämtaLarm(correlationId).catch(() => null);
    if (!larmnu) {
      return kortsvar(statuskort("Larmet hittades inte", "Det finns ingen larmrad att avfärda.", d));
    }
    if (larmnu.status !== "forlarm") {
      return kortsvar(statuskort("Går inte att avfärda",
        larmnu.status === "aktivt"
          ? `${larmnu.larm_id} är ett aktivt larm. Det avfärdas inte — det blåses av.`
          : `${larmnu.larm_id} har status ${larmnu.status}.`, d));
    }

    // Ett avfärdat förlarm ger inget FARAN ÖVER-kort. Ingen har blivit utrymd,
    // och ett "faran över" på något som aldrig var farligt lär folk att
    // ignorera nästa.
    await avblåsLarm(correlationId, vem);

    const sam = await sammanhang(correlationId);
    return kortsvar(rendera("forlarm", {
      ...(sam?.data ?? { correlationId }),
      forlarmslage: `Avfärdat av ${vem} ${klocka(new Date().toISOString())}`,
    }, []));
  }

  // --- Avblås: larmet är över. Samma väg som `simulera clear`. ---
  //
  // Knappen fanns på lägeskortet från början, men ingen gren hanterade den:
  // trycket föll igenom till standardsvaret nedan, som sa "Avblåsning
  // skickad — inväntar bekräftelse från anläggningen". Ingenting skickades.
  // Larmet stod kvar rött tills någon körde `simulera clear`, och kortet
  // påstod hela tiden att något var på väg. Mätt 16 oktober: sex minuter.
  //
  // presentEvent gör allt arbetet och är samma anrop som simulatorn använder:
  // kortlåset, PATCH på larmraden (inte en ny rad — clear är slutet på en
  // incident) och omritning av alla utskickade kort.
  if (action === "standdown") {
    const larmnu = await hämtaLarm(correlationId).catch(() => null);
    if (!larmnu) {
      return kortsvar(statuskort("Larmet hittades inte",
        "Det finns ingen larmrad att blåsa av.", d));
    }
    if (larmnu.status === "avblast") {
      return kortsvar(statuskort("Redan avblåst",
        `${larmnu.larm_id} är redan avblåst. Ingenting gjordes.`, d));
    }
    if (larmnu.status === "forlarm") {
      return kortsvar(statuskort("Går inte att blåsa av",
        `${larmnu.larm_id} är ett förlarm — det avfärdas, inte avblåses.`, d));
    }

    const sam = await sammanhang(correlationId);
    // scenario skickas INTE med: avblåsningen ska inte skriva om vad larmet
    // handlade om. Kortet säger HÄNDELSEN ÖVER, raden behåller sitt scenario.
    const res = await presentEvent({
      correlationId,
      tenant: "COID",
      site: sam?.event?.site ?? site,
      zone: sam?.event?.zone ?? zone,
      severity: "cleared",
      test: false,
      kalla: larmnu.kalla ?? sam?.event?.kalla,
      occurredAt: new Date().toISOString(),
      avsandare: "knapp:standdown",
      // Hamnar i avblast_av på raden, så tavlan kan visa vem som blåste av.
      rollSomAgerade: vem,
    });
    console.log(`standdown ${correlationId} av ${vem}:`
      + ` ${res?.uppdaterade ?? 0} kort uppdaterade, ${res?.nya ?? 0} nya`
      + (res?.ignorerat ? ` (ignorerat: ${res.skäl})` : ""));

    // Mallen har ett eget fält för det här: avblastAv. Skickar man i stället
    // forlarmslage faller raden bort tyst, och kortet säger inte vem som
    // blåste av — vilket är just det man vill se efteråt.
    const efter = await sammanhang(correlationId);
    return kortsvar(rendera("avblast", {
      ...(efter?.data ?? { correlationId }),
      avblastAv: `${vem} ${klocka(new Date().toISOString())}`,
    }, []));
  }

  // Okänd åtgärd. Den gamla texten sa "<åtgärd> skickad — inväntar
  // bekräftelse från anläggningen", vilket var osant för allt som inte hade
  // en gren: ingenting skickades någonsin. Ett kort som påstår att något är
  // på väg är värre än ett som säger att det inte hände, särskilt i ett
  // larmläge där någon väntar på att det ska ta.
  console.warn(`okänd åtgärd: ${action}`);
  return kortsvar(statuskort(
    "Okänd åtgärd",
    `Knappen "${ETIKETT[action] ?? action}" hanteras inte av connectorn.`
    + " Ingenting skickades. Använd `simulera clear` i chatten om larmet"
    + " ska blåsas av.",
    d));
}

/**
 * Påminnelsen är en ny bot-rad till var och en som inte svarat. Den ritar inte om
 * deras larmkort — en in-place-uppdatering ger ingen notis, och poängen är notisen.
 */
async function påminn(correlationId) {
  const personer = await allaPersoner();
  const l = await läge(correlationId, personer.length);
  const svarat = new Set(l.svarande);
  const kvar = personer.filter((p) => !svarat.has(p.aadObjectId));
  if (!kvar.length) return textsvar("Alla har svarat. Ingen påminnelse skickad.");

  let nådda = 0;
  for (const p of kvar) {
    const ref = await getByAad(p.aadObjectId);
    if (!ref) continue;
    try {
      await botrad(ref, "Påminnelse: du har inte svarat på brandlarmet. Svara på kortet i den här chatten så att säkerhetsansvarig vet att du är i säkerhet.");
      nådda++;
    } catch (e) { console.error(`påminnelsen nådde inte ${p.aadObjectId}`, e.message); }
  }
  console.log(`påminnelse för ${correlationId}: ${nådda} av ${kvar.length}`);
  return textsvar(`Påminnelse skickad till ${nådda} av ${kvar.length} som inte svarat.`);
}

/** Välkomstkortets testlarm: ett övningskort i den egna chatten, aldrig i kanalen. */
async function testlarm(context, aad) {
  const p = aad ? await personFörAad(aad) : null;
  const site = process.env.DEMO_SITE ?? "noname-stockholm";
  const rutt = await routing("COID", site);
  const data = byggData({
    correlationId: `test-${Date.now()}`, site, zone: rutt?.zonNyckel, test: true,
    occurredAt: new Date().toISOString(),
  }, rutt, null);
  data.larmId = "TESTLARM";
  try {
    await context.sendActivity({ attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: rendera("ovning", { ...data, zon: p?.zon || data.zon }, []) }] });
    return textsvar("Testlarm skickat till dig.");
  } catch (e) {
    console.error("testlarmet gick inte fram", e);
    return textsvar("Testlarmet gick inte fram. Försök igen.");
  }
}

module.exports = { hanteraExecute, kortsvar, textsvar, scenarioFrån };
