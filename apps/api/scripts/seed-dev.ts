/**
 * Local dev/demo seed for the Games surface. Inserts a spread of featured Pokémon card markets with marks
 * (so the games have a pool to draw from — a fresh DB has none, since live pricing needs provider keys),
 * enables all 7 games (with demo-friendly knobs), and funds GAME_POOL so prizes can pay out.
 *
 * Run once against the dev pglite BEFORE starting the API (pglite is single-connection):
 *   PGLITE_DIR=.pglite-dev npx tsx scripts/seed-dev.ts
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { usdc } from '../src/money.ts';
import {
  setPackRipConfig, setSetPokerConfig, setGradeGambleConfig, setTheBreakConfig,
  setPriceDuelConfig, setCardFantasyConfig, setDraftArenaConfig,
} from '../src/services/game-config.ts';
import { seedGamePool } from '../src/services/games.ts';

// [display name, current price USD] — spread across the Pack Rip value bands ($1 → $1500).
const CARDS: [string, number][] = [
  ['Charizard ex (Obsidian Flames) #125', 18], ['Pikachu VMAX (Vivid Voltage) #044', 32],
  ['Umbreon VMAX Alt Art (Evolving Skies) #215', 480], ['Rayquaza VMAX Alt (Evolving Skies) #218', 240],
  ['Mewtwo ex (151) #150', 26], ['Charizard ex SIR (151) #199', 320], ['Blastoise ex (151) #009', 14],
  ['Gengar ex (151) #094', 22], ['Lugia V Alt Art (Silver Tempest) #186', 95], ['Giratina V Alt (Lost Origin) #186', 130],
  ['Mew ex SIR (151) #205', 145], ['Moonbreon — Umbreon VMAX (Evolving Skies) #215', 520],
  ['Glaceon VMAX Alt (Evolving Skies) #209', 110], ['Sylveon VMAX Alt (Evolving Skies) #212', 130],
  ['Leafeon VMAX Alt (Evolving Skies) #205', 90], ['Espeon VMAX Alt (Evolving Skies) #208', 105],
  ['Charizard UPC Promo (151) #', 60], ['Pikachu with Grey Felt Hat Promo', 1500],
  ['Iono SAR (Paldea Evolved) #269', 80], ['Miriam SAR (Scarlet & Violet) #', 35],
  ['Lance’s Charizard (Expedition) #', 900], ['Base Set Charizard #4 (Unlimited)', 350],
  ['Base Set Blastoise #2', 120], ['Base Set Venusaur #15', 95], ['Shining Charizard (Neo Destiny) #107', 700],
  ['Gold Star Rayquaza (Deoxys) #107', 1200], ['Crystal Charizard (Skyridge) #146', 1100],
  ['Gardevoir ex (Paldea Evolved) #245', 28], ['Chien-Pao ex SAR #', 40],
  ['Koraidon ex SAR (Scarlet & Violet) #', 33], ['Miraidon ex SAR #', 30], ['Tinkaton ex #', 9],
  ['Roaring Moon ex SAR (Paradox Rift) #', 55], ['Iron Valiant ex #', 12], ['Slither Wing #', 4],
  ['Pidgeot ex (Obsidian Flames) #', 16], ['Snorlax (Base Set) #11', 22], ['Dragonite (Fossil) #4', 30],
  ['Alakazam (Base Set) #1', 40], ['Machamp 1st Ed (Base Set) #8', 18], ['Zard — Charizard VSTAR Rainbow #', 70],
  ['Giratina VSTAR (Lost Origin) #', 24], ['Arceus VSTAR Gold #', 45], ['Mew (151) #151', 6],
  ['Bulbasaur (151) #001', 3], ['Squirtle (151) #007', 4], ['Charmander (151) #004', 8],
  ['Eevee (151) #133', 5], ['Jigglypuff (151) #039', 3],
];

function slug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Math.abs(hash(name)).toString(36).slice(0, 4);
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function main() {
  const db = await getDb();
  await migrate();

  let inserted = 0;
  for (const [name, priceUsd] of CARDS) {
    const sym = slug(name);
    const id = randomUUID();
    const r = await db.query<{ id: string }>(
      `INSERT INTO markets(id, kind, game, symbol, display_name, status, tradeable, featured)
       VALUES($1, 'card', 'pokemon', $2, $3, 'active', true, true) ON CONFLICT (symbol) DO NOTHING RETURNING id`,
      [id, sym, name],
    );
    const marketId = r.rows[0]?.id ?? (await db.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [sym])).rows[0].id;
    if (r.rows[0]) {
      // A mark a few days ago (slightly lower) + one now → a non-zero recent move on the screener.
      await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6, computed_at) VALUES($1,$2,$2, now() - interval '3 days')`, [marketId, usdc(priceUsd * 0.92).toString()]);
      await db.query(`INSERT INTO marks(market_id, mark_price_e6, index_price_e6) VALUES($1,$2,$2)`, [marketId, usdc(priceUsd).toString()]);
      inserted++;
    }
  }

  // Enable every game with demo-friendly knobs (smaller lobbies / shorter windows than prod defaults).
  await setPackRipConfig(db, { enabled: true });
  await setSetPokerConfig(db, { enabled: true });
  await setGradeGambleConfig(db, { enabled: true });
  await setTheBreakConfig(db, { enabled: true, spots: 4, entryUsd: 25 });
  await setPriceDuelConfig(db, { enabled: true, anteUsd: 25, windowHours: 1 });
  await setCardFantasyConfig(db, { enabled: true, entryUsd: 25, rosterSize: 5, capUsd: 1000, windowHours: 24, minEntries: 2 });
  await setDraftArenaConfig(db, { enabled: true, spots: 4, rosterSize: 5, poolSize: 30, windowHours: 24 });

  const pool = await seedGamePool(db, 1_000_000);

  const total = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM markets WHERE featured`)).rows[0].n;
  console.log(`seed-dev: +${inserted} new cards (${total} featured total), all 7 games enabled, GAME_POOL = ${pool.poolE6} µUSDC ($1,000,000).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
