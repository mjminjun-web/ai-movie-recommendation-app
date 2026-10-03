const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chooseTmdbPoster,
  tmdbPosterUrl,
} = require("./poster-ranking");

test("builds a w500 TMDb poster URL", () => {
  assert.equal(
    tmdbPosterUrl("/iron-man.jpg"),
    "https://image.tmdb.org/t/p/w500/iron-man.jpg",
  );
});

test("prefers a strong English poster over a similar unlocalized poster", () => {
  const selected = chooseTmdbPoster({
    posters: [
      poster("/plain.jpg", null, 7.2, 20),
      poster("/english.jpg", "en", 7, 18),
    ],
  });

  assert.equal(selected.file_path, "/english.jpg");
});

test("uses votes and resolution to choose between same-language posters", () => {
  const selected = chooseTmdbPoster({
    posters: [
      poster("/small.jpg", "en", 5, 2, 300, 450),
      poster("/quality.jpg", "en", 8.4, 120, 1000, 1500),
    ],
  });

  assert.equal(selected.file_path, "/quality.jpg");
});

test("moves to an alternate poster when the current URL failed", () => {
  const excludedUrls = new Set([tmdbPosterUrl("/default.jpg")]);
  const selected = chooseTmdbPoster({
    defaultPath: "/default.jpg",
    excludedUrls,
    posters: [
      poster("/default.jpg", "en", 9, 200),
      poster("/alternate.jpg", "en", 7.5, 40),
    ],
  });

  assert.equal(selected.file_path, "/alternate.jpg");
});

test("falls back to the title record poster when image metadata is unavailable", () => {
  const selected = chooseTmdbPoster({ defaultPath: "/search-result.jpg" });
  assert.equal(selected.file_path, "/search-result.jpg");
});

test("returns null for missing or excluded candidates", () => {
  assert.equal(chooseTmdbPoster(), null);
  assert.equal(
    chooseTmdbPoster({
      defaultPath: "/failed.jpg",
      excludedUrls: new Set([tmdbPosterUrl("/failed.jpg")]),
    }),
    null,
  );
});

function poster(filePath, language, voteAverage, voteCount, width = 1000, height = 1500) {
  return {
    file_path: filePath,
    iso_639_1: language,
    vote_average: voteAverage,
    vote_count: voteCount,
    width,
    height,
    aspect_ratio: width / height,
  };
}
