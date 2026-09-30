// All tid som visas för en människa räknas i svensk tid. Databasen lagrar UTC —
// ISO-strängens tecken 11–16 är därför fel klockslag, och dess datum fel dygn
// mellan midnatt och 02 (03 i sommartid). Det slog mot larm-id:t och mot Tid på
// larmkortet natten till 2026-10-01.
const TIDSZON = process.env.TIDSZON ?? "Europe/Stockholm";

const när = (v) => (v instanceof Date ? v : new Date(v ?? Date.now()));

/** "14:02" i svensk tid. Tom sträng när värdet inte går att tolka. */
function klocka(v) {
  const d = när(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("sv-SE", { timeZone: TIDSZON, hour: "2-digit", minute: "2-digit" });
}

/** "2026-10-01" i svensk tid. */
function datum(v) {
  const d = när(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("sv-SE", { timeZone: TIDSZON });
}

/** "261001" — dygnet i larm-id:t YYMMDD-NNN, räknat svenskt. */
const dygn = (v) => datum(v).slice(2).replace(/-/g, "");

/** Skillnaden mellan två tidpunkter som "17 min" eller "1 h 05 min". */
function varaktighet(från, till) {
  const ms = när(till).getTime() - när(från).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.max(1, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

module.exports = { klocka, datum, dygn, varaktighet, TIDSZON };
