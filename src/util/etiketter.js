// Visningsetiketter. Speglar tavlans src/lib/etiketter.ts — Teams och tavlan
// ska säga samma ord om samma rad.
//
// KONTRAKT.md avsnitt 2 skickar scenario i gemener: brand · inrymning ·
// utrymning · annat. Det är datan, och den ska vara exakt så. Versaliseringen
// hör hit, i visningslagret. Lägg aldrig versaler i det som skrivs till
// alarms — matchningsvärden ska inte böjas för att se bra ut.
const SCENARIER = {
  brand: "Brand",
  inrymning: "Inrymning",
  utrymning: "Utrymning",
  annat: "Annat",
};

function storForsta(text) {
  const t = String(text ?? "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Okända värden visas som de kom, med stor första bokstav. Ett scenario vi inte
 * känner igen ska synas på kortet, inte tystas.
 */
function scenarioEtikett(scenario) {
  const ratt = String(scenario ?? "").trim();
  if (!ratt) return "";
  return SCENARIER[ratt.toLowerCase()] ?? storForsta(ratt);
}

module.exports = { scenarioEtikett, SCENARIER };
