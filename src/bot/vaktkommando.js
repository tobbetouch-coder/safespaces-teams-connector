// Tolkningen och texten för `vakt`. Ren logik, ingen Teams-tur och ingen
// databas — allt här går att prova med node --test.
const { klocka } = require("../util/tid");

// "på" med ring är det rätta ordet, men ingen skriver ringar på ett
// telefontangentbord i en monter. "pa" ska betyda samma sak.
const PÅ = new Set(["på", "pa", "on", "till"]);
const AV = new Set(["av", "off", "från", "fran"]);

const FÄLT = {
  kamera: { kolumn: "kamera_aktiv", etikett: "Kamera" },
  knappar: { kolumn: "knappar_aktiva", etikett: "Knappar" },
};

const HJÄLP =
  "Använd: `vakt` för att se läget, `vakt kamera på|av` eller "
  + "`vakt knappar på|av` för att ändra det.\n\n"
  + "**Kamera** styr om kameraanalysen får ge förlarm. **Knappar** styr om "
  + "nödknappen och brandlarmcentralen får larma. Ett pågående larm går alltid "
  + "att avsluta, oavsett läge.";

/**
 * "vakt" → {visa:true}
 * "vakt kamera på" → {fält:"kamera", värde:true}
 * allt annat → null, vilket ger hjälptext.
 *
 * Samma regel som `simulera`: okända eller extra ord ger hjälptext, aldrig en
 * gissning. Att av misstag slå AV knapparna i en monter är precis den sortens
 * fel ett slarvigt skrivet kommando inte ska kunna orsaka.
 */
function tolkaVakt(text) {
  const ord = String(text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (ord[0] !== "vakt") return null;
  if (ord.length === 1) return { visa: true };
  if (ord.length !== 3) return null;

  const fält = FÄLT[ord[1]];
  if (!fält) return null;
  if (PÅ.has(ord[2])) return { fält: ord[1], värde: true };
  if (AV.has(ord[2])) return { fält: ord[1], värde: false };
  return null;
}

const pånoff = (v) => (v ? "på" : "av");

/** "Kamera: av · Knappar: på · ändrat 21:14" */
function formateraVakt(rad) {
  const delar = [
    `Kamera: ${pånoff(rad?.kamera_aktiv)}`,
    `Knappar: ${pånoff(rad?.knappar_aktiva)}`,
  ];
  const tid = rad?.uppdaterad ? klocka(rad.uppdaterad) : "";
  delar.push(tid ? `ändrat ${tid}` : "aldrig ändrat");
  return delar.join(" · ");
}

// Står under varje ändring, inte under avläsningen: den som just slagit på
// kameran ska veta både att det tar några sekunder och vad spärren gör, utan
// att behöva fråga.
const GENOMSLAG =
  "Slår igenom på Site Connect inom några sekunder. Kameran ger högst ett "
  + "förlarm per 3 minuter och inget medan ett larm är öppet.";

module.exports = { tolkaVakt, formateraVakt, FÄLT, HJÄLP, GENOMSLAG, PÅ, AV };
