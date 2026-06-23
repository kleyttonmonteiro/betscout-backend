const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_FOOTBALL_KEY || "4283613a9df421f35d51f9b1f4b9576c";
const API_HOST = "v3.football.api-sports.io";

const headers = {
  "x-apisports-key": API_KEY,
};

// Jogos ao vivo
app.get("/api/live", async (req, res) => {
  try {
    const response = await axios.get(`https://${API_HOST}/fixtures?live=all`, { headers });
    const fixtures = response.data.response || [];

    const matches = fixtures.map((f) => ({
      id: f.fixture.id,
      league: f.league.name,
      country: f.league.country,
      logo: f.league.logo,
      home: f.teams.home.name,
      homeLogo: f.teams.home.logo,
      away: f.teams.away.name,
      awayLogo: f.teams.away.logo,
      score_home: f.goals.home ?? 0,
      score_away: f.goals.away ?? 0,
      minute: f.fixture.status.elapsed ?? 0,
      status: f.fixture.status.short,
      statusLong: f.fixture.status.long,
    }));

    res.json({ ok: true, matches, total: matches.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Estatísticas de um jogo
app.get("/api/stats/:fixtureId", async (req, res) => {
  try {
    const { fixtureId } = req.params;
    const response = await axios.get(
      `https://${API_HOST}/fixtures/statistics?fixture=${fixtureId}`,
      { headers }
    );
    const data = response.data.response || [];

    if (data.length < 2) {
      return res.json({ ok: true, stats: null });
    }

    const get = (arr, type) => {
      const item = arr.find((s) => s.type === type);
      return parseInt(item?.value) || 0;
    };

    const homeStats = data[0].statistics;
    const awayStats = data[1].statistics;

    const stats = {
      shots_home: get(homeStats, "Total Shots"),
      shots_away: get(awayStats, "Total Shots"),
      shots_on_home: get(homeStats, "Shots on Goal"),
      shots_on_away: get(awayStats, "Shots on Goal"),
      dangerous_home: get(homeStats, "Dangerous Attacks"),
      dangerous_away: get(awayStats, "Dangerous Attacks"),
      attacks_home: get(homeStats, "Attacks"),
      attacks_away: get(awayStats, "Attacks"),
      possession_home: get(homeStats, "Ball Possession"),
      possession_away: get(awayStats, "Ball Possession"),
      corners_home: get(homeStats, "Corner Kicks"),
      corners_away: get(awayStats, "Corner Kicks"),
    };

    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "BetScout backend online ✅" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`BetScout backend rodando na porta ${PORT}`));
