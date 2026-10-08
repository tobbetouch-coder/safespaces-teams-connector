// Bygger deploy-flex.zip för zip-deploy till func-safespaces-flex.
//   npm ci --omit=dev && npm run paketera && npm run deploy
//
// node_modules följer MED i paketet. Fjärrbygget gav 8 oktober en "lyckad"
// deploy som ändå installerade noll beroenden: varje require föll, noll
// funktioner registrerades och appen svarade 404 på allt. Vi packar själva.
//
// Zip:en skrivs utan @azure/functions' egna krav på en viss layout — host.json
// och package.json i roten, src/ och node_modules/ under den.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROT = path.resolve(__dirname, "..");
const UT = path.join(ROT, "deploy-flex.zip");

// Gäller bara i roten: en katalog som heter scripts djupt inne i node_modules
// ska följa med.
const UTE_KATALOG = new Set([".git", ".vscode", "__pycache__", "scripts", "supabase"]);
const UTE_FIL = new Set([
  "local.settings.json", "local.settings.json.exempel",
  "deploy.zip", "deploy-flex.zip", "README.md", ".gitignore", ".funcignore",
]);

function filer(katalog, iRoten = false) {
  const ut = [];
  for (const post of fs.readdirSync(katalog, { withFileTypes: true })) {
    if (post.isDirectory()) {
      if (iRoten && UTE_KATALOG.has(post.name)) continue;
      ut.push(...filer(path.join(katalog, post.name)));
    } else if (!(iRoten && UTE_FIL.has(post.name)) && !UTE_FIL.has(post.name)) {
      ut.push(path.join(katalog, post.name));
    }
  }
  return ut;
}

if (!fs.existsSync(path.join(ROT, "node_modules", "botbuilder"))) {
  console.error("node_modules saknas eller är ofullständig. Kör: npm ci --omit=dev");
  process.exit(1);
}

const lista = filer(ROT, true).map((f) => path.relative(ROT, f).split(path.sep).join("/"));
const listfil = path.join(ROT, ".paketera-filer.txt");
fs.writeFileSync(listfil, lista.join("\n"), "utf8");
fs.rmSync(UT, { force: true });

// Windows egen bsdtar hanterar både drivbokstäver och sökvägar förbi 260
// tecken, vilket nästlade node_modules går långt över. Full sökväg, eftersom
// Git Bash lägger GNU-tar först i PATH och den tolkar "C:" som en fjärrvärd.
const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";
try {
  execFileSync(TAR, ["-a", "-c", "-f", UT, "-C", ROT, "-T", listfil], { stdio: "inherit" });
} finally {
  fs.rmSync(listfil, { force: true });
}

const mb = (fs.statSync(UT).size / 1048576).toFixed(1);
console.log(`deploy-flex.zip: ${lista.length} filer, ${mb} MB`);
console.log("Deploya med: npm run deploy");
console.log("Verifiera sedan /admin/functions — en lyckad deploy betyder inte att appen kör.");
