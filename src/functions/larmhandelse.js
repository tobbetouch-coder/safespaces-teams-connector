// Supabase Database Webhook -> Teams-kort.
//
// Den andra halvan av Teams <-> tavla. Tavlan prenumererar på alarms via
// Realtime; den här funktionen gör samma sak åt Teams. Ett larm som Site
// Connect skickar genom bryggan har tidigare bara nått tavlan.
//
// Vägen är ADDITIV. Direktvägen (simulera och knapparna -> presentEvent) är
// orörd. Båda kan vilja skicka kort för samma övergång, och kortlåset i
// src/store/idempotens.js avgör vem som gör det.
//
// authLevel "function": nyckeln i URL:en ÄR den delade hemligheten. Ingen egen
// header-kontroll — Functions-värden gör jobbet innan koden körs, och en
// hemlighet som bara finns på ett ställe är en hemlighet mindre att rotera.
//
// Triggern i Supabase skapas i Dashboard och pekar hit med ?code=<nyckel>.
const { app } = require("@azure/functions");
const { hämtaLarm, nästaLarmId, sattLarmId } = require("../store/mustering");
const { routing } = require("../store/config");
const { presentEvent } = require("../present/presentEvent");
const { slugify } = require("../util/slug");

const OPPNA = new Set(["forlarm", "aktivt"]);

/**
 * Vad en statusövergång ska ge för kort.
 *
 * gammal -> ny                  kort
 * (ingen) -> forlarm            förlarmkort
 * (ingen) -> aktivt             larmkort
 * forlarm -> aktivt             larmkort (förlarmkortet ersätts, "Eskalerat")
 * aktivt  -> avblast            FARAN ÖVER
 * forlarm -> avblast            förlarmkortet "Avfärdat" — INGET faran över
 * samma   -> samma              ingenting (loopskydd)
 *
 * Ett avfärdat förlarm får inte ge FARAN ÖVER: ingen har blivit utrymd, och
 * ett "faran över" på något som aldrig var farligt lär folk att ignorera det.
 */
function overgang(gammal, ny) {
  if (gammal === ny) return null;
  if (ny === "forlarm") return { mall: "forlarm", severity: "prealarm" };
  if (ny === "aktivt") return { mall: "larm", severity: "active", eskalerat: gammal === "forlarm" };
  if (ny === "avblast") {
    if (gammal === "forlarm") return { mall: "forlarm", severity: "prealarm", avfardat: true };
    return { mall: "avblast", severity: "cleared" };
  }
  return null;
}

app.http("larm-handelse", {
  methods: ["POST"],
  authLevel: "function",
  route: "larm/handelse",
  handler: async (request, context) => {
    let kropp;
    try {
      kropp = await request.json();
    } catch {
      return { status: 400, jsonBody: { fel: "ogiltig JSON" } };
    }

    const typ = String(kropp?.type ?? "").toUpperCase();
    if (typ === "DELETE") {
      return { status: 200, jsonBody: { hoppadeOver: "DELETE" } };
    }

    const cid = kropp?.record?.correlation_id;
    if (!cid) {
      return { status: 200, jsonBody: { hoppadeOver: "ingen correlation_id" } };
    }

    // Payloaden är en upplysning om att något hänt, inte sanningen om vad som
    // står i tabellen nu. Två skrivningar tätt inpå varandra kan nå hit i fel
    // ordning, och då ska vi agera på det som faktiskt gäller.
    const rad = await hämtaLarm(cid);
    if (!rad) {
      context.log(`larm-handelse: ${cid} finns inte längre, hoppar över`);
      return { status: 200, jsonBody: { hoppadeOver: "raden borta" } };
    }

    const gammal = kropp?.old_record?.status ?? null;
    const steg = overgang(gammal, rad.status);
    if (!steg) {
      return { status: 200, jsonBody: { hoppadeOver: `ingen övergång (${gammal} -> ${rad.status})` } };
    }

    // Routing på site-slugen ur byggnaden, enligt KONTRAKT.md avsnitt 1:
    // "Noname Stockholm" -> "noname-stockholm".
    // Bryggans rader har inget larm_id. Numret tilldelas FÖRE routingen, och
    // det är med flit: numret identifierar incidenten, och tavlan visar det.
    // Ett larm från en anläggning vi inte har routing för ska synas på tavlan
    // med ett riktigt id, även om ingen Teams-kanal kan ta emot korten.
    let larmId = rad.larm_id;
    if (!larmId) {
      larmId = await nästaLarmId(null);
      await sattLarmId(cid, larmId);
      context.log(`larm-handelse: ${cid} saknade larm_id, tilldelade ${larmId}`);
    }

    const site = slugify(rad.byggnad);
    const rutt = await routing("COID", site);
    if (!rutt) {
      context.log(`larm-handelse: ingen routingrad för "${site}" (byggnad "${rad.byggnad}"), inga kort skickade`);
      return { status: 200, jsonBody: { larmId, hoppadeOver: `ingen routing för ${site}` } };
    }

    const event = {
      correlationId: cid,
      tenant: "COID",
      site,
      zone: rad.zon_nyckel || rutt.zonNyckel,
      // Visningsfälten tas ur RADEN, inte ur routingen: raden är det Site
      // Connect faktiskt skickade, och tavlan visar samma sak.
      byggnad: rad.byggnad,
      zonEtikett: rad.zon,
      uppsamlingsplats: rad.uppsamlingsplats || rutt.uppsamlingsplats,
      kalla: rad.kalla || rutt.kalla,
      scenario: rad.scenario,
      severity: steg.severity,
      // Mallen sägs uttryckligen: webhooken vet vilken övergång det är, och
      // väljMall kan inte veta skillnaden mellan ett avfärdat förlarm och ett
      // nytt. En övning renderas som övning, men bara när det är ett larm —
      // ett avfärdat förlarm ska visa förlarmkortet även i övningsläge.
      mall: rad.test === true && steg.mall === "larm" ? "ovning" : steg.mall,
      test: rad.test === true,
      occurredAt: rad.utlost_at,
      larmId,
      avsandare: "webhook",
      // Texterna på förlarmkortet när det byter läge.
      ...(steg.eskalerat ? { forlarmslage: "Eskalerat till larm" } : {}),
      ...(steg.avfardat ? { forlarmslage: "Avfärdat", avblastAv: rad.avblast_av } : {}),
    };

    const res = await presentEvent(event);
    context.log(`larm-handelse ${larmId}: ${gammal ?? "(ny)"} -> ${rad.status}`
      + ` mall=${res.mall} nya=${res.nya ?? 0} uppdaterade=${res.uppdaterade ?? 0}`
      + (res.ignorerat ? ` (${res.skäl})` : ""));

    return {
      status: 200,
      jsonBody: {
        larmId,
        overgang: `${gammal ?? "(ny)"} -> ${rad.status}`,
        mall: res.mall,
        nya: res.nya ?? 0,
        uppdaterade: res.uppdaterade ?? 0,
        ...(res.ignorerat ? { ignorerat: res.skäl } : {}),
      },
    };
  },
});

module.exports = { overgang, OPPNA };
