// Hälsokoll för egressen mot Safe Spaces-Supabase. Kräver funktionsnyckel, alltså
// inte öppen för världen. Finns för att kunna särskilja nätverksfel från kodfel.
const { app } = require("@azure/functions");
const { pinga } = require("../store/mustering");

app.http("health-supabase", {
  methods: ["GET"],
  authLevel: "function",
  route: "health/supabase",
  handler: async () => {
    try {
      const r = await pinga();
      return { status: 200, jsonBody: { supabase: "nåbar", ...r } };
    } catch (err) {
      return { status: 503, jsonBody: { supabase: "onåbar", fel: String(err.message).slice(0, 300) } };
    }
  },
});
