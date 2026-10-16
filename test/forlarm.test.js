// Självtest av förlarmets scenario — båda ändarna av kedjan.
//
// Buggen 16 oktober: `simulera förlarm` → Bekräfta gav ett BRANDLARM, medan
// kamerans förlarm → Bekräfta gav inrymning. Två vägar, två utfall, samma
// knapp.
//
// Scenariot tappades aldrig. Bekräfta tog det troget ur larmraden hela
// tiden — det var simuleringen som skrev `brand` i förlarmet från början.
// Kameran skriver `inrymning`, som den ska.
//
// Varför det spelar roll: ett brandlarm säger spring ut, en inrymning säger
// stanna inne och lås dörren. Att skicka fel är inte ett skönhetsfel.

const test = require("node:test");
const assert = require("node:assert");

const { VARIANTER } = require("../src/bot/bot");
const { scenarioFrån } = require("../src/actions/execute");

test("simulera förlarm ger ett inrymningsförlarm, inte brand", () => {
  assert.strictEqual(VARIANTER.forlarm.scenario, "inrymning");
  assert.strictEqual(VARIANTER.forlarm.severity, "prealarm");
});

test("förlarm och inrymning är samma sak — en sorts förlarm finns", () => {
  assert.strictEqual(VARIANTER.forlarm.scenario, VARIANTER.inrymning.scenario);
  assert.strictEqual(VARIANTER.forlarm.severity, VARIANTER.inrymning.severity);
});

test("brandlarmet är fortfarande brand och aktivt", () => {
  assert.strictEqual(VARIANTER.brandlarm.scenario, "brand");
  assert.strictEqual(VARIANTER.brandlarm.severity, "active");
  assert.strictEqual(VARIANTER.trigger.scenario, "brand");
  assert.strictEqual(VARIANTER.ovning.scenario, "brand");
  assert.strictEqual(VARIANTER.ovning.test, true);
});

test("Bekräfta tar scenariot ur larmraden, ordagrant", () => {
  assert.strictEqual(scenarioFrån({ scenario: "inrymning" }), "inrymning");
  assert.strictEqual(scenarioFrån({ scenario: "brand" }), "brand");
  // Inget normaliseras och inget tolkas om: står det något annat i raden
  // går det ut som det står, och väljMall avgör kortet.
  assert.strictEqual(scenarioFrån({ scenario: "utrymning" }), "utrymning");
});

test("saknat scenario ger null — aldrig en gissning", () => {
  for (const rad of [{}, { scenario: "" }, { scenario: "   " }, { scenario: null },
    { scenario: undefined }, null, undefined]) {
    assert.strictEqual(scenarioFrån(rad), null,
      `gissade på ${JSON.stringify(rad)}`);
  }
});

test("whitespace runt scenariot trimmas bort", () => {
  assert.strictEqual(scenarioFrån({ scenario: " inrymning " }), "inrymning");
});
