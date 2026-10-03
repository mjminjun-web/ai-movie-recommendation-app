const { tmdbPosterUrl } = require("./poster-ranking");

const TMDB_GENRES = new Map([
  [12, "Adventure"],
  [14, "Fantasy"],
  [16, "Animation"],
  [18, "Drama"],
  [27, "Horror"],
  [28, "Action"],
  [35, "Comedy"],
  [36, "History"],
  [37, "Western"],
  [53, "Thriller"],
  [80, "Crime"],
  [99, "Documentary"],
  [878, "Science Fiction"],
  [9648, "Mystery"],
  [10402, "Music"],
  [10749, "Romance"],
  [10751, "Family"],
  [10752, "War"],
  [10770, "TV Movie"],
]);

function futureDateRange(startDate, daysAhead = 365) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) {
    throw new RangeError("Start date must use YYYY-MM-DD format.");
  }
  const numericDays = Number(daysAhead);
  if (!Number.isInteger(numericDays) || numericDays < 1 || numericDays > 730) {
    throw new RangeError("Future release range must be between 1 and 730 days.");
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw new RangeError("Start date is invalid.");
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + numericDays);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function selectTmdbTrailer(videos = []) {
  const candidates = videos
    .filter((video) => video?.site === "YouTube")
    .filter((video) => isYoutubeVideoId(video.key))
    .sort((a, b) => tmdbTrailerScore(b) - tmdbTrailerScore(a));

  const selected = candidates[0];
  if (!selected) return null;
  return {
    key: selected.key,
    name: selected.name || "Official trailer",
    type: selected.type || "Trailer",
    official: Boolean(selected.official),
    source: "TMDb",
    sourceUrl: `https://www.youtube.com/watch?v=${selected.key}`,
  };
}

function normalizeKinoCheckTrailer(payload) {
  const selected = payload?.trailer;
  if (!selected || !isYoutubeVideoId(selected.youtube_video_id)) return null;
  return {
    key: selected.youtube_video_id,
    name: selected.title || "Official trailer",
    type: "Trailer",
    official: true,
    source: "KinoCheck",
    sourceUrl:
      selected.url ||
      payload.url ||
      `https://www.youtube.com/watch?v=${selected.youtube_video_id}`,
  };
}

function selectYouTubeTrailer(items = [], expectedTitle = "", expectedYear = null) {
  const titleTokens = trailerTokens(expectedTitle);
  if (!titleTokens.length) return null;

  const candidates = (Array.isArray(items) ? items : [])
    .map((item) => {
      const key = item?.id?.videoId;
      const name = decodeYouTubeText(item?.snippet?.title || "");
      const channelTitle = decodeYouTubeText(item?.snippet?.channelTitle || "");
      const normalizedName = normalizeTrailerText(name);
      const trustedChannel = isTrustedTrailerChannel(channelTitle);
      const matchedTokens = titleTokens.filter((token) => normalizedName.includes(token));
      const coverage = matchedTokens.length / titleTokens.length;

      if (!isYoutubeVideoId(key) || coverage < 0.6) return null;
      if (!/\b(trailer|teaser)\b/.test(normalizedName)) return null;
      if (/\b(fan ?made|concept|reaction|review|breakdown|explained|gameplay|soundtrack|clip)\b/.test(normalizedName)) {
        return null;
      }
      if (!trustedChannel) return null;

      let score = Math.round(coverage * 100) + 60;
      if (/\bofficial\b/.test(normalizedName)) score += 45;
      if (/\btrailer\b/.test(normalizedName)) score += 35;
      if (/\bteaser\b/.test(normalizedName)) score += 15;
      if (expectedYear && normalizedName.includes(String(expectedYear))) score += 10;

      return { key, name, channelTitle, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const selected = candidates[0];
  if (!selected) return null;
  return {
    key: selected.key,
    name: selected.name || "Official trailer",
    type: "Trailer",
    official: true,
    source: "YouTube",
    sourceUrl: `https://www.youtube.com/watch?v=${selected.key}`,
    channelTitle: selected.channelTitle,
  };
}

function normalizeUpcomingMovie(item, details = {}, trailer = null) {
  const title = details.title || item.title || item.original_title || "Untitled movie";
  const genreNames = Array.isArray(details.genres)
    ? details.genres.map((genre) => genre?.name).filter(Boolean)
    : [];
  const fallbackGenres = (item.genre_ids || [])
    .map((genreId) => TMDB_GENRES.get(Number(genreId)))
    .filter(Boolean);

  return {
    id: Number(item.id),
    title,
    originalTitle: details.original_title || item.original_title || title,
    releaseDate: item.release_date || details.release_date || "",
    runtime: positiveNumber(details.runtime),
    genres: [...new Set(genreNames.length ? genreNames : fallbackGenres)].slice(0, 4),
    overview: details.overview || item.overview || "",
    posterUrl: tmdbPosterUrl(details.poster_path || item.poster_path || ""),
    backdropUrl: tmdbBackdropUrl(details.backdrop_path || item.backdrop_path || ""),
    rating: positiveNumber(item.vote_average || details.vote_average),
    popularity: positiveNumber(item.popularity || details.popularity),
    trailer,
    sourceUrl: `https://www.themoviedb.org/movie/${item.id}`,
  };
}

function normalizeWikidataUpcomingBindings(
  bindings = [],
  { rangeStart = "", rangeEnd = "" } = {},
) {
  const moviesById = new Map();

  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const id = Number(bindingValue(binding, "tmdbId"));
    const title = bindingValue(binding, "filmLabel").trim();
    const releaseDate = bindingValue(binding, "releaseDate").slice(0, 10);
    const entityId = wikidataEntityId(bindingValue(binding, "film"));

    if (!Number.isInteger(id) || id < 1 || !title || /^Q\d+$/i.test(title)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) continue;
    if (rangeStart && releaseDate < rangeStart) continue;
    if (rangeEnd && releaseDate > rangeEnd) continue;

    const candidate = {
      id,
      title,
      originalTitle: title,
      releaseDate,
      year: Number(releaseDate.slice(0, 4)),
      runtime: positiveNumber(bindingValue(binding, "runtime")),
      genres: [],
      overview: "Upcoming release information provided by Wikidata.",
      posterUrl: normalizeWikidataPosterUrl(bindingValue(binding, "poster")),
      backdropUrl: "",
      rating: null,
      popularity: 0,
      trailer: null,
      imdbId: bindingValue(binding, "imdbId"),
      mediaType: "movie",
      source: "Wikidata",
      sourceUrl: entityId
        ? `https://www.wikidata.org/wiki/${entityId}`
        : bindingValue(binding, "film"),
    };

    const existing = moviesById.get(id);
    if (!existing) {
      moviesById.set(id, candidate);
      continue;
    }

    const earlier = candidate.releaseDate < existing.releaseDate ? candidate : existing;
    const later = earlier === candidate ? existing : candidate;
    earlier.posterUrl ||= later.posterUrl;
    earlier.runtime ||= later.runtime;
    earlier.imdbId ||= later.imdbId;
    moviesById.set(id, earlier);
  }

  return [...moviesById.values()].sort(
    (a, b) =>
      a.releaseDate.localeCompare(b.releaseDate) || a.title.localeCompare(b.title),
  );
}

function tmdbTrailerScore(video) {
  let score = 0;
  if (video.type === "Trailer") score += 100;
  else if (video.type === "Teaser") score += 55;
  if (video.official) score += 30;
  if (String(video.iso_639_1 || "").toLowerCase() === "en") score += 15;
  if (/official/i.test(video.name || "")) score += 8;
  if (/final trailer/i.test(video.name || "")) score += 4;
  return score;
}

function tmdbBackdropUrl(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
  return `https://image.tmdb.org/t/p/w1280${normalizedPath}`;
}

function isYoutubeVideoId(value) {
  return /^[A-Za-z0-9_-]{6,20}$/.test(String(value || ""));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function trailerTokens(value) {
  const ignored = new Set(["a", "an", "and", "of", "the"]);
  return normalizeTrailerText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !ignored.has(token));
}

function normalizeTrailerText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isTrustedTrailerChannel(value) {
  const channel = normalizeTrailerText(value);
  return /\b(warner bros pictures|universal pictures|sony pictures entertainment|paramount pictures|20th century studios|searchlight pictures|lionsgate movies|walt disney studios|marvel entertainment|amazon mgm studios|prime video|apple tv|netflix|hulu|max|a24|neon|focus features|studiocanal|shudder|gkids films|crunchyroll|aniplex|toho movie|toho animation|cj enm|lotte entertainment|showbox|kadokawa)\b/.test(
    channel,
  );
}

function decodeYouTubeText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function bindingValue(binding, key) {
  return typeof binding?.[key]?.value === "string" ? binding[key].value : "";
}

function wikidataEntityId(value) {
  return String(value || "").match(/\/(Q\d+)$/i)?.[1]?.toUpperCase() || "";
}

function normalizeWikidataPosterUrl(value) {
  if (!/^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//i.test(value)) {
    return "";
  }

  const encodedFilename = value.split("Special:FilePath/")[1]?.split(/[?#]/)[0] || "";
  let filename = encodedFilename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    // Keep the encoded filename when a source contains malformed escape sequences.
  }

  if (!/\b(poster|key[ _-]?art|one[ _-]?sheet|theatrical)[ _.-]?\b/i.test(filename)) {
    return "";
  }

  const secureUrl = value.replace(/^http:/i, "https:");
  return `${secureUrl}${secureUrl.includes("?") ? "&" : "?"}width=500`;
}

module.exports = {
  futureDateRange,
  normalizeKinoCheckTrailer,
  normalizeUpcomingMovie,
  normalizeWikidataUpcomingBindings,
  selectTmdbTrailer,
  selectYouTubeTrailer,
};
