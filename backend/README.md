# Music Style Association Model

This project uses the Kaggle `Million Song Dataset + Spotify + Last.fm` data as
a **style/taste prior** for a private, friends-only, non-profit AI music
platform.

The goal is not to recommend the old catalog directly. The goal is to learn:

- which tags/styles tend to be liked by the same listeners
- how to expand a user's taste tags into adjacent tastes
- how to score new AI-generated songs that only have metadata/tags

This matches AI music platforms where songs are new, cold-started, and already
come with tags or prompt metadata.

OpenTunes also has a small backend-owned MP3 song library. The database stores
song metadata, tags, file size, and file hash; the MP3 file stays on disk. Cover
art can remain embedded inside the MP3, so this version does not require a
separate cover image file or table.

## Setup

```bash
cd backend
uv sync
```

## Backend Modules

```text
src/music_taste_rec/             FastAPI routes and tag/style model
src/openband/prompt_generation/  Profile, playlist, prompt, and lyric generation
src/openband/suno_browser/       Suno browser automation backend module
```

`openband.prompt_generation` is Python-native. It uses the trained tag model to
build playlist/song tag seeds and calls a Responses-compatible API to draft Suno
prompts.

`openband.suno_browser` is the backend wrapper around the current Playwright
browser automation scripts. The scripts live inside the backend module now, so
FastAPI or future workers can call them through Python without treating them as
an external project.

```bash
cd backend/src/openband/suno_browser/playwright
npm install
cd ../../../..
uv run openband-suno-browser --help
```

## Data

Download the Kaggle dataset:

```bash
uv run kaggle auth login
uv run music-rec download
```

Download the richer Last.fm 320K tag dataset:

```bash
uv run kaggle datasets download \
  -d adarsh1077/last-fm-320k-music-tracks-with-tags \
  -p data/lastfm_320k/raw \
  --unzip
```

Inspect it:

```bash
uv run music-rec inspect
```

Check how much of the main catalog is covered by Last.fm 320K tags using
normalized `artist + title` matching:

```bash
uv run music-rec lastfm-coverage
```

This writes:

- `models/lastfm320k_match_report.csv`
- `models/lastfm320k_matched_sample.csv`

## Train Style Associations

Fast sample:

```bash
uv run music-rec train \
  --model-path models/style_model_sampled.joblib \
  --max-interactions 2000000 \
  --lastfm-path data/lastfm_320k/raw \
  --lastfm-filter-profile ai \
  --lastfm-tag-weight 0.5
```

Full training:

```bash
uv run music-rec train \
  --model-path models/style_model.joblib \
  --lastfm-path data/lastfm_320k/raw \
  --lastfm-filter-profile ai \
  --lastfm-tag-weight 0.5
```

The model learns tag embeddings from:

```text
user -> listened tracks -> fused track tags/genres -> user taste vector
```

When `--lastfm-path` is provided, the trainer first matches Last.fm 320K rows to
the main catalog by normalized `artist + title`, adds the matched tags, filters
obvious non-style labels such as ratings and title-description tags, then runs
SVD over the user-tag matrix to learn style associations.

The current default fusion recipe is:

```text
catalog tags: 1.0
genre tags:   1.0
Last.fm tags: 0.5
profile:      ai
```

This keeps Last.fm's richer style vocabulary while preventing the external tags
from overpowering the original listening-history catalog signal.

## Explore Tag Associations

Find tags related to one style:

```bash
uv run music-rec similar-tags ambient --model-path models/style_model.joblib
```

Expand a taste profile:

```bash
uv run music-rec expand-tags \
  "ambient; piano; sleep" \
  --model-path models/style_model.joblib
```

## Score AI Songs

Score one AI song's tags against user taste tags:

```bash
uv run music-rec score-tags \
  --user-tags "dark pop; female vocal; synth; melancholic" \
  --song-tags "synthpop; female vocalists; sad; electronic" \
  --model-path models/style_model.joblib
```

Rank a batch of AI songs:

```csv
track_id,name,artist,genre,tags
ai_001,Velvet Static,AI,Rock,"shoegaze; dream_pop; guitar; indie"
ai_002,Lake Light,AI,Ambient,"ambient; piano; sleep; minimal"
```

```bash
uv run music-rec rank-songs ai_songs.csv \
  --user-tags "ambient; piano; sleep" \
  --model-path models/style_model.joblib
```

## Serve API

Start the recommendation API:

```bash
OPENBAND_ADMIN_KEY=change-me uv run music-rec serve --model-path models/style_model.joblib --port 8000
```

Open the interactive docs at:

```text
http://127.0.0.1:8000/docs
```

Useful endpoints:

```text
GET  /health
POST /v1/auth/invite-keys
POST /v1/auth/login
POST /v1/auth/refresh
GET  /v1/me
GET  /v1/me/music-tags
PUT  /v1/me/music-tags
POST /v1/songs
GET  /v1/songs
GET  /v1/songs/daily
GET  /v1/songs/{song_id}
GET  /v1/songs/{song_id}/audio
GET  /v1/daily/today
POST /v1/daily/today/generate
GET  /v1/daily/history
GET  /v1/daily/{date}
GET  /v1/daily/jobs/{job_id}
GET  /v1/tags/{tag}/similar
POST /v1/profile
POST /v1/score
POST /v1/rank
```

## Auth And Accounts

OpenTunes uses one-time invite keys for first login. An admin creates a key, the
client logs in with it once, and the backend returns a 15-minute access token
plus a 30-day refresh token. Protected API calls use:

```text
Authorization: Bearer <access_token>
```

Create a key:

```bash
curl -X POST http://127.0.0.1:8000/v1/auth/invite-keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: change-me" \
  -d '{"label":"Alice"}'
```

The response includes:

```json
{
  "key": "ob_key_...",
  "qr_payload": "openband://login?key=ob_key_...",
  "qr_svg": "<?xml version='1.0' encoding='UTF-8'?>..."
}
```

Use the key once:

```bash
curl -X POST http://127.0.0.1:8000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"key":"ob_key_...","device_name":"iPhone"}'
```

Store music tag preferences for a user:

```bash
curl -X PUT http://127.0.0.1:8000/v1/me/music-tags \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"tags":["dream pop","synth","ambient"]}'
```

By default auth state is stored at `runtime/openband.sqlite3`. Override it with
`OPENBAND_AUTH_DB_PATH=/path/to/openband.sqlite3`.

## Song Library

Admin upload stores an MP3 file and creates rows in `songs` and `song_tags`.
The raw MP3 is not checked into git.

```bash
curl -X POST http://127.0.0.1:8000/v1/songs \
  -H "X-Admin-Key: change-me" \
  -F "title=Lake Light" \
  -F "artist=Suno Sketch" \
  -F "album=Midnight Sketches" \
  -F "tags=ambient; piano; sleep" \
  -F "duration_seconds=138" \
  -F "source=suno" \
  -F "file=@/path/to/lake-light.mp3;type=audio/mpeg"
```

Authenticated clients list and download songs:

```bash
curl http://127.0.0.1:8000/v1/songs/daily \
  -H "Authorization: Bearer <access_token>"

curl http://127.0.0.1:8000/v1/songs/song_xxx/audio \
  -H "Authorization: Bearer <access_token>" \
  --output lake-light.mp3
```

By default song files are stored at `storage/songs`. Override it with
`OPENBAND_SONG_STORAGE_ROOT=/path/to/song-storage`.

## Daily Playlists

Daily playlists are system-generated archives. They reference songs from the
same `songs` library, but they are stored separately from user-created
`/v1/playlists`.

The generation pipeline is:

```text
user taste tags -> dated tag clusters -> daily playlist plan -> per-song Suno prompts -> 5-song Suno batch queue -> MP3 import -> Daily YYYY-MM-DD
```

Useful endpoints:

```bash
curl http://127.0.0.1:8000/v1/daily/today \
  -H "Authorization: Bearer <access_token>"

curl -X POST http://127.0.0.1:8000/v1/daily/today/generate \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-06-22"}'

curl http://127.0.0.1:8000/v1/daily/history \
  -H "Authorization: Bearer <access_token>"
```

Generation runs as a background job and exposes stages such as
`generating_tags`, `generating_song_prompts`, `suno_queue`, `suno_batch_1`,
`suno_batch_2`, `importing`, `ready`, and `failed`.

Suno work is stored in the SQLite-backed `daily_suno_batches` queue. The first
MVP worker drains this queue sequentially so only one browser automation batch
runs at a time. Each queue item covers up to 5 songs and is visible in
`GET /v1/daily/jobs/{job_id}`.

Suno batch automation adds a random delay before and after each form fill,
keyboard press, and click. The default maximum is 500 ms; adjust it with
`SUNO_BATCH_ACTION_JITTER_MS` or `--jitter-ms`.

Batch runs are resumable by default. Each run writes `batch-state.json` next to
its screenshots, or the path given by `SUNO_BATCH_STATE` / `--state`. Re-running
the same batch skips songs already submitted, ready, or downloaded; use
`SUNO_BATCH_RESET_STATE=1` / `--reset-state` to start over. Daily jobs store one
state file per queue item, such as `suno-batch-01-state.json` and
`suno-batch-02-state.json`, inside the job runtime directory.

Build a user taste profile:

```bash
curl -X POST http://127.0.0.1:8000/v1/profile \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"user_tags":"shoegaze; dream pop; female vocalists","top_n":10}'
```

Rank new AI songs by tags:

```bash
curl -X POST http://127.0.0.1:8000/v1/rank \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "user_tags": "ambient; piano; sleep",
    "songs": [
      {"track_id":"ai_001","name":"Lake Light","artist":"AI","genre":"Ambient","tags":"ambient; piano; sleep; minimal"},
      {"track_id":"ai_002","name":"Velvet Static","artist":"AI","genre":"Rock","tags":"shoegaze; dream pop; guitar"}
    ],
    "top_n": 2
  }'
```

## Useful Commands

```bash
uv run music-rec tag-stats --model-path models/style_model.joblib
uv run music-rec evaluate \
  --model-path models/style_model.joblib \
  --lastfm-path data/lastfm_320k/raw \
  --output-path models/offline_eval_lastfm320k.json \
  --examples-path models/offline_eval_lastfm320k_examples.csv
uv run pytest
```
