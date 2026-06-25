/**
 * Loads the competitor watchlist from src/config/competitors.yaml.
 * Build step copies src/config/*.yaml -> dist/config/, mirroring how
 * channels.yaml / request-patterns.yaml are loaded.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { Watchlist } from './types';

let cached: Watchlist | null = null;

export function loadWatchlist(): Watchlist {
  if (cached) return cached;
  // __dirname at runtime is dist/competitor-intel; config sits at dist/config
  const path = join(__dirname, '..', 'config', 'competitors.yaml');
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw) as Watchlist;
  cached = {
    pillars: parsed.pillars ?? [],
    competitors: parsed.competitors ?? [],
    watch_categories: parsed.watch_categories ?? [],
    standing_threads: parsed.standing_threads ?? [],
    ai_visibility_prompts: parsed.ai_visibility_prompts ?? [],
    proposed: parsed.proposed ?? [],
  };
  return cached;
}
