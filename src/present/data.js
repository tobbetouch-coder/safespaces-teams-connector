// Ett ställe som binder eventet och routingraden till mallarnas fält. Delas av
// presentEvent, lägeskortet och knapphanteraren så att samma larm alltid visar
// samma ord — och samma ord som Cloud-skivan läser ur alarms-raden.
const { klocka, datum, varaktighet } = require("../util/tid");
const { scenarioEtikett } = require("../util/etiketter");

const KARTA_URL = process.env.UTRYMNINGSKARTA_URL ?? "https://tower.co-ideation.com/safespaces/utrymningskarta";
const MUSTERING_URL = process.env.MUSTERING_URL ?? "https://tower.co-ideation.com/safespaces/mustering";
const ZON_URL = process.env.ZON_URL ?? "https://tower.co-ideation.com/safespaces/min-zon";

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
