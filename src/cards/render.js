// Renderar en mall med data och lägger på de knappar mottagarens roll faktiskt får använda.
// Knappsynligheten är steg 1 i default deny: syns inte knappen kan den inte tryckas.
const fs = require("node:fs");
const path = require("node:path");

const MALLAR = ["larm", "aktivt", "forlarm", "avblast", "ovning", "valkomst", "placeholder"];
const cache = new Map();

function mall(namn) {
  if (!MALLAR.includes(namn)) throw new Error(`okänd mall: ${namn}`);
  if (!cache.has(namn)) cache.set(namn, fs.readFileSync(path.join(__dirname, `${namn}.json`), "utf8"));
  return JSON.parse(cache.get(namn));
}

// Rubrikbanden följer kortspecifikationen: BRANDLARM, FÖRLARM, FARAN ÖVER.
const RUBRIKBAND = { larm: "BRANDLARM", aktivt: "BRANDLARM", forlarm: "FÖRLARM", avblast: "FARAN ÖVER", ovning: "ÖVNING" };

const KNAPP = {
  confirm: { titel: "Bekräfta", stil: "positive" },
  dismiss: { titel: "Avfärda", stil: "default" },
  standdown: { titel: "Avblås", stil: "destructive" },
};

/** Vilken mall ett event ska renderas med. test:true vinner alltid, så övning aldrig misstas för skarpt. */
function väljMall(event) {
  if (event.test === true || event.test === "true") return "ovning";
  const s = String(event.scenario ?? "").toLowerCase();
  const sev = String(event.severity ?? "").toLowerCase();
  if (sev === "cleared" || s.includes("clear") || s.includes("avblås")) return "avblast";
  if (sev === "prealarm" || s.includes("förlarm") || s.includes("prealarm")) return "forlarm";
  if (sev === "active") return "aktivt";
  return "larm";
}

function fyll(nod, data) {
  if (typeof nod === "string") return nod.replace(/\{\{(\w+)\}\}/g, (_, k) => (data[k] ?? ""));
  if (Array.isArray(nod)) return nod.map((n) => fyll(n, data));
  if (nod && typeof nod === "object") return Object.fromEntries(Object.entries(nod).map(([k, v]) => [k, fyll(v, data)]));
  return nod;
}

/**
 * @param {string} mallNamn
 * @param {object} data fälten som mallen binder mot
 * @param {string[]} tillåtnaActions åtgärder mottagarens roll får utföra
 */
function rendera(mallNamn, data, tillåtnaActions = []) {
  const kort = fyll(mall(mallNamn), { ...data, rubrikband: data.rubrikband ?? RUBRIKBAND[mallNamn] ?? "" });
  // Terminalkort och välkomst bär aldrig knappar.
  const knappbara = ["larm", "aktivt", "forlarm", "ovning"].includes(mallNamn);
  if (knappbara && tillåtnaActions.length) {
    kort.actions = tillåtnaActions.map((action) => ({
      type: "Action.Execute",
      title: KNAPP[action].titel,
      style: KNAPP[action].stil,
      verb: action,
      data: { correlationId: data.correlationId, zone: data.zon, site: data.site, action },
    }));
  }
  return kort;
}

/** Kort som ersätter originalet när trycket avvisas eller är på väg. Alltid ett riktigt kort, aldrig en bubbla. */
function statuskort(rubrik, text, data = {}) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: rubrik, weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text, wrap: true },
      ...(data.correlationId ? [{ type: "TextBlock", text: `Larm ${data.correlationId}`, size: "Small", isSubtle: true }] : []),
    ],
  };
}

module.exports = { rendera, väljMall, statuskort, RUBRIKBAND, MALLAR };
