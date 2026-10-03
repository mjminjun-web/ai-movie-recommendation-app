# ReelMood AI

Local movie and TV recommendation app with natural-language search, AI explanations,
reviews, a saved watchlist, and multi-source poster fallback.

## Run locally

1. Add server-side credentials to `.env.local` as needed.
2. Run `node server.js`.
3. Open `http://127.0.0.1:4173/`.

The server retries temporary Gemini timeouts and rate-limit responses with short
backoff delays, caches successful recommendation responses briefly, and keeps the
local semantic search active when Gemini is unavailable. You can tune the defaults
in `.env.local` if needed:

```dotenv
GEMINI_TIMEOUT_MS=24000
GEMINI_RETRY_LIMIT=2
```

The free API quota is protected by a per-IP request limit. When that limit is reached,
the app reports that state separately and pauses new AI calls briefly instead of
mislabeling the service as offline.

## Marvel and other movie posters

TMDb is the primary poster provider when configured. It offers dedicated movie and TV
search, localized poster sets, multiple artwork choices, and high-resolution CDN images.
The app searches by title and year, requests English and language-neutral poster options,
then selects a well-rated 2:3 poster. If an image fails, it can choose another TMDb image
before trying the app's no-key fallback sources.

1. Create a TMDb account and request API access from the API section of account settings.
2. Put the API Read Access Token in `.env.local`:

   ```dotenv
   TMDB_READ_ACCESS_TOKEN=your_token_here
   ```

3. Restart `node server.js`.

Never put the token in `script.js` or `index.html`. TMDb allows attributed
non-commercial API use; contact TMDb for commercial licensing. The required TMDb credit
is included in the app's Help dialog.

## Upcoming release calendar

The `Upcoming` button opens a full-screen feed of announced movies releasing from today
through the next 12 months. When configured, TMDb Discover supplies release dates,
posters, genres, runtime, and movie metadata. TMDb videos are preferred for the trailer
player; KinoCheck is queried when TMDb does not list a YouTube trailer.

If TMDb is not configured or is temporarily unavailable, the server automatically falls
back to Wikidata's public SPARQL endpoint for announced release dates and identifiers.
This no-key backup keeps the feed usable, but its metadata and artwork can be less complete
than TMDb. Results are cached for one hour to avoid unnecessary public API traffic.

KinoCheck's public API can be used without a key within its daily request limit. For higher
KinoCheck limits, add an optional server-side key:

```dotenv
KINOCHECK_API_KEY=your_optional_key_here
```

For one final trailer fallback, enable YouTube Data API v3 in a Google Cloud project and
add a separate server-side key:

```dotenv
YOUTUBE_API_KEY=your_youtube_data_api_key
```

YouTube results are accepted only when the title matches and the upload comes from a known
studio or distributor channel. Searches are cached for 24 hours to protect the API quota.

## Rating and review sources

The interface's `Viewer fit` and `Quality` percentages are ReelMood decision signals, not
IMDb or Rotten Tomatoes ratings. Each title includes a compact `Source check` disclosure
linking to IMDb, Rotten Tomatoes, and YouTube for independent verification.

Rotten Tomatoes data is not scraped. Its terms prohibit automated collection without
Fandango's written authorization, so live Rotten Tomatoes scores should only be added after
obtaining licensed API access.
