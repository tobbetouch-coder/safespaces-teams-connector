// Slug-regeln är KONTRAKT.md avsnitt 1, ordagrant samma som bryggans slugify i
// edge/site-connect-bridge/mappning.py. De två måste ge samma svar: bryggan
// skriver zon_nyckel, connectorn härleder site ur byggnad, och matchar de inte
// hittar routingen ingen rad.
//
//   gemener · å/ä -> a, ö -> o · allt som inte är a-z0-9 -> bindestreck
//   inga dubbla eller kantliggande streck
//
//   "Noname Stockholm" -> "noname-stockholm"
//   "Källaren Öst"     -> "kallaren-ost"
function slugify(text) {
  if (!text) return "";
  let t = String(text).trim().toLowerCase();
  t = t.replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o");
  t = t.replace(/æ/g, "ae").replace(/ø/g, "o").replace(/ü/g, "u");
  // Övriga diakriter bort: é -> e.
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/[^a-z0-9]+/g, "-");
  return t.replace(/^-+|-+$/g, "");
}

module.exports = { slugify };
