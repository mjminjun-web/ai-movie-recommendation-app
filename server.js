const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chooseTmdbPoster, tmdbPosterUrl } = require("./poster-ranking");
const {
  futureDateRange,
  normalizeKinoCheckTrailer,
  normalizeUpcomingMovie,
  normalizeWikidataUpcomingBindings,
  selectTmdbTrailer,
  selectYouTubeTrailer,
} = require("./upcoming-movies");

const root = __dirname;
loadLocalEnv(path.join(root, ".env.local"));
loadLocalEnv(path.join(root, ".env"));

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

// --- Gemini config -----------------------------------------------------------
// Get a free key at https://aistudio.google.com/apikey (no credit card needed).
// Free tier covers the Flash family. gemini-2.5-flash is a solid default;
// gemini-2.5-flash-lite has higher burst limits if you expect lots of traffic.
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const tmdbApiKey = process.env.TMDB_API_KEY;
const tmdbAccessToken =
  process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_ACCESS_TOKEN;
const omdbApiKey = process.env.OMDB_API_KEY;
const kinoCheckApiKey = process.env.KINOCHECK_API_KEY;
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const tmdbAttribution =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const omdbAttribution =
  "Poster fallback can use OMDb title metadata when OMDB_API_KEY is configured.";
const wikimediaAttribution =
  "Poster fallback checks free-to-access Wikipedia/Wikimedia page and file images when available.";
const itunesAttribution =
  "Poster fallback can use public iTunes Search artwork when a matching movie or TV record is available.";
const tvmazeAttribution =
  "TV poster fallback can use public TVmaze show artwork when a matching series record is available.";
const jikanAttribution =
  "Japanese anime poster fallback can use public Jikan/MyAnimeList image records when a matching anime record is available.";
const kitsuAttribution =
  "Japanese anime poster fallback can use public Kitsu anime poster records when a matching anime record is available.";
const wikidataAttribution =
  "Poster fallback can use Wikidata image records that link back to Wikimedia media.";
const posterFallbackAttribution =
  "Poster fallback checks TMDb/OMDb when configured, Jikan/Kitsu anime art, TVmaze show art, iTunes artwork, Wikimedia/Wikipedia, and Wikidata images.";
const posterFallbackCache = new Map();
const globalCatalogCache = new Map();
const upcomingCatalogCache = new Map();
const youtubeTrailerCache = new Map();
const geminiTimeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 24_000);
const geminiRetryLimit = Math.max(0, Math.min(3, Number(process.env.GEMINI_RETRY_LIMIT || 2)));
const geminiResponseCacheMs = 2 * 60 * 1000;
const geminiResponseCache = new Map();
const globalCatalogCacheMs = 10 * 60 * 1000;
const upcomingCatalogCacheMs = 60 * 60 * 1000;
const youtubeTrailerCacheMs = 24 * 60 * 60 * 1000;

// --- Simple per-IP rate limiter ----------------------------------------------
// Protects your free daily quota: one visitor can't burn through everything.
// In-memory only (resets when the server restarts) — fine for a small public app.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 8); // AI calls per IP per minute
const rateBuckets = new Map(); // ip -> { count, resetAt }

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separator = trimmed.indexOf("=");
    if (separator === -1) return;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }

  if (bucket.count >= RATE_LIMIT) return true;
  bucket.count += 1;
  return false;
}

function clientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress || "unknown";
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/ai-status") {
      return sendJson(response, 200, {
        enabled: Boolean(apiKey),
        model: apiKey ? model : null,
      });
    }

    if (url.pathname === "/api/recommend") {
      if (request.method !== "POST")
        return sendJson(response, 405, { error: "Method not allowed" });
      return handleAiRecommendation(request, response);
    }

    if (url.pathname === "/api/global-movies") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method not allowed" });
      return handleGlobalMovies(url, response);
    }

    if (url.pathname === "/api/poster-fallback") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method not allowed" });
      return handlePosterFallback(url, response);
    }

    if (url.pathname === "/api/upcoming-movies") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method not allowed" });
      return handleUpcomingMovies(url, response);
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    return sendJson(response, 500, {
      error: "Server error",
      detail: error.message,
    });
  }
});

async function handleUpcomingMovies(url, response) {
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const page = Math.max(1, Math.min(500, Number(url.searchParams.get("page") || 1)));
  const requestedRegion = (url.searchParams.get("region") || "GLOBAL").trim().toUpperCase();
  const region = requestedRegion === "GLOBAL" ? "" : requestedRegion;

  if (region && !/^[A-Z]{2}$/.test(region)) {
    return sendJson(response, 400, { error: "Region must be GLOBAL or a two-letter country code." });
  }

  const range = futureDateRange(today, 365);
  const hasTmdb = Boolean(tmdbApiKey || tmdbAccessToken);
  const cacheKey = `v2|${hasTmdb ? "tmdb-first" : "wikidata-only"}|${range.start}|${range.end}|${requestedRegion}|${page}`;
  const cached = upcomingCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < upcomingCatalogCacheMs) {
    return sendJson(response, 200, { ...cached.payload, cached: true });
  }

  let payload = null;
  let tmdbProblem = "";

  if (hasTmdb) {
    try {
      payload = await fetchTmdbUpcomingMovies({
        page,
        range,
        region,
        requestedRegion,
      });
    } catch (error) {
      tmdbProblem = error.message;
    }
  }

  if (!payload) {
    try {
      payload = await fetchWikidataUpcomingMovies({
        page,
        range,
        requestedRegion,
      });
      payload.warning = hasTmdb
        ? "TMDb is temporarily unavailable, so this feed is using the Wikidata backup. Some dates, details, and posters may be incomplete."
        : "Using the no-key Wikidata backup. Add a TMDb token later for richer release details and poster coverage."
    } catch (error) {
      return sendJson(response, 502, {
        error: "Upcoming release sources are temporarily unavailable.",
        message: hasTmdb
          ? "The app tried both TMDb and its Wikidata backup. Please try again shortly."
          : "The no-key Wikidata backup could not be reached. Please try again shortly.",
        detail: [tmdbProblem, error.message].filter(Boolean).join(" / "),
      });
    }
  }

  upcomingCatalogCache.set(cacheKey, { payload, savedAt: Date.now() });
  return sendJson(response, 200, payload);
}

async function fetchTmdbUpcomingMovies({ page, range, region, requestedRegion }) {

  const discoverParams = {
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    page: String(page),
    sort_by: "primary_release_date.asc",
  };

  if (region) {
    discoverParams.region = region;
    discoverParams["release_date.gte"] = range.start;
    discoverParams["release_date.lte"] = range.end;
    discoverParams.with_release_type = "3|2";
  } else {
    discoverParams["primary_release_date.gte"] = range.start;
    discoverParams["primary_release_date.lte"] = range.end;
  }

  const discoverData = await tmdbRequest("/discover/movie", discoverParams);

  const movies = await mapWithConcurrency(
    (discoverData.results || []).filter((movie) => movie?.id && movie?.title),
    4,
    async (movie) => {
      let details = {};
      try {
        details = await tmdbRequest(`/movie/${movie.id}`, {
          append_to_response: "videos",
          language: "en-US",
        });
      } catch {
        // The discover payload still contains enough data to render the release.
      }

      let trailer = selectTmdbTrailer(details.videos?.results || []);
      if (!trailer) {
        trailer = await fetchBackupTrailer({
          id: movie.id,
          title: details.title || movie.title,
          year: Number((movie.release_date || details.release_date || "").slice(0, 4)),
        });
      }

      return normalizeUpcomingMovie(movie, details, trailer);
    },
  );

  movies.sort(
    (a, b) =>
      String(a.releaseDate).localeCompare(String(b.releaseDate)) ||
      Number(b.popularity || 0) - Number(a.popularity || 0),
  );

  const payload = {
    source: "TMDb",
    trailerSources: ["TMDb", "KinoCheck", ...(youtubeApiKey ? ["YouTube"] : [])],
    attribution: tmdbAttribution,
    rangeStart: range.start,
    rangeEnd: range.end,
    region: requestedRegion,
    releaseScope: region ? "Theatrical" : "Global primary release",
    page,
    totalPages: Math.min(500, Number(discoverData.total_pages || 1)),
    totalResults: Number(discoverData.total_results || movies.length),
    totalResultsKnown: true,
    hasMore: page < Math.min(500, Number(discoverData.total_pages || 1)),
    movies,
  };

  return payload;
}

async function fetchWikidataUpcomingMovies({ page, range, requestedRegion }) {
  const pageSize = 20;
  const query = `
SELECT ?film ?filmLabel ?tmdbId
       (MIN(?candidateDate) AS ?releaseDate)
       (SAMPLE(?imdb) AS ?imdbId)
       (SAMPLE(?posterImage) AS ?poster)
       (SAMPLE(?runtimeMinutes) AS ?runtime)
WHERE {
  ?film wdt:P31 wd:Q11424;
        wdt:P577 ?candidateDate;
        wdt:P4947 ?tmdbId;
        rdfs:label ?filmLabel.
  FILTER(LANG(?filmLabel) = "en")
  FILTER(
    ?candidateDate >= "${range.start}T00:00:00Z"^^xsd:dateTime &&
    ?candidateDate <= "${range.end}T23:59:59Z"^^xsd:dateTime
  )
  FILTER NOT EXISTS {
    ?film wdt:P577 ?earlierDate.
    FILTER(?earlierDate < "${range.start}T00:00:00Z"^^xsd:dateTime)
  }
  OPTIONAL { ?film wdt:P345 ?imdb. }
  OPTIONAL { ?film wdt:P18 ?posterImage. }
  OPTIONAL { ?film wdt:P2047 ?runtimeMinutes. }
}
GROUP BY ?film ?filmLabel ?tmdbId
ORDER BY ?releaseDate
LIMIT ${pageSize + 1}
OFFSET ${(page - 1) * pageSize}
  `.trim();
  const queryUrl = new URL("https://query.wikidata.org/sparql");
  queryUrl.searchParams.set("query", query);

  const apiResponse = await fetchWithTimeout(
    queryUrl,
    {
      headers: {
        ...wikidataHeaders(),
        Accept: "application/sparql-results+json",
      },
    },
    25_000,
  );
  if (!apiResponse.ok) {
    throw new Error(`Wikidata returned ${apiResponse.status}.`);
  }

  const data = await apiResponse.json();
  const normalized = normalizeWikidataUpcomingBindings(
    data?.results?.bindings || [],
    { rangeStart: range.start, rangeEnd: range.end },
  );
  const hasMore = normalized.length > pageSize;
  const movies = await mapWithConcurrency(
    normalized.slice(0, pageSize),
    3,
    async (movie) => {
      const trailer = await fetchBackupTrailer(movie);
      return { ...movie, trailer };
    },
  );

  return {
    source: "Wikidata",
    trailerSources: ["KinoCheck", ...(youtubeApiKey ? ["YouTube"] : [])],
    attribution:
      "Upcoming release backup data is provided by Wikidata. Trailer lookup is provided by KinoCheck.",
    rangeStart: range.start,
    rangeEnd: range.end,
    region: requestedRegion,
    releaseScope: "Global announced release dates",
    page,
    totalPages: hasMore ? page + 1 : page,
    totalResults: null,
    totalResultsKnown: false,
    hasMore,
    movies,
  };
}

async function fetchBackupTrailer(movie) {
  try {
    const kinoCheckTrailer = await fetchKinoCheckTrailer(movie.id);
    if (kinoCheckTrailer) return kinoCheckTrailer;
  } catch {
    // Continue to the optional YouTube Data API fallback.
  }

  if (!youtubeApiKey) return null;
  try {
    return await fetchYouTubeTrailer(movie);
  } catch {
    return null;
  }
}

async function fetchKinoCheckTrailer(tmdbId) {
  const url = new URL("https://api.kinocheck.com/movies");
  url.search = new URLSearchParams({
    tmdb_id: String(tmdbId),
    language: "en",
    categories: "Trailer",
  }).toString();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (kinoCheckApiKey) {
    headers["X-Api-Key"] = kinoCheckApiKey;
    headers["X-Api-Host"] = "api.kinocheck.com";
  }

  const apiResponse = await fetchWithTimeout(url, { headers }, 6_000);
  if (!apiResponse.ok) {
    throw new Error(`KinoCheck returned ${apiResponse.status}.`);
  }
  return normalizeKinoCheckTrailer(await apiResponse.json());
}

async function fetchYouTubeTrailer({ title, year, releaseDate }) {
  if (!youtubeApiKey || !title) return null;
  const releaseYear = Number(year || String(releaseDate || "").slice(0, 4)) || null;
  const cacheKey = `${String(title).toLowerCase()}|${releaseYear || ""}`;
  const cached = youtubeTrailerCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < youtubeTrailerCacheMs) {
    return cached.trailer;
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({
    part: "snippet",
    q: [
      title,
      releaseYear || "",
      "official trailer",
      "-fan",
      "-concept",
      "-reaction",
      "-review",
      "-breakdown",
    ]
      .filter(Boolean)
      .join(" "),
    type: "video",
    maxResults: "10",
    videoEmbeddable: "true",
    safeSearch: "moderate",
    relevanceLanguage: "en",
    key: youtubeApiKey,
  }).toString();

  const apiResponse = await fetchWithTimeout(
    url,
    { headers: { Accept: "application/json" } },
    8_000,
  );
  if (!apiResponse.ok) {
    throw new Error(`YouTube returned ${apiResponse.status}.`);
  }

  const data = await apiResponse.json();
  const trailer = selectYouTubeTrailer(data.items || [], title, releaseYear);
  youtubeTrailerCache.set(cacheKey, { trailer, savedAt: Date.now() });
  return trailer;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function handlePosterFallback(url, response) {
  const title = (url.searchParams.get("title") || "").trim();
  const year = (url.searchParams.get("year") || "").trim();
  const imdbId = (url.searchParams.get("imdbId") || "").trim();
  const mediaType = normalizeMediaParam(url.searchParams.get("media"), "movie");
  const locales = new Set(
    (url.searchParams.get("locales") || "")
      .split(/[|,]/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const excludedPosterUrls = new Set(
    url.searchParams
      .getAll("exclude")
      .flatMap((value) => value.split("|"))
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (!title && !imdbId) {
    return sendJson(response, 400, {
      error: "Provide a title or IMDb ID for poster lookup.",
    });
  }

  const cacheKey = `${mediaType}|${imdbId || ""}|${title.toLowerCase()}|${year}|${[...excludedPosterUrls].join(",")}`;
  if (posterFallbackCache.has(cacheKey)) {
    return sendJson(response, 200, posterFallbackCache.get(cacheKey));
  }

  const lookup = {
    title,
    year,
    imdbId,
    mediaType,
    locales,
    excludedPosterUrls,
  };
  const sourcesTried = [];
  const sourceProblems = [];

  for (const sourceConfig of posterFallbackSources(mediaType, locales)) {
    sourcesTried.push(sourceConfig.source);

    try {
      const poster = await sourceConfig.fetcher(lookup);
      if (poster?.posterUrl && !excludedPosterUrls.has(poster.posterUrl)) {
        const payload = {
          enabled: true,
          source: sourceConfig.source,
          attribution: sourceConfig.attribution,
          sourcesTried,
          ...poster,
        };

        posterFallbackCache.set(cacheKey, payload);
        return sendJson(response, 200, payload);
      }
    } catch (error) {
      sourceProblems.push(`${sourceConfig.source}: ${error.message}`);
    }
  }

  const optionalSourceHint = [
    !tmdbApiKey && !tmdbAccessToken
      ? "Set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY for a stronger dedicated poster database."
      : "",
    !omdbApiKey ? "Set OMDB_API_KEY for OMDb/IMDb-backed metadata posters." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const payload = {
    enabled: false,
    source: "Poster fallback",
    posterUrl: "",
    attribution: posterFallbackAttribution,
    sourcesTried,
    message: `No poster was found from ${sourcesTried.join(", ")}.${optionalSourceHint ? ` ${optionalSourceHint}` : ""}`,
    detail: sourceProblems.slice(0, 4).join(" / "),
  };

  posterFallbackCache.set(cacheKey, payload);
  return sendJson(response, 200, payload);
}

function posterFallbackSources(mediaType, locales = new Set()) {
  const isTv = mediaType === "tv";
  const isJapaneseTv = isTv && locales.has("japan");
  const isEnglishTv = isTv && (locales.has("us") || locales.has("english"));
  const isKoreanTv = isTv && locales.has("korea");

  return [
    ...(tmdbApiKey || tmdbAccessToken
      ? [
          {
            source: "TMDb",
            attribution: tmdbAttribution,
            fetcher: fetchTmdbPoster,
          },
        ]
      : []),
    ...(omdbApiKey
      ? [
          {
            source: "OMDb",
            attribution: omdbAttribution,
            fetcher: fetchOmdbPoster,
          },
        ]
      : []),
    ...(isJapaneseTv
      ? [
          {
            source: "Jikan",
            attribution: jikanAttribution,
            fetcher: fetchJikanAnimePoster,
          },
          {
            source: "Kitsu",
            attribution: kitsuAttribution,
            fetcher: fetchKitsuAnimePoster,
          },
        ]
      : []),
    ...(isEnglishTv
      ? [
          {
            source: "TVmaze",
            attribution: tvmazeAttribution,
            fetcher: fetchTvmazePoster,
          },
        ]
      : []),
    ...(isKoreanTv
      ? [
          {
            source: "Wikimedia",
            attribution: wikimediaAttribution,
            fetcher: fetchWikimediaPoster,
          },
        ]
      : []),
    {
      source: "iTunes Search",
      attribution: itunesAttribution,
      fetcher: fetchItunesPoster,
    },
    ...(!isKoreanTv
      ? [
          {
            source: "Wikimedia",
            attribution: wikimediaAttribution,
            fetcher: fetchWikimediaPoster,
          },
        ]
      : []),
    ...(isTv && !isEnglishTv
      ? [
          {
            source: "TVmaze",
            attribution: tvmazeAttribution,
            fetcher: fetchTvmazePoster,
          },
        ]
      : []),
    {
      source: "Wikidata",
      attribution: wikidataAttribution,
      fetcher: fetchWikidataPoster,
    },
  ];
}

async function fetchTmdbPoster({
  title,
  year,
  imdbId,
  mediaType,
  excludedPosterUrls = new Set(),
}) {
  let titleRecord = null;
  const isTv = mediaType === "tv";

  if (imdbId) {
    const data = await tmdbRequest(`/find/${encodeURIComponent(imdbId)}`, {
      external_source: "imdb_id",
    });
    titleRecord = chooseTmdbTitle(
      isTv ? data.tv_results || [] : data.movie_results || [],
      title,
      year,
      mediaType,
    );
  }

  if (!titleRecord && title) {
    const searchParams = {
      query: title,
      include_adult: "false",
      language: "en-US",
    };
    if (year) searchParams[isTv ? "first_air_date_year" : "year"] = year;

    const data = await tmdbRequest(isTv ? "/search/tv" : "/search/movie", searchParams);
    titleRecord = chooseTmdbTitle(data.results || [], title, year, mediaType);
  }

  if (!titleRecord?.id) {
    return {
      posterUrl: "",
      sourceUrl: "",
    };
  }

  let posters = [];
  try {
    const imageData = await tmdbRequest(
      `/${isTv ? "tv" : "movie"}/${titleRecord.id}/images`,
      {
        language: "en-US",
        include_image_language: "en,null",
      },
    );
    posters = imageData.posters || [];
  } catch {
    // The search result poster remains usable if the optional images lookup fails.
  }

  const selectedPoster = chooseTmdbPoster({
    posters,
    defaultPath: titleRecord.poster_path || "",
    excludedUrls: excludedPosterUrls,
  });
  const sourceUrl = `https://www.themoviedb.org/${isTv ? "tv" : "movie"}/${titleRecord.id}`;

  if (!selectedPoster) {
    return { posterUrl: "", sourceUrl };
  }

  return {
    posterUrl: tmdbPosterUrl(selectedPoster.file_path),
    sourceUrl,
    tmdbId: titleRecord.id,
  };
}

async function fetchOmdbPoster({
  title,
  year,
  imdbId,
  mediaType,
  excludedPosterUrls = new Set(),
}) {
  if (!omdbApiKey || (!title && !imdbId)) return { posterUrl: "" };

  const searchUrl = new URL("https://www.omdbapi.com/");
  searchUrl.searchParams.set("apikey", omdbApiKey);
  searchUrl.searchParams.set("plot", "short");
  searchUrl.searchParams.set("r", "json");
  searchUrl.searchParams.set("type", mediaType === "tv" ? "series" : "movie");
  if (imdbId) {
    searchUrl.searchParams.set("i", imdbId);
  } else {
    searchUrl.searchParams.set("t", title);
  }
  if (year) searchUrl.searchParams.set("y", year);

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
    },
  });
  if (!response.ok) throw httpStatusError("OMDb poster lookup failed", response.status);

  const data = await response.json();
  if (data.Response === "False" || !data.Poster || data.Poster === "N/A") {
    return { posterUrl: "" };
  }
  if (excludedPosterUrls.has(data.Poster)) return { posterUrl: "" };

  const candidateYear = posterYear(data.Year);
  const score = posterCandidateScore({
    candidateTitle: data.Title,
    targetTitle: title || data.Title,
    targetYear: Number(year),
    candidateYear,
    description: `${data.Plot || ""} ${data.Genre || ""}`,
    posterUrl: data.Poster,
  });
  if (score < 52) return { posterUrl: "" };

  return {
    posterUrl: data.Poster,
    sourceUrl: data.imdbID ? `https://www.imdb.com/title/${data.imdbID}/` : "",
    imdbId: data.imdbID || imdbId || "",
    pageTitle: data.Title || title,
  };
}

async function fetchJikanAnimePoster({
  title,
  year,
  mediaType,
  excludedPosterUrls = new Set(),
}) {
  if (!title || mediaType !== "tv") return { posterUrl: "" };

  const searchUrl = new URL("https://api.jikan.moe/v4/anime");
  searchUrl.search = new URLSearchParams({
    q: title,
    limit: "10",
    type: "tv",
  }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
    },
  });
  if (!response.ok) throw httpStatusError("Jikan anime poster lookup failed", response.status);

  const data = await response.json();
  const candidates = (data.data || [])
    .map((anime) => {
      const candidateTitle = anime.title_english || anime.title || "";
      const posterUrl =
        anime.images?.jpg?.large_image_url ||
        anime.images?.webp?.large_image_url ||
        anime.images?.jpg?.image_url ||
        "";
      if (!candidateTitle || !posterUrl || excludedPosterUrls.has(posterUrl)) return null;

      const candidateYear = anime.year || anime.aired?.prop?.from?.year || 0;
      const score =
        posterCandidateScore({
          candidateTitle,
          targetTitle: title,
          targetYear: Number(year),
          candidateYear,
          description: [
            anime.title,
            anime.title_japanese,
            anime.synopsis,
            anime.type,
            ...(anime.genres || []).map((genre) => genre.name),
          ]
            .filter(Boolean)
            .join(" "),
          posterUrl,
        }) + (anime.type === "TV" ? 10 : 0);

      return {
        posterUrl,
        sourceUrl: anime.url || "",
        pageTitle: candidateTitle,
        mediaType: "tv",
        score,
      };
    })
    .filter(Boolean);

  return bestPosterCandidate(candidates);
}

async function fetchKitsuAnimePoster({
  title,
  year,
  mediaType,
  excludedPosterUrls = new Set(),
}) {
  if (!title || mediaType !== "tv") return { posterUrl: "" };

  const searchUrl = new URL("https://kitsu.io/api/edge/anime");
  searchUrl.search = new URLSearchParams({
    "filter[text]": title,
    "page[limit]": "10",
  }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
    },
  });
  if (!response.ok) throw httpStatusError("Kitsu anime poster lookup failed", response.status);

  const data = await response.json();
  const candidates = (data.data || [])
    .map((anime) => {
      const attributes = anime.attributes || {};
      const candidateTitle =
        attributes.titles?.en ||
        attributes.titles?.en_jp ||
        attributes.canonicalTitle ||
        "";
      const posterUrl =
        attributes.posterImage?.original ||
        attributes.posterImage?.large ||
        attributes.posterImage?.medium ||
        "";
      if (!candidateTitle || !posterUrl || excludedPosterUrls.has(posterUrl)) return null;

      const candidateYear = posterYear(attributes.startDate);
      const score =
        posterCandidateScore({
          candidateTitle,
          targetTitle: title,
          targetYear: Number(year),
          candidateYear,
          description: [
            attributes.canonicalTitle,
            attributes.titles?.ja_jp,
            attributes.synopsis,
            attributes.showType,
          ]
            .filter(Boolean)
            .join(" "),
          posterUrl,
        }) + (attributes.showType === "TV" ? 10 : 0);

      return {
        posterUrl,
        sourceUrl: anime.links?.self || "",
        pageTitle: candidateTitle,
        mediaType: "tv",
        score,
      };
    })
    .filter(Boolean);

  return bestPosterCandidate(candidates);
}

async function fetchItunesPoster({
  title,
  year,
  mediaType,
  locales = new Set(),
  excludedPosterUrls = new Set(),
}) {
  if (!title) return { posterUrl: "" };

  const candidates = [];
  for (const country of itunesCountriesForLocales(locales)) {
    for (const search of itunesCatalogSearches(mediaType)) {
      const data = await fetchItunesSearch(title, search, 12, country);
      candidates.push(
        ...(data.results || [])
          .map((item) => {
            const candidateTitle = item.trackName || item.collectionName || "";
            const posterUrl = highResolutionItunesArtwork(
              item.artworkUrl100 || item.artworkUrl60 || "",
            );
            if (!candidateTitle || !posterUrl || excludedPosterUrls.has(posterUrl)) return null;

            const candidateYear = itunesYear(item.releaseDate);
            const score =
              posterCandidateScore({
                candidateTitle,
                targetTitle: title,
                targetYear: Number(year),
                candidateYear,
                description: `${item.longDescription || item.shortDescription || ""} ${item.primaryGenreName || ""}`,
                posterUrl,
              }) + (country !== "US" ? 4 : 0);

            return {
              posterUrl,
              sourceUrl: item.trackViewUrl || item.collectionViewUrl || "",
              pageTitle: candidateTitle,
              mediaType: search.mediaType,
              country,
              score,
            };
          })
          .filter(Boolean),
      );
    }
  }

  return bestPosterCandidate(candidates);
}

async function fetchTvmazePoster({
  title,
  year,
  mediaType,
  locales = new Set(),
  excludedPosterUrls = new Set(),
}) {
  if (!title || mediaType !== "tv") return { posterUrl: "" };

  const searchUrl = new URL("https://api.tvmaze.com/search/shows");
  searchUrl.searchParams.set("q", title);

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
    },
  });
  if (!response.ok) throw httpStatusError("TVmaze poster lookup failed", response.status);

  const data = await response.json();
  const candidates = (data || [])
    .map((item) => {
      const show = item.show || {};
      const posterUrl = show.image?.original || show.image?.medium || "";
      if (!show.name || !posterUrl || excludedPosterUrls.has(posterUrl)) return null;

      const candidateYear = posterYear(show.premiered);
      const score =
        posterCandidateScore({
          candidateTitle: show.name,
          targetTitle: title,
          targetYear: Number(year),
          candidateYear,
          description: `${show.summary || ""} ${(show.genres || []).join(" ")}`,
          posterUrl,
        }) +
        Math.min(10, Number(item.score || 0) * 10) +
        tvmazeLocaleBonus(show, locales);

      return {
        posterUrl,
        sourceUrl: show.url || "",
        pageTitle: show.name,
        mediaType: "tv",
        score,
      };
    })
    .filter(Boolean);

  return bestPosterCandidate(candidates);
}

async function fetchWikidataPoster({
  title,
  year,
  mediaType,
  locales = new Set(),
  excludedPosterUrls = new Set(),
}) {
  if (!title) return { posterUrl: "" };

  const searchUrl = new URL("https://www.wikidata.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "wbsearchentities",
    format: "json",
    language: "en",
    uselang: "en",
    type: "item",
    limit: "12",
    search: title,
    origin: "*",
  }).toString();

  const searchResponse = await fetch(searchUrl, {
    headers: wikidataHeaders(),
  });
  if (!searchResponse.ok) {
    throw httpStatusError("Wikidata poster search failed", searchResponse.status);
  }

  const searchData = await searchResponse.json();
  const ids = (searchData.search || []).map((item) => item.id).filter(Boolean);
  if (!ids.length) return { posterUrl: "" };

  const entities = await fetchWikidataEntities(ids);
  const candidates = ids
    .map((id) => normalizeWikidataTitle(id, entities[id], mediaType))
    .filter((item) => item?.posterUrl && !excludedPosterUrls.has(item.posterUrl))
    .map((item) => ({
      posterUrl: item.posterUrl,
      sourceUrl: item.wikidataUrl || "",
      pageTitle: item.title,
      mediaType: item.mediaType,
      score: posterCandidateScore({
        candidateTitle: item.title,
        targetTitle: title,
        targetYear: Number(year),
        candidateYear: item.year,
        description: `${item.description} ${[...locales].join(" ")}`,
        posterUrl: item.posterUrl,
      }),
    }));

  return bestPosterCandidate(candidates);
}

function bestPosterCandidate(candidates, minimumScore = 52) {
  const best = candidates
    .filter((candidate) => candidate?.posterUrl)
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < minimumScore) return { posterUrl: "" };

  const { score, ...poster } = best;
  return poster;
}

function itunesCountriesForLocales(locales = new Set()) {
  const countries = [];
  if (locales.has("japan")) countries.push("JP");
  if (locales.has("korea")) countries.push("KR");
  if (locales.has("english")) countries.push("GB");
  countries.push("US");
  return [...new Set(countries)];
}

function tvmazeLocaleBonus(show, locales = new Set()) {
  const countryCode = show.network?.country?.code || show.webChannel?.country?.code || "";
  const language = String(show.language || "").toLowerCase();
  let bonus = 0;

  if (locales.has("us") && countryCode === "US") bonus += 14;
  if (locales.has("korea") && countryCode === "KR") bonus += 14;
  if (locales.has("japan") && countryCode === "JP") bonus += 14;
  if (locales.has("english") && language === "english") bonus += 8;

  return bonus;
}

function posterCandidateScore({
  candidateTitle,
  targetTitle,
  targetYear,
  candidateYear,
  description = "",
  posterUrl = "",
}) {
  const normalizedCandidate = normalizeLookupText(candidateTitle);
  const normalizedTarget = normalizeLookupText(targetTitle);
  const haystack = normalizeLookupText(`${candidateTitle} ${description}`);
  const targetTokens = normalizedTarget.split(" ").filter((token) => token.length > 2);
  let score = 0;

  if (!normalizedCandidate || !normalizedTarget) return 0;
  if (posterUrl) score += 30;
  if (normalizedCandidate === normalizedTarget) score += 65;
  if (normalizedCandidate.startsWith(normalizedTarget)) score += 34;
  if (normalizedCandidate.includes(normalizedTarget) && normalizedTarget.length > 2) score += 26;
  if (normalizedTarget.includes(normalizedCandidate) && normalizedCandidate.length > 2) score += 18;
  if (haystack.includes(normalizedTarget) && normalizedTarget.length > 2) score += 12;

  if (targetTokens.length) {
    const matchedTokens = targetTokens.filter((token) => haystack.includes(token)).length;
    score += matchedTokens * 8;
  }

  if (targetYear && candidateYear) {
    if (Number(candidateYear) === Number(targetYear)) {
      score += 22;
    } else if (Math.abs(Number(candidateYear) - Number(targetYear)) <= 1) {
      score += 8;
    } else {
      score -= 8;
    }
  } else if (targetYear && haystack.includes(String(targetYear))) {
    score += 8;
  }

  return score;
}

function posterYear(value) {
  const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

async function fetchWikimediaPoster({
  title,
  year,
  mediaType,
  locales = new Set(),
  excludedPosterUrls = new Set(),
}) {
  if (!title) return { posterUrl: "" };

  const queries = wikimediaPosterQueries(title, mediaType, locales);
  const candidates = [];
  const titleCandidates = wikimediaPosterTitleCandidates(title, mediaType, locales);

  try {
    candidates.push(
      ...(await wikipediaSummaryPosterCandidates(
        titleCandidates,
        year,
        mediaType,
        excludedPosterUrls,
      )),
    );
  } catch {
    // Try the remaining free poster sources.
  }

  try {
    candidates.push(
      ...(await wikipediaGuessedFileCandidates(
        title,
        year,
        mediaType,
        excludedPosterUrls,
      )),
    );
  } catch {
    // Try the remaining free poster sources.
  }

  try {
    candidates.push(
      ...(await wikipediaArticleFileCandidates(
        titleCandidates,
        year,
        mediaType,
        excludedPosterUrls,
      )),
    );
  } catch {
    // Try the remaining free poster sources.
  }

  try {
    const directData = await wikipediaPageImagesByTitles(titleCandidates);

    Object.values(directData.query?.pages || {}).forEach((page) => {
      const posterUrl = page.thumbnail?.source || page.original?.source || "";
      if (!posterUrl || excludedPosterUrls.has(posterUrl)) return;

      candidates.push({
        posterUrl,
        sourceUrl: page.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`,
        pageTitle: page.title || "",
        extract: page.extract || "",
        query: "direct title",
        year,
        mediaType,
      });
    });
  } catch {
    // Search can still find a useful title image.
  }

  for (const query of queries) {
    try {
      const data = await wikipediaPageImageSearch(query);
      Object.values(data.query?.pages || {}).forEach((page) => {
        const posterUrl = page.thumbnail?.source || page.original?.source || "";
        if (!posterUrl || excludedPosterUrls.has(posterUrl)) return;

        candidates.push({
          posterUrl,
          sourceUrl: page.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`,
          pageTitle: page.title || "",
          extract: page.extract || "",
          query,
          year,
          mediaType,
        });
      });
    } catch {
      // Keep any candidates already found.
    }
  }

  const normalizedTitle = normalizeLookupText(title);
  const viableCandidates = candidates.filter((candidate) => {
    const candidateTitle = normalizeLookupText(candidate.pageTitle);
    return candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle);
  });
  const best = viableCandidates
    .map((candidate) => ({
      candidate,
      score: wikimediaPosterScore(candidate, title),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 40) return { posterUrl: "" };

  return {
    posterUrl: best.candidate.posterUrl,
    sourceUrl: best.candidate.sourceUrl,
    pageTitle: best.candidate.pageTitle,
  };
}

async function wikipediaSummaryPosterCandidates(
  titles,
  year,
  mediaType,
  excludedPosterUrls,
) {
  const candidates = [];

  for (const title of [...new Set(titles)]) {
    try {
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const response = await fetch(summaryUrl, { headers: wikidataHeaders() });
      if (!response.ok) continue;

      const data = await response.json();
      const posterUrl = data.thumbnail?.source || data.originalimage?.source || "";
      if (!posterUrl || excludedPosterUrls.has(posterUrl)) continue;

      candidates.push({
        posterUrl,
        sourceUrl: data.content_urls?.desktop?.page || data.content_urls?.mobile?.page || "",
        pageTitle: data.title || title,
        extract: data.extract || "",
        query: "summary",
        year,
        mediaType,
      });
    } catch {
      // Continue through the candidate list; a missing summary is normal.
    }
  }

  return candidates;
}

async function wikipediaGuessedFileCandidates(
  title,
  year,
  mediaType,
  excludedPosterUrls,
) {
  const fileTitles = guessedWikipediaFileTitles(title, year, mediaType);
  const imageInfo = await wikipediaFileInfo(fileTitles);

  return Object.values(imageInfo.query?.pages || {})
    .map((page) => {
      const imageInfoItem = page?.imageinfo?.[0];
      const posterUrl = imageInfoItem?.thumburl || imageInfoItem?.url || "";
      if (!posterUrl || excludedPosterUrls.has(posterUrl)) return null;

      return {
        posterUrl,
        sourceUrl: imageInfoItem?.descriptionurl || "",
        pageTitle: title,
        extract: `${title} ${mediaType === "tv" ? "television series" : "film"} ${page.title || ""}`,
        fileTitle: page.title || "",
        query: "guessed file",
        year,
        mediaType,
      };
    })
    .filter(Boolean);
}

function guessedWikipediaFileTitles(title, year, mediaType) {
  const baseTitle = title.trim();
  const extensions = ["jpg", "jpeg", "png", "webp"];
  const descriptors =
    mediaType === "tv"
      ? [
          "poster",
          "title card",
          "logo",
          "key visual",
          "promotional poster",
          "TV series poster",
        ]
      : ["poster", "film poster", "theatrical poster"];
  const titleForms = [baseTitle];

  if (year && mediaType === "tv") {
    titleForms.push(`${baseTitle} (${year} TV series)`);
    titleForms.push(`${baseTitle} (${year} television series)`);
  } else if (year) {
    titleForms.push(`${baseTitle} (${year} film)`);
  }

  const files = [];
  titleForms.forEach((titleForm) => {
    descriptors.forEach((descriptor) => {
      extensions.forEach((extension) => {
        files.push(`File:${titleForm} ${descriptor}.${extension}`);
        files.push(`File:${titleForm}_${descriptor.replace(/\s+/g, "_")}.${extension}`);
      });
    });
  });

  return [...new Set(files)];
}

async function wikipediaArticleFileCandidates(
  titles,
  year,
  mediaType,
  excludedPosterUrls,
) {
  const pagesData = await wikipediaArticleImagesByTitles(titles);
  const fileCandidates = [];

  Object.values(pagesData.query?.pages || {}).forEach((page) => {
    const pageTitle = page.title || "";
    const extract = page.extract || "";

    (page.images || []).forEach((image) => {
      const fileTitle = image.title || "";
      if (!imageFileLooksLikePoster(fileTitle)) return;

      fileCandidates.push({
        fileTitle,
        pageTitle,
        extract,
      });
    });
  });

  const uniqueFiles = [...new Map(fileCandidates.map((item) => [item.fileTitle, item])).values()].slice(0, 24);
  if (!uniqueFiles.length) return [];

  const imageInfo = await wikipediaFileInfo(uniqueFiles.map((item) => item.fileTitle));
  const infoByTitle = new Map(
    Object.values(imageInfo.query?.pages || {}).map((page) => [page.title, page]),
  );

  return uniqueFiles
    .map((candidate) => {
      const page = infoByTitle.get(candidate.fileTitle);
      const imageInfoItem = page?.imageinfo?.[0];
      const posterUrl = imageInfoItem?.thumburl || imageInfoItem?.url || "";
      if (!posterUrl || excludedPosterUrls.has(posterUrl)) return null;

      return {
        posterUrl,
        sourceUrl: imageInfoItem?.descriptionurl || "",
        pageTitle: candidate.pageTitle,
        extract: `${candidate.extract} ${candidate.fileTitle}`,
        fileTitle: candidate.fileTitle,
        query: "article file",
        year,
        mediaType,
      };
    })
    .filter(Boolean);
}

async function wikipediaArticleImagesByTitles(titles) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    titles: [...new Set(titles)].join("|"),
    redirects: "1",
    prop: "images|extracts|info",
    imlimit: "50",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    inprop: "url",
    format: "json",
    origin: "*",
  }).toString();

  const response = await fetch(searchUrl, { headers: wikidataHeaders() });
  if (!response.ok) {
    throw new Error(`Wikipedia article image lookup failed: ${response.status}`);
  }

  return response.json();
}

async function wikipediaFileInfo(fileTitles) {
  const pages = {};

  for (const chunk of chunkArray([...new Set(fileTitles)].filter(Boolean), 40)) {
    const data = await wikipediaFileInfoChunk(chunk);
    Object.assign(pages, data.query?.pages || {});
  }

  return { query: { pages } };
}

async function wikipediaFileInfoChunk(fileTitles) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    titles: fileTitles.join("|"),
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: "600",
    format: "json",
    origin: "*",
  }).toString();

  const response = await fetch(searchUrl, { headers: wikidataHeaders() });
  if (!response.ok) {
    throw new Error(`Wikipedia file image lookup failed: ${response.status}`);
  }

  return response.json();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function imageFileLooksLikePoster(fileTitle) {
  return (
    /\.(jpe?g|png|webp)$/i.test(fileTitle) &&
    /\b(poster|title[ _-]?card|key[ _-]?visual|visual|promotional|promo|cover|logo)\b/i.test(
      fileTitle,
    )
  );
}

function wikimediaPosterTitleCandidates(title, mediaType, locales = new Set()) {
  const baseTitle = title.trim();
  if (mediaType === "tv") {
    const candidates = [
      baseTitle,
      `${baseTitle} (TV series)`,
      `${baseTitle} (television series)`,
      `${baseTitle} (British TV series)`,
      `${baseTitle} (American TV series)`,
    ];

    if (locales.has("japan")) {
      candidates.push(
        `${baseTitle} (anime)`,
        `${baseTitle} (Japanese TV series)`,
        `${baseTitle} (Japanese television series)`,
        `${baseTitle} (Japanese drama)`,
      );
    }
    if (locales.has("korea")) {
      candidates.push(
        `${baseTitle} (South Korean TV series)`,
        `${baseTitle} (South Korean television series)`,
        `${baseTitle} (Korean drama)`,
      );
    }

    return candidates;
  }

  return [baseTitle, `${baseTitle} (film)`, `${baseTitle} (movie)`];
}

function wikimediaPosterQueries(title, mediaType, locales = new Set()) {
  const baseTitle = title.trim();
  if (mediaType === "tv") {
    const queries = [
      `${baseTitle} television series`,
      `${baseTitle} TV series`,
      `${baseTitle} drama`,
      baseTitle,
    ];

    if (locales.has("japan")) {
      queries.unshift(
        `${baseTitle} anime television series`,
        `${baseTitle} anime`,
        `${baseTitle} Japanese TV series`,
        `${baseTitle} Japanese drama`,
      );
    }
    if (locales.has("korea")) {
      queries.unshift(
        `${baseTitle} Korean drama`,
        `${baseTitle} K-drama`,
        `${baseTitle} South Korean television series`,
      );
    }

    return [...new Set(queries)];
  }

  return [`${baseTitle} film`, `${baseTitle} movie`, baseTitle];
}

async function wikipediaPageImagesByTitles(titles) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    titles: [...new Set(titles)].join("|"),
    redirects: "1",
    prop: "pageimages|extracts|info",
    piprop: "thumbnail|original",
    pithumbsize: "600",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    inprop: "url",
    format: "json",
    origin: "*",
  }).toString();

  const response = await fetch(searchUrl, { headers: wikidataHeaders() });
  if (!response.ok) {
    throw new Error(`Wikipedia title image lookup failed: ${response.status}`);
  }

  return response.json();
}

async function wikipediaPageImageSearch(query, resultLimit = 8) {
  const baseParams = {
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(Math.max(1, Math.min(40, Number(resultLimit) || 8))),
    prop: "pageimages|extracts|info",
    piprop: "thumbnail|original",
    pithumbsize: "600",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    inprop: "url",
    format: "json",
    origin: "*",
  };
  const pages = {};
  let continuation = {};

  for (let requestIndex = 0; requestIndex < 5; requestIndex += 1) {
    const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
    searchUrl.search = new URLSearchParams({ ...baseParams, ...continuation }).toString();
    const response = await fetch(searchUrl, { headers: wikidataHeaders() });
    if (!response.ok) {
      throw new Error(`Wikipedia image search failed: ${response.status}`);
    }

    const data = await response.json();
    Object.entries(data.query?.pages || {}).forEach(([pageId, page]) => {
      pages[pageId] = { ...(pages[pageId] || {}), ...page };
    });
    if (!data.continue) break;
    continuation = data.continue;
  }

  return { query: { pages } };
}

function wikimediaPosterScore(candidate, title) {
  const normalizedTitle = normalizeLookupText(title);
  const candidateTitle = normalizeLookupText(candidate.pageTitle);
  const fileName = wikimediaFileLabel(candidate);
  const normalizedFileName = normalizeLookupText(fileName);
  const titleAndExtract = `${candidate.pageTitle} ${candidate.extract}`;
  const haystack = normalizeLookupText(`${candidate.pageTitle} ${candidate.extract} ${fileName}`);
  const targetYear = Number(candidate.year);
  let score = 0;

  if (candidate.posterUrl) score += 30;
  if (candidateTitle === normalizedTitle) score += 45;
  if (candidateTitle.includes(normalizedTitle)) score += 24;
  if (normalizedTitle && !candidateTitle.includes(normalizedTitle)) score -= 55;
  if (normalizedTitle && haystack.includes(normalizedTitle)) score += 10;
  if (targetYear && haystack.includes(String(targetYear))) score += 8;

  if (candidate.mediaType === "tv") {
    const hasTvSignal = /\b(television|tv|anime|drama|miniseries|sitcom|streaming)\b/i.test(
      titleAndExtract,
    );
    if (hasTvSignal) score += 22;
    if (/\b(tv series|television series|anime)\b/i.test(candidate.pageTitle)) score += 18;
    if (/\bepisode\b/i.test(candidate.extract)) score -= 30;
    if (/\bfilm\b/i.test(candidate.extract)) score -= 18;
    if (
      !hasTvSignal &&
      /\b(manga|comic|novel|book|video game|franchise)\b/i.test(titleAndExtract)
    ) {
      score -= 45;
    }
    if (
      /\b(manga|volume|novel|book|comic|video game)\b/i.test(normalizedFileName) &&
      !/\b(tv|television|poster|key visual|title card)\b/i.test(normalizedFileName)
    ) {
      score -= 100;
    }
  } else {
    if (/\b(film|movie)\b/i.test(candidate.extract)) score += 18;
    if (/\btelevision series\b/i.test(candidate.extract)) score -= 22;
  }

  if (/\b(poster|key visual|title card|cover)\b/i.test(normalizedFileName)) score += 34;
  if (/\b(promotional|promo|visual)\b/i.test(normalizedFileName)) score += 18;
  if (/\blogo\b/i.test(normalizedFileName)) score -= 8;
  if (/\b(disambiguation|list of|awards?)\b/i.test(candidate.pageTitle)) score -= 60;
  if (/(\.svg|\/svg\/)/i.test(candidate.posterUrl)) score -= 18;

  return score;
}

function wikimediaFileLabel(candidate) {
  const urlFileName = (candidate.posterUrl || "").split(/[/?#]/).filter(Boolean).pop() || "";
  return `${candidate.fileTitle || ""} ${safeDecodeURIComponent(urlFileName)}`;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function tmdbRequest(pathname, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, value);
  });
  if (tmdbApiKey && !tmdbAccessToken) url.searchParams.set("api_key", tmdbApiKey);

  const apiResponse = await fetch(url, { headers: tmdbHeaders() });
  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    throw new Error(`TMDb returned ${apiResponse.status}: ${detail.slice(0, 160)}`);
  }

  return apiResponse.json();
}

function tmdbHeaders() {
  const headers = { Accept: "application/json" };
  if (tmdbAccessToken) headers.Authorization = `Bearer ${tmdbAccessToken}`;
  return headers;
}

function chooseTmdbTitle(results, title, year, mediaType) {
  const normalizedTitle = normalizeLookupText(title);
  const targetYear = Number(year);

  return results
    .filter((titleRecord) => titleRecord && (titleRecord.poster_path || titleRecord.id))
    .sort(
      (a, b) =>
        tmdbTitleScore(b, normalizedTitle, targetYear, mediaType) -
        tmdbTitleScore(a, normalizedTitle, targetYear, mediaType),
    )[0];
}

function tmdbTitleScore(titleRecord, normalizedTitle, targetYear, mediaType) {
  const isTv = mediaType === "tv";
  const candidateTitle = normalizeLookupText(
    titleRecord.title ||
      titleRecord.original_title ||
      titleRecord.name ||
      titleRecord.original_name ||
      "",
  );
  const dateValue = isTv ? titleRecord.first_air_date || "" : titleRecord.release_date || "";
  const releaseYear = Number(dateValue.slice(0, 4));
  let score = 0;

  if (titleRecord.poster_path) score += 20;
  if (normalizedTitle && candidateTitle === normalizedTitle) score += 30;
  if (normalizedTitle && candidateTitle.includes(normalizedTitle)) score += 12;
  if (targetYear && releaseYear === targetYear) score += 20;
  score += Math.min(10, Number(titleRecord.vote_count || 0) / 100);
  score += Number(titleRecord.popularity || 0) / 20;

  return score;
}

function normalizeLookupText(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function handleGlobalMovies(url, response) {
  const query = (url.searchParams.get("q") || "").trim();
  const mediaType = normalizeMediaParam(url.searchParams.get("media"), "movie");
  const limit = Math.max(
    1,
    Math.min(30, Number(url.searchParams.get("limit") || 12)),
  );

  if (query.length < 2) {
    return sendJson(response, 400, { error: "Search at least 2 characters." });
  }

  const cacheKey = `${mediaType}|${query.toLowerCase()}|${limit}`;
  const cached = globalCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < globalCatalogCacheMs) {
    return sendJson(response, 200, { ...cached.payload, cached: true });
  }

  const preferredSources = [
    ...(tmdbApiKey || tmdbAccessToken ? [fetchTmdbCatalogMovies] : []),
    fetchItunesCatalogMovies,
    fetchWikidataCatalogMovies,
    fetchWikipediaCatalogMovies,
  ];
  const sourceProblems = [];
  const combinedMovies = [];
  const combinedSources = [];

  for (const fetchCatalogMovies of preferredSources) {
    try {
      const payload = await fetchCatalogMovies(query, mediaType, limit);
      if (payload.movies.length) {
        combinedSources.push(payload.source);
        combinedMovies.push(
          ...payload.movies.map((movie, index) => ({
            ...movie,
            source: movie.source || payload.source,
            combinedRank: combinedMovies.length + index,
          })),
        );
      }
    } catch (error) {
      sourceProblems.push(error);
    }
  }

  if (combinedMovies.length) {
    const movies = dedupeCatalogPayloads(combinedMovies)
      .sort(
        (a, b) =>
          genericConceptTitlePenalty(a, query) - genericConceptTitlePenalty(b, query) ||
          (a.combinedRank || 0) - (b.combinedRank || 0),
      )
      .slice(0, limit)
      .map(({ combinedRank, ...movie }, catalogRank) => ({ ...movie, catalogRank }));
    const payload = {
      mode: "global",
      source: combinedSources.length > 1 ? "Multiple catalogs" : combinedSources[0],
      sourcesChecked: combinedSources,
      mediaType,
      query,
      movies,
    };

    globalCatalogCache.set(cacheKey, { payload, savedAt: Date.now() });
    return sendJson(response, 200, payload);
  }

  const payload = fetchOfflineCatalogMovies(query, mediaType, limit);
  payload.warning = payload.movies.length
    ? "Trusted online catalogs did not return a match, so these results came from the offline backup catalog."
    : "Trusted online catalogs are temporarily unavailable, and no offline backup title matched that search.";
  if (payload.movies.length) {
    globalCatalogCache.set(cacheKey, { payload, savedAt: Date.now() });
  }
  if (!payload.movies.length && sourceProblems.length) {
    payload.detail = sourceProblems.map((error) => error.message).filter(Boolean).slice(0, 3).join(" / ");
  }
  return sendJson(response, 200, payload);
}

function genericConceptTitlePenalty(movie, query) {
  const normalizedQuery = normalizeLookupText(query);
  if (normalizedQuery !== "superhero") return 0;
  const normalizedTitle = normalizeLookupText(movie.title);
  return normalizedTitle === normalizedQuery || normalizedTitle === `${normalizedQuery} movie` ? 1 : 0;
}

async function fetchWikidataCatalogMovies(query, mediaType, limit) {
  const searchUrl = new URL("https://www.wikidata.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "wbsearchentities",
    format: "json",
    language: "en",
    uselang: "en",
    type: "item",
    limit: String(Math.min(30, limit * 3)),
    search: query,
    origin: "*",
  }).toString();

  const searchResponse = await fetch(searchUrl, {
    headers: wikidataHeaders(),
  });
  if (!searchResponse.ok) {
    throw httpStatusError("Wikidata search failed", searchResponse.status);
  }

  const searchData = await searchResponse.json();
  const ids = (searchData.search || [])
    .map((item) => item.id)
    .filter(Boolean);
  if (!ids.length)
    return {
      mode: "global",
      source: "Wikidata",
      mediaType,
      query,
      movies: [],
    };

  const entities = await fetchWikidataEntities(ids);
  const movies = ids
    .map((id) => normalizeWikidataTitle(id, entities[id], mediaType))
    .filter(Boolean)
    .slice(0, limit);

  return {
    mode: "global",
    source: "Wikidata",
    mediaType,
    query,
    movies,
  };
}

async function fetchTmdbCatalogMovies(query, mediaType, limit) {
  const searches = tmdbCatalogSearches(mediaType);
  const results = [];

  for (const search of searches) {
    const data = await tmdbRequest(search.pathname, {
      query,
      include_adult: "false",
      language: "en-US",
      page: "1",
    });
    results.push(
      ...(data.results || []).map((item) =>
        normalizeTmdbCatalogTitle(item, query, search.mediaType),
      ),
    );
  }

  const movies = dedupeCatalogPayloads(results)
    .filter(Boolean)
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, limit)
    .map(({ searchScore, ...movie }) => movie);

  return {
    mode: "global",
    source: "TMDb",
    mediaType,
    query,
    movies,
  };
}

function tmdbCatalogSearches(mediaType) {
  if (mediaType === "tv") return [{ pathname: "/search/tv", mediaType: "tv" }];
  if (mediaType === "all") {
    return [
      { pathname: "/search/movie", mediaType: "movie" },
      { pathname: "/search/tv", mediaType: "tv" },
    ];
  }

  return [{ pathname: "/search/movie", mediaType: "movie" }];
}

function normalizeTmdbCatalogTitle(item, query, mediaType) {
  const title = mediaType === "tv" ? item.name || item.original_name : item.title || item.original_title;
  if (!title) return null;

  const releaseDate = mediaType === "tv" ? item.first_air_date : item.release_date;
  const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "";
  const description =
    item.overview ||
    `${title} ${mediaType === "tv" ? "TV show" : "movie"} from TMDb.`.trim();
  const searchScore = tmdbCatalogScore(title, description, query, item.popularity);
  if (searchScore < 18) return null;

  return {
    id: `tmdb-${mediaType}-${item.id}`,
    title,
    year: tmdbYear(releaseDate),
    runtime: null,
    description,
    posterUrl,
    posterSource: posterUrl ? "TMDb" : "",
    mediaType,
    imdbId: "",
    wikidataUrl: `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${item.id}`,
    searchScore,
  };
}

function tmdbCatalogScore(title, description, query, popularity = 0) {
  const normalizedQuery = normalizeLookupText(query);
  const normalizedTitle = normalizeLookupText(title);
  const haystack = normalizeLookupText(`${title} ${description}`);
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 78;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 38;
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) score += 26;
  if (haystack.includes(normalizedQuery)) score += 12;
  score += Math.min(16, Number(popularity || 0) / 10);

  return score;
}

function tmdbYear(releaseDate) {
  const match = String(releaseDate || "").match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : 0;
}

async function fetchWikipediaCatalogMovies(query, mediaType, limit) {
  const searchTerms = wikipediaCatalogQueries(query, mediaType);
  const pagesById = new Map();

  for (const searchTerm of searchTerms) {
    const resultLimit = searchTerm.startsWith("deepcategory:") ? 40 : 8;
    const data = await wikipediaPageImageSearch(searchTerm, resultLimit);
    Object.values(data.query?.pages || {}).forEach((page) => {
      if (page.pageid) pagesById.set(page.pageid, page);
    });
    if (pagesById.size >= limit * 3) break;
  }

  const movies = [...pagesById.values()]
    .map((page) => normalizeWikipediaCatalogTitle(page, query, mediaType))
    .filter(Boolean)
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, limit)
    .map(({ searchScore, ...movie }) => movie);

  return {
    mode: "global",
    source: "Wikipedia",
    mediaType,
    query,
    movies,
  };
}

function wikipediaCatalogQueries(query, mediaType) {
  const base = query.trim();
  const normalized = normalizeLookupText(base);
  const superheroDiscovery =
    normalized === "superhero" && mediaType !== "tv"
      ? ["deepcategory:\"Superhero films\" -intitle:list"]
      : [];
  if (mediaType === "tv") {
    return [`${base} television series`, `${base} TV series`, `${base} anime`, base];
  }
  if (mediaType === "all") {
    return [
      ...superheroDiscovery,
      `${base} film`,
      `${base} movie`,
      `${base} television series`,
      base,
    ];
  }

  return [...superheroDiscovery, `${base} film`, `${base} movie`, base];
}

function normalizeWikipediaCatalogTitle(page, query, requestedMedia) {
  const pageTitle = page.title || "";
  const extract = page.extract || "";
  if (isCatalogReferencePage(pageTitle, extract)) return null;
  const mediaType = detectWikipediaMedia(pageTitle, extract, requestedMedia);
  if (!pageTitle || !mediaType) return null;

  const title = displayWikipediaTitle(pageTitle);
  const posterUrl = page.thumbnail?.source || page.original?.source || "";
  const searchScore = wikipediaCatalogScore({
    pageTitle,
    title,
    extract,
    posterUrl,
    query,
    mediaType,
    searchIndex: page.index,
  });
  if (searchScore < 20) return null;

  return {
    id: `wikipedia-${page.pageid}`,
    title,
    year: wikipediaYearFromText(`${pageTitle} ${extract}`),
    runtime: null,
    description: extract || `${title} ${mediaType === "tv" ? "television series" : "film"}`,
    posterUrl,
    posterSource: posterUrl ? "Wikipedia" : "",
    mediaType,
    wikidataUrl: page.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`,
    searchScore,
  };
}

function detectWikipediaMedia(pageTitle, extract, requestedMedia) {
  const extractText = String(extract || "");
  const leadSentence =
    extractText.match(/^.*?[.!?](?=\s+[A-Z]|$)/)?.[0] || extractText.slice(0, 500);
  const haystack = `${pageTitle} ${leadSentence}`.toLowerCase();
  const tvMatch = /\b(tv series|television series|web series|miniseries|anime television|korean drama|drama series|sitcom)\b/.test(
    haystack,
  );
  const movieMatch = /\b(film|movie|documentary film|animated film|feature film|short film)\b/.test(
    haystack,
  );

  if (requestedMedia === "tv") return tvMatch ? "tv" : null;
  if (requestedMedia === "movie") return movieMatch && !tvMatch ? "movie" : null;
  if (movieMatch && !tvMatch) return "movie";
  if (tvMatch) return "tv";
  return null;
}

function displayWikipediaTitle(title) {
  return title
    .replace(/\s+\((?:\d{4}\s+)?(?:film|movie|TV series|television series|miniseries|anime|drama)\)$/i, "")
    .trim();
}

function wikipediaYearFromText(text) {
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function wikipediaCatalogScore({ pageTitle, title, extract, posterUrl, query, mediaType, searchIndex }) {
  const normalizedQuery = normalizeLookupText(query);
  const normalizedTitle = normalizeLookupText(title);
  const normalizedPageTitle = normalizeLookupText(pageTitle);
  const haystack = normalizeLookupText(`${pageTitle} ${extract}`);
  let score = 0;

  if (posterUrl) score += 14;
  if (normalizedTitle === normalizedQuery || normalizedPageTitle === normalizedQuery) score += 60;
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) score += 28;
  if (haystack.includes(normalizedQuery)) score += 14;
  if (normalizedQuery === "superhero" && !haystack.includes("superhero")) score -= 80;
  if (normalizedQuery === "superhero" && Number.isFinite(Number(searchIndex))) {
    score += Math.max(0, 42 - Number(searchIndex));
  }
  if (mediaType === "tv" && /\b(series|episode|season|television|anime)\b/i.test(extract)) score += 15;
  if (mediaType === "movie" && /\b(film|movie|cinema|directed by)\b/i.test(extract)) score += 15;
  if (/\b(disambiguation|song|album|book|novel|game|video game|character)\b/i.test(extract)) score -= 30;

  return score;
}

async function fetchBackupCatalogMovies(query, mediaType, limit, warning) {
  try {
    const payload = await fetchItunesCatalogMovies(query, mediaType, limit);
    if (payload.movies.length) {
      payload.warning = warning.replace("backup catalog", "iTunes Search");
      return payload;
    }
  } catch {
    // Continue to the offline backup catalog.
  }

  const payload = fetchOfflineCatalogMovies(query, mediaType, limit);
  payload.warning = payload.movies.length
    ? warning
    : "Online catalogs are temporarily limited, and no offline backup title matched that search.";
  return payload;
}

async function fetchItunesCatalogMovies(query, mediaType, limit) {
  const searches = itunesCatalogSearches(mediaType);
  const results = [];

  for (const search of searches) {
    const data = await fetchItunesSearch(query, search, limit);
    results.push(
      ...(data.results || []).map((item) =>
        normalizeItunesCatalogTitle(item, query, search.mediaType),
      ),
    );
  }

  const movies = dedupeCatalogPayloads(results)
    .filter(Boolean)
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, limit)
    .map(({ searchScore, ...movie }) => movie);

  return {
    mode: "global",
    source: "iTunes Search",
    mediaType,
    query,
    movies,
  };
}

function itunesCatalogSearches(mediaType) {
  if (mediaType === "tv") return [{ media: "tvShow", entity: "tvSeason", mediaType: "tv" }];
  if (mediaType === "all") {
    return [
      { media: "movie", entity: "movie", mediaType: "movie" },
      { media: "tvShow", entity: "tvSeason", mediaType: "tv" },
    ];
  }

  return [{ media: "movie", entity: "movie", mediaType: "movie" }];
}

async function fetchItunesSearch(query, search, limit, country = "US") {
  const searchUrl = new URL("https://itunes.apple.com/search");
  searchUrl.search = new URLSearchParams({
    term: query,
    country,
    media: search.media,
    entity: search.entity,
    limit: String(Math.min(25, Math.max(1, limit))),
  }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
    },
  });
  if (!response.ok) throw httpStatusError("iTunes Search failed", response.status);
  return response.json();
}

function normalizeItunesCatalogTitle(item, query, mediaType) {
  const title = item.trackName || item.collectionName || "";
  if (!title) return null;

  const description =
    [
      item.longDescription || item.shortDescription || title,
      item.primaryGenreName,
      mediaType === "tv" ? "TV show" : "movie",
    ]
      .filter(Boolean)
      .join(" ");
  const artwork = highResolutionItunesArtwork(item.artworkUrl100 || item.artworkUrl60 || "");
  const searchScore = itunesCatalogScore(title, description, query, item.primaryGenreName);
  if (searchScore < 18) return null;

  return {
    id: `itunes-${item.trackId || item.collectionId || normalizeLookupText(title)}`,
    title,
    year: itunesYear(item.releaseDate),
    runtime: item.trackTimeMillis ? Math.round(Number(item.trackTimeMillis) / 60000) : null,
    description,
    posterUrl: artwork,
    posterSource: artwork ? "iTunes Search" : "",
    mediaType,
    imdbId: "",
    wikidataUrl: item.trackViewUrl || item.collectionViewUrl || "",
    searchScore,
  };
}

function itunesCatalogScore(title, description, query, genre = "") {
  const normalizedQuery = normalizeLookupText(query);
  const normalizedTitle = normalizeLookupText(title);
  const haystack = normalizeLookupText(`${title} ${description} ${genre}`);
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 70;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 35;
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) score += 24;
  if (haystack.includes(normalizedQuery)) score += 12;
  if (/\b(movie|film|tv|series|season|episode)\b/i.test(description)) score += 8;

  return score;
}

function highResolutionItunesArtwork(url) {
  return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, "/600x600bb.$1");
}

function itunesYear(releaseDate) {
  const match = String(releaseDate || "").match(/^(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : 0;
}

function dedupeCatalogPayloads(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.title) return false;
    const key = `${item.mediaType}|${normalizeLookupText(item.title)}|${item.year || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fetchOfflineCatalogMovies(query, mediaType, limit) {
  const movies = offlineGlobalCatalog
    .filter((item) => mediaType === "all" || item.mediaType === mediaType)
    .map((item) => ({ ...item, searchScore: offlineCatalogScore(item, query) }))
    .filter((item) => item.searchScore > 0)
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, limit)
    .map(({ searchScore, ...item }) => item);

  return {
    mode: "global",
    source: "Offline backup",
    mediaType,
    query,
    movies,
  };
}

function offlineCatalogScore(item, query) {
  const normalizedQuery = normalizeLookupText(query);
  const normalizedTitle = normalizeLookupText(item.title);
  const haystack = normalizeLookupText(`${item.title} ${item.description} ${item.year}`);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 90;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 46;
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) score += 32;
  score += queryTokens.filter((token) => haystack.includes(token)).length * 12;

  return score;
}

const offlineGlobalCatalog = [
  {
    id: "offline-seven-samurai",
    title: "Seven Samurai",
    year: 1954,
    runtime: 207,
    description: "Japanese samurai epic directed by Akira Kurosawa about villagers hiring warriors for protection.",
    posterUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Seven%20Samurai%20poster2.jpg?width=360",
    posterSource: "Wikimedia Commons",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-spirited-away",
    title: "Spirited Away",
    year: 2001,
    runtime: 125,
    description: "Japanese animated fantasy film about a young girl navigating a mysterious spirit world.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-oldboy",
    title: "Oldboy",
    year: 2003,
    runtime: 120,
    description: "South Korean mystery thriller about revenge, captivity, and a devastating hidden truth.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-train-to-busan",
    title: "Train to Busan",
    year: 2016,
    runtime: 118,
    description: "South Korean action horror film set during a zombie outbreak on a high-speed train.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-in-the-mood-for-love",
    title: "In the Mood for Love",
    year: 2000,
    runtime: 98,
    description: "Hong Kong romantic drama about longing, restraint, memory, and missed connection.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-city-of-god",
    title: "City of God",
    year: 2002,
    runtime: 130,
    description: "Brazilian crime drama following youth, violence, survival, and ambition in Rio de Janeiro.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-pans-labyrinth",
    title: "Pan's Labyrinth",
    year: 2006,
    runtime: 118,
    description: "Dark Spanish fantasy drama mixing fairy-tale horror with postwar political cruelty.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-a-separation",
    title: "A Separation",
    year: 2011,
    runtime: 123,
    description: "Iranian family drama about marriage, caregiving, class pressure, and moral uncertainty.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-drive-my-car",
    title: "Drive My Car",
    year: 2021,
    runtime: 179,
    description: "Japanese drama about grief, theater, silence, and unexpected emotional honesty.",
    posterUrl: "",
    posterSource: "",
    mediaType: "movie",
    wikidataUrl: "",
  },
  {
    id: "offline-breaking-bad",
    title: "Breaking Bad",
    year: 2008,
    runtime: 47,
    description: "American crime drama series about a chemistry teacher becoming a drug kingpin.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
  {
    id: "offline-attack-on-titan",
    title: "Attack on Titan",
    year: 2013,
    runtime: 24,
    description: "Japanese anime action drama about humanity fighting giant man-eating Titans.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
  {
    id: "offline-shogun",
    title: "Shogun",
    year: 2024,
    runtime: 58,
    description: "Historical drama series set in feudal Japan with political strategy and culture clash.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
  {
    id: "offline-squid-game",
    title: "Squid Game",
    year: 2021,
    runtime: 55,
    description: "South Korean survival thriller series about deadly games, debt, and social pressure.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
  {
    id: "offline-reply-1988",
    title: "Reply 1988",
    year: 2015,
    runtime: 90,
    description: "South Korean slice-of-life family drama about friendship, neighborhood bonds, and nostalgia.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
  {
    id: "offline-alice-in-borderland",
    title: "Alice in Borderland",
    year: 2020,
    runtime: 50,
    description: "Japanese science-fiction thriller series about survival games in an abandoned Tokyo.",
    posterUrl: "",
    posterSource: "",
    mediaType: "tv",
    wikidataUrl: "",
  },
];

function httpStatusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchWikidataEntities(ids) {
  const entityUrl = new URL("https://www.wikidata.org/w/api.php");
  entityUrl.search = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    languages: "en",
    props: "labels|descriptions|claims",
    ids: ids.join("|"),
    origin: "*",
  }).toString();

  const response = await fetch(entityUrl, { headers: wikidataHeaders() });
  if (!response.ok)
    throw httpStatusError("Wikidata entity fetch failed", response.status);
  const data = await response.json();
  return data.entities || {};
}

function normalizeWikidataTitle(id, entity, requestedMedia) {
  if (!entity || entity.missing) return null;

  const title = entity.labels?.en?.value;
  const description = entity.descriptions?.en?.value || "";
  if (isCatalogReferencePage(title, description)) return null;
  const mediaType = detectWikidataMedia(entity, description, requestedMedia);
  if (!title || !mediaType) return null;

  const year =
    wikidataYear(entity.claims?.P577) ||
    wikidataYear(entity.claims?.P571) ||
    wikidataYear(entity.claims?.P580);
  const runtime = wikidataQuantity(entity.claims?.P2047);
  const image = wikidataImage(entity.claims?.P18);
  const imdbId = wikidataString(entity.claims?.P345);

  return {
    id,
    title,
    year,
    runtime,
    description,
    posterUrl: image,
    imdbId,
    mediaType,
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
  };
}

function isCatalogReferencePage(title = "", description = "") {
  const normalizedTitle = normalizeLookupText(title);
  const normalizedDescription = normalizeLookupText(description);

  if (/^(?:list of|category|index of)\b/.test(normalizedTitle)) return true;
  if (
    /\b(?:disambiguation page|film genre|genre of films|genre of fiction|fiction genre|fictional character|film character|television character|character appearing in|media franchise|production company|subgenre of)\b/.test(
      normalizedDescription,
    )
  ) {
    return true;
  }
  return (
    /^(?:superhero film|superhero film character)$/.test(normalizedTitle) ||
    /\bfilm series$/.test(normalizedTitle)
  );
}

function normalizeMediaParam(value, fallback = "all") {
  if (value === "movie" || value === "tv" || value === "all") return value;
  return fallback;
}

function detectWikidataMedia(entity, description, requestedMedia) {
  const movieTypeIds = new Set([
    "Q11424",
    "Q506240",
    "Q29168811",
    "Q24862",
    "Q202866",
    "Q93204",
    "Q229390",
    "Q5185279",
  ]);
  const tvTypeIds = new Set([
    "Q5398426",
    "Q15416",
    "Q1259759",
    "Q581714",
  ]);
  const instanceIds = (entity.claims?.P31 || [])
    .map((claim) => claim.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
  const looksEpisodeOrSeason = /\b(episode|season) of (a )?television series\b/i.test(
    description,
  );
  const looksMovie =
    instanceIds.some((instanceId) => movieTypeIds.has(instanceId)) ||
    /\b(film|movie|cinema|documentary|short|feature)\b/i.test(description);
  const looksTv =
    !looksEpisodeOrSeason &&
    (instanceIds.some((instanceId) => tvTypeIds.has(instanceId)) ||
      /\b(tv|television)\s+(series|show|program|programme|miniseries)\b|\bweb series\b|\bsitcom\b|\bstreaming television\b/i.test(
        description,
      ));

  if (requestedMedia === "movie") return looksMovie ? "movie" : null;
  if (requestedMedia === "tv") return looksTv ? "tv" : null;
  if (looksTv && !looksMovie) return "tv";
  if (looksMovie) return "movie";
  if (looksTv) return "tv";
  return null;
}

function wikidataYear(claims = []) {
  const value = claims[0]?.mainsnak?.datavalue?.value?.time;
  if (!value) return null;
  const match = value.match(/[+-](\d{4})/);
  return match ? Number(match[1]) : null;
}

function wikidataQuantity(claims = []) {
  const amount = claims[0]?.mainsnak?.datavalue?.value?.amount;
  if (!amount) return null;
  const number = Number(amount);
  return Number.isFinite(number) ? Math.round(Math.abs(number)) : null;
}

function wikidataImage(claims = []) {
  const filename = claims[0]?.mainsnak?.datavalue?.value;
  if (!filename) return "";
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=360`;
}

function wikidataString(claims = []) {
  return claims[0]?.mainsnak?.datavalue?.value || "";
}

function wikidataHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": "ReelMoodAIPrototype/1.0 (local prototype)",
  };
}

async function handleAiRecommendation(request, response) {
  const body = await readJsonBody(request);

  if (!apiKey) {
    return sendJson(response, 200, {
      mode: "offline",
      message:
        "Set GEMINI_API_KEY and restart the server to enable live AI recommendations.",
      recommendations: [],
    });
  }

  // Guard the free quota: cap AI calls per visitor per minute.
  if (isRateLimited(clientIp(request))) {
    return sendJson(response, 200, {
      mode: "rate-limited",
      message: "AI rate limit reached for a moment. Semantic search is still active.",
      retryAfterSeconds: 60,
      recommendations: [],
    });
  }

  const payload = {
    userRequest: body.userRequest || "",
    settings: body.settings || {},
    candidates: (body.candidates || []).slice(0, 15),
  };
  const cacheKey = JSON.stringify({ model, payload });
  const cached = geminiResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < geminiResponseCacheMs) {
    return sendJson(response, 200, { ...cached.result, cached: true });
  }

  const systemInstruction =
    "You are the AI semantic search and decision layer for a movie and TV recommendation app. Rank candidates for the user's natural-language request, chosen format, TV origin/language, crowd, internal viewer-fit signals, personal reviews, freshness, genre, mood, story fit, and decision lens. Respect settings.searchIntent: never contradict an explicit exclusion, do not repeat excluded subjects in recommendation explanations, and treat preferLess entries as ranking penalties rather than hard bans. The candidate viewerFitScore and qualitySignalScore are internal app estimates, not IMDb, Rotten Tomatoes, or other external ratings; never describe them as sourced audience or critic scores. Do not mention streaming platforms, availability, or where to watch. Return only compact JSON.";

  const userPrompt = [
    "Choose the best movie or TV recommendations from these candidates.",
    "Infer the user's meaning even when the search is casual, indirect, misspelled, or mood-based.",
    "Honor the parsed lookingFor, excluding, and preferLess intent in settings.searchIntent. Never reintroduce excluded content or name excluded subjects in decision, why, or watchWarning text.",
    "Use story similarity, genre/mood fit, internal viewer-fit and quality signals, personal reviews, format preference, TV origin/language preference, selected crowd, freshnessAdjustment, recentlyShown, and decision lens heavily.",
    "Do not keep choosing the same safest title when a fresh candidate is still a strong fit.",
    "Never mention where the title streams, source availability, rental, purchase, or platform names.",
    "Also write answer as a direct response to the user's search bar request. It should feel like an AI search assistant, mention the kind of titles found, name 1-3 best candidates, and briefly explain why. Keep answer to 1-2 sentences.",
    'Return JSON with this shape: {"answer":"short user-facing answer","recommendations":[{"title":"Movie title","aiScore":1-99,"decision":"short direct decision help","why":["reason","reason"],"watchWarning":"short caution"}]}',
    JSON.stringify(payload),
  ].join("\n\n");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const requestBody = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    // Force the model to return raw JSON so we can parse it reliably.
    generationConfig: { responseMimeType: "application/json" },
  };

  let apiResponse;
  try {
    apiResponse = await fetchGeminiWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      geminiTimeoutMs,
    );
  } catch (error) {
    return sendJson(response, 200, {
      mode: "error",
      message: "Gemini is temporarily unavailable. Semantic search is still active.",
      error: "Gemini request failed after retries",
      detail: error.name === "AbortError" ? "Request timed out" : error.message,
      recommendations: [],
    });
  }

  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    const isRateLimited = apiResponse.status === 429;
    const isKeyProblem = [400, 401, 403].includes(apiResponse.status);
    return sendJson(response, 200, {
      mode: isRateLimited ? "rate-limited" : "error",
      message: isRateLimited
        ? "Gemini is rate-limited right now. Semantic search is still active."
        : isKeyProblem
          ? "Gemini rejected the server key. Check GEMINI_API_KEY and restart the server."
          : "Gemini is temporarily unavailable. Semantic search is still active.",
      error: "Gemini request failed",
      status: apiResponse.status,
      retryAfterSeconds: isRateLimited ? 60 : undefined,
      detail: detail.slice(0, 500),
      recommendations: [],
    });
  }

  const data = await apiResponse.json();
  const text = extractOutputText(data);
  const parsed = parseModelJson(text);

  if (!text) {
    return sendJson(response, 200, {
      mode: "error",
      message: "Gemini returned an empty response. Semantic search is still active.",
      recommendations: [],
    });
  }

  const result = {
    mode: "live",
    model,
    answer: typeof parsed.answer === "string" ? parsed.answer : "",
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : [],
  };
  geminiResponseCache.set(cacheKey, { result, savedAt: Date.now() });
  return sendJson(response, 200, result);
}

function isRetryableGeminiStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(3000, retryAfter * 1000);
  }
  return Math.min(3000, 300 * 2 ** attempt);
}

async function fetchGeminiWithRetry(url, options, timeoutMs) {
  for (let attempt = 0; attempt <= geminiRetryLimit; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (
        response.ok ||
        !isRetryableGeminiStatus(response.status) ||
        attempt === geminiRetryLimit
      ) {
        return response;
      }

      await response.text().catch(() => "");
      await delay(retryDelayMs(response, attempt));
    } catch (error) {
      if (attempt === geminiRetryLimit) throw error;
      await delay(Math.min(3000, 300 * 2 ** attempt));
    }
  }

  throw new Error("Gemini retry limit reached");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Gemini returns candidates[].content.parts[].text
function extractOutputText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return { recommendations: [] };
      }
    }

    return { recommendations: [] };
  }
}

function serveStatic(pathname, response) {
  let file = decodeURIComponent(pathname);
  if (file === "/") file = "/index.html";

  const fullPath = path.normalize(path.join(root, file));
  if (!fullPath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type":
        contentTypes[path.extname(fullPath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

server.listen(port, host, () => {
  console.log(`ReelMood AI running at http://${host}:${port}/`);
  console.log(
    apiKey
      ? `Live AI enabled with ${model}`
      : "Live AI offline: set GEMINI_API_KEY to enable it.",
  );
  console.log(
    tmdbApiKey || tmdbAccessToken
      ? "TMDb poster fallback enabled."
      : "TMDb poster fallback offline: set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY to enable it.",
  );
});
