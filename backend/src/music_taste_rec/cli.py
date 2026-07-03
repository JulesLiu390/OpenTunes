from __future__ import annotations

from pathlib import Path
from typing import Annotated

import pandas as pd
import typer
from rich.console import Console
from rich.table import Table

from music_taste_rec.api import MODEL_PATH_ENV
from music_taste_rec.data import load_raw_dataset, normalize_history, normalize_music_info
from music_taste_rec.download import DATASET_SLUG, download_kaggle_dataset
from music_taste_rec.offline_eval import evaluate_holdout, write_evaluation_outputs
from music_taste_rec.style_model import StyleAssociationModel, StyleTrainingConfig, train_style_model
from music_taste_rec.tag_fusion import (
    compute_lastfm320k_coverage,
    fuse_lastfm320k_tags,
    load_lastfm320k,
    write_lastfm320k_match_outputs,
)


app = typer.Typer(help="Music style/tag association tools for AI music recommendation.")
console = Console()


@app.command()
def download(
    raw_dir: Annotated[Path, typer.Option(help="Directory for raw Kaggle files.")] = Path("data/raw"),
    force: Annotated[bool, typer.Option(help="Re-download even if files already exist.")] = False,
) -> None:
    """Download the Kaggle dataset."""
    console.print(f"Downloading Kaggle dataset: [bold]{DATASET_SLUG}[/bold]")
    files = download_kaggle_dataset(raw_dir=raw_dir, force=force)
    console.print(f"Ready in [bold]{raw_dir}[/bold] with {len(files)} files.")


@app.command()
def inspect(
    raw_dir: Annotated[Path, typer.Option(help="Directory containing raw CSV files.")] = Path("data/raw"),
) -> None:
    """Inspect raw and normalized dataset shapes."""
    raw = load_raw_dataset(raw_dir)
    music, audio_columns = normalize_music_info(raw.music)
    history = normalize_history(raw.history)

    table = Table(title="Dataset inspection")
    table.add_column("Part")
    table.add_column("Path")
    table.add_column("Rows", justify="right")
    table.add_column("Columns", justify="right")
    table.add_row("Music raw", str(raw.music_path), str(len(raw.music)), str(len(raw.music.columns)))
    table.add_row("History raw", str(raw.history_path), str(len(raw.history)), str(len(raw.history.columns)))
    table.add_row("Music normalized", "-", str(len(music)), str(len(music.columns)))
    table.add_row("History normalized", "-", str(len(history)), str(len(history.columns)))
    console.print(table)
    console.print(f"Audio feature columns present: {', '.join(audio_columns) or 'none'}")


@app.command()
def lastfm_coverage(
    raw_dir: Annotated[Path, typer.Option(help="Directory containing the main raw CSV files.")] = Path("data/raw"),
    lastfm_path: Annotated[
        Path,
        typer.Option(help="Last.fm 320K CSV file or directory containing lastfm_tracks.csv."),
    ] = Path("data/lastfm_320k/raw"),
    report_path: Annotated[Path, typer.Option(help="Where to write the full match report CSV.")] = Path(
        "models/lastfm320k_match_report.csv"
    ),
    sample_path: Annotated[Path, typer.Option(help="Where to write a small matched sample CSV.")] = Path(
        "models/lastfm320k_matched_sample.csv"
    ),
) -> None:
    """Measure artist+title coverage between the main catalog and Last.fm 320K tags."""
    raw = load_raw_dataset(raw_dir)
    music, _ = normalize_music_info(raw.music)
    lastfm = load_lastfm320k(lastfm_path)
    result = compute_lastfm320k_coverage(music=music, lastfm=lastfm)
    write_lastfm320k_match_outputs(result=result, report_path=report_path, sample_path=sample_path)

    table = Table(title="Last.fm 320K Match Coverage")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    for key, value in result.stats.items():
        if isinstance(value, float):
            formatted = f"{value:.2f}"
        else:
            formatted = f"{value:,}"
        table.add_row(key, formatted)
    console.print(table)
    console.print(f"New matched tag examples: {', '.join(result.new_tag_examples) or 'none'}")
    console.print(f"Report written to [bold]{report_path}[/bold]")
    console.print(f"Sample written to [bold]{sample_path}[/bold]")


@app.command()
def train(
    raw_dir: Annotated[Path, typer.Option(help="Directory containing raw CSV files.")] = Path("data/raw"),
    model_path: Annotated[Path, typer.Option(help="Where to save the style model.")] = Path(
        "models/style_model.joblib"
    ),
    max_interactions: Annotated[
        int | None,
        typer.Option(help="Optional interaction sample size for faster experiments."),
    ] = None,
    min_tag_tracks: Annotated[int, typer.Option(help="Minimum catalog tracks required for a tag.")] = 5,
    max_tags: Annotated[int, typer.Option(help="Maximum number of tags to keep.")] = 5_000,
    n_components: Annotated[int, typer.Option(help="Latent dimensions for tag embeddings.")] = 64,
    include_genre: Annotated[bool, typer.Option(help="Also treat genre as a style tag.")] = True,
    lastfm_path: Annotated[
        Path | None,
        typer.Option(help="Fuse matched Last.fm 320K tags before training."),
    ] = None,
    filter_lastfm_noise: Annotated[
        bool,
        typer.Option(help="Filter non-style Last.fm tags such as years, ratings, and library labels."),
    ] = True,
    lastfm_filter_profile: Annotated[
        str,
        typer.Option(help="Last.fm tag filter profile: broad or ai."),
    ] = "broad",
    catalog_tag_weight: Annotated[float, typer.Option(help="Weight for original catalog tags.")] = 1.0,
    genre_tag_weight: Annotated[float, typer.Option(help="Weight for genre tags.")] = 1.0,
    lastfm_tag_weight: Annotated[float, typer.Option(help="Weight for fused Last.fm 320K tags.")] = 1.0,
) -> None:
    """Train a tag/style association model from listening behavior."""
    config = StyleTrainingConfig(
        raw_dir=raw_dir,
        model_path=model_path,
        max_interactions=max_interactions,
        min_tag_tracks=min_tag_tracks,
        max_tags=max_tags,
        n_components=n_components,
        include_genre=include_genre,
        lastfm320k_path=lastfm_path,
        filter_lastfm_noise=filter_lastfm_noise,
        lastfm_filter_profile=lastfm_filter_profile,
        catalog_tag_weight=catalog_tag_weight,
        genre_tag_weight=genre_tag_weight,
        lastfm_tag_weight=lastfm_tag_weight,
    )
    if lastfm_path is not None:
        console.print(f"Training style/tag association model with Last.fm 320K tags from [bold]{lastfm_path}[/bold]...")
    else:
        console.print("Training style/tag association model...")
    model = train_style_model(config)
    model.save(model_path)
    console.print(
        f"Saved [bold]{model_path}[/bold] | tags={len(model.tags):,} "
        f"users={model.config['users']:,} interactions={model.config['interactions']:,}"
    )
    if lastfm_path is not None:
        console.print(
            "Last.fm 320K fusion | "
            f"matched={model.config.get('lastfm320k_matched_tracks', 0):,} "
            f"coverage={float(model.config.get('lastfm320k_coverage_pct_of_main', 0.0)):.2f}% "
            f"tracks_with_added_tags={model.config.get('lastfm320k_tracks_with_added_tags', 0):,} "
            f"added_tag_assignments={model.config.get('lastfm320k_added_tag_assignments', 0):,} "
            f"profile={model.config.get('lastfm_filter_profile', 'broad')} "
            f"lastfm_weight={float(model.config.get('lastfm_tag_weight', 1.0)):.2f}"
        )


@app.command()
def similar_tags(
    tag: Annotated[str, typer.Argument(help="Known style tag.")],
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
    top_n: Annotated[int, typer.Option(help="Number of related tags.")] = 20,
    min_user_count: Annotated[int, typer.Option(help="Hide tags with fewer training users.")] = 5_000,
) -> None:
    """Show tags associated with one style tag."""
    model = StyleAssociationModel.load(model_path)
    _print_frame(model.similar_tags(tag, top_n=top_n, min_user_count=min_user_count), title=f"Tags Like {tag}")


@app.command()
def expand_tags(
    tags: Annotated[str, typer.Argument(help="Semicolon/comma separated user or song tags.")],
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
    top_n: Annotated[int, typer.Option(help="Number of related tags.")] = 20,
    min_user_count: Annotated[int, typer.Option(help="Hide tags with fewer training users.")] = 5_000,
) -> None:
    """Expand a tag set into likely adjacent tastes."""
    model = StyleAssociationModel.load(model_path)
    _print_frame(
        model.expand_tags(tags, top_n=top_n, min_user_count=min_user_count),
        title="Expanded Taste Tags",
    )


@app.command()
def score_tags(
    user_tags: Annotated[str, typer.Option(help="User taste tags, separated by semicolon/comma.")],
    song_tags: Annotated[str, typer.Option(help="AI song tags, separated by semicolon/comma.")],
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
) -> None:
    """Score how well an AI song tag set matches a user taste tag set."""
    model = StyleAssociationModel.load(model_path)
    result = model.score_tags(user_tags=user_tags, song_tags=song_tags)
    table = Table(title="Tag Match Score")
    table.add_column("Field")
    table.add_column("Value")
    for key, value in result.items():
        if isinstance(value, list):
            value = ", ".join(value)
        elif isinstance(value, float):
            value = f"{value:.6f}"
        table.add_row(key, str(value))
    console.print(table)


@app.command()
def rank_songs(
    songs_csv: Annotated[Path, typer.Argument(help="CSV with track_id/name/artist/genre/tags.")],
    user_tags: Annotated[str, typer.Option(help="User taste tags, separated by semicolon/comma.")],
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
    top_n: Annotated[int, typer.Option(help="Number of AI songs to return.")] = 20,
) -> None:
    """Rank AI songs by compatibility with a user taste tag set."""
    model = StyleAssociationModel.load(model_path)
    songs = pd.read_csv(songs_csv)
    ranked = model.rank_songs(songs, user_tags=user_tags, top_n=top_n)
    columns = [
        "score",
        "embedding_score",
        "overlap_score",
        "track_id",
        "name",
        "artist",
        "genre",
        "known_song_tags",
        "unknown_song_tags",
    ]
    _print_frame(ranked[columns], title="Ranked AI Songs")


@app.command()
def tag_stats(
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
    top_n: Annotated[int, typer.Option(help="Number of tags to show.")] = 30,
) -> None:
    """Show the most common learned tags."""
    model = StyleAssociationModel.load(model_path)
    stats = model.tag_stats.sort_values("user_count", ascending=False).head(top_n)
    _print_frame(stats, title="Tag Stats")


@app.command()
def evaluate(
    raw_dir: Annotated[Path, typer.Option(help="Directory containing raw CSV files.")] = Path("data/raw"),
    model_path: Annotated[Path, typer.Option(help="Path to style model.")] = Path("models/style_model.joblib"),
    lastfm_path: Annotated[
        Path | None,
        typer.Option(help="Fuse Last.fm 320K tags into the evaluation catalog."),
    ] = None,
    lastfm_filter_profile: Annotated[
        str | None,
        typer.Option(help="Override Last.fm filter profile; defaults to the model config."),
    ] = None,
    filter_lastfm_noise: Annotated[
        bool | None,
        typer.Option(help="Override Last.fm noise filtering; defaults to the model config."),
    ] = None,
    output_path: Annotated[Path, typer.Option(help="Where to write evaluation metrics JSON.")] = Path(
        "models/offline_eval.json"
    ),
    examples_path: Annotated[Path, typer.Option(help="Where to write example holdout rankings CSV.")] = Path(
        "models/offline_eval_examples.csv"
    ),
    max_users: Annotated[int, typer.Option(help="Maximum eligible users to evaluate.")] = 10_000,
    min_user_interactions: Annotated[int, typer.Option(help="Minimum tagged listens needed per user.")] = 5,
    negative_count: Annotated[int, typer.Option(help="Random negatives sampled per held-out positive.")] = 100,
    top_k: Annotated[int, typer.Option(help="K for hit-rate and NDCG.")] = 10,
    include_genre: Annotated[bool, typer.Option(help="Also treat genre as a style tag during evaluation.")] = True,
    random_state: Annotated[int, typer.Option(help="Random seed for holdout and negative sampling.")] = 42,
) -> None:
    """Evaluate tag recommendations with random leave-one-out holdouts."""
    model = StyleAssociationModel.load(model_path)
    raw = load_raw_dataset(raw_dir)
    music, _ = normalize_music_info(raw.music)
    history = normalize_history(raw.history)
    if lastfm_path is not None:
        lastfm = load_lastfm320k(lastfm_path)
        profile = lastfm_filter_profile or str(model.config.get("lastfm_filter_profile", "broad"))
        filter_noise = (
            bool(model.config.get("filter_lastfm_noise", True))
            if filter_lastfm_noise is None
            else filter_lastfm_noise
        )
        fusion = fuse_lastfm320k_tags(
            music=music,
            lastfm=lastfm,
            filter_noisy_tags=filter_noise,
            filter_profile=profile,
        )
        music = fusion.music

    result = evaluate_holdout(
        model=model,
        music=music,
        history=history,
        include_genre=include_genre,
        max_users=max_users,
        min_user_interactions=min_user_interactions,
        negative_count=negative_count,
        top_k=top_k,
        random_state=random_state,
    )
    write_evaluation_outputs(result=result, output_path=output_path, examples_path=examples_path)

    table = Table(title="Offline Holdout Evaluation")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    for key, value in result.metrics.items():
        table.add_row(key, _format_metric(value))
    console.print(table)
    console.print(f"Metrics written to [bold]{output_path}[/bold]")
    console.print(f"Examples written to [bold]{examples_path}[/bold]")


@app.command()
def serve(
    model_path: Annotated[Path, typer.Option(help="Path to style model served by the API.")] = Path(
        "models/style_model.joblib"
    ),
    host: Annotated[str, typer.Option(help="Host interface to bind.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to bind.")] = 8000,
    reload: Annotated[bool, typer.Option(help="Reload the API server on code changes.")] = False,
) -> None:
    """Serve the recommendation API."""
    import os

    import uvicorn

    os.environ[MODEL_PATH_ENV] = str(model_path)
    console.print(f"Serving API with model [bold]{model_path}[/bold] at http://{host}:{port}")
    uvicorn.run("music_taste_rec.api:create_app", factory=True, host=host, port=port, reload=reload)


def _build_song_store():
    """Construct a SongStore wired to R2 from environment, like the running API."""
    import os

    from music_taste_rec.api import (
        AUTH_DB_PATH_ENV,
        DEFAULT_AUTH_DB_PATH,
    )
    from openband.songs import (
        DEFAULT_SONG_STORAGE_ROOT,
        SONG_STORAGE_ROOT_ENV,
        SongStore,
    )
    from openband.storage import (
        local_cache_days,
        presigned_url_ttl,
        r2_storage_from_env,
    )

    return SongStore(
        db_path=Path(os.getenv(AUTH_DB_PATH_ENV, str(DEFAULT_AUTH_DB_PATH))),
        storage_root=Path(os.getenv(SONG_STORAGE_ROOT_ENV, str(DEFAULT_SONG_STORAGE_ROOT))),
        object_storage=r2_storage_from_env(),
        cache_days=local_cache_days(),
        url_ttl=presigned_url_ttl(),
    )


@app.command()
def migrate_r2(
    overwrite: Annotated[bool, typer.Option(help="Re-upload even if the object already exists in R2.")] = False,
) -> None:
    """Backfill existing songs (audio + extracted covers) into Cloudflare R2."""
    store = _build_song_store()
    if store.object_storage is None:
        console.print("[red]R2 is not configured.[/red] Set OPENBAND_R2_* environment variables first.")
        raise typer.Exit(code=1)
    console.print("Uploading existing songs to R2…")
    result = store.offload_existing_to_r2(overwrite=overwrite)
    console.print(
        f"Uploaded [bold]{result['uploaded']}[/bold] audio, [bold]{result['covers']}[/bold] covers, "
        f"skipped [bold]{result['skipped']}[/bold] (already present), "
        f"missing-local [bold]{result['missing']}[/bold]."
    )


@app.command()
def prune_cache() -> None:
    """Delete cached local MP3s older than the retention window once R2 has them."""
    store = _build_song_store()
    if store.object_storage is None:
        console.print("[yellow]R2 is not configured; skipping prune (local is the only copy).[/yellow]")
        raise typer.Exit(code=0)
    removed = store.prune_local_cache()
    console.print(f"Pruned [bold]{removed}[/bold] local cached file(s) older than {store.cache_days} day(s).")


def _print_frame(frame: pd.DataFrame, title: str) -> None:
    table = Table(title=title)
    for column in frame.columns:
        justify = "right" if pd.api.types.is_numeric_dtype(frame[column]) else "left"
        table.add_column(str(column), overflow="fold", justify=justify)

    for _, row in frame.iterrows():
        table.add_row(*[_format_value(value) for value in row.tolist()])
    console.print(table)


def _format_value(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.6f}"
    return str(value)


def _format_metric(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.6f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


if __name__ == "__main__":
    app()
