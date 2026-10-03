const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const DEFAULT_POSTER_SIZE = "w500";
const IDEAL_POSTER_RATIO = 2 / 3;

function tmdbPosterUrl(filePath, size = DEFAULT_POSTER_SIZE) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
  return `${TMDB_IMAGE_BASE}/${size}${normalizedPath}`;
}

function chooseTmdbPoster({
  posters = [],
  defaultPath = "",
  excludedUrls = new Set(),
  size = DEFAULT_POSTER_SIZE,
} = {}) {
  const candidates = [...posters];
  if (defaultPath && !candidates.some((poster) => poster?.file_path === defaultPath)) {
    candidates.push({ file_path: defaultPath });
  }

  return candidates
    .filter((poster) => poster?.file_path)
    .filter((poster) => !excludedUrls.has(tmdbPosterUrl(poster.file_path, size)))
    .sort(
      (a, b) =>
        tmdbPosterScore(b, defaultPath) - tmdbPosterScore(a, defaultPath),
    )[0] || null;
}

function tmdbPosterScore(poster, defaultPath = "") {
  const language = String(poster.iso_639_1 || "").toLowerCase();
  const width = Number(poster.width || 0);
  const height = Number(poster.height || 0);
  const ratio = Number(poster.aspect_ratio || (width && height ? width / height : 0));
  const voteAverage = Math.max(0, Math.min(10, Number(poster.vote_average || 0)));
  const voteCount = Math.max(0, Number(poster.vote_count || 0));
  let score = 0;

  if (language === "en") score += 24;
  else if (!language) score += 10;
  if (poster.file_path === defaultPath) score += 8;
  if (width >= 500 && height >= 750) score += 5;
  if (width && height) score += Math.min(5, (width * height) / 1_000_000);
  if (ratio) score -= Math.abs(ratio - IDEAL_POSTER_RATIO) * 45;
  score += voteAverage * 1.5;
  score += Math.min(12, Math.log10(voteCount + 1) * 5);

  return score;
}

module.exports = {
  chooseTmdbPoster,
  tmdbPosterScore,
  tmdbPosterUrl,
};
