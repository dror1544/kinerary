#!/usr/bin/env node
/**
 * country-info.js — emergency numbers, currency, and calling code for a country.
 *
 * Usage:
 *   node scripts/country-info.js "Japan"
 *   node scripts/country-info.js "Japan" --json     # machine-readable, for driver.mjs/answers.json
 *
 * Live sources, no API key needed:
 *   https://countries.dev            — name → currency, calling code, capital, ISO code
 *   https://emergencynumberapi.com   — ISO code → police / ambulance / fire
 *
 * This is a starting point, not a guarantee — both are free, community-run
 * services with their own disclaimers (emergencynumberapi.com's own words:
 * "provided without any claims of accuracy... do your own due diligence").
 * Spot-check before travel, especially for less-common destinations. There
 * is no automated source here for electrical plug type/voltage or driving
 * side — no free API for those was found reliable enough to bundle; add
 * those manually if you want them.
 */

async function findCountry(query) {
  let res;
  try {
    res = await fetch(`https://countries.dev/name/${encodeURIComponent(query)}`);
  } catch (e) {
    return { error: `Could not reach countries.dev: ${e.message}` };
  }
  if (res.status === 404) return { error: `No country found matching "${query}"` };
  if (!res.ok) return { error: `countries.dev lookup failed: HTTP ${res.status}` };
  const matches = await res.json();
  if (!matches.length) return { error: `No country found matching "${query}"` };

  // countries.dev returns matches in no particular order — "united states" alone
  // matched "United States Minor Outlying Islands" before "United States of
  // America" here. Prefer an exact match, then the *shortest* name among
  // prefix matches (sovereign countries tend to have shorter canonical names
  // than the dependent territories/subdivisions that also share the prefix),
  // then the shortest match overall.
  const q = query.toLowerCase();
  const byShortest = (a, b) => a.name.length - b.name.length;
  const exact = matches.find(c => c.name.toLowerCase() === q);
  const startsWith = matches.filter(c => c.name.toLowerCase().startsWith(q)).sort(byShortest)[0];
  const chosen = exact || startsWith || [...matches].sort(byShortest)[0];
  const alternatives = matches.filter(c => c.name !== chosen.name).map(c => c.name);
  return { chosen, alternatives };
}

async function getEmergencyNumbers(alpha2Code) {
  try {
    const res = await fetch(`https://emergencynumberapi.com/api/country/${alpha2Code}`);
    if (!res.ok) return null;
    const { data } = await res.json();
    // "all"/"gsm"/"fixed" arrays sometimes hold [""] rather than being empty —
    // treat a blank string as absent, same as null/undefined.
    const pick = svc => svc?.all?.[0] || svc?.gsm?.[0] || svc?.fixed?.[0] || null;
    // Countries with one number for everything (US 911, UK 999, etc.) put it
    // under "dispatch", not police/ambulance/fire — those come back blank.
    // Surface it as `general` and also fill police/ambulance/fire with it,
    // since in practice that one number reaches whichever service you need.
    const general = pick(data.dispatch);
    return {
      police: pick(data.police) || general,
      ambulance: pick(data.ambulance) || general,
      fire: pick(data.fire) || general,
      general,
      unified112: !!data.member_112,
    };
  } catch {
    return null;
  }
}

async function lookup(query) {
  const { chosen, alternatives, error } = await findCountry(query);
  if (error) return { error };

  const emergency = await getEmergencyNumbers(chosen.alpha2Code);
  const currency = chosen.currencies?.[0] || null;

  return {
    country: chosen.name,
    flag: chosen.flag || null,
    capital: chosen.capital || null,
    currency: currency ? { code: currency.code, name: currency.name, symbol: currency.symbol } : null,
    callingCode: chosen.callingCodes?.[0] ? `+${chosen.callingCodes[0]}` : null,
    emergency,
    alternatives,
  };
}

async function main() {
  const query = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!query || query.startsWith('--')) {
    console.error('Usage: node scripts/country-info.js "<country name>" [--json]');
    process.exit(1);
  }

  const result = await lookup(query);
  if (result.error) {
    console.error(`❌  ${result.error}`);
    process.exit(1);
  }

  if (asJson) {
    const { alternatives, ...clean } = result;
    console.log(JSON.stringify(clean, null, 2));
    return;
  }

  console.log(`\n${result.country}${result.flag ? ' ' + result.flag : ''}`);
  console.log(`  Capital       : ${result.capital || '—'}`);
  console.log(`  Currency      : ${result.currency ? `${result.currency.name} (${result.currency.symbol || result.currency.code})` : '—'}`);
  console.log(`  Calling code  : ${result.callingCode || '—'}`);
  if (result.emergency?.general) {
    console.log(`  Emergency     : ${result.emergency.general} (one number for all services)${result.emergency.unified112 ? ' — 112 also works' : ''}`);
  } else if (result.emergency) {
    console.log(`  Emergency     : police ${result.emergency.police || '—'} · ambulance ${result.emergency.ambulance || '—'} · fire ${result.emergency.fire || '—'}${result.emergency.unified112 ? ' (112 also works)' : ''}`);
  } else {
    console.log('  Emergency     : lookup failed — fill in manually');
  }
  if (result.alternatives.length) {
    console.log(`\n  (also matched: ${result.alternatives.join(', ')} — pass a more specific name if this picked the wrong one)`);
  }
  console.log('\n  Add --json for machine-readable output (used by the create-trip skill).');
}

if (require.main === module) {
  main();
}

module.exports = { lookup };
