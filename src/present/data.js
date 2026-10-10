// Ett ställe som binder eventet och routingraden till mallarnas fält. Delas av
// presentEvent, lägeskortet och knapphanteraren så att samma larm alltid visar
// samma ord — och samma ord som Cloud-skivan läser ur alarms-raden.
const { klocka, datum, varaktighet } = require("../util/tid");
const { scenarioEtikett } = require("../util/etiketter");

const KARTA_URL = process.env.UTRYMNINGSKARTA_URL ?? "https://tower.co-ideation.com/safespaces/utrymningskarta";
const MUSTERING_URL = process.env.MUSTERING_URL ?? "https://tower.co-ideation.com/safespaces/mustering";
const ZON_URL = process.env.ZON_URL ?? "https://tower.co-ideation.com/safespaces/min-zon";

/**
 * Texterna som skiljer sig åt mellan scenarier.
 *
 * Räddningstjänstens ord är "händelsen över", inte "faran över" — faran kan
 * mycket väl finnas kvar, det är händelsen som är avslutad.
 */
function scenariotexter(scenario, zon) {
  const s = String(scenario ?? "").trim().toLowerCase();

  if (s === "inrymning") {
    return {
      avblastRubrik: "Du kan lämna skyddet",
      avblastText: "Du kan lämna skyddet. Hotet är avblåst. Följ personalens anvisningar.",
      forlarmText: `Kameran har flaggat en möjlig händelse vid ${zon}. `
        + "Bekräfta för att utlösa inrymning, eller avfärda om det är ofarligt.",
    };
  }

  return {
    avblastRubrik: "Du kan återgå till byggnaden",
    avblastText: "Tack för att du svarade snabbt. Frågor om händelsen tar du med din säkerhetsansvarige.",
    forlarmText: "En analyskälla har flaggat en möjlig händelse i zonen. "
      + "Bekräfta för att utlösa larm, eller avfärda om det är ofarligt.",
  };
}

/** KAMERA_LOBBY, KAMERA_OFFICES_2F … Bindestreck blir understreck. */
function kameraUrl(zonNyckel) {
  const nyckel = String(zonNyckel ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!nyckel) return "";
  return (process.env[`KAMERA_${nyckel}`] ?? "").trim();
}

/**
 * @param {object} event eventet från bridgen eller simulatorn
 * @param {object|null} rutt routingraden för siten: byggnad, zonEtikett, uppsamlingsplats
 * @param {object|null} larm larmraden ur Supabase, för larm_id och utlösningstid
 */
function byggData(event, rutt, larm) {
  const nu = new Date().toISOString();
  const start = larm?.utlost_at ?? event.occurredAt ?? nu;
  return {
    correlationId: event.correlationId,
    larmId: larm?.larm_id ?? event.correlationId,
    site: event.site ?? "",
    byggnad: event.byggnad ?? rutt?.byggnad ?? event.plats ?? event.site ?? "",
    plats: event.byggnad ?? rutt?.byggnad ?? event.plats ?? event.site ?? "",
    zon: event.zonEtikett ?? rutt?.zonEtikett ?? event.zone ?? "",
    zonNyckel: event.zone ?? rutt?.zonNyckel ?? "",
    kalla: event.kalla ?? rutt?.kalla ?? "",
    uppsamlingsplats: event.uppsamlingsplats ?? rutt?.uppsamlingsplats ?? "",
    // Kontraktet avsnitt 2 skickar scenario i gemener (brand, inrymning,
    // utrymning, annat). Versaliseringen hör i visningslagret, aldrig i datan —
    // samma regel som tavlans etiketter.ts.
    scenario: scenarioEtikett(event.scenario),
    klockslag: klocka(start),
    // Förlarmkortets sista rad. "Väntar på bedömning" tills någon tryckt,
    // sedan "Bekräftat av Maria Ek 14:02", "Avfärdat" eller "Eskalerat".
    forlarmslage: event.forlarmslage ?? "Väntar på bedömning",
    // Sidfotsraden pa larmkortet nar nagon bekraftat. Tom i utskicket till
    // alla; satt bara i svaret till den som tryckte.
    bekraftelse: event.bekraftelse ?? "",
    // Scenarioberoende korttexter. Ett brandlarm och en inrymning är motsatta
    // instruktioner — det ena säger gå ut, det andra stanna inne och lås.
    ...scenariotexter(event.scenario, event.zonEtikett ?? rutt?.zonEtikett ?? event.zone ?? ""),
    // Kameralänk per zon, ur app settings: KAMERA_LOBBY, KAMERA_OFFICES_2F.
    // Samma mönster som tavlans VITE_KAMERA_<ZON>. Saknas den visas ingen knapp.
    kameraUrl: kameraUrl(event.zone ?? rutt?.zonNyckel),
    // Faran över: "14:02–14:19 (17 min)" och vem som avblåste.
    larmintervall: `${klocka(start)}–${klocka(nu)} (${varaktighet(start, nu)})`,
    avblastAv: event.rollSomAgerade ?? larm?.avblast_av ?? "",
    kartaUrl: event.kartaUrl ?? KARTA_URL,
    musteringUrl: MUSTERING_URL,
    zonUrl: ZON_URL,
    aktiveringsdatum: datum(nu),
  };
}

module.exports = { byggData, klocka, datum, varaktighet, KARTA_URL, MUSTERING_URL, ZON_URL };
