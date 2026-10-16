// Självtest av "Visa kamera"-knappen på förlarmskortet.
//
// Den som ska bedöma om ett förlarm är skarpt behöver se bilden, inte gissa.
// Knappen är en Action.OpenUrl mot kamerans egen adress, och URL:en kommer ur
// en app-inställning per zon — KAMERA_LOBBY, KAMERA_OFFICES_2F och så vidare.
//
// Tre saker kan gå fel, och alla tre är tysta:
//
//   1. **Knappen saknas** när inställningen finns. Då står den som ska
//      bedöma utan bild och trycker Bekräfta på magkänsla.
//   2. **Knappen finns utan adress.** En knapp som leder ingenstans är värre
//      än ingen knapp: den som trycker tror att något är trasigt i stunden
//      då det är som mest bråttom.
//   3. **Knappen hamnar på fel kort.** Ett brandlarm som redan är bekräftat
//      ska inte bjuda in till att titta på en kamerabild i stället för att
//      utrymma.

const test = require("node:test");
const assert = require("node:assert");

const { rendera } = require("../src/cards/render");

const KAMERA = "http://192.168.11.9/axis-cgi/mjpg/video.cgi";

function basdata(extra = {}) {
  return {
    byggnad: "Noname Stockholm",
    zon: "Lobby",
    zonNyckel: "lobby",
    site: "noname-stockholm",
    correlationId: "cid-1",
    larmId: "261016-001",
    klockslag: "11:34",
    kalla: "api",
    ...extra,
  };
}

function knappar(kort) {
  return (kort.actions ?? []).map((a) => `${a.type}:${a.title}`);
}

function kameraknapp(kort) {
  return (kort.actions ?? []).find((a) => a.type === "Action.OpenUrl"
    && String(a.title).includes("Visa kamera"));
}

test("förlarmskortet får kameraknappen när zonen har en URL", () => {
  const kort = rendera("forlarm", basdata({ kameraUrl: KAMERA }), ["confirm", "dismiss"]);
  const knapp = kameraknapp(kort);
  assert.ok(knapp, `ingen kameraknapp bland: ${knappar(kort).join(", ")}`);
  assert.strictEqual(knapp.type, "Action.OpenUrl");
  assert.strictEqual(knapp.url, KAMERA);
});

test("rollknapparna finns kvar bredvid kameraknappen", () => {
  const kort = rendera("forlarm", basdata({ kameraUrl: KAMERA }), ["confirm", "dismiss"]);
  const titlar = knappar(kort);
  assert.ok(titlar.some((t) => t.includes("Bekräfta")), titlar.join(", "));
  assert.ok(titlar.some((t) => t.includes("Avfärda")), titlar.join(", "));
  // Bedömningen är kortets uppgift. Kameran är ett stöd, inte huvudsaken —
  // den ska ligga efter knapparna som faktiskt fattar beslutet.
  assert.strictEqual(titlar[titlar.length - 1].includes("Visa kamera"), true);
});

test("ingen kameraknapp när zonen saknar URL", () => {
  for (const varde of [undefined, null, "", "   "]) {
    const kort = rendera("forlarm", basdata({ kameraUrl: varde }), ["confirm", "dismiss"]);
    assert.strictEqual(kameraknapp(kort), undefined,
      `kameraknapp dök upp för ${JSON.stringify(varde)}`);
  }
});

test("kameraknappen hamnar bara på förlarmskortet", () => {
  for (const mall of ["aktivt", "larm", "avblast", "inrymning", "ovning"]) {
    const kort = rendera(mall, basdata({ kameraUrl: KAMERA }), ["standdown"]);
    assert.strictEqual(kameraknapp(kort), undefined,
      `kameraknapp dök upp på mallen ${mall}`);
  }
});

test("kortet är fortfarande ett giltigt AdaptiveCard", () => {
  const kort = rendera("forlarm", basdata({ kameraUrl: KAMERA }), ["confirm", "dismiss"]);
  assert.strictEqual(kort.type, "AdaptiveCard");
  assert.ok(Array.isArray(kort.body) && kort.body.length > 0);
  // Varje action måste ha de fält Teams kräver, annars renderas kortet inte alls.
  for (const a of kort.actions) {
    assert.ok(a.type && a.title, JSON.stringify(a));
    if (a.type === "Action.OpenUrl") assert.ok(a.url, JSON.stringify(a));
    if (a.type === "Action.Execute") assert.ok(a.verb, JSON.stringify(a));
  }
});

test("adressen tas ordagrant — ingen omskrivning av URL:en", () => {
  // Faller mjpg-strömmen i en mobilwebbläsare är reserven kamerans rotsida.
  // Båda ska gå fram som de står, utan att koden lägger till eller tar bort.
  for (const url of [KAMERA, "http://192.168.11.9/", "http://192.168.11.9:8080/annat?x=1"]) {
    const kort = rendera("forlarm", basdata({ kameraUrl: url }), []);
    assert.strictEqual(kameraknapp(kort).url, url);
  }
});
