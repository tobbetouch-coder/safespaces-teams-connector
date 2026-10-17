// Demokunden stavas NoName — versalt N i mitten. Rättat 17 oktober.
//
// Två saker som kan gå sönder av just den här rättningen, och som båda är
// tysta:
//
//   1. **Slugen.** Connectorn härleder `site` ur byggnadsnamnet. Hade
//      slugify börjat ge "no-name-stockholm" skulle routingen inte hitta
//      någon rad, och korten hade slutat gå ut — utan felmeddelande, för
//      en tom routing ser ut som en zon ingen prenumererar på.
//   2. **Stavningen själv.** Den syns inte i en kodgranskning, bara på
//      kortet i Teams.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { slugify } = require("../src/util/slug.js");

test("NoName ger samma slug som förut", () => {
  assert.strictEqual(slugify("NoName Stockholm"), "noname-stockholm");
  assert.strictEqual(slugify("NoName School"), "noname-school");
  assert.strictEqual(slugify("NoName Hospital"), "noname-hospital");
});

test("ingen gammal stavning kvar i koden", () => {
  const fel = new RegExp("No" + "name");
  const traffar = [];
  const gå = (katalog) => {
    for (const post of fs.readdirSync(katalog, { withFileTypes: true })) {
      if (post.name === "node_modules" || post.name.startsWith(".")) continue;
      const vag = path.join(katalog, post.name);
      if (post.isDirectory()) gå(vag);
      else if (/\.(js|json|md)$/.test(post.name)) {
        fs.readFileSync(vag, "utf8")
          .split("\n")
          .forEach((rad, i) => {
            if (fel.test(rad)) traffar.push(`${vag}:${i + 1}`);
          });
      }
    }
  };
  gå(path.join(__dirname, ".."));
  assert.deepStrictEqual(traffar, [], `fel stavning:\n${traffar.join("\n")}`);
});
