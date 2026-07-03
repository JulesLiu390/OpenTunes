# OpenTunes Tag Recommendation Metrics

This document describes how the OpenTunes tag recommendation system is trained, how it is currently evaluated, and which metrics should be tracked as the system moves from offline ranking quality to real user feedback.

Short version:

- The system does not directly recommend old catalog songs. It learns relationships between music style tags and uses those relationships for user taste tags, Daily tag seeds, Suno style prompt tags, and AI song ranking.
- The current production model has 416 tags and 64-dimensional tag embeddings. It was trained from 962,037 users and 9,711,301 listening interactions, with additional Last.fm 320K tags fused into the catalog.
- Standard top-N ranking metrics explain how well the model can recover held-out historical listens. OpenTunes also needs metrics for tag coverage, tag diversity, Daily playlist freshness, and whether users actually save, like, or remove generated tags and songs.

## 1. System Scope

The current tag recommendation system does three things:

1. Maps user-entered or saved taste tags to known model tags.
2. Uses tag embeddings to find nearby tags for Daily profile-only and hybrid tag groups.
3. Scores candidate songs or generated songs against a user's tags.

It does not directly generate music, judge audio quality, or judge lyric quality. Those belong to the later LLM and Suno generation stages.

Relevant code:

- Training and scoring: [backend/src/music_taste_rec/style_model.py](../backend/src/music_taste_rec/style_model.py)
- Offline evaluation: [backend/src/music_taste_rec/offline_eval.py](../backend/src/music_taste_rec/offline_eval.py)
- Daily tag seed generation: [backend/src/openband/prompt_generation/cli.py](../backend/src/openband/prompt_generation/cli.py)
- Product flow explainer: [daily-playlist-explainer/README.md](../daily-playlist-explainer/README.md)

## 2. How The Model Is Trained

The current model is a tag relationship model. Its goal is not to predict audio or imitate a particular artist. Its goal is to learn which music tags tend to be liked by the same users.

### 2.1 Training Inputs

The trainer reads two core data sources:

| Data | Purpose |
| --- | --- |
| Music catalog | `track_id`, title, artist, genre, catalog tags |
| Listening history | `user_id`, `track_id`, `play_count` |

It can also fuse Last.fm 320K tags:

- Match Last.fm rows to the main catalog using normalized `artist + title`.
- Filter noisy tags such as years, ratings, pure favorites markers, and non-style labels.
- The current production run uses `lastfm_filter_profile=ai`, which keeps tags that are more useful for AI music generation, such as style, mood, instrument, language, era, and vocal tags.

### 2.2 Current Training Snapshot

The following values come from the current `backend/models/style_model.joblib`:

| Item | Value |
| --- | ---: |
| Tag vocabulary | 416 |
| Embedding dimensions | 64 |
| Users | 962,037 |
| Interactions | 9,711,301 |
| `min_tag_tracks` | 5 |
| `catalog_tag_weight` | 1.0 |
| `genre_tag_weight` | 1.0 |
| `lastfm_tag_weight` | 0.5 |
| Last.fm matched tracks | 34,921 |
| Last.fm coverage of main catalog | 68.9% |
| Tracks with added Last.fm tags | 29,556 |
| Added Last.fm tag assignments | 48,550 |

### 2.3 Training Pipeline

1. Clean tags: lowercase, trim whitespace, normalize `_` and `-` into spaces, deduplicate.
2. Build weighted tags for each track:
   - Catalog tags: weight 1.0
   - Genre tags: weight 1.0
   - Last.fm tags: weight 0.5
3. Filter low-support tags: keep tags that appear on at least 5 tracks.
4. Build a sparse track-tag matrix.
5. Build a sparse user-track matrix. `play_count` is compressed with `log1p(play_count)` to reduce the effect of extreme repeat listening.
6. Multiply the matrices:

```text
user-track matrix x track-tag matrix = user-tag matrix
```

7. Apply TF-IDF to the user-tag matrix:
   - `use_idf=True`
   - `sublinear_tf=True`
   - `norm=l2`
8. Run TruncatedSVD on the weighted user-tag matrix to learn 64-dimensional latent tag factors.
9. L2-normalize every tag embedding.
10. At inference time, use cosine similarity to find related tags or represent a tag group by the mean of its tag embeddings.

Why this works:

- TF-IDF reduces the influence of overly generic tags and gives more distinctive tags more weight.
- TruncatedSVD works well on sparse TF-IDF matrices and is the classic LSA-style dimensionality reduction path.
- After L2 normalization, cosine similarity can be computed as a dot product.

The scikit-learn `TfidfTransformer` documentation explicitly notes that with L2 normalization, the dot product is equivalent to cosine similarity. The `TruncatedSVD` documentation also notes that it can work efficiently on sparse term count or TF-IDF matrices and is known as LSA in that context.

## 3. Current Scoring

### 3.1 Tag-To-Tag Similarity

```text
similarity(tag_a, tag_b) = dot(normalized_embedding_a, normalized_embedding_b)
```

Used by:

- `/v1/tags/{tag}/similar`
- Related tag suggestions for taste tags
- The related half of Daily hybrid tag groups
- Mapping Suno style prompt language back to the 416 known tags

### 3.2 User Tags vs Song Tags

Current `score_tags()`:

```text
embedding_score = cosine(mean(user_tag_embeddings), mean(song_tag_embeddings))
overlap_score = |user_tags intersect song_tags| / sqrt(|user_tags| * |song_tags|)
final_score = 0.85 * embedding_score + 0.15 * overlap_score
```

Interpretation:

- `embedding_score` captures nearby taste even when tags do not exactly match.
- `overlap_score` rewards direct matches with user-declared taste.
- The 0.85 / 0.15 blend means the current system mostly trusts embedding similarity while keeping a small exact-match reward.

## 4. Offline Evaluation Metrics

The existing offline evaluation uses leave-one-out holdout:

1. For each user with enough history, randomly hold out one listened track as the positive item.
2. Build a user vector from the remaining listening history.
3. Sample 100 negative tracks the user did not listen to.
4. Rank the 1 positive and 100 negatives.
5. Aggregate Hit@10, MRR, NDCG@10, AUC, and mean rank.

This matches a top-N recommendation setting better than rating-prediction metrics. Cremonesi, Koren, and Turrin argue that top-N recommenders should be evaluated with top-N accuracy metrics such as precision and recall rather than only rating-error metrics such as RMSE.

### 4.1 Metric Definitions

| Metric | Meaning In This Project | Higher Is Better | Question It Answers |
| --- | --- | ---: | --- |
| HitRate@10 | Whether the held-out positive ranks in the top 10 | Yes | Would the user likely see the relevant item? |
| MRR | Mean reciprocal rank of the positive item | Yes | Is the hit near the very top? |
| NDCG@10 | Position-discounted quality in the top 10 | Yes | How good is the top-ranked area? |
| Mean AUC | Probability that the positive scores above random negatives | Yes | Can the model separate positive from negative tracks overall? |
| Mean rank / 101 | Average positive rank among 101 candidates | No | Where does the positive usually land? |
| Median rank / 101 | Median positive rank among 101 candidates | No | Is the rank distribution robust to outliers? |

Manning, Raghavan, and Schutze describe precision and recall as basic retrieval metrics and note that ranked retrieval requires top-k or ranked-list evaluation. Herlocker et al. also warn that recommender evaluation should not rely on a single accuracy metric; coverage, novelty, serendipity, behavior, and user satisfaction also matter.

### 4.2 Current Experiment Comparison

From `backend/models/experiments/fusion_weight_comparison.csv`:

| Variant | Tags | Valid Tagged Tracks | Hit@10 | MRR | NDCG@10 | Mean AUC | Mean Rank / 101 | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `base` | 102 | 49,988 | 0.5095 | 0.3009 | 0.3366 | 0.7938 | 21.62 | No Last.fm fusion; smaller but tighter vocabulary |
| `lastfm_w050_ai_g100` | 416 | 50,400 | 0.5104 | 0.2983 | 0.3346 | 0.7963 | 21.37 | Current training recipe; wider tag coverage |
| `lastfm_w050_ai_g080` | 416 | 50,400 | 0.5092 | 0.2978 | 0.3338 | 0.7954 | 21.46 | Similar recipe |
| `lastfm_equal_broad` | about 427 | 50,404 | 0.4906 | 0.2907 | 0.3235 | 0.7874 | 22.26 | Last.fm is too strong and too broad/noisy |

Interpretation:

- The current 416-tag model slightly improves Hit@10, AUC, and mean rank over the base model.
- The base model has slightly better MRR and NDCG@10, which suggests that a smaller tag space can be sharper on some historical holdout rankings.
- OpenTunes is not only trying to recover old catalog listens. It also needs AI song tags, user-added tags, style prompt tags, and Daily playlist diversity. For that product goal, the 416-tag vocabulary is a reasonable tradeoff.
- The `lastfm_equal_broad` run performs worse, which shows that external tags should not be fused blindly. They need filtering and lower weight.

### 4.3 Recommended Offline Gates

Every retrain should record at least:

| Gate | Recommendation |
| --- | --- |
| Hit@10 | Should not drop by more than 2% relative to production unless tag coverage improves meaningfully |
| Mean AUC | Should not drop by more than 1% relative |
| Mean rank / 101 | Lower is better; more than 5% relative worse needs explanation |
| Valid tagged tracks | Should not drop materially |
| Known user tag ratio | Should improve or stay flat on real user profile tags |
| Tag vocabulary size | Larger is not automatically better; check noise rate and actual online usage |

Run evaluation:

```bash
cd backend
uv run music-rec evaluate \
  --model-path models/style_model.joblib \
  --lastfm-path data/lastfm_320k/raw \
  --output-path models/offline_eval_current.json \
  --examples-path models/offline_eval_current_examples.csv \
  --max-users 10000 \
  --negative-count 100 \
  --top-k 10
```

## 5. Daily Generation Metrics

Daily generation does not simply rank the top 10 songs. It creates 10 tag groups. Metrics here should measure coherence, diversity, and freshness.

The current seed already records:

| Metric | Location | Meaning |
| --- | --- | --- |
| `intra_similarity` | Per song seed | Average pairwise cosine among the song's tags |
| `nearest_previous_similarity` | Per song seed | Highest cosine against earlier selected tag groups in the same day |
| `nearest_history_similarity` | Per song seed | Highest cosine against recent historical Daily tag groups |
| `avg_intra_cluster_similarity` | Seed metrics | Average tag-group coherence across today's playlist |
| `avg_inter_cluster_similarity` | Seed metrics | Average similarity between different songs today |
| `max_inter_cluster_similarity` | Seed metrics | Similarity of the most similar pair today |
| `avg_history_cluster_similarity` | Seed metrics | Average similarity against historical playlists |
| `max_history_cluster_similarity` | Seed metrics | Most repeated-feeling song against history |

Suggested interpretation:

| Metric | Direction | Recommendation |
| --- | --- | --- |
| `intra_similarity` | Moderate to high | Too low feels random; too high can be narrow |
| `max_inter_cluster_similarity` | Lower is better | It should not frequently hit `playlist_max_cluster_similarity=0.88` |
| `avg_history_cluster_similarity` | Lower means fresher | High values suggest the Daily playlist is repeating recent days |
| Tag reuse count | More balanced is better | Monitor reuse within the day and within a 7-day window |

## 6. Online User Metrics

Offline holdout only tells us whether the model can recover historical listening behavior. OpenTunes' real goal is whether users want to listen, like, save, and generate music from these tags.

Recommended events:

| Event | Metric | Purpose |
| --- | --- | --- |
| User saves AI-suggested tags | `suggestion_accept_rate` | Are generated tag suggestions useful? |
| User removes taste tags | `tag_remove_rate` | Are recommendations noisy? |
| User opens a tag page | `tag_explore_rate` | Does the tag UI encourage exploration? |
| User plays a generated Daily song | `daily_first_play_rate` | Is the Daily playlist attractive enough to start? |
| Playback passes 30s / 50% / 90% | `completion_rate` | Is the song actually listenable? |
| User likes a song | `song_like_rate` | Core positive signal for future taste learning |
| User adds a song to a playlist | `playlist_add_rate` | Stronger long-term interest signal than a casual like |
| User skips quickly | `skip_rate_5s`, `skip_rate_30s` | Negative feedback |
| User unlikes a tag from song detail | `tag_unlike_after_song_detail` | Did song-level tags misrepresent taste? |

Events should be sliceable by:

- `user_id`
- source: taste page, song detail, Daily, library tags, search
- tag
- `song_id`
- Daily date
- model version
- seed metrics snapshot

This makes it possible to answer:

- Which tags lead to liked generated songs?
- Which related tags are often removed by users?
- Do hybrid songs create more exploration than profile-only songs?
- Did a model version increase skip rate?

## 7. Style Prompt Tag Metrics

When a song is generated, the system maps the Suno style prompt back onto the 416 known tags and saves those as song tags. This layer needs its own monitoring.

| Metric | Meaning |
| --- | --- |
| `style_prompt_tag_count` | Number of known tags extracted from the style prompt |
| `blocked_negative_tag_count` | Number of tags blocked by `no ...`, `avoid ...`, or similar negative text |
| `unknown_style_fragment_count` | Number of style fragments that cannot map to known model tags |
| `prompt_to_seed_tag_overlap` | Exact overlap between style prompt tags and seed tags |
| `prompt_to_seed_embedding_similarity` | Embedding cosine between style prompt tags and seed tags |

These metrics can expose two common problems:

1. The LLM-generated style prompt drifts away from the seed tags.
2. The model vocabulary is missing useful style language, so many prompt fragments cannot map to known tags.

## 8. Priority Checklist

Short-term:

1. Keep the current offline holdout metrics: Hit@10, MRR, NDCG@10, AUC, mean rank.
2. Store Daily seed metrics: average/max inter similarity, history similarity, tag reuse.
3. Add client analytics for song likes, skips, completion, tag add/remove.
4. Record the following for every generated song:
   - `model_version`
   - `seed_tags`
   - `style_prompt_tags`
   - `used_llm_lyrics`
   - `prompt_to_seed_similarity`

Medium-term:

- Evaluate by user segment: new users, users with few tags, users with many tags.
- Evaluate by tag category: genre, mood, instrument, vocal, era, language.
- Run A/B comparisons: 102-tag base vs 416-tag model vs next vocabulary.
- Use real likes and playlist adds to train or calibrate song/tag scoring.

## 9. References

- Jonathan L. Herlocker, Joseph A. Konstan, Loren G. Terveen, John T. Riedl. "Evaluating Collaborative Filtering Recommender Systems." ACM TOIS, 2004. https://grouplens.org/site-content/uploads/evaluating-TOIS-20041.pdf
- Paolo Cremonesi, Yehuda Koren, Roberto Turrin. "Performance of Recommender Algorithms on Top-N Recommendation Tasks." RecSys 2010. https://dl.acm.org/doi/10.1145/1864708.1864721
- Christopher D. Manning, Prabhakar Raghavan, Hinrich Schutze. "Introduction to Information Retrieval." Cambridge University Press, online edition. https://nlp.stanford.edu/IR-book/pdf/irbookonlinereading.pdf
- scikit-learn `TfidfTransformer` documentation. https://scikit-learn.org/stable/modules/generated/sklearn.feature_extraction.text.TfidfTransformer.html
- scikit-learn `TruncatedSVD` documentation. https://scikit-learn.org/stable/modules/generated/sklearn.decomposition.TruncatedSVD.html
