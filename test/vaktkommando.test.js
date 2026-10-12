// Tolkningen av `vakt`, utan Teams-tur och utan databas — samma sätt som
// `tolka` för simulera är gjord för att gå att prova.
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");

const { tolkaVakt, formateraVakt } = require("../src/bot/vaktkommando");

test("vakt utan argument visar läget", () => {
  assert.deepEqual(tolkaVakt("vakt"), { visa: true });
  assert.deepEqual(tolkaVakt("  VAKT  "), { visa: true });
});

test("vakt kamera och knappar på och av", () => {
  assert.deepEqual(tolkaVakt("vakt kamera på"), { fält: "kamera", värde: true });
  assert.deepEqual(tolkaVakt("vakt kamera av"), { fält: "kamera", värde: false });
  assert.deepEqual(tolkaVakt("vakt knappar på"), { fält: "knappar", värde: true });
  assert.deepEqual(tolkaVakt("vakt knappar av"), { fält: "knappar", värde: false });
});

test("pa utan ring betyder på — ingen skriver ringar i en monter", () => {
  assert.deepEqual(tolkaVakt("vakt kamera pa"), { fält: "kamera", värde: true });
  assert.deepEqual(tolkaVakt("VAKT KNAPPAR PA"), { fält: "knappar", värde: true });
});

test("okända och extra ord ger hjälptext, aldrig en gissning", () => {
  // Att av misstag slå AV knapparna i en monter är precis det ett slarvigt
  // skrivet kommando inte ska kunna orsaka.
  for (const rad of [
    "vakt kamera",
    "vakt kamera på av",
    "vakt kameran på",
    "vakt kamera kanske",
    "vakt allt av",
    "vaktmästare",
    "simulera vakt kamera av",
    "",
  ]) {
    assert.equal(tolkaVakt(rad), null, `"${rad}" skulle ge null`);
  }
});

test("formateringen visar båda fälten och när det ändrades", () => {
  const rad = {
    kamera_aktiv: false,
    knappar_aktiva: true,
    uppdaterad: "2026-10-13T19:14:00+00:00",
  };
  const text = formateraVakt(rad);
  assert.match(text, /^Kamera: av · Knappar: på · ändrat \d\d:\d\d$/);
  // Svensk tid, inte UTC: 19:14 UTC är 21:14 i Stockholm i oktober.
  assert.match(text, /21:14/);
});

test("en rad som aldrig ändrats säger det i stället för att visa tom tid", () => {
  assert.equal(
    formateraVakt({ kamera_aktiv: true, knappar_aktiva: false, uppdaterad: null }),
    "Kamera: på · Knappar: av · aldrig ändrat",
  );
});

test("saknad rad läses som standardläget, inte som fel", () => {
  // Så här ser svaret ut när site_settings är tom: kameran av, knapparna på.
  assert.equal(formateraVakt(undefined), "Kamera: av · Knappar: av · aldrig ändrat");
  assert.equal(
    formateraVakt({ kamera_aktiv: false, knappar_aktiva: true }),
    "Kamera: av · Knappar: på · aldrig ändrat",
  );
});
