(function initializeSearchIntent(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ReelMoodSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSearchIntentApi() {
  "use strict";

  const protectedTitles = [
    "Don't Breathe",
    "Don't Look Up",
    "Don't Worry Darling",
    "Leave No Trace",
    "Never Let Me Go",
    "No Country for Old Men",
    "Notting Hill",
    "Nothing But the Truth",
    "But I'm a Cheerleader",
  ];

  const fillerWords = new Set([
    "a",
    "an",
    "and",
    "any",
    "anything",
    "about",
    "based",
    "can",
    "find",
    "for",
    "give",
    "i",
    "is",
    "kind",
    "like",
    "looking",
    "me",
    "of",
    "please",
    "recommend",
    "related",
    "something",
    "that",
    "the",
    "to",
    "tonight",
    "want",
    "watch",
    "with",
  ]);

  const tokenAliases = {
    animated: "animation",
    animations: "animation",
    children: "family",
    docs: "documentary",
    doc: "documentary",
    films: "movie",
    film: "movie",
    gory: "gore",
    cruz: "cruise",
    hero: "superhero",
    heroes: "superhero",
    korean: "korea",
    kdrama: "k-drama",
    soldiers: "soldier",
    solider: "soldier",
    soliders: "soldier",
    militaries: "military",
    movies: "movie",
    romantic: "romance",
    scarier: "scary",
    scarry: "scary",
    shows: "show",
    spooky: "scary",
    terrifying: "scary",
    thrillers: "thriller",
    superheroes: "superhero",
    zombies: "zombie",
  };

  const genreTerms = {
    action: ["action", "fight", "chase", "explosive", "superhero"],
    animation: ["animation", "animated", "anime"],
    comedy: ["comedy", "funny", "hilarious", "laugh"],
    crime: ["crime", "criminal", "gangster", "police"],
    documentary: ["documentary", "doc"],
    drama: ["drama", "dramatic"],
    family: ["family", "kids", "children", "wholesome"],
    fantasy: ["fantasy", "magic", "magical"],
    horror: [
      "horror",
      "scary",
      "creepy",
      "haunted",
      "ghost",
      "demon",
      "slasher",
      "supernatural",
      "nightmare",
      "zombie",
    ],
    mystery: ["mystery", "detective", "whodunit"],
    romance: ["romance", "romantic", "rom-com", "romcom"],
    "sci-fi": ["sci-fi", "scifi", "science fiction", "space", "alien"],
    thriller: ["thriller", "suspense", "suspenseful", "tense"],
    war: ["war", "army", "soldier", "military", "battle", "battlefield", "combat", "troop", "platoon"],
  };

  const directGenreTerms = {
    action: "action",
    animation: "animation",
    animated: "animation",
    anime: "animation",
    comedy: "comedy",
    crime: "crime",
    documentary: "documentary",
    doc: "documentary",
    drama: "drama",
    family: "family",
    fantasy: "fantasy",
    horror: "horror",
    scary: "horror",
    mystery: "mystery",
    romance: "romance",
    romantic: "romance",
    "sci-fi": "sci-fi",
    scifi: "sci-fi",
    thriller: "thriller",
    war: "war",
  };

  const conceptAliases = {
    animation: ["animation", "animated", "anime"],
    gore: ["gore", "gory", "blood splatter", "graphic violence", "body horror"],
    horror: ["horror", "scary", "creepy", "haunted", "slasher", "nightmare"],
    romance: ["romance", "romantic", "love story", "rom-com", "romcom"],
    scary: ["scary", "horror", "creepy", "haunted", "terrifying", "nightmare"],
    "spider man": ["spider man", "spider-man", "spider verse", "miles morales", "peter parker"],
    superhero: [
      "superhero",
      "super hero",
      "comic book superhero",
      "masked superhero",
      "superpowered hero",
      "marvel superhero",
      "dc superhero",
    ],
    army: ["army", "military", "soldier", "soldiers", "troop", "troops", "platoon", "battlefield", "combat"],
    military: ["military", "army", "soldier", "soldiers", "troop", "troops", "platoon", "battlefield", "combat"],
    soldier: ["soldier", "soldiers", "army", "military", "troop", "troops", "platoon", "battlefield", "combat"],
    war: ["war", "army", "military", "soldier", "soldiers", "battlefield", "combat", "platoon", "troops"],
    violent: ["violent", "violence", "graphic violence", "combat", "brutal"],
    violence: ["violent", "violence", "graphic violence", "combat", "brutal"],
    zombie: [
      "zombie",
      "zombies",
      "undead",
      "living dead",
      "infected",
      "rage virus",
      "cordyceps",
      "fungus zombie",
    ],
  };

  const locationAliases = {
    english: ["english", "british", "american", "australian", "canadian"],
    japan: ["japan", "japanese", "anime", "tokyo"],
    korea: ["korea", "korean", "k-drama", "kdrama", "seoul"],
    uk: ["uk", "british", "united kingdom", "england"],
    us: ["us", "u.s.", "american", "united states"],
  };

  const amountWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
  };
  const requiredSubjectTerms = new Set(["superhero", "zombie"]);

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicalToken(token) {
    let value = String(token || "").toLowerCase().replace(/^-+|-+$/g, "");
    if (!value) return "";
    if (tokenAliases[value]) return tokenAliases[value];
    if (value === "series") return value;
    if (value.length > 5 && value.endsWith("ies")) value = `${value.slice(0, -3)}y`;
    else if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) value = value.slice(0, -1);
    return tokenAliases[value] || value;
  }

  function canonicalTokens(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .match(/[a-z0-9]+(?:-[a-z0-9]+)*/g)?.map(canonicalToken).filter(Boolean) || [];
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = String(value).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function titleCase(value) {
    return String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        if (part.toLowerCase() === "bbc") return "BBC";
        if (part.toLowerCase() === "tv") return "TV";
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  function canonicalConcept(value) {
    const tokens = canonicalTokens(value).filter((token) => !["a", "an", "the", "any", "all"].includes(token));
    const phrase = tokens.join(" ");
    if (!phrase) return "";
    if (phrase === "tv show" || phrase === "television show" || phrase === "television series") return "tv";
    if (phrase === "movie film" || phrase === "film movie") return "movie";
    if (phrase === "graphic violence") return "gore";
    return phrase;
  }

  function stripSearchWrapper(prompt) {
    return String(prompt || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(
        /^(?:please\s+)?(?:i\s+)?(?:want|would like|need|like)\s+(?:to\s+)?(?:watch|see|find)\s+/i,
        "",
      )
      .replace(/^(?:please\s+)?(?:find|show|search for)\s+(?:me\s+)?/i, "")
      .trim();
  }

  function detectExactTitle(prompt, knownTitles) {
    const stripped = stripSearchWrapper(prompt);
    const normalized = normalizeText(stripped);
    if (!normalized) return "";

    const titles = unique([...(knownTitles || []), ...protectedTitles]);
    return titles.find((title) => normalizeText(title) === normalized) || "";
  }

  function emptyIntent(prompt) {
    return {
      rawPrompt: prompt,
      normalizedPrompt: normalizeText(prompt),
      positivePrompt: "",
      includeTerms: [],
      requiredTerms: [],
      excludeTerms: [],
      softAvoidTerms: [],
      genres: [],
      excludedGenres: [],
      mediaType: null,
      excludedMediaTypes: [],
      countries: [],
      excludedCountries: [],
      languages: [],
      excludedLanguages: [],
      excludedQualities: [],
      yearConstraints: { exact: null, min: null, max: null, exclude: [] },
      runtimeConstraints: { minMinutes: null, maxMinutes: null },
      exactTitle: null,
      exclusions: [],
      softAvoids: [],
      hasPositiveCriteria: false,
      hasConstraints: false,
    };
  }

  function parseAmount(value) {
    const normalized = String(value || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(amountWords, normalized)) return amountWords[normalized];
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function durationToMinutes(amount, unit) {
    const number = parseAmount(amount);
    if (!Number.isFinite(number)) return null;
    return /^h|hour/i.test(unit) ? Math.round(number * 60) : Math.round(number);
  }

  function extractRuntimeConstraints(prompt) {
    const result = { minMinutes: null, maxMinutes: null, sources: [] };
    const amount = "(\\d+(?:\\.\\d+)?|one|two|three|four)";
    const unit = "(hours?|hrs?|hr|minutes?|mins?|min)";
    const patterns = [
      {
        type: "max",
        regex: new RegExp(`\\b(?:under|less than|no more than|not longer than|up to|max(?:imum)?(?: of)?)\\s+${amount}\\s*${unit}\\b`, "gi"),
      },
      {
        type: "min",
        regex: new RegExp(`\\b(?:over|more than|at least|minimum(?: of)?)\\s+${amount}\\s*${unit}\\b`, "gi"),
      },
    ];

    patterns.forEach(({ type, regex }) => {
      let match;
      while ((match = regex.exec(prompt))) {
        const minutes = durationToMinutes(match[1], match[2]);
        if (!minutes) continue;
        if (type === "max") result.maxMinutes = minutes;
        else result.minMinutes = minutes;
        result.sources.push(match[0]);
      }
    });

    return result;
  }

  function extractOppositeYearConstraints(prompt) {
    const result = { min: null, max: null, sources: [] };
    const patterns = [
      { type: "min", regex: /\bnot\s+before\s+(19\d{2}|20\d{2})\b/gi },
      { type: "max", regex: /\bnot\s+after\s+(19\d{2}|20\d{2})\b/gi },
    ];

    patterns.forEach(({ type, regex }) => {
      let match;
      while ((match = regex.exec(prompt))) {
        const year = Number(match[1]);
        if (type === "min") result.min = year;
        else result.max = year;
        result.sources.push(match[0]);
      }
    });

    return result;
  }

  function maskSources(text, sources) {
    return sources.reduce((current, source) => {
      if (!source) return current;
      return current.replace(new RegExp(escapeRegExp(source), "i"), " ".repeat(source.length));
    }, text);
  }

  function splitNegativeValues(value) {
    return String(value || "")
      .split(/\s*(?:,|\band\b|\bor\b)\s*/i)
      .map((part) => part.replace(/^(?:a|an|the|any|all)\s+/i, "").trim())
      .filter(Boolean);
  }

  function mediaFromPhrase(value, negative) {
    const tokens = canonicalTokens(value).filter((token) => !["a", "an", "the", "any", "all"].includes(token));
    const movieTerms = new Set(["movie", "film", "cinema"]);
    const tvTerms = new Set(["tv", "television", "show", "series", "episode"]);
    const wantsMovie = tokens.some((token) => movieTerms.has(token));
    const wantsTv = tokens.some((token) => tvTerms.has(token));

    if (negative) {
      const unrelated = tokens.filter((token) => !movieTerms.has(token) && !tvTerms.has(token));
      if (unrelated.length) return null;
    }

    if (wantsMovie && !wantsTv) return "movie";
    if (wantsTv && !wantsMovie) return "tv";
    return null;
  }

  function directGenreFromValue(value) {
    const key = canonicalConcept(value);
    if (directGenreTerms[key]) return directGenreTerms[key];
    const tokens = canonicalTokens(key);
    return tokens.length === 1 ? directGenreTerms[tokens[0]] || null : null;
  }

  function detectGenres(value) {
    const normalized = normalizeText(value);
    const tokens = new Set(canonicalTokens(value));
    const matches = [];

    Object.entries(genreTerms).forEach(([genre, terms]) => {
      const found = terms.some((term) => {
        const termTokens = canonicalTokens(term);
        if (termTokens.length === 1) return tokens.has(termTokens[0]);
        return normalizeText(normalized).includes(normalizeText(term));
      });
      if (found) matches.push(genre);
    });

    return matches;
  }

  function locationsFromValue(value) {
    const normalized = normalizeText(value);
    const countries = [];
    const languages = [];

    Object.entries(locationAliases).forEach(([location, aliases]) => {
      if (!aliases.some((alias) => normalized.includes(normalizeText(alias)))) return;
      if (location === "english") languages.push("english");
      else {
        countries.push(location);
        if (location === "korea") languages.push("korean");
        if (location === "japan") languages.push("japanese");
      }
    });

    return { countries: unique(countries), languages: unique(languages) };
  }

  function extractYearConstraints(value) {
    const constraints = { exact: null, min: null, max: null, exclude: [] };
    const text = String(value || "");
    let match = text.match(/\bbetween\s+(19\d{2}|20\d{2})\s+and\s+(19\d{2}|20\d{2})\b/i);
    if (match) {
      constraints.min = Math.min(Number(match[1]), Number(match[2]));
      constraints.max = Math.max(Number(match[1]), Number(match[2]));
      return constraints;
    }

    match = text.match(/\b(?:after|newer than|later than)\s+(19\d{2}|20\d{2})\b/i);
    if (match) constraints.min = Number(match[1]) + 1;
    match = text.match(/\b(?:since|from)\s+(19\d{2}|20\d{2})\b/i);
    if (match) constraints.min = Number(match[1]);
    match = text.match(/\b(?:before|older than|earlier than)\s+(19\d{2}|20\d{2})\b/i);
    if (match) constraints.max = Number(match[1]) - 1;
    match = text.match(/\b(?:through|until)\s+(19\d{2}|20\d{2})\b/i);
    if (match) constraints.max = Number(match[1]);

    if (!constraints.min && !constraints.max) {
      match = text.match(/\b(19\d{2}|20\d{2})\b/);
      if (match) constraints.exact = Number(match[1]);
    }

    return constraints;
  }

  function constraintLabel(type, value, rawValue) {
    if (type === "media") return value === "tv" ? "TV Shows" : "Movies";
    if (type === "year") return String(value);
    if (type === "quality") return value === "low-quality" ? "Low-rated titles" : titleCase(value);
    if (type === "country") {
      const labels = { korea: "Korean", japan: "Japanese", us: "US", uk: "UK" };
      return labels[value] || titleCase(value);
    }
    if (type === "language") return titleCase(value);
    if (type === "genre") return titleCase(value);
    return titleCase(canonicalConcept(rawValue) || value);
  }

  function qualityFromValue(value) {
    const phrase = canonicalConcept(value);
    if (!phrase) return null;
    return /^(?:(?:very )?(?:bad|terrible|awful|poor)|low quality|low rated|poorly rated)(?: (?:movie|show|title|content))?$/.test(
      phrase,
    )
      ? "low-quality"
      : null;
  }

  function createConstraint(candidate, kind) {
    const rawValue = String(candidate.rawValue || "").trim();
    const concept = canonicalConcept(rawValue);
    if (!concept) return null;

    const year = /^\d{4}$/.test(concept) ? Number(concept) : null;
    const media = mediaFromPhrase(rawValue, true);
    const genre = directGenreFromValue(rawValue);
    const locations = locationsFromValue(rawValue);
    const quality = qualityFromValue(rawValue);
    let type = "term";
    let value = concept;

    if (kind === "soft") {
      type = "term";
      value = concept;
    } else if (year && year >= 1900 && year <= 2030) {
      type = "year";
      value = year;
    } else if (media) {
      type = "media";
      value = media;
    } else if (quality) {
      type = "quality";
      value = quality;
    } else if (genre) {
      type = "genre";
      value = genre;
    } else if (locations.countries.length && canonicalTokens(rawValue).length <= 2) {
      type = "country";
      value = locations.countries[0];
    } else if (locations.languages.length && canonicalTokens(rawValue).length <= 2) {
      type = "language";
      value = locations.languages[0];
    }

    return {
      id: `${kind}:${type}:${value}`,
      kind,
      type,
      value,
      rawValue,
      source: candidate.source || rawValue,
      sourceItemCount: 1,
      label: constraintLabel(type, value, rawValue),
    };
  }

  function markSourceCounts(constraints) {
    const counts = new Map();
    constraints.forEach((item) => {
      const key = normalizeText(item.source);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    constraints.forEach((item) => {
      item.sourceItemCount = counts.get(normalizeText(item.source)) || 1;
    });
  }

  function parseSearchIntent(rawPrompt, options = {}) {
    const prompt = String(rawPrompt || "").trim();
    const intent = emptyIntent(prompt);
    if (!prompt) return intent;

    const exactTitle = detectExactTitle(prompt, options.knownTitles || []);
    if (exactTitle) {
      intent.exactTitle = exactTitle;
      intent.positivePrompt = exactTitle;
      intent.includeTerms = [exactTitle];
      intent.hasPositiveCriteria = true;
      intent.hasConstraints = true;
      return intent;
    }

    const runtime = extractRuntimeConstraints(prompt);
    const oppositeYears = extractOppositeYearConstraints(prompt);
    intent.runtimeConstraints.minMinutes = runtime.minMinutes;
    intent.runtimeConstraints.maxMinutes = runtime.maxMinutes;

    let working = maskSources(prompt, [...runtime.sources, ...oppositeYears.sources]);
    const hardCandidates = [];
    const softCandidates = [];
    const positivePhrases = [];

    working = working.replace(
      /(^|\s)-(?:"([^"]+)"|([a-z0-9][a-z0-9-]*))/gi,
      (full, prefix, quoted, single) => {
        const rawValue = quoted || single;
        hardCandidates.push({ rawValue, source: full.trim() });
        return prefix || " ";
      },
    );

    working = working.replace(
      /\bbut\s+([^,;.!?]+?)(?=(?:[,;.!?]|$))/gi,
      (source, rawValue, offset, fullText) => {
        const leftClause = fullText.slice(0, offset).split(/[,;.!?]/).pop() || "";
        const leftTokens = canonicalTokens(leftClause);
        const cleanedValue = rawValue
          .trim()
          .replace(/\s+(?:movies?|films?|shows?|series)$/i, "")
          .trim();
        if (
          !cleanedValue ||
          /\b(?:not|no|without|except|exclude|avoid|do\s+not|don['\u2019]?t|dont|skip|omit|remove)\b/i.test(
            cleanedValue,
          )
        ) {
          return source;
        }

        const rightTokens = canonicalTokens(cleanedValue).filter(
          (token) => !["a", "an", "the"].includes(token),
        );
        const leftHasMedia = leftTokens.some((token) =>
          ["movie", "film", "cinema", "tv", "television", "show", "series"].includes(token),
        );
        const hasImplicitSubject = rightTokens.some((token) =>
          ["zombie", "gore", "violence"].includes(token),
        );
        const looksLikeNamedEntity =
          leftHasMedia &&
          rightTokens.length >= 2 &&
          rightTokens.length <= 4 &&
          detectGenres(cleanedValue).length === 0;

        if (!hasImplicitSubject && !looksLikeNamedEntity) return source;
        const values = hasImplicitSubject ? splitNegativeValues(cleanedValue) : [cleanedValue];
        values.forEach((value) => hardCandidates.push({ rawValue: value, source }));
        return " ";
      },
    );

    working = working.replace(/\banything\s+but\b/gi, "anything__but__");
    const clauses = working.split(/\s*(?:[,;.!?]+|\b(?:but|however|though|yet)\b)\s*/i);
    const softPattern = /\b(not\s+(?:too|very|so|especially)|less|light\s+on|low\s+on|minimal(?:ly)?|easy\s+on)\s+(scary|violent|violence|gory|gore|romantic|romance|intense|intensity|dark)\b/i;
    const hardPattern = /\b(anything\s+but|would\s+rather\s+not|prefer(?:red)?\s+not(?:\s+to)?|do\s+not|don['\u2019]?t|dont|must\s+not|should\s+not|stay\s+away\s+from|leave\s+out|free\s+of|none\s+of|other\s+than|without|except(?:\s+for)?|excluding|exclude|avoid|skip|omit|remove|never|not|no)\b/i;

    clauses.forEach((rawClause) => {
      let clause = rawClause.replace(/anything__but__/gi, "anything but").trim();
      if (!clause) return;

      if (/\bnot\s+only\b/i.test(clause)) {
        positivePhrases.push(clause.replace(/\bnot\s+only\b/i, " ").trim());
        return;
      }

      let softMatch = clause.match(softPattern);
      while (softMatch) {
        const source = softMatch[0];
        softCandidates.push({ rawValue: softMatch[2], source });
        clause = `${clause.slice(0, softMatch.index)} ${clause.slice((softMatch.index || 0) + source.length)}`.trim();
        softMatch = clause.match(softPattern);
      }

      const hardMatch = clause.match(hardPattern);
      if (!hardMatch) {
        if (clause) positivePhrases.push(clause);
        return;
      }

      const markerIndex = hardMatch.index || 0;
      const positivePrefix = clause.slice(0, markerIndex).trim();
      if (positivePrefix && !/^anything$/i.test(positivePrefix)) positivePhrases.push(positivePrefix);

      let negativeBody = clause.slice(markerIndex + hardMatch[0].length).trim();
      negativeBody = negativeBody
        .replace(
          /^(?:(?:want(?:\s+to)?|like|include|show|recommend|mention|add|give(?:\s+me)?|have|contain|see|watch)\s+)+/i,
          "",
        )
        .trim();
      const restart = negativeBody.match(/\b(?:and|then)\s+(?:with|include|including|give me|something)\s+/i);
      if (restart) {
        const positiveRestart = negativeBody.slice((restart.index || 0) + restart[0].length).trim();
        negativeBody = negativeBody.slice(0, restart.index).trim();
        if (positiveRestart) positivePhrases.push(positiveRestart);
      }

      const source = clause.slice(markerIndex).trim();
      splitNegativeValues(negativeBody).forEach((rawValue) => {
        hardCandidates.push({ rawValue, source });
      });
    });

    const hardConstraints = hardCandidates
      .map((candidate) => createConstraint(candidate, "hard"))
      .filter(Boolean);
    const softConstraints = softCandidates
      .map((candidate) => createConstraint(candidate, "soft"))
      .filter(Boolean);
    intent.exclusions = uniqueById(hardConstraints);
    intent.softAvoids = uniqueById(softConstraints);
    markSourceCounts([...intent.exclusions, ...intent.softAvoids]);

    intent.exclusions.forEach((constraint) => {
      if (constraint.type === "genre") intent.excludedGenres.push(constraint.value);
      else if (constraint.type === "media") intent.excludedMediaTypes.push(constraint.value);
      else if (constraint.type === "country") intent.excludedCountries.push(constraint.value);
      else if (constraint.type === "language") intent.excludedLanguages.push(constraint.value);
      else if (constraint.type === "quality") intent.excludedQualities.push(constraint.value);
      else if (constraint.type === "year") intent.yearConstraints.exclude.push(constraint.value);
      else intent.excludeTerms.push(constraint.value);
    });
    intent.softAvoidTerms = intent.softAvoids.map((constraint) => constraint.value);

    intent.positivePrompt = positivePhrases.join(" ").replace(/\s+/g, " ").trim();
    intent.genres = detectGenres(intent.positivePrompt);
    intent.mediaType = mediaFromPhrase(intent.positivePrompt, false);

    const locations = locationsFromValue(intent.positivePrompt);
    intent.countries = locations.countries;
    intent.languages = locations.languages;

    const years = extractYearConstraints(intent.positivePrompt);
    intent.yearConstraints.exact = years.exact;
    intent.yearConstraints.min = oppositeYears.min || years.min;
    intent.yearConstraints.max = oppositeYears.max || years.max;

    const structuredTokens = new Set([
      ...Object.keys(directGenreTerms),
      "movie",
      "film",
      "cinema",
      "tv",
      "television",
      "show",
      "series",
      "episode",
      "korea",
      "k-drama",
      "japan",
      "japanese",
      "english",
      "american",
      "after",
      "before",
      "british",
      "earlier",
      "from",
      "hour",
      "later",
      "minute",
      "newer",
      "older",
      "over",
      "since",
      "than",
      "through",
      "under",
      "until",
    ]);
    intent.includeTerms = unique(
      canonicalTokens(intent.positivePrompt).filter(
        (token) =>
          !fillerWords.has(token) &&
          !structuredTokens.has(token) &&
          !/^\d{4}$/.test(token),
      ),
    );
    intent.requiredTerms = intent.includeTerms.filter((term) => requiredSubjectTerms.has(term));

    intent.excludedGenres = unique(intent.excludedGenres);
    intent.excludedMediaTypes = unique(intent.excludedMediaTypes);
    intent.excludedCountries = unique(intent.excludedCountries);
    intent.excludedLanguages = unique(intent.excludedLanguages);
    intent.excludedQualities = unique(intent.excludedQualities);
    intent.yearConstraints.exclude = unique(intent.yearConstraints.exclude);
    intent.hasPositiveCriteria = Boolean(
      intent.positivePrompt ||
        intent.genres.length ||
        intent.mediaType ||
        intent.countries.length ||
        intent.languages.length ||
        intent.yearConstraints.exact ||
        intent.yearConstraints.min ||
        intent.yearConstraints.max ||
        intent.runtimeConstraints.minMinutes ||
        intent.runtimeConstraints.maxMinutes,
    );
    intent.hasConstraints = Boolean(
      intent.hasPositiveCriteria || intent.exclusions.length || intent.softAvoids.length,
    );
    return intent;
  }

  function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  function itemSearchText(item) {
    return normalizeText(
      [
        item.title,
        item.summary,
        item.text,
        ...(item.genres || []),
        ...(item.moods || []),
        ...(item.tags || []),
        ...(item.hints || []),
        ...(item.contentWarnings || []),
        ...(item.countries || []),
        ...(item.languages || []),
      ].join(" "),
    );
  }

  function textMatchesConcept(text, concept) {
    const key = canonicalConcept(concept);
    if (!key) return false;
    const textTokens = new Set(canonicalTokens(text));
    const aliases = conceptAliases[key] || [key];

    return aliases.some((alias) => {
      const normalizedAlias = normalizeText(alias);
      const aliasTokens = canonicalTokens(alias);
      if (!aliasTokens.length) return false;
      if (aliasTokens.length === 1) return textTokens.has(aliasTokens[0]);
      return text.includes(normalizedAlias) || aliasTokens.every((token) => textTokens.has(token));
    });
  }

  function itemMatchesLocation(item, location) {
    const text = itemSearchText(item);
    const aliases = locationAliases[location] || [location];
    return aliases.some((alias) => {
      const normalized = normalizeText(alias);
      return text.includes(normalized);
    });
  }

  function evaluateItemAgainstIntent(item, intent) {
    const hardMatches = [];
    const softMatches = [];
    const mediaType = item.mediaType === "tv" ? "tv" : "movie";
    const year = Number(item.year || 0);
    const runtime = Number(item.runtime || 0);
    const genres = (item.genres || []).map((genre) => canonicalConcept(genre));
    const text = itemSearchText(item);

    if (intent.mediaType && mediaType !== intent.mediaType) {
      hardMatches.push(intent.mediaType === "tv" ? "TV Shows only" : "Movies only");
    }
    if (intent.excludedMediaTypes.includes(mediaType)) {
      hardMatches.push(mediaType === "tv" ? "TV Shows" : "Movies");
    }

    const years = intent.yearConstraints || {};
    if (years.exact && year !== years.exact) hardMatches.push(`${years.exact} only`);
    if (years.min && year && year < years.min) hardMatches.push(`${years.min} or newer`);
    if (years.max && year && year > years.max) hardMatches.push(`${years.max} or older`);
    if ((years.exclude || []).includes(year)) hardMatches.push(String(year));

    const runtimes = intent.runtimeConstraints || {};
    if (runtimes.maxMinutes && runtime > runtimes.maxMinutes) {
      hardMatches.push(`Over ${runtimes.maxMinutes} min`);
    }
    if (runtimes.minMinutes && runtime && runtime < runtimes.minMinutes) {
      hardMatches.push(`Under ${runtimes.minMinutes} min`);
    }

    if (intent.countries?.length && !intent.countries.some((country) => itemMatchesLocation(item, country))) {
      hardMatches.push("Outside requested origin");
    }
    if (intent.languages?.length && !intent.languages.some((language) => itemMatchesLocation(item, language))) {
      hardMatches.push("Outside requested language");
    }
    if (intent.excludedCountries?.some((country) => itemMatchesLocation(item, country))) {
      hardMatches.push("Excluded origin");
    }
    if (intent.excludedLanguages?.some((language) => itemMatchesLocation(item, language))) {
      hardMatches.push("Excluded language");
    }

    (intent.requiredTerms || []).forEach((term) => {
      if (!textMatchesConcept(text, term)) hardMatches.push(`Missing ${titleCase(term)}`);
    });

    intent.exclusions.forEach((constraint) => {
      if (["media", "year", "country", "language"].includes(constraint.type)) return;
      if (constraint.type === "quality") {
        const rating = Number(item.rating || 0);
        const audience = Number(item.feedback?.audience || 0);
        const critic = Number(item.feedback?.critic || 0);
        const isLowRated =
          (rating > 0 && rating < 6.5) ||
          (audience > 0 && audience < 65) ||
          (critic > 0 && critic < 60);
        if (constraint.value === "low-quality" && isLowRated) hardMatches.push(constraint.label);
        return;
      }
      if (constraint.type === "genre") {
        if (genres.includes(constraint.value)) hardMatches.push(constraint.label);
        return;
      }
      if (textMatchesConcept(text, constraint.value)) hardMatches.push(constraint.label);
    });

    let softPenalty = 0;
    intent.softAvoids.forEach((constraint) => {
      const value = canonicalConcept(constraint.value);
      const intensity = Number(item.intensity || 0);
      let matches = textMatchesConcept(text, value);
      let penalty = 18;

      if (["scary", "horror", "intense", "intensity"].includes(value)) {
        matches = matches || intensity >= 4;
        penalty = 8 + Math.max(0, intensity - 2) * 14;
      } else if (["violent", "violence", "gore"].includes(value)) {
        matches = matches || (intensity >= 4 && genres.some((genre) => ["action", "horror", "thriller"].includes(genre)));
        penalty = 12 + Math.max(0, intensity - 2) * 10;
      } else if (value === "romance") {
        matches = matches || genres.includes("romance");
        penalty = 24;
      }

      if (!matches) return;
      softPenalty += penalty;
      softMatches.push(constraint.label);
    });

    return {
      excluded: hardMatches.length > 0,
      hardMatches: unique(hardMatches),
      softPenalty,
      softMatches: unique(softMatches),
    };
  }

  function summarizeIntent(intent) {
    const lookingFor = [];
    if (intent.exactTitle) lookingFor.push(intent.exactTitle);
    else {
      intent.genres.forEach((genre) => lookingFor.push(titleCase(genre)));
      if (intent.mediaType) lookingFor.push(intent.mediaType === "tv" ? "TV Shows" : "Movies");
      intent.countries.forEach((country) => lookingFor.push(constraintLabel("country", country, country)));
      intent.languages.forEach((language) => {
        if (!lookingFor.some((label) => label.toLowerCase().startsWith(language.replace(/an$/, "")))) {
          lookingFor.push(titleCase(language));
        }
      });
      intent.includeTerms.forEach((term) => lookingFor.push(titleCase(term)));
    }

    const years = intent.yearConstraints || {};
    if (years.exact) lookingFor.push(String(years.exact));
    else {
      if (years.min) lookingFor.push(`${years.min}+`);
      if (years.max) lookingFor.push(`Through ${years.max}`);
    }
    const runtimes = intent.runtimeConstraints || {};
    if (runtimes.maxMinutes) lookingFor.push(`Under ${runtimes.maxMinutes} min`);
    if (runtimes.minMinutes) lookingFor.push(`${runtimes.minMinutes}+ min`);
    if (!lookingFor.length && intent.exclusions.length) lookingFor.push("Anything else");

    return {
      lookingFor: unique(lookingFor).slice(0, 8),
      excluding: intent.exclusions,
      softAvoiding: intent.softAvoids,
    };
  }

  function buildCatalogSearchQuery(intent) {
    if (!intent) return "";
    if (intent.exactTitle) return intent.exactTitle;

    const locationLabels = {
      japan: "japanese",
      korea: "korean",
      uk: "british",
      us: "american",
    };
    const locations = (intent.countries || []).map(
      (country) => locationLabels[country] || country,
    );
    const requiredTerms = unique(intent.requiredTerms || []);
    const descriptiveTerms = unique(intent.includeTerms || []);
    const genres = unique(intent.genres || []);
    const terms = [];

    if (requiredTerms.length) {
      terms.push(...locations, ...requiredTerms);
    } else if (descriptiveTerms.length) {
      terms.push(...locations, ...descriptiveTerms.slice(0, 4));
      if (terms.length < 4) terms.push(...genres.slice(0, 1));
    } else {
      terms.push(...locations, ...genres);
    }

    if (!terms.length && intent.languages?.length) terms.push(...intent.languages);
    if (intent.yearConstraints?.exact) terms.push(String(intent.yearConstraints.exact));
    return unique(terms.filter(Boolean)).slice(0, 5).join(" ").trim();
  }

  function removeConstraintFromPrompt(prompt, constraint) {
    let next = String(prompt || "");
    const source = String(constraint?.source || "").trim();
    const rawValue = String(constraint?.rawValue || "").trim();

    if (source && constraint.sourceItemCount === 1) {
      next = next.replace(new RegExp(escapeRegExp(source), "i"), " ");
    } else if (rawValue) {
      next = next.replace(new RegExp(escapeRegExp(rawValue), "i"), " ");
    }

    return next
      .replace(/(^|\s)-(?=\s|[,;.!?]|$)/g, " ")
      .replace(/\b(no|not|do\s+not|don['\u2019]?t|dont|without|except(?:\s+for)?|excluding|exclude|avoid|skip|omit|remove|leave\s+out|anything\s+but)\s+(?:and|or)\s+/gi, "$1 ")
      .replace(/\b(no|not|do\s+not|don['\u2019]?t|dont|without|except(?:\s+for)?|excluding|exclude|avoid|skip|omit|remove|leave\s+out|anything\s+but)\s*(?=(?:[,;.!?]|\bbut\b|$))/gi, " ")
      .replace(/\b(?:but|and|or)\s*(?=$)/gi, " ")
      .replace(/^\s*(?:but|and|or)\b\s*/i, "")
      .replace(/\s+([,;.!?])/g, "$1")
      .replace(/([,;])\s*([,;])/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/^[,;.!?\s]+|[,;\s]+$/g, "")
      .trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return {
    buildCatalogSearchQuery,
    evaluateItemAgainstIntent,
    normalizeText,
    parseSearchIntent,
    removeConstraintFromPrompt,
    summarizeIntent,
  };
});
