#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_KEY = '6839cf3576edc840d160c633c6f8eedf';
const BASE_URL = 'https://api.the-odds-api.com/v4';
const SPORT_KEYS = { nba: 'basketball_nba', mlb: 'baseball_mlb' };
const BOOKMAKERS = 'fanduel,draftkings,betmgm';
const REGIONS = 'us';

function resolveSport(league) {
  const key = SPORT_KEYS[(league || 'nba').toLowerCase()];
  if (!key) throw new Error(`Unsupported league "${league}". Use "nba" or "mlb".`);
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
  const { event_id, date } = args;

  const commonParams = {
    regions: REGIONS,
    markets: 'h2h,spreads,totals',
    bookmakers: BOOKMAKERS,
    oddsFormat: 'american',
    eventIds: event_id,
  };

  // Parallel: historical snapshot + current odds
  const [histResult, currResult] = await Promise.all([
    oddsApiRequest(`/sports/${SPORT_KEYS.nba}/odds-history/`, { ...commonParams, date }),
    oddsApiRequest(`/sports/${SPORT_KEYS.nba}/odds/`, commonParams),
  ]);

  // Historical endpoint wraps results in { data: [...], timestamp, ... }
  const histGame = Array.isArray(histResult.data)
    ? histResult.data[0]
    : histResult.data?.data?.[0];

  const currGame = Array.isArray(currResult.data)
    ? currResult.data[0]
    : null;

  if (!currGame) return `No current odds found for event ${event_id}.`;

  const { home_team: home, away_team: away } = currGame;
  let out = `Line Movement: ${away} @ ${home}\nEvent ID: ${event_id}\nSnapshot date: ${date}\n`;

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
        'Fetches current spreads, totals, and moneylines for NBA or MLB games across FanDuel, DraftKings, and BetMGM. Returns all upcoming games by default; optionally filter by team name or date range.',
      inputSchema: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['nba', 'mlb'],
            description: 'The league to fetch odds for: "nba" (default) or "mlb".',
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
        'Fetches historical odds movement from a given snapshot date to current for a specific NBA game, showing how spreads, totals, and moneylines have shifted at FanDuel, DraftKings, and BetMGM. Obtain the event_id from get_odds first.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The OddsAPI event ID for the game. Get this from get_odds.',
          },
          date: {
            type: 'string',
            description:
              'The historical snapshot datetime in ISO 8601 format (e.g. 2025-05-08T12:00:00Z). Use the game\'s open date/time or any earlier checkpoint to compare against current lines.',
          },
        },
        required: ['event_id', 'date'],
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
  ]}));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let text;
      if (name === 'get_odds') text = await handleGetOdds(args);
      else if (name === 'get_line_movement') text = await handleGetLineMovement(args);
      else if (name === 'get_player_props') text = await handleGetPlayerProps(args);
      else return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
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
  const app = createMcpExpressApp({ host: '0.0.0.0' });
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
