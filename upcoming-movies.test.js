const test = require("node:test");
const assert = require("node:assert/strict");

const {
  futureDateRange,
  normalizeKinoCheckTrailer,
  normalizeUpcomingMovie,
  normalizeWikidataUpcomingBindings,
  selectTmdbTrailer,
  selectYouTubeTrailer,
} = require("./upcoming-movies");

test("builds a rolling upcoming window from today", () => {
  assert.deepEqual(futureDateRange("2026-07-13", 365), {
    start: "2026-07-13",
    end: "2027-07-13",
  });
});

test("rejects malformed upcoming date windows", () => {
  assert.throws(() => futureDateRange("next week", 365), RangeError);
  assert.throws(() => futureDateRange("2026-07-13", 0), RangeError);
});

test("prefers an official English TMDb trailer", () => {
  const selected = selectTmdbTrailer([
    video("teaser", "Teaser", false, "en"),
    video("foreignTrailer", "Trailer", true, "fr"),
    video("officialTrailer", "Trailer", true, "en"),
  ]);

  assert.equal(selected.key, "officialTrailer");
  assert.equal(selected.source, "TMDb");
});

test("ignores non-YouTube and malformed video entries", () => {
  assert.equal(
    selectTmdbTrailer([
      { site: "Vimeo", key: "validkey", type: "Trailer" },
      { site: "YouTube", key: "bad key", type: "Trailer" },
    ]),
    null,
  );
});

test("normalizes KinoCheck's selected trailer", () => {
  const selected = normalizeKinoCheckTrailer({
    url: "https://kinocheck.com/movie/example",
    trailer: {
      youtube_video_id: "O1M_iqSBEpA",
      title: "Official trailer",
      url: "https://kinocheck.com/trailer/example",
    },
  });

  assert.equal(selected.key, "O1M_iqSBEpA");
  assert.equal(selected.source, "KinoCheck");
});

test("selects a title-matched trailer from a trusted YouTube channel", () => {
  const selected = selectYouTubeTrailer(
    [
      youtubeResult("fanTrailer1", "Future Film Official Concept Trailer", "Fan Trailer World"),
      youtubeResult("studioTrail1", "Future Film - Official Trailer (2027)", "Warner Bros. Pictures"),
      youtubeResult("wrongMovie1", "Different Movie Official Trailer", "Universal Pictures"),
    ],
    "Future Film",
    2027,
  );

  assert.equal(selected.key, "studioTrail1");
  assert.equal(selected.source, "YouTube");
  assert.equal(selected.official, true);
});

test("rejects untrusted, fan-made, and weakly matched YouTube trailers", () => {
  assert.equal(
    selectYouTubeTrailer(
      [
        youtubeResult("fanTrailer1", "Future Film Official Trailer", "Uploads Channel"),
        youtubeResult("conceptOne1", "Future Film Concept Trailer", "Sony Pictures Entertainment"),
      ],
      "Future Film",
      2027,
    ),
    null,
  );
});

test("normalizes release, runtime, genres, artwork, and trailer metadata", () => {
  const movie = normalizeUpcomingMovie(
    {
      id: 100,
      title: "Future Film",
      release_date: "2026-05-15",
      genre_ids: [28, 878],
      poster_path: "/poster.jpg",
      popularity: 42,
    },
    { runtime: 126, overview: "A future adventure." },
    { key: "trailerKey", source: "TMDb" },
  );

  assert.equal(movie.releaseDate, "2026-05-15");
  assert.equal(movie.runtime, 126);
  assert.deepEqual(movie.genres, ["Action", "Science Fiction"]);
  assert.equal(movie.posterUrl, "https://image.tmdb.org/t/p/w500/poster.jpg");
  assert.equal(movie.trailer.key, "trailerKey");
});

test("normalizes and deduplicates Wikidata upcoming releases", () => {
  const movies = normalizeWikidataUpcomingBindings(
    [
      wikidataBinding({
        title: "Future Film",
        releaseDate: "2026-09-12T00:00:00Z",
        poster: "http://commons.wikimedia.org/wiki/Special:FilePath/Future%20Film%20poster.jpg",
      }),
      wikidataBinding({
        title: "Future Film",
        releaseDate: "2026-09-10T00:00:00Z",
      }),
    ],
    { rangeStart: "2026-07-13", rangeEnd: "2027-07-13" },
  );

  assert.equal(movies.length, 1);
  assert.equal(movies[0].id, 7654321);
  assert.equal(movies[0].releaseDate, "2026-09-10");
  assert.equal(movies[0].runtime, 118);
  assert.match(movies[0].posterUrl, /^https:\/\/commons\.wikimedia\.org/);
  assert.equal(movies[0].imdbId, "tt1234567");
});

test("rejects Wikidata placeholders, out-of-range dates, and non-poster images", () => {
  const movies = normalizeWikidataUpcomingBindings(
    [
      wikidataBinding({ title: "Q12345" }),
      wikidataBinding({ title: "Old Film", releaseDate: "2020-01-01T00:00:00Z" }),
      wikidataBinding({
        title: "Photo Film",
        poster: "http://commons.wikimedia.org/wiki/Special:FilePath/Actor%20at%20a%20festival.jpg",
      }),
    ],
    { rangeStart: "2026-07-13", rangeEnd: "2027-07-13" },
  );

  assert.equal(movies.length, 1);
  assert.equal(movies[0].title, "Photo Film");
  assert.equal(movies[0].posterUrl, "");
});

function video(key, type, official, language) {
  return {
    site: "YouTube",
    key,
    name: `${official ? "Official " : ""}${type}`,
    type,
    official,
    iso_639_1: language,
  };
}

function wikidataBinding({
  title = "Future Film",
  releaseDate = "2026-09-10T00:00:00Z",
  poster = "",
} = {}) {
  return {
    film: { value: "http://www.wikidata.org/entity/Q999999" },
    filmLabel: { value: title },
    tmdbId: { value: "7654321" },
    releaseDate: { value: releaseDate },
    runtime: { value: "118" },
    imdbId: { value: "tt1234567" },
    ...(poster ? { poster: { value: poster } } : {}),
  };
}

function youtubeResult(videoId, title, channelTitle) {
  return {
    id: { videoId },
    snippet: { title, channelTitle },
  };
}
