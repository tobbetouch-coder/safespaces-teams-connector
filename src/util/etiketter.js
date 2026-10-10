// Visningsetiketter. Speglar tavlans src/lib/etiketter.ts — Teams och tavlan
// ska säga samma ord om samma rad.
//
// KONTRAKT.md avsnitt 2 skickar scenario i gemener: brand · inrymning ·
// utrymning · annat. Det är datan, och den ska vara exakt så. Versaliseringen
// hör hit, i visningslagret. Lägg aldrig versaler i det som skrivs till
// alarms — matchningsvärden ska inte böjas för att se bra ut.
// Kallorna ur kontraktet avsnitt 2, i gemener. api ar kameraanalysen —
// "Api" pa ett larmkort sager ingenting for den som laser det.
const KALLOR = {
  api: "Kameraanalys",
  brandlarmcentral: "Brandlarmcentral",
  manuell: "Manuell",
  passersystem: "Passersystem",
};

const SCENARIER = {
  brand: "Brand",
  inrymning: "Inrymning",
  utrymning: "Utrymning",
  annat: "Annat",
  // Kameraanalysens flagga. Rod som ett aktivt larm pa tavlan, men den ger
  // aldrig nagot Teams-kort — se cards/render.js UTAN_KORT.
  fara: "Fara",
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

/** Okand kalla visas som den kom, med stor forsta bokstav. */
function kallaEtikett(kalla) {
  const ratt = String(kalla ?? "").trim();
  if (!ratt) return "";
  return KALLOR[ratt.toLowerCase()] ?? storForsta(ratt);
}

module.exports = { scenarioEtikett, kallaEtikett, SCENARIER, KALLOR };
