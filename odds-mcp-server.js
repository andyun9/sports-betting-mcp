#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Supabase — only required for bet logger tools
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } })
  : null;
console.error('[startup] Supabase client:', supabase ? `initialized (URL: ${process.env.SUPABASE_URL})` : 'NOT initialized — missing env vars');

function requireSupabase() {
  if (!supabase) throw new Error('Bet logger unavailable: SUPABASE_URL and SUPABASE_KEY env vars not set.');
  return supabase;
}

const API_KEY = '6839cf3576edc840d160c633c6f8eedf';
const BASE_URL = 'https://api.the-odds-api.com/v4';
const SPORT_KEYS = { nba: 'basketball_nba', mlb: 'baseball_mlb', nfl: 'american_football_nfl' };
const BOOKMAKERS = 'fanduel,draftkings,betmgm';
const REGIONS = 'us';

function resolveSport(league) {
  const key = SPORT_KEYS[(league || 'nba').toLowerCase()];
  if (!key) throw new Error(`Unsupported league "${league}". Use "nba", "mlb", or "nfl".`);
  return key;
}

const BOOK_LABELS = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM' };
const MARKET_LABELS = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };
const PROP_LABELS = {
  // NBA
  player_points: 'Points',
  player_rebounds: 'Rebounds',
  player_assists: 'Assists',
  player_threes: '3-Pointers Made',
  player_blocks: 'Blocks',
  player_steals: 'Steals',
  player_points_alternate: 'Points (Alt)',
  player_rebounds_alternate: 'Rebounds (Alt)',
  player_assists_alternate: 'Assists (Alt)',
  // MLB batters
  batter_hits: 'Hits',
  batter_total_bases: 'Total Bases',
  batter_rbis: 'RBIs',
  batter_runs_scored: 'Runs Scored',
  batter_home_runs: 'Home Runs',
  batter_strikeouts: 'Strikeouts (Batter)',
  batter_hits_alternate: 'Hits (Alt)',
  batter_total_bases_alternate: 'Total Bases (Alt)',
  batter_home_runs_alternate: 'Home Runs (Alt)',
  // MLB pitchers
  pitcher_strikeouts: 'Strikeouts (Pitcher)',
  pitcher_hits_allowed: 'Hits Allowed',
  pitcher_strikeouts_alternate: 'Strikeouts (Pitcher Alt)',
  // NFL
  player_pass_yds: 'Pass Yards',
  player_pass_tds: 'Pass TDs',
  player_pass_completions: 'Completions',
  player_pass_interceptions: 'Interceptions',
  player_rush_yds: 'Rush Yards',
  player_receptions: 'Receptions',
  player_reception_yds: 'Receiving Yards',
  player_reception_tds: 'Receiving TDs',
  player_kicking_points: 'Kicking Points',
};

function fmt(price) {
  return price > 0 ? `+${price}` : String(price);
}

function fmtPoint(point) {
  if (point === undefined || point === null) return '';
  return point > 0 ? `+${point}` : String(point);
}

async function oddsApiRequest(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apiKey', API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString());
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OddsAPI ${res.status}: ${text}`);
  }

  const data = await res.json();
  return { data, remaining, used };
}

// ── Tool: get_odds ──────────────────────────────────────────────────────────

function formatOddsGames(games, league = 'NBA') {
  if (!games || games.length === 0) return `No ${league.toUpperCase()} games found.`;

  return games.map(game => {
    const { id, home_team: home, away_team: away, commence_time, bookmakers = [] } = game;
    const time = new Date(commence_time).toLocaleString('en-US', { timeZoneName: 'short' });

    const lines = { h2h: {}, spreads: {}, totals: {} };
    for (const bm of bookmakers) {
      for (const market of bm.markets || []) {
        if (lines[market.key]) lines[market.key][bm.key] = market.outcomes;
      }
    }

    let out = `${away} @ ${home}\nGame Time: ${time}\nEvent ID: ${id}\n`;

    out += '\nMoneyline:\n';
    for (const [book, outcomes] of Object.entries(lines.h2h)) {
      const aw = outcomes?.find(o => o.name === away)?.price;
      const hw = outcomes?.find(o => o.name === home)?.price;
      out += `  ${BOOK_LABELS[book] ?? book}: ${away} ${fmt(aw)} | ${home} ${fmt(hw)}\n`;
    }

    out += '\nSpread:\n';
    for (const [book, outcomes] of Object.entries(lines.spreads)) {
      const aw = outcomes?.find(o => o.name === away);
      const hw = outcomes?.find(o => o.name === home);
      out += `  ${BOOK_LABELS[book] ?? book}: ${away} ${fmtPoint(aw?.point)} (${fmt(aw?.price)}) | ${home} ${fmtPoint(hw?.point)} (${fmt(hw?.price)})\n`;
    }

    out += '\nTotal:\n';
    for (const [book, outcomes] of Object.entries(lines.totals)) {
      const ov = outcomes?.find(o => o.name === 'Over');
      const un = outcomes?.find(o => o.name === 'Under');
      out += `  ${BOOK_LABELS[book] ?? book}: O${ov?.point} (${fmt(ov?.price)}) | U${un?.point} (${fmt(un?.price)})\n`;
    }

    return out;
  }).join('\n' + '─'.repeat(50) + '\n');
}

async function handleGetOdds(args) {
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);

  const params = {
    regions: REGIONS,
    markets: 'h2h,spreads,totals',
    bookmakers: BOOKMAKERS,
    oddsFormat: 'american',
  };
  if (args.date_from) params.commenceTimeFrom = args.date_from;
  if (args.date_to) params.commenceTimeTo = args.date_to;

  const { data, remaining } = await oddsApiRequest(`/sports/${sport}/odds/`, params);

  let games = Array.isArray(data) ? data : [];
  if (args.team) {
    const q = args.team.toLowerCase();
    games = games.filter(g =>
      g.home_team.toLowerCase().includes(q) || g.away_team.toLowerCase().includes(q)
    );
  }

  const header = `${league.toUpperCase()} Odds — FanDuel / DraftKings / BetMGM  (API requests remaining: ${remaining})\n\n`;
  return header + formatOddsGames(games, league);
}

// ── Tool: get_line_movement ─────────────────────────────────────────────────

async function handleGetLineMovement(args) {
  const { event_id } = args;
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);

  const commonParams = {
    regions: REGIONS,
    markets: 'h2h,spreads,totals',
    bookmakers: BOOKMAKERS,
    oddsFormat: 'american',
    eventIds: event_id,
  };

  // Fetch current odds first to get commence_time for the opening snapshot
  const currResult = await oddsApiRequest(`/sports/${sport}/odds/`, commonParams);
  const currGame = Array.isArray(currResult.data) ? currResult.data[0] : null;

  if (!currGame) return `No current odds found for event ${event_id}.`;

  // Use provided date or fall back to game's commence_time (opening line)
  const snapshotDate = args.date || currGame.commence_time;

  const histResult = await oddsApiRequest(`/sports/${sport}/odds-history/`, {
    ...commonParams,
    date: snapshotDate,
  });

  const histGame = Array.isArray(histResult.data)
    ? histResult.data[0]
    : histResult.data?.data?.[0];

  const { home_team: home, away_team: away } = currGame;
  const snapshotLabel = args.date ? `Snapshot: ${snapshotDate}` : `Opening line (${new Date(snapshotDate).toLocaleString('en-US', { timeZoneName: 'short' })})`;
  let out = `Line Movement: ${away} @ ${home}\nEvent ID: ${event_id}\n${snapshotLabel}\n`;

  if (!histGame) {
    out += '\nNote: No historical snapshot found for this date. Try an earlier date.\n';
    out += '\nCurrent odds:\n' + formatOddsGames([currGame]);
    return out;
  }

  for (const currBm of currGame.bookmakers || []) {
    const bookName = BOOK_LABELS[currBm.key] ?? currBm.key;
    const histBm = histGame.bookmakers?.find(b => b.key === currBm.key);
    out += `\n${bookName}:\n`;

    for (const currMarket of currBm.markets || []) {
      const histMarket = histBm?.markets?.find(m => m.key === currMarket.key);
      const label = MARKET_LABELS[currMarket.key] ?? currMarket.key;
      out += `  ${label}:\n`;

      for (const co of currMarket.outcomes || []) {
        const ho = histMarket?.outcomes?.find(o => o.name === co.name);
        let line = `    ${co.name}: `;

        if (co.point !== undefined) {
          const pointMoved = ho?.point !== undefined ? ` → moved ${fmtPoint(co.point - ho.point)}` : '';
          line += `${fmtPoint(co.point)} (was ${ho?.point !== undefined ? fmtPoint(ho.point) : 'N/A'}${pointMoved})  `;
        }

        const priceMoved = ho ? ` → moved ${fmt(co.price - ho.price)}` : '';
        line += `${fmt(co.price)} odds (was ${ho ? fmt(ho.price) : 'N/A'}${priceMoved})`;
        out += line + '\n';
      }
    }
  }

  return out;
}

// ── Tool: get_player_props ──────────────────────────────────────────────────

const DEFAULT_PROPS = {
  nba: 'player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals',
  mlb: 'batter_hits,batter_total_bases,batter_rbis,batter_runs_scored,batter_home_runs,batter_strikeouts,pitcher_strikeouts',
  nfl: 'player_pass_yds,player_pass_tds,player_rush_yds,player_receptions,player_reception_yds',
};

async function handleGetPlayerProps(args) {
  const { event_id, markets } = args;
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);
  const propMarkets = markets || DEFAULT_PROPS[league] || DEFAULT_PROPS.nba;

  const { data, remaining } = await oddsApiRequest(
    `/sports/${sport}/events/${event_id}/odds/`,
    {
      regions: REGIONS,
      markets: propMarkets,
      bookmakers: BOOKMAKERS,
      oddsFormat: 'american',
    }
  );

  if (!data || !data.home_team) return `No player props found for event ${event_id}.`;

  const { home_team: home, away_team: away, commence_time } = data;
  const time = new Date(commence_time).toLocaleString('en-US', { timeZoneName: 'short' });
  let out = `Player Props: ${away} @ ${home}\nGame Time: ${time}\nAPI requests remaining: ${remaining}\n`;

  // Organize: market → player → side → { book: { price, point } }
  const byMarket = {};
  for (const bm of data.bookmakers || []) {
    const bookName = BOOK_LABELS[bm.key] ?? bm.key;
    for (const market of bm.markets || []) {
      if (!byMarket[market.key]) byMarket[market.key] = {};
      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        byMarket[market.key][player] ??= {};
        byMarket[market.key][player][outcome.name] ??= {};
        byMarket[market.key][player][outcome.name][bookName] = {
          price: outcome.price,
          point: outcome.point,
        };
      }
    }
  }

  for (const [marketKey, players] of Object.entries(byMarket)) {
    const marketLabel = PROP_LABELS[marketKey] ?? marketKey;
    out += `\n${'═'.repeat(40)}\n${marketLabel}\n${'═'.repeat(40)}\n`;

    const sorted = Object.entries(players).sort(([a], [b]) => a.localeCompare(b));
    for (const [player, sides] of sorted) {
      out += `\n  ${player}:\n`;
      for (const [side, books] of Object.entries(sides)) {
        const bookParts = Object.entries(books).map(([book, line]) => {
          const pt = line.point !== undefined ? ` ${fmtPoint(line.point)}` : '';
          return `${book}${pt} (${fmt(line.price)})`;
        });
        out += `    ${side}: ${bookParts.join('  |  ')}\n`;
      }
    }
  }

  return out;
}

// ── Tool: get_live_scores ────────────────────────────────────────────────────

function formatScores(games, league) {
  if (!games || games.length === 0) return `No live or recent ${league.toUpperCase()} games found.`;

  return games.map(game => {
    const { id, home_team: home, away_team: away, commence_time, completed, scores, last_update } = game;
    const startTime = new Date(commence_time).toLocaleString('en-US', { timeZoneName: 'short' });
    const updatedAt = last_update ? new Date(last_update).toLocaleString('en-US', { timeZoneName: 'short' }) : 'N/A';
    const status = completed ? 'FINAL' : 'LIVE';

    let out = `[${status}] ${away} @ ${home}\nStarted: ${startTime}\nLast Update: ${updatedAt}\nEvent ID: ${id}\n`;
    if (scores && scores.length > 0) {
      out += 'Score:\n';
      for (const s of scores) out += `  ${s.name}: ${s.score}\n`;
    } else {
      out += 'Score: Not yet available\n';
    }
    return out;
  }).join('\n' + '─'.repeat(50) + '\n');
}

async function handleGetLiveScores(args) {
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);
  const daysFrom = args.days_from ?? 1;

  const { data, remaining } = await oddsApiRequest(`/sports/${sport}/scores/`, { daysFrom });

  let games = Array.isArray(data) ? data : [];
  if (args.team) {
    const q = args.team.toLowerCase();
    games = games.filter(g =>
      g.home_team.toLowerCase().includes(q) || g.away_team.toLowerCase().includes(q)
    );
  }

  const live = games.filter(g => !g.completed);
  const finished = games.filter(g => g.completed);

  let out = `${league.toUpperCase()} Scores  (API requests remaining: ${remaining})\n\n`;

  if (live.length > 0) {
    out += `${'═'.repeat(50)}\nIN PROGRESS (${live.length} game${live.length !== 1 ? 's' : ''})\n${'═'.repeat(50)}\n\n`;
    out += formatScores(live, league);
  } else {
    out += 'No games currently in progress.\n';
  }

  if (finished.length > 0) {
    out += `\n\n${'═'.repeat(50)}\nRECENTLY COMPLETED (${finished.length} game${finished.length !== 1 ? 's' : ''})\n${'═'.repeat(50)}\n\n`;
    out += formatScores(finished, league);
  }

  return out;
}

// ── Tool: get_live_odds ──────────────────────────────────────────────────────
// The Odds API has no /odds-live/ endpoint. Strategy: fetch scores to find
// in-progress event IDs, then fetch odds filtered to those IDs, then merge
// score context into the output.

async function handleGetLiveOdds(args) {
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);

  // Step 1: get in-progress games from scores endpoint
  const { data: scoreData } = await oddsApiRequest(`/sports/${sport}/scores/`, { daysFrom: 1 });
  const allScores = Array.isArray(scoreData) ? scoreData : [];
  const liveScores = allScores.filter(g => !g.completed);

  if (liveScores.length === 0) {
    return `No ${league.toUpperCase()} games currently in progress.`;
  }

  // Step 2: fetch odds filtered to live event IDs
  const liveIds = liveScores.map(g => g.id).join(',');
  const { data: oddsData, remaining } = await oddsApiRequest(`/sports/${sport}/odds/`, {
    regions: REGIONS,
    markets: 'h2h,spreads,totals',
    bookmakers: BOOKMAKERS,
    oddsFormat: 'american',
    eventIds: liveIds,
  });

  let games = Array.isArray(oddsData) ? oddsData : [];

  if (args.team) {
    const q = args.team.toLowerCase();
    games = games.filter(g =>
      g.home_team.toLowerCase().includes(q) || g.away_team.toLowerCase().includes(q)
    );
  }

  if (games.length === 0) {
    return `No live ${league.toUpperCase()} odds available yet for in-progress games.  (API requests remaining: ${remaining})`;
  }

  // Step 3: build score lookup and format with score context
  const scoreById = Object.fromEntries(liveScores.map(g => [g.id, g]));

  const header = `[LIVE] ${league.toUpperCase()} Odds — FanDuel / DraftKings / BetMGM  (API requests remaining: ${remaining})\n\n`;

  const body = games.map(game => {
    const { id, home_team: home, away_team: away, commence_time, bookmakers = [] } = game;
    const startTime = new Date(commence_time).toLocaleString('en-US', { timeZoneName: 'short' });

    // Embed current score if available
    const scoreGame = scoreById[id];
    let scoreStr = '';
    if (scoreGame?.scores?.length) {
      const parts = scoreGame.scores.map(s => `${s.name} ${s.score}`).join(' | ');
      const updated = scoreGame.last_update
        ? new Date(scoreGame.last_update).toLocaleString('en-US', { timeZoneName: 'short' })
        : 'N/A';
      scoreStr = `Score: ${parts}  (as of ${updated})\n`;
    }

    const lines = { h2h: {}, spreads: {}, totals: {} };
    for (const bm of bookmakers) {
      for (const market of bm.markets || []) {
        if (lines[market.key]) lines[market.key][bm.key] = market.outcomes;
      }
    }

    let out = `[LIVE] ${away} @ ${home}\nStarted: ${startTime}\nEvent ID: ${id}\n${scoreStr}`;

    out += '\nMoneyline:\n';
    for (const [book, outcomes] of Object.entries(lines.h2h)) {
      const aw = outcomes?.find(o => o.name === away)?.price;
      const hw = outcomes?.find(o => o.name === home)?.price;
      out += `  ${BOOK_LABELS[book] ?? book}: ${away} ${fmt(aw)} | ${home} ${fmt(hw)}\n`;
    }

    out += '\nSpread:\n';
    for (const [book, outcomes] of Object.entries(lines.spreads)) {
      const aw = outcomes?.find(o => o.name === away);
      const hw = outcomes?.find(o => o.name === home);
      out += `  ${BOOK_LABELS[book] ?? book}: ${away} ${fmtPoint(aw?.point)} (${fmt(aw?.price)}) | ${home} ${fmtPoint(hw?.point)} (${fmt(hw?.price)})\n`;
    }

    out += '\nTotal:\n';
    for (const [book, outcomes] of Object.entries(lines.totals)) {
      const ov = outcomes?.find(o => o.name === 'Over');
      const un = outcomes?.find(o => o.name === 'Under');
      out += `  ${BOOK_LABELS[book] ?? book}: O${ov?.point} (${fmt(ov?.price)}) | U${un?.point} (${fmt(un?.price)})\n`;
    }

    return out;
  }).join('\n' + '─'.repeat(50) + '\n');

  return header + body;
}

// ── Tool: get_live_player_props ──────────────────────────────────────────────

async function handleGetLivePlayerProps(args) {
  const { event_id, markets } = args;
  const league = (args.league || 'nba').toLowerCase();
  const sport = resolveSport(league);
  const propMarkets = markets || DEFAULT_PROPS[league] || DEFAULT_PROPS.nba;

  const { data, remaining } = await oddsApiRequest(
    `/sports/${sport}/events/${event_id}/odds/`,
    {
      regions: REGIONS,
      markets: propMarkets,
      bookmakers: BOOKMAKERS,
      oddsFormat: 'american',
    }
  );

  if (!data || !data.home_team) return `No live player props found for event ${event_id}.`;

  const { home_team: home, away_team: away, commence_time } = data;
  const startTime = new Date(commence_time).toLocaleString('en-US', { timeZoneName: 'short' });
  let out = `[LIVE] Player Props: ${away} @ ${home}\nStarted: ${startTime}\nAPI requests remaining: ${remaining}\n`;

  const byMarket = {};
  for (const bm of data.bookmakers || []) {
    const bookName = BOOK_LABELS[bm.key] ?? bm.key;
    for (const market of bm.markets || []) {
      if (!byMarket[market.key]) byMarket[market.key] = {};
      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        byMarket[market.key][player] ??= {};
        byMarket[market.key][player][outcome.name] ??= {};
        byMarket[market.key][player][outcome.name][bookName] = {
          price: outcome.price,
          point: outcome.point,
        };
      }
    }
  }

  for (const [marketKey, players] of Object.entries(byMarket)) {
    const marketLabel = PROP_LABELS[marketKey] ?? marketKey;
    out += `\n${'═'.repeat(40)}\n${marketLabel}\n${'═'.repeat(40)}\n`;

    const sorted = Object.entries(players).sort(([a], [b]) => a.localeCompare(b));
    for (const [player, sides] of sorted) {
      out += `\n  ${player}:\n`;
      for (const [side, books] of Object.entries(sides)) {
        const bookParts = Object.entries(books).map(([book, line]) => {
          const pt = line.point !== undefined ? ` ${fmtPoint(line.point)}` : '';
          return `${book}${pt} (${fmt(line.price)})`;
        });
        out += `    ${side}: ${bookParts.join('  |  ')}\n`;
      }
    }
  }

  return out;
}

// ── Bet logger helpers ───────────────────────────────────────────────────────

function impliedProb(americanOdds) {
  if (americanOdds === null || americanOdds === undefined || americanOdds === '') return null;
  const odds = parseInt(String(americanOdds).replace(/[^-\d]/g, ''));
  if (isNaN(odds) || odds === 0) return null;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function betPnl(americanOdds, stakeUnits, result) {
  if (result === 'push') return 0;
  if (result === 'loss') return -Math.abs(stakeUnits);
  const odds = parseInt(String(americanOdds).replace(/[^-\d]/g, ''));
  if (isNaN(odds)) return null;
  return odds > 0 ? stakeUnits * (odds / 100) : stakeUnits * (100 / Math.abs(odds));
}

function betClv(betOdds, closingOdds) {
  const bp = impliedProb(betOdds);
  const cp = impliedProb(closingOdds);
  if (bp === null || cp === null) return null;
  return r2((cp - bp) * 100);
}

function r2(n) { return Math.round(n * 100) / 100; }

function buildSummary(bets) {
  const settled = bets.filter(b => b.result !== 'pending');
  const pending  = bets.filter(b => b.result === 'pending');
  const wins   = settled.filter(b => b.result === 'win').length;
  const losses = settled.filter(b => b.result === 'loss').length;
  const pushes = settled.filter(b => b.result === 'push').length;
  const totalPnl = r2(settled.reduce((s, b) => s + (b.pnl_units ?? 0), 0));
  const clvBets  = settled.filter(b => b.clv !== null && b.clv !== undefined);
  const avgClv   = clvBets.length ? r2(clvBets.reduce((s, b) => s + b.clv, 0) / clvBets.length) : 0;

  function groupStats(key) {
    const map = {};
    for (const b of settled) {
      const k = b[key]; if (!k) continue;
      map[k] ??= { wins: 0, losses: 0, pushes: 0, pnl: 0 };
      if (b.result === 'win')  map[k].wins++;
      if (b.result === 'loss') map[k].losses++;
      if (b.result === 'push') map[k].pushes++;
      map[k].pnl += b.pnl_units ?? 0;
    }
    const out = {};
    for (const [label, s] of Object.entries(map)) {
      const total = s.wins + s.losses;
      out[label] = { record: `${s.wins}-${s.losses}${s.pushes ? '-' + s.pushes : ''}`, hit_rate: total ? Math.round(s.wins / total * 100) : 0, pnl: r2(s.pnl) };
    }
    return out;
  }

  const dailyPnl = {};
  for (const b of settled) {
    if (!b.date) continue;
    dailyPnl[b.date] = r2((dailyPnl[b.date] ?? 0) + (b.pnl_units ?? 0));
  }

  return {
    total_bets: settled.length,
    record: `${wins}-${losses}${pushes ? '-' + pushes : ''}`,
    hit_rate_pct: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
    total_pnl_units: totalPnl,
    avg_clv_pct: avgClv,
    pending_count: pending.length,
    by_bet_type: groupStats('bet_type'),
    by_classification: groupStats('classification'),
    clv_positive_bets: clvBets.filter(b => b.clv > 0).length,
    clv_negative_bets: clvBets.filter(b => b.clv < 0).length,
    daily_pnl: dailyPnl,
  };
}

// ── Tool: log_bet ────────────────────────────────────────────────────────────

async function handleLogBet(args) {
  const db = requireSupabase();
  const bet = {
    bet_id: randomUUID(), date: args.date, time_placed: args.time_placed ?? null,
    sport: args.sport, game: args.game, bet_type: args.bet_type,
    classification: args.classification ?? null, line: args.line, odds: args.odds,
    stake_units: args.stake_units, best_book: args.best_book ?? null,
    second_book_checked: args.second_book_checked ?? null, projection: args.projection ?? null,
    fair_line: args.fair_line ?? null, edge_pct: args.edge_pct ?? null,
    playable_to: args.playable_to ?? null, checklist_pct: args.checklist_pct ?? null,
    key_factors: args.key_factors ?? null, risk_flags: args.risk_flags ?? null,
    opening_line: args.opening_line ?? null, closing_line: null, clv: null,
    result: 'pending', pnl_units: null, notes: args.notes ?? null,
  };
  const { data, error } = await db.from('bets').insert(bet).select().single();
  if (error) throw new Error(`Failed to log bet: ${error.message}`);
  return JSON.stringify({ success: true, bet: data }, null, 2);
}

// ── Tool: update_bet ─────────────────────────────────────────────────────────

async function handleUpdateBet(args) {
  const db = requireSupabase();
  const { data: existing, error: fetchErr } = await db.from('bets').select('*').eq('bet_id', args.bet_id).single();
  if (fetchErr || !existing) throw new Error(`Bet not found: ${args.bet_id}`);

  const updates = {};
  if (args.result        !== undefined) updates.result        = args.result;
  if (args.closing_line  !== undefined) updates.closing_line  = args.closing_line;
  if (args.notes         !== undefined) updates.notes         = args.notes;
  if (args.result_detail !== undefined) updates.result_detail = args.result_detail;

  const closingLine = args.closing_line ?? existing.closing_line;
  if (closingLine && existing.odds) updates.clv = betClv(existing.odds, closingLine);

  const result = args.result ?? existing.result;
  if (result && result !== 'pending') updates.pnl_units = r2(betPnl(existing.odds, existing.stake_units, result));

  const { data, error } = await db.from('bets').update(updates).eq('bet_id', args.bet_id).select().single();
  if (error) throw new Error(`Failed to update bet: ${error.message}`);
  return JSON.stringify({ success: true, bet: data }, null, 2);
}

// ── Tool: get_bets ───────────────────────────────────────────────────────────

async function handleGetBets(args) {
  const db = requireSupabase();
  let query = db.from('bets').select('*').order('date', { ascending: false });
  if (args.filter_result         && args.filter_result         !== 'all') query = query.eq('result',         args.filter_result);
  if (args.filter_sport          && args.filter_sport          !== 'all') query = query.eq('sport',          args.filter_sport);
  if (args.filter_bet_type       && args.filter_bet_type       !== 'all') query = query.eq('bet_type',       args.filter_bet_type);
  if (args.filter_classification && args.filter_classification !== 'all') query = query.eq('classification', args.filter_classification);
  query = query.limit(args.limit ?? 50);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to retrieve bets: ${error.message}`);
  return JSON.stringify(data ?? [], null, 2);
}

// ── Tool: get_pending_bets ───────────────────────────────────────────────────

async function handleGetPendingBets() {
  const db = requireSupabase();
  const { data, error } = await db.from('bets').select('*').eq('result', 'pending').order('date', { ascending: false });
  if (error) throw new Error(`Failed to retrieve pending bets: ${error.message}`);
  return JSON.stringify(data ?? [], null, 2);
}

// ── Tool: get_summary ────────────────────────────────────────────────────────

async function handleGetSummary() {
  const db = requireSupabase();
  const { data, error } = await db.from('bets').select('*');
  if (error) throw new Error(`Failed to retrieve bets: ${error.message}`);
  return JSON.stringify(buildSummary(data ?? []), null, 2);
}

// ── Tool: run_50_bet_review ──────────────────────────────────────────────────

async function handleRun50BetReview() {
  const db = requireSupabase();
  const { data, error } = await db.from('bets').select('*');
  if (error) throw new Error(`Failed to retrieve bets: ${error.message}`);

  const settled = (data ?? []).filter(b => b.result !== 'pending');
  const count   = settled.length;

  if (count === 0 || count % 50 !== 0) {
    const next = Math.ceil(Math.max(count + 1, 1) / 50) * 50;
    return JSON.stringify({ ready: false, settled_bets: count, bets_until_review: next - count, next_review_at: next }, null, 2);
  }

  const last50  = settled.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
  const wins    = last50.filter(b => b.result === 'win').length;
  const losses  = last50.filter(b => b.result === 'loss').length;
  const pushes  = last50.filter(b => b.result === 'push').length;
  const totalPnl = r2(last50.reduce((s, b) => s + (b.pnl_units ?? 0), 0));
  const clvBets  = last50.filter(b => b.clv !== null && b.clv !== undefined);
  const avgClv   = clvBets.length ? r2(clvBets.reduce((s, b) => s + b.clv, 0) / clvBets.length) : 0;

  const byType = {};
  for (const b of last50) {
    if (!b.bet_type) continue;
    byType[b.bet_type] ??= { wins: 0, losses: 0, pnl: 0 };
    if (b.result === 'win')  byType[b.bet_type].wins++;
    if (b.result === 'loss') byType[b.bet_type].losses++;
    byType[b.bet_type].pnl += b.pnl_units ?? 0;
  }
  let bestType = null, worstType = null, bestPnl = -Infinity, worstPnl = Infinity;
  for (const [type, s] of Object.entries(byType)) {
    if (s.pnl > bestPnl)  { bestPnl = s.pnl;  bestType = type; }
    if (s.pnl < worstPnl) { worstPnl = s.pnl; worstType = type; }
  }

  let correlation = 'neutral';
  if (clvBets.length >= 10) {
    const pos = clvBets.filter(b => b.clv > 0);
    const neg = clvBets.filter(b => b.clv < 0);
    const posWr = pos.length ? pos.filter(b => b.result === 'win').length / pos.length : 0;
    const negWr = neg.length ? neg.filter(b => b.result === 'win').length / neg.length : 0;
    if      (posWr > negWr + 0.05) correlation = 'positive';
    else if (negWr > posWr + 0.05) correlation = 'negative';
  }

  const hitRate = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
  const rec = [];
  rec.push(totalPnl >= 0 ? `Profitable over the last 50 bets (+${totalPnl}u).` : `Down ${Math.abs(totalPnl)}u over the last 50 bets.`);
  rec.push(hitRate >= 55 ? `Hit rate of ${hitRate}% is above break-even — solid execution.` : hitRate < 50 ? `Hit rate of ${hitRate}% is below 50% — sharpen edge identification.` : `Hit rate of ${hitRate}% near break-even — edge comes from odds quality.`);
  if (avgClv > 0) rec.push(`Positive avg CLV (+${avgClv}%) confirms consistent line-shopping advantage.`);
  if (avgClv < 0) rec.push(`Negative avg CLV (${avgClv}%) — shop earlier or add more books.`);
  if (bestType)                    rec.push(`Best type: ${bestType} (+${r2(bestPnl)}u) — lean in.`);
  if (worstType && worstType !== bestType) rec.push(`Cut or tighten criteria on ${worstType} (${r2(worstPnl)}u).`);
  if (correlation === 'positive')  rec.push('CLV positively correlates with results — process is valid.');
  if (correlation === 'negative')  rec.push('CLV negatively correlating — likely variance, monitor next 50.');

  return JSON.stringify({
    ready: true, bets_reviewed: 50,
    record: `${wins}-${losses}${pushes ? '-' + pushes : ''}`,
    hit_rate_pct: hitRate, total_pnl_units: totalPnl, avg_clv_pct: avgClv,
    best_bet_type: bestType, worst_bet_type: worstType,
    clv_vs_results_correlation: correlation, recommendation: rec.join(' '),
  }, null, 2);
}

// ── Server factory ───────────────────────────────────────────────────────────
// Returns a fully configured Server instance. Called once per stdio session,
// or once per HTTP client session in Railway mode.

function makeServer() {
  const srv = new Server(
    { name: 'sports-betting-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
    {
      name: 'get_odds',
      description:
        'Fetches current spreads, totals, and moneylines for NBA, MLB, or NFL games across FanDuel, DraftKings, and BetMGM. Returns all upcoming games by default; optionally filter by team name or date range.',
      inputSchema: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['nba', 'mlb', 'nfl'],
            description: 'The league to fetch odds for: "nba" (default), "mlb", or "nfl".',
          },
          team: {
            type: 'string',
            description: 'Filter to games involving this team name (partial match). Optional.',
          },
          date_from: {
            type: 'string',
            description: 'Only return games starting on or after this ISO 8601 datetime (e.g. 2025-05-10T00:00:00Z). Optional.',
          },
          date_to: {
            type: 'string',
            description: 'Only return games starting on or before this ISO 8601 datetime. Optional.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_line_movement',
      description:
        'Shows how spreads, totals, and moneylines have moved from open to current for a specific game at FanDuel, DraftKings, and BetMGM. Useful for detecting sharp money and reverse line movement. When no date is provided, automatically compares the opening line (game\'s commence_time) to current. Obtain the event_id from get_odds first.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The OddsAPI event ID for the game. Get this from get_odds.',
          },
          league: {
            type: 'string',
            enum: ['nba', 'mlb', 'nfl'],
            description: 'The league the event belongs to: "nba" (default), "mlb", or "nfl".',
          },
          date: {
            type: 'string',
            description:
              'Optional. ISO 8601 snapshot datetime (e.g. 2025-05-08T12:00:00Z) to compare against current lines. Omit to automatically use the opening line at game\'s commence_time.',
          },
        },
        required: ['event_id'],
      },
    },
    {
      name: 'get_player_props',
      description:
        'Fetches player prop lines for a specific NBA or MLB game across FanDuel, DraftKings, and BetMGM. NBA defaults: points, rebounds, assists, 3-pointers, blocks, steals. MLB defaults: hits, total bases, RBIs, runs scored, home runs, strikeouts (batters & pitchers). Obtain the event_id from get_odds first.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The OddsAPI event ID for the game. Get this from get_odds.',
          },
          league: {
            type: 'string',
            enum: ['nba', 'mlb'],
            description: 'The league the event belongs to: "nba" (default) or "mlb". Must match what was used in get_odds.',
          },
          markets: {
            type: 'string',
            description:
              'Comma-separated prop market keys to override the default set. NBA options: player_points, player_rebounds, player_assists, player_threes, player_blocks, player_steals (and *_alternate variants). MLB batter options: batter_hits, batter_total_bases, batter_rbis, batter_runs_scored, batter_home_runs, batter_strikeouts. MLB pitcher options: pitcher_strikeouts, pitcher_hits_allowed.',
          },
        },
        required: ['event_id'],
      },
    },
    {
      name: 'get_live_scores',
      description:
        'Fetches current scores and game state for in-progress and recently completed NBA, MLB, or NFL games. Returns score, completion status, and last-update timestamp. Use alongside get_live_odds for full live betting context.',
      inputSchema: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['nba', 'mlb', 'nfl'],
            description: 'The league to fetch scores for: "nba" (default), "mlb", or "nfl".',
          },
          team: {
            type: 'string',
            description: 'Filter to games involving this team name (partial match). Optional.',
          },
          days_from: {
            type: 'number',
            description: 'Number of days back to include recently completed games (1–3, default 1). Optional.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_live_odds',
      description:
        'Fetches live in-game spreads, totals, and moneylines for currently in-progress NBA, MLB, or NFL games across FanDuel, DraftKings, and BetMGM. Only returns games actively being played. Pair with get_live_scores for score context.',
      inputSchema: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['nba', 'mlb', 'nfl'],
            description: 'The league to fetch live odds for: "nba" (default), "mlb", or "nfl".',
          },
          team: {
            type: 'string',
            description: 'Filter to games involving this team name (partial match). Optional.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_live_player_props',
      description:
        'Fetches live player prop lines for a specific in-progress game across FanDuel, DraftKings, and BetMGM. NBA defaults: points, rebounds, assists, 3-pointers, blocks, steals. MLB defaults: hits, total bases, RBIs, runs scored, home runs, strikeouts. NFL defaults: pass yards, pass TDs, rush yards, receptions, receiving yards. Obtain the event_id from get_live_odds first.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The OddsAPI event ID for the live game. Get this from get_live_odds.',
          },
          league: {
            type: 'string',
            enum: ['nba', 'mlb', 'nfl'],
            description: 'The league the event belongs to: "nba" (default), "mlb", or "nfl".',
          },
          markets: {
            type: 'string',
            description:
              'Comma-separated prop market keys to override the default set. NBA: player_points, player_rebounds, player_assists, player_threes, player_blocks, player_steals. MLB batters: batter_hits, batter_total_bases, batter_rbis, batter_runs_scored, batter_home_runs, batter_strikeouts. MLB pitchers: pitcher_strikeouts, pitcher_hits_allowed. NFL: player_pass_yds, player_pass_tds, player_pass_completions, player_pass_interceptions, player_rush_yds, player_receptions, player_reception_yds, player_reception_tds.',
          },
        },
        required: ['event_id'],
      },
    },
    {
      name: 'log_bet',
      description: 'Log a new bet to the bet tracker. Required: date, sport, game, bet_type, line, odds, stake_units. Returns the saved bet with its generated bet_id.',
      inputSchema: {
        type: 'object',
        properties: {
          date:                 { type: 'string', description: 'Date of the bet (YYYY-MM-DD).' },
          time_placed:          { type: 'string', description: 'Time the bet was placed (HH:MM or freeform). Optional.' },
          sport:                { type: 'string', description: 'Sport (e.g. "NBA", "MLB", "NFL").' },
          game:                 { type: 'string', description: 'Game identifier (e.g. "LAL @ BOS").' },
          bet_type:             { type: 'string', description: 'Bet type (e.g. "spread", "total", "ML", "player prop").' },
          classification:       { type: 'string', description: 'Bet classification (e.g. "A+", "A", "B"). Optional.' },
          line:                 { type: 'string', description: 'The line bet (e.g. "LAL -5.5", "Over 224.5", "LeBron Over 25.5 pts").' },
          odds:                 { type: 'string', description: 'American odds at time of bet (e.g. "-110", "+135").' },
          stake_units:          { type: 'number', description: 'Units wagered.' },
          best_book:            { type: 'string', description: 'Book where the bet was placed. Optional.' },
          second_book_checked:  { type: 'string', description: 'Second book checked for comparison. Optional.' },
          projection:           { type: 'string', description: 'Model or manual projection for the bet. Optional.' },
          fair_line:            { type: 'string', description: 'Calculated fair line (e.g. "-105"). Optional.' },
          edge_pct:             { type: 'string', description: 'Edge percentage over fair line. Optional.' },
          playable_to:          { type: 'string', description: 'Worst acceptable odds to still place the bet. Optional.' },
          checklist_pct:        { type: 'number', description: 'Pre-bet checklist score 0–100. Optional.' },
          key_factors:          { type: 'string', description: 'Key reasons/factors supporting the bet. Optional.' },
          risk_flags:           { type: 'string', description: 'Any risk factors or concerns. Optional.' },
          opening_line:         { type: 'string', description: 'Opening line for CLV reference. Optional.' },
          notes:                { type: 'string', description: 'Free-form notes. Optional.' },
        },
        required: ['date', 'sport', 'game', 'bet_type', 'line', 'odds', 'stake_units'],
      },
    },
    {
      name: 'update_bet',
      description: 'Update an existing bet result, closing line, or notes. Automatically calculates P&L and CLV when result and closing_line are provided.',
      inputSchema: {
        type: 'object',
        properties: {
          bet_id:       { type: 'string', description: 'UUID of the bet to update.' },
          result:        { type: 'string', enum: ['win', 'loss', 'push', 'pending'], description: 'Outcome of the bet.' },
          closing_line:  { type: 'string', description: 'American odds at close (for CLV calculation). Optional.' },
          result_detail: { type: 'string', description: 'Final score or stat line (e.g. "LAL 112 BOS 108" or "LeBron 28 pts"). Optional.' },
          notes:         { type: 'string', description: 'Updated or appended notes. Optional.' },
        },
        required: ['bet_id'],
      },
    },
    {
      name: 'get_bets',
      description: 'Retrieve bet history with optional filters. Returns bets sorted newest-first.',
      inputSchema: {
        type: 'object',
        properties: {
          filter_result:         { type: 'string', enum: ['all', 'win', 'loss', 'push', 'pending'], description: 'Filter by result (default: all).' },
          filter_sport:          { type: 'string', description: 'Filter by sport (e.g. "NBA"). Optional.' },
          filter_bet_type:       { type: 'string', description: 'Filter by bet type. Optional.' },
          filter_classification: { type: 'string', description: 'Filter by classification (e.g. "A+"). Optional.' },
          limit:                 { type: 'number', description: 'Max bets to return (default 50).' },
        },
        required: [],
      },
    },
    {
      name: 'get_pending_bets',
      description: 'Returns all bets that have not yet been graded (result = "pending").',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_summary',
      description: 'Returns overall betting performance stats: record, hit rate, total P&L, avg CLV, breakdown by bet type and classification, daily P&L, and pending count.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'run_50_bet_review',
      description: 'Runs a rolling 50-bet performance review when exactly a multiple of 50 bets have been settled. Returns record, P&L, CLV correlation, best/worst bet types, and actionable recommendations. Returns "not ready" status otherwise.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ]}));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let text;
      if (name === 'get_odds') text = await handleGetOdds(args);
      else if (name === 'get_line_movement') text = await handleGetLineMovement(args);
      else if (name === 'get_player_props') text = await handleGetPlayerProps(args);
      else if (name === 'get_live_scores') text = await handleGetLiveScores(args);
      else if (name === 'get_live_odds') text = await handleGetLiveOdds(args);
      else if (name === 'get_live_player_props') text = await handleGetLivePlayerProps(args);
      else if (name === 'log_bet')           text = await handleLogBet(args);
      else if (name === 'update_bet')        text = await handleUpdateBet(args);
      else if (name === 'get_bets')          text = await handleGetBets(args);
      else if (name === 'get_pending_bets')  text = await handleGetPendingBets();
      else if (name === 'get_summary')       text = await handleGetSummary();
      else if (name === 'run_50_bet_review') text = await handleRun50BetReview();
      else return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      console.error(`[tool:${name}] ERROR:`, err);
      return { content: [{ type: 'text', text: `Error in ${name}: ${err.message}\n${err.stack ?? ''}` }], isError: true };
    }
  });

  return srv;
}

// ── Transport selection ───────────────────────────────────────────────────────
// PORT is set by Railway (and other PaaS hosts). When present, serve over HTTP
// using the MCP Streamable HTTP transport so Claude Code can connect remotely
// via: claude mcp add --transport http sports-betting https://<host>/mcp
// Without PORT, fall back to stdio for local Claude Code use.

const PORT = process.env.PORT;

if (PORT) {
  const app = express();
  app.use(express.json());
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'Authorization'],
    exposedHeaders: ['Mcp-Session-Id'],
  }));
  const sessions = new Map();

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.all('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId ? sessions.get(sessionId) : null;

      if (!transport) {
        if (req.method !== 'POST' || req.body?.method !== 'initialize') {
          res.status(400).json({ error: 'Send an MCP initialize request first.' });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const srv = makeServer();
        await srv.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.error(`Sports Betting MCP HTTP server listening on port ${PORT}`);
  });
} else {
  const srv = makeServer();
  const transport = new StdioServerTransport();
  await srv.connect(transport);
  console.error('Sports Betting MCP server running on stdio');
}
