// netlify/functions/live-location.js
//
// Proxies a Garmin MapShare KML feed and returns the most recent position
// as JSON. The browser can't fetch share.garmin.com directly (no CORS
// headers on Garmin's end), so this function fetches it server-side and
// re-serves the result in the shape the map's frontend expects:
//
//   { lat: number, lon: number, timestampUTC: ISOString, name?: string }
//
// Setup:
//   1. Set the MAPSHARE_ALIAS environment variable in the Netlify site
//      settings (Site configuration -> Environment variables). Either
//      the bare alias ("rodeolabs") or the full share link
//      ("https://share.garmin.com/Feed/Share/rodeolabs" or
//      "https://share.garmin.com/rodeolabs") works -- normalizeAlias()
//      below extracts just the alias either way. A MapShare password,
//      if the feed is password-protected, goes in MAPSHARE_PASSWORD.
//   2. Redeploy after changing environment variables -- Netlify functions
//      only pick up new env vars on a fresh deploy.
//   3. The frontend already polls /.netlify/functions/live-location every
//      3 minutes and hides the "Where are they now?" button until this
//      returns a valid response, so it's safe to ship ahead of the trip
//      and safe to leave running after it ends (stale feed just means a
//      stale "last ping" time, not an error).

const CACHE_MS = 60 * 1000; // avoid hammering Garmin if Netlify cold-starts frequently
let cache = { data: null, fetchedAt: 0 };

// Accepts a bare alias, a full share link, or a Feed/Share link -- pulls
// out just the alias segment either way, so pasting the whole URL into
// the env var (an easy mistake) doesn't silently break the feed URL.
function normalizeAlias(raw) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const match = trimmed.match(/share\.garmin\.com\/(?:Feed\/Share\/)?([^/?#]+)/i);
  return match ? match[1] : trimmed;
}

exports.handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  const rawAlias = process.env.MAPSHARE_ALIAS;
  if (!rawAlias) {
    return {
      statusCode: 501,
      headers,
      body: JSON.stringify({
        error: 'MAPSHARE_ALIAS environment variable is not set. Add it in Netlify site settings and redeploy.',
      }),
    };
  }
  const alias = normalizeAlias(rawAlias);

  if (cache.data && Date.now() - cache.fetchedAt < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  try {
    const feedUrl = new URL(`https://share.garmin.com/Feed/Share/${encodeURIComponent(alias)}`);
    if (process.env.MAPSHARE_PASSWORD) {
      feedUrl.searchParams.set('password', process.env.MAPSHARE_PASSWORD);
    }

    const res = await fetch(feedUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ColoradoDiagonalMap/1.0)' },
    });
    if (!res.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Garmin feed returned ${res.status}`, feedUrl: feedUrl.toString(), parsedAlias: alias }),
      };
    }

    const kml = await res.text();
    const point = extractLatestPoint(kml);
    if (!point) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'No position found in the Garmin feed (feed may be empty or the alias may be wrong).', feedUrl: feedUrl.toString(), parsedAlias: alias }),
      };
    }

    cache = { data: point, fetchedAt: Date.now() };
    return { statusCode: 200, headers, body: JSON.stringify(point) };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: `Failed to fetch/parse Garmin feed: ${err.message}`, parsedAlias: alias }),
    };
  }
};

// Garmin MapShare KML lists each pinged position as its own <Placemark>,
// each with a <Point><coordinates>lon,lat[,ele]</coordinates></Point> and
// (usually) a <TimeStamp><when>ISO8601</when></TimeStamp>. Placemarks are
// normally in chronological order, but we pick by parsed timestamp rather
// than trusting feed order, since that's held true across Garmin feed
// format changes in the past.
function extractLatestPoint(kml) {
  const placemarkRe = /<Placemark\b[\s\S]*?<\/Placemark>/g;
  const placemarks = kml.match(placemarkRe) || [];

  let best = null;

  for (const block of placemarks) {
    const coordMatch = block.match(/<coordinates>\s*([^<]+?)\s*<\/coordinates>/);
    if (!coordMatch) continue;

    const parts = coordMatch[1].split(',').map(s => parseFloat(s.trim()));
    const [lon, lat] = parts;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const whenMatch = block.match(/<when>([^<]+)<\/when>/);
    const timeMatch = block.match(/<Data name="Time"[^>]*>\s*<value>([^<]+)<\/value>/i);
    const rawTime = whenMatch ? whenMatch[1] : timeMatch ? timeMatch[1] : null;
    const timestampUTC = rawTime ? new Date(rawTime).toISOString() : null;

    const nameMatch = block.match(/<name>([^<]*)<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : undefined;

    const candidate = { lat, lon, timestampUTC: timestampUTC || new Date().toISOString(), name };

    if (!best) {
      best = candidate;
    } else if (timestampUTC && best.timestampUTC && candidate.timestampUTC > best.timestampUTC) {
      best = candidate;
    } else if (!best.timestampUTC) {
      best = candidate; // fall back to last-seen placemark if no timestamps parse at all
    }
  }

  return best;
}
