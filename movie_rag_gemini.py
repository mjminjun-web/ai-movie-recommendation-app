"""Gemini RAG helper for movie and TV search results.

This file keeps Gemini grounded in retrieved movie data. Instead of sending only
the user's raw search text, pass the user's query plus the movie results that
your search engine already found.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any

try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = None
    types = None


INSUFFICIENT_INFORMATION = "I do not have enough information to answer that."
NO_MOVIES_FOUND = "No movies found."
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


def _first_present(movie: dict[str, Any], keys: tuple[str, ...], default: str = "Unknown") -> str:
    for key in keys:
        value = movie.get(key)
        if value:
            return str(value)
    return default


def _year_from_movie(movie: dict[str, Any]) -> str:
    explicit_year = movie.get("year")
    if explicit_year:
        return str(explicit_year)

    date_value = movie.get("release_date") or movie.get("first_air_date")
    if isinstance(date_value, str) and len(date_value) >= 4:
        return date_value[:4]

    return "Unknown"


def _format_genres(movie: dict[str, Any]) -> str:
    genres = movie.get("genres") or movie.get("genre_names") or []

    if isinstance(genres, str):
        return genres

    if isinstance(genres, list):
        clean_genres: list[str] = []
        for genre in genres:
            if isinstance(genre, dict):
                name = genre.get("name")
                if name:
                    clean_genres.append(str(name))
            elif genre:
                clean_genres.append(str(genre))
        return ", ".join(clean_genres) if clean_genres else "Unknown"

    return "Unknown"


def _format_people(value: Any) -> str:
    if not value:
        return "Unknown"
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        names = []
        for person in value:
            if isinstance(person, dict):
                name = person.get("name")
                if name:
                    names.append(str(name))
            elif person:
                names.append(str(person))
        return ", ".join(names) if names else "Unknown"
    return str(value)


def format_movie_context(movie_results: list[dict[str, Any]]) -> str:
    """Format retrieved movie data into readable context for Gemini."""
    formatted_movies: list[str] = []

    for index, movie in enumerate(movie_results, start=1):
        title = _first_present(movie, ("title", "name", "original_title", "original_name"))
        year = _year_from_movie(movie)
        media_type = _first_present(movie, ("media_type", "type"), "Unknown")
        director = _format_people(movie.get("director") or movie.get("directors"))
        cast = _format_people(movie.get("cast") or movie.get("actors"))
        genres = _format_genres(movie)
        runtime = _first_present(movie, ("runtime", "runtime_minutes"), "Unknown")
        rating = _first_present(movie, ("vote_average", "rating", "imdb_rating"), "Unknown")
        summary = _first_present(movie, ("overview", "summary", "description", "plot"), "No summary available.")

        formatted_movies.append(
            "\n".join(
                [
                    f"{index}. Title: {title}",
                    f"   Year: {year}",
                    f"   Type: {media_type}",
                    f"   Director: {director}",
                    f"   Cast: {cast}",
                    f"   Genres: {genres}",
                    f"   Runtime: {runtime}",
                    f"   Rating: {rating}",
                    f"   Summary: {summary}",
                ]
            )
        )

    return "\n\n".join(formatted_movies)


def call_gemini(user_query: str, movie_results: list[dict[str, Any]]) -> str:
    """Ask Gemini to answer using only retrieved movie result context."""
    if not movie_results:
        return NO_MOVIES_FOUND

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return "Gemini API key is missing. Set GEMINI_API_KEY in your environment."
    if genai is None or types is None:
        return "Gemini Python SDK is missing. Install it with: pip install google-genai"

    movie_context = format_movie_context(movie_results)
    prompt = f"""
You are a movie assistant. Answer the user's question using ONLY the provided
movie data context. If the answer is not in the context, say
"{INSUFFICIENT_INFORMATION}"

Rules:
- Do not invent titles, ratings, actors, release years, genres, or plot details.
- Recommend only titles that appear in the provided context.
- If the user asks for a reason, explain it using only fields from the context.
- Keep the answer concise and useful.

<movie_data_context>
{movie_context}
</movie_data_context>

<user_question>
{user_query}
</user_question>
""".strip()

    try:
        client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=30_000),
        )
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
    except Exception:
        logging.exception("Gemini API call failed")
        return "Gemini is temporarily unavailable. Please try again."

    return (response.text or "").strip() or INSUFFICIENT_INFORMATION


def _load_movie_results(path: str | None) -> list[dict[str, Any]]:
    raw_text = open(path, encoding="utf-8").read() if path else sys.stdin.read()
    data = json.loads(raw_text)
    if not isinstance(data, list):
        raise ValueError("Movie results JSON must be a list of objects.")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="Ask Gemini using retrieved movie results as RAG context.")
    parser.add_argument("query", help="User movie question or search query.")
    parser.add_argument(
        "--results",
        help="Path to a JSON file containing a list of retrieved movie result objects. Reads stdin if omitted.",
    )
    args = parser.parse_args()

    movie_results = _load_movie_results(args.results)
    print(call_gemini(args.query, movie_results))


if __name__ == "__main__":
    main()
