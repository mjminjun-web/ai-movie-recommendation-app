const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCatalogSearchQuery,
  evaluateItemAgainstIntent,
  parseSearchIntent,
  removeConstraintFromPrompt,
  summarizeIntent,
} = require("./search-intent");

function title(overrides = {}) {
  return {
    title: "Example",
    mediaType: "movie",
    year: 2020,
    runtime: 105,
    genres: [],
    moods: [],
    hints: [],
    contentWarnings: [],
    countries: [],
    languages: ["english"],
    intensity: 3,
    summary: "",
    ...overrides,
  };
}

test("scary movie but not zombies keeps horror and hard-excludes zombies", () => {
  const intent = parseSearchIntent("I want a scary movie but not zombies");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("horror"));
  assert.ok(intent.excludeTerms.includes("zombie"));

  const zombie = title({ genres: ["horror"], hints: ["undead outbreak"] });
  const haunted = title({ genres: ["horror"], hints: ["haunted house ghost"] });
  assert.equal(evaluateItemAgainstIntent(zombie, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(haunted, intent).excluded, false);
});

test("Korean thriller without romance applies origin, genre, and exclusion", () => {
  const intent = parseSearchIntent("Korean thriller without romance");
  assert.ok(intent.countries.includes("korea"));
  assert.ok(intent.genres.includes("thriller"));
  assert.ok(intent.excludedGenres.includes("romance"));

  const romantic = title({
    genres: ["thriller", "romance"],
    countries: ["korea"],
    languages: ["korean"],
  });
  const crime = title({
    genres: ["thriller", "crime"],
    countries: ["korea"],
    languages: ["korean"],
  });
  assert.equal(evaluateItemAgainstIntent(romantic, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(crime, intent).excluded, false);
});

test("Anything but animation works as an exclusion-only query", () => {
  const intent = parseSearchIntent("Anything but animation");
  assert.equal(intent.hasPositiveCriteria, false);
  assert.equal(intent.hasConstraints, true);
  assert.ok(intent.excludedGenres.includes("animation"));
  assert.equal(evaluateItemAgainstIntent(title({ genres: ["animation"] }), intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(title({ genres: ["drama"] }), intent).excluded, false);
  assert.deepEqual(summarizeIntent(intent).lookingFor, ["Anything else"]);
});

test("but is a contrast boundary and does not negate by itself", () => {
  const intent = parseSearchIntent("Funny but dark");
  assert.ok(intent.genres.includes("comedy"));
  assert.ok(intent.includeTerms.includes("dark"));
  assert.equal(intent.exclusions.length, 0);
});

test("scarry movie but zombie uses the app convention that bare but excludes zombies", () => {
  const intent = parseSearchIntent("scarry movie but zombie");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("horror"));
  assert.deepEqual(intent.requiredTerms, []);
  assert.ok(intent.excludeTerms.includes("zombie"));
  assert.equal(buildCatalogSearchQuery(intent), "horror");

  const zombieMovie = title({ genres: ["horror"], hints: ["undead outbreak"] });
  const hauntedMovie = title({ genres: ["horror"], hints: ["haunted house"] });
  assert.equal(evaluateItemAgainstIntent(zombieMovie, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(hauntedMovie, intent).excluded, false);

  const pluralIntent = parseSearchIntent("scarry movie but zombies");
  assert.ok(pluralIntent.excludeTerms.includes("zombie"));
});

test("action movie but tom cruz excludes Tom Cruise titles and corrects the name", () => {
  const intent = parseSearchIntent("action movie but tom cruz");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("action"));
  assert.ok(intent.excludeTerms.includes("tom cruise"));
  assert.deepEqual(summarizeIntent(intent).excluding.map((item) => item.label), ["Tom Cruise"]);
  assert.equal(buildCatalogSearchQuery(intent), "action");

  const cruiseMovie = title({ genres: ["action"], hints: ["starring Tom Cruise"] });
  const otherMovie = title({ genres: ["action"], hints: ["starring Keanu Reeves"] });
  assert.equal(evaluateItemAgainstIntent(cruiseMovie, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(otherMovie, intent).excluded, false);
});

test("hero movie but spider man requires superheroes and excludes the Spider-Man franchise", () => {
  const intent = parseSearchIntent("hero movie but spider man");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("action"));
  assert.ok(intent.includeTerms.includes("superhero"));
  assert.ok(intent.requiredTerms.includes("superhero"));
  assert.ok(intent.excludeTerms.includes("spider man"));
  assert.equal(buildCatalogSearchQuery(intent), "superhero");

  const spiderVerse = title({
    title: "Spider-Man: Into the Spider-Verse",
    genres: ["action", "animation"],
    hints: ["superhero", "Miles Morales", "Spider-Verse"],
  });
  const xMen = title({
    title: "X-Men",
    genres: ["action", "sci-fi"],
    summary: "An American superhero film about mutant heroes.",
  });
  const unrelatedAction = title({
    title: "Unrelated Action Film",
    genres: ["action", "thriller"],
    summary: "A police chase and international spy mission.",
  });

  assert.equal(evaluateItemAgainstIntent(spiderVerse, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(xMen, intent).excluded, false);
  assert.equal(evaluateItemAgainstIntent(unrelatedAction, intent).excluded, true);
});

test("expanded rejection phrases remove command words and exclude their subject", () => {
  [
    "horror do not include zombies",
    "horror don't show zombies",
    "horror skip zombies",
    "horror leave out zombies",
    "horror none of the zombies",
    "horror other than zombies",
    "horror but I do not want zombies",
  ].forEach((query) => {
    const intent = parseSearchIntent(query);
    assert.ok(intent.genres.includes("horror"), query);
    assert.ok(intent.excludeTerms.includes("zombie"), query);
    assert.equal(intent.includeTerms.includes("include"), false, query);
    assert.equal(intent.includeTerms.includes("show"), false, query);
  });
});

test("no bad movies becomes a low-quality exclusion instead of a search keyword", () => {
  const intent = parseSearchIntent("horror movie but no bad movies");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("horror"));
  assert.deepEqual(intent.excludedQualities, ["low-quality"]);
  assert.equal(intent.excludeTerms.includes("bad"), false);
  assert.deepEqual(summarizeIntent(intent).excluding.map((item) => item.label), ["Low-rated titles"]);

  const lowRated = title({ rating: 5.8, genres: ["horror"] });
  const wellRated = title({ rating: 7.8, genres: ["horror"] });
  assert.equal(evaluateItemAgainstIntent(lowRated, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(wellRated, intent).excluded, false);
});

test("army movie find solider understands soldier typo and military intent", () => {
  const intent = parseSearchIntent("army movie find solider");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("war"));
  assert.ok(intent.includeTerms.includes("army"));
  assert.ok(intent.includeTerms.includes("soldier"));
  assert.equal(intent.includeTerms.includes("find"), false);
  assert.equal(buildCatalogSearchQuery(intent), "army soldier war");

  const militaryMovie = title({
    genres: ["war", "drama"],
    hints: ["army soldier combat battlefield"],
  });
  const unrelatedMovie = title({
    genres: ["comedy"],
    summary: "A light comedy about a family vacation.",
  });
  assert.equal(evaluateItemAgainstIntent(militaryMovie, intent).excluded, false);
  assert.equal(evaluateItemAgainstIntent(unrelatedMovie, intent).excluded, false);
});

test("not too scary is a soft penalty, not a hard ban", () => {
  const intent = parseSearchIntent("Zombie movie but not too scary");
  assert.ok(intent.includeTerms.includes("zombie"));
  assert.ok(intent.softAvoidTerms.includes("scary"));
  assert.equal(intent.exclusions.length, 0);

  const gentle = title({ genres: ["horror"], hints: ["zombie"], intensity: 3 });
  const intense = title({ genres: ["horror"], hints: ["zombie"], intensity: 5 });
  const gentleEvaluation = evaluateItemAgainstIntent(gentle, intent);
  const intenseEvaluation = evaluateItemAgainstIntent(intense, intent);
  const nonZombie = title({ genres: ["horror"], hints: ["haunted house"], intensity: 3 });
  assert.equal(gentleEvaluation.excluded, false);
  assert.equal(intenseEvaluation.excluded, false);
  assert.equal(evaluateItemAgainstIntent(nonZombie, intent).excluded, true);
  assert.ok(intenseEvaluation.softPenalty > gentleEvaluation.softPenalty);
});

test("Sherlock but not the BBC series excludes that entity, not every TV show", () => {
  const intent = parseSearchIntent("Sherlock but not the BBC series");
  assert.ok(intent.includeTerms.includes("sherlock"));
  assert.deepEqual(intent.excludedMediaTypes, []);

  const bbc = title({
    title: "Sherlock",
    mediaType: "tv",
    hints: ["BBC television series Benedict Cumberbatch"],
  });
  const film = title({ title: "Sherlock Holmes", hints: ["Robert Downey Jr detective film"] });
  assert.equal(evaluateItemAgainstIntent(bbc, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(film, intent).excluded, false);
});

test("year, gore, and runtime constraints combine deterministically", () => {
  const intent = parseSearchIntent("Horror after 2015, no gore, under two hours");
  assert.equal(intent.yearConstraints.min, 2016);
  assert.equal(intent.runtimeConstraints.maxMinutes, 120);
  assert.ok(intent.excludeTerms.includes("gore"));

  const cleanFit = title({ year: 2019, runtime: 110, genres: ["horror"] });
  const old = title({ year: 2014, runtime: 110, genres: ["horror"] });
  const long = title({ year: 2019, runtime: 140, genres: ["horror"] });
  const graphic = title({ year: 2019, runtime: 110, genres: ["horror"], contentWarnings: ["gore"] });
  assert.equal(evaluateItemAgainstIntent(cleanFit, intent).excluded, false);
  assert.equal(evaluateItemAgainstIntent(old, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(long, intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(graphic, intent).excluded, true);
});

test("typos are normalized before exclusion-aware intent is built", () => {
  const intent = parseSearchIntent("scarry movie except zombie");
  assert.equal(intent.mediaType, "movie");
  assert.ok(intent.genres.includes("horror"));
  assert.ok(intent.excludeTerms.includes("zombie"));
});

test("Google-style minus syntax creates separate hard exclusions", () => {
  const intent = parseSearchIntent("horror -zombie -gore");
  assert.ok(intent.genres.includes("horror"));
  assert.deepEqual(intent.excludeTerms.sort(), ["gore", "zombie"]);
  assert.equal(
    evaluateItemAgainstIntent(title({ genres: ["horror"], hints: ["zombie"] }), intent).excluded,
    true,
  );
});

test("additional negation and media cases", () => {
  const noHorror = parseSearchIntent("not horror");
  assert.ok(noHorror.excludedGenres.includes("horror"));

  const horrorNoZombie = parseSearchIntent("horror but not zombie");
  assert.ok(horrorNoZombie.genres.includes("horror"));
  assert.ok(horrorNoZombie.excludeTerms.includes("zombie"));

  const koreanNoRomance = parseSearchIntent("Korean drama, no romance");
  assert.ok(koreanNoRomance.countries.includes("korea"));
  assert.ok(koreanNoRomance.excludedGenres.includes("romance"));

  const movieNotTv = parseSearchIntent("movie not TV show");
  assert.equal(movieNotTv.mediaType, "movie");
  assert.ok(movieNotTv.excludedMediaTypes.includes("tv"));
});

test("after 2015 but not 2020 combines a range and excluded year", () => {
  const intent = parseSearchIntent("after 2015 but not 2020");
  assert.equal(intent.yearConstraints.min, 2016);
  assert.deepEqual(intent.yearConstraints.exclude, [2020]);
  assert.equal(evaluateItemAgainstIntent(title({ year: 2019 }), intent).excluded, false);
  assert.equal(evaluateItemAgainstIntent(title({ year: 2020 }), intent).excluded, true);
  assert.equal(evaluateItemAgainstIntent(title({ year: 2015 }), intent).excluded, true);
});

test("movie titles containing rejection words stay title searches", () => {
  [
    "Don't Breathe",
    "Don't Look Up",
    "Leave No Trace",
    "Never Let Me Go",
    "No Country for Old Men",
    "Notting Hill",
    "Nothing But the Truth",
    "But I'm a Cheerleader",
  ].forEach((query) => {
    const intent = parseSearchIntent(query);
    assert.equal(intent.exactTitle, query);
    assert.equal(intent.exclusions.length, 0);
  });
});

test("empty and exclusion-only prompts remain valid", () => {
  const empty = parseSearchIntent("");
  assert.equal(empty.hasConstraints, false);
  assert.equal(empty.hasPositiveCriteria, false);

  const onlyExclusion = parseSearchIntent("without romance");
  assert.equal(onlyExclusion.hasPositiveCriteria, false);
  assert.ok(onlyExclusion.excludedGenres.includes("romance"));
});

test("removing a parsed exclusion preserves the positive request", () => {
  const query = "I want a scary movie but not zombies";
  const intent = parseSearchIntent(query);
  assert.equal(removeConstraintFromPrompt(query, intent.exclusions[0]), "I want a scary movie");

  const minusQuery = "horror -zombie -gore";
  const minusIntent = parseSearchIntent(minusQuery);
  assert.equal(removeConstraintFromPrompt(minusQuery, minusIntent.exclusions[0]), "horror -gore");
});

test("hard exclusions cannot appear in the first 15 filtered results", () => {
  const intent = parseSearchIntent("horror but not zombie");
  const candidates = Array.from({ length: 30 }, (_, index) =>
    title({
      title: `Candidate ${index + 1}`,
      genres: ["horror"],
      hints: index % 3 === 0 ? ["zombie undead"] : ["haunted ghost"],
      intensity: 2 + (index % 4),
    }),
  );
  const firstFifteen = candidates
    .filter((candidate) => !evaluateItemAgainstIntent(candidate, intent).excluded)
    .slice(0, 15);

  assert.equal(firstFifteen.length, 15);
  assert.equal(
    firstFifteen.some((candidate) => candidate.hints.some((hint) => hint.includes("zombie"))),
    false,
  );
});
