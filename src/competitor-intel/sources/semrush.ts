/**
 * SEMrush Analytics API client.
 *
 * The classic Analytics API returns semicolon-delimited CSV. We pull a domain
 * overview (organic/paid keyword counts, traffic, cost) and the top organic
 * keywords (phrase, position, volume, url) per competitor. These land in the
 * Sheet as time-series rows so we can track position/traffic movement weekly.
 *
 * Docs: https://www.semrush.com/api-analytics/
 */

import { ciConfig } from '../config';
import type { SemrushSnapshot } from '../types';

const BASE = 'https://api.semrush.com/';

/** Parse SEMrush semicolon-CSV into row objects keyed by header. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';');
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h.trim()] = (cells[i] ?? '').trim()));
    return row;
  });
}

async function call(params: Record<string, string>): Promise<Record<string, string>[]> {
  const url = new URL(BASE);
  url.searchParams.set('key', ciConfig.semrushApiKey);
  url.searchParams.set('database', ciConfig.semrushDatabase);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  const text = await res.text();
  // SEMrush returns errors as plain text starting with "ERROR"
  if (!res.ok || text.startsWith('ERROR')) {
    throw new Error(`[semrush] ${params.type}: ${text.slice(0, 200)}`);
  }
  return parseCsv(text);
}

/** Domain overview: organic keywords, organic traffic, cost, adwords keywords. */
async function getOverview(domain: string): Promise<Partial<SemrushSnapshot>> {
  // Columns: Dn=domain, Rk=rank, Or=organic kw, Ot=organic traffic, Oc=organic cost, Ad=adwords kw
  const rows = await call({
    type: 'domain_ranks',
    domain,
    export_columns: 'Dn,Rk,Or,Ot,Oc,Ad',
  });
  const r = rows[0] ?? {};
  return {
    organicKeywords: num(r['Organic Keywords'] ?? r['Or']),
    organicTraffic: num(r['Organic Traffic'] ?? r['Ot']),
    organicCost: num(r['Organic Cost'] ?? r['Oc']),
    adwordsKeywords: num(r['Adwords Keywords'] ?? r['Ad']),
  };
}

/** Top organic keywords a domain ranks for. */
async function getTopKeywords(domain: string, limit = 20) {
  const rows = await call({
    type: 'domain_organic',
    domain,
    display_limit: String(limit),
    export_columns: 'Ph,Po,Nq,Ur',
    display_sort: 'tr_desc', // by traffic
  });
  return rows.map((r) => ({
    phrase: r['Keyword'] ?? r['Ph'] ?? '',
    position: num(r['Position'] ?? r['Po']) ?? 0,
    volume: num(r['Search Volume'] ?? r['Nq']) ?? 0,
    url: r['Url'] ?? r['Ur'] ?? '',
  }));
}

/** Paid-search keywords a competitor bids on (domain_adwords). */
async function getPaidKeywords(domain: string, limit = 15) {
  const rows = await call({
    type: 'domain_adwords',
    domain,
    display_limit: String(limit),
    export_columns: 'Ph,Po,Cp,Nq,Ur',
    display_sort: 'tr_desc',
  });
  return rows.map((r) => ({
    phrase: r['Keyword'] ?? r['Ph'] ?? '',
    position: num(r['Position'] ?? r['Po']) ?? 0,
    cpc: num(r['CPC'] ?? r['Cp']) ?? 0,
    volume: num(r['Search Volume'] ?? r['Nq']) ?? 0,
    url: r['Url'] ?? r['Ur'] ?? '',
  }));
}

/** Actual ad copy a competitor runs (domain_adwords_unique). */
async function getAdCopies(domain: string, limit = 10) {
  const rows = await call({
    type: 'domain_adwords_unique',
    domain,
    display_limit: String(limit),
    export_columns: 'Tt,Ds,Vu',
  });
  return rows.map((r) => ({
    title: r['Title'] ?? r['Tt'] ?? '',
    description: r['Description'] ?? r['Ds'] ?? '',
    visibleUrl: r['Visible Url'] ?? r['Vu'] ?? '',
  }));
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Full snapshot for one competitor domain. Never throws — returns {error}. */
export async function snapshot(domain: string): Promise<SemrushSnapshot> {
  try {
    const [overview, topKeywords, paidKeywords, adCopies] = await Promise.all([
      getOverview(domain),
      getTopKeywords(domain).catch(() => []),
      getPaidKeywords(domain).catch(() => []),
      getAdCopies(domain).catch(() => []),
    ]);
    return { domain, ...overview, topKeywords, paidKeywords, adCopies };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return { domain, error: message };
  }
}
