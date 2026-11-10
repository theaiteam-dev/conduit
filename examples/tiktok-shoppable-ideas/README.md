# Example: tiktok-shoppable-ideas

The **dogfood flow** for the real-run path ([`prd/done/real-run-path.md`](../../prd/done/real-run-path.md)).
A linear, gated flow that turns real TikTok-shop data into **one paragraph of filming ideas** for a
shoppable video, grounded in what's actually selling and which hooks actually work.

```
intake → fetch_context → ideate ──(gate verify: pass)──→ done
            (DuckDB)      (LLM)          │
                            ▲────(reject)─┘   rework, bounded
```

| Station | kind | does |
|---|---|---|
| `fetch_context` | deterministic | runs `fetch.sql` against the Arcane DuckDB → `context.json` |
| `ideate` | transform | prompt rendered against `context.json` → one `filming_idea` paragraph |
| `ideate`'s gate | check (gate) | a second, stronger critic LLM verifies the idea is grounded + actionable; reject → rework |

## Files

| File | Role |
|---|---|
| `flow.yaml` | the flow definition (stations, topology, prompts, output schema, allowlist) |
| `fetch.sql` | `fetch_context`'s query — builds `context.json` from the DuckDB |
| `prompts/ideate.md` | the `ideate` prompt template, rendered against `context.json` |
| `prompts/verify.md` | the gate critic prompt, rendered against `idea.json` + `context.json` |
| `request.example.json` | sample seed (targets the synthetic fixture product out of the box) |
| `fixtures/build-fixture.sql` | builds the synthetic, non-sensitive `fixture.duckdb` |
| `fixtures/fixture.duckdb` | the generated fixture (small; rebuild any time from the script) |

## Run the Generation and Inspection Loop

This example uses synthetic product data and makes real, billed model calls.
Install Bun and DuckDB, then configure an OpenAI-compatible endpoint that serves
both model names in `flow.yaml`. The [gateway setup below](#run-against-a-litellm-gateway-multi-provider-one-endpoint)
provides one option; you can also change both models to ones your endpoint serves.
Set `CONDUIT_BASE_URL` and `CONDUIT_API_KEY` for that endpoint in your shell
before continuing. The gateway section supplies values for the local example.

Run these commands from the repository root after cloning:

```bash
bun install --frozen-lockfile

export CONDUIT_EXAMPLE_DIR="$(mktemp -d)"
export CONDUIT_STATE_DB="$CONDUIT_EXAMPLE_DIR/conduit.sqlite"
export CONDUIT_JOURNAL_DB="$CONDUIT_EXAMPLE_DIR/conduit.journal.sqlite"
export CONDUIT_PROJECT_ROOT="$PWD/examples/tiktok-shoppable-ideas"

bun run src/cli/main.ts doctor examples/tiktok-shoppable-ideas/flow.yaml
bun run src/cli/main.ts run examples/tiktok-shoppable-ideas/flow.yaml \
  --input examples/tiktok-shoppable-ideas/request.example.json --run-id marketing-demo

bun run src/cli/main.ts run status --run marketing-demo
bun run src/cli/main.ts journal inspect entry-marketing-demo --run marketing-demo
```

The entry step seeds `request.json` and fetches `context.json`. The maker writes
`idea.json`; its critic either passes it or returns findings for revision. The
maker's prompt includes `{{feedback}}`, which receives those findings. The gate
allows at most two revisions and can stop sooner when findings repeat. A run
can finish with rejected work; inspect its status and journal before treating
`idea.json` as accepted.

To resume an interrupted run with the same environment and state:

```bash
bun run src/cli/main.ts resume examples/tiktok-shoppable-ideas/flow.yaml --run marketing-demo
```

Use a fresh state directory and run ID for an independent experiment. The example
writes artifacts into its project directory; use separate project copies for
concurrent experiments.

The synthetic fixture encodes a deliberate test: **Nebula** is the proven best-seller, **Sunset
Fade** is a brand-new rising star — but Sunset Fade *already has a recent video*, so a good `ideate`
output features it from a **fresh** angle (or picks Nebula), and the gate should reject a repeat.

## Run it on real data

Point `fetch_context`'s `args` (in `flow.yaml`) at the real `arcane.duckdb`, and edit the seed
(real `product_id`, a `sales_name_like` pattern, and your maintained `active_campaigns`). The real
DB is **not committed** (buyer PII, ~36 MB).

## Run against a LiteLLM gateway (multi-provider, one endpoint)

This flow uses **two different providers** — `ideate` runs on `gemini-flash-lite-latest` (Google)
and the gate critic on `gpt-4o` (OpenAI). Conduit speaks plain OpenAI to a single
`CONDUIT_BASE_URL` and never routes per-model itself, so to serve a multi-provider flow you put a
gateway in front. [`litellm.config.yaml`](./litellm.config.yaml) maps each station's `model:`
string to its upstream provider — change providers (or swap a station to a local Ollama model)
without touching `flow.yaml`.

```bash
pip install 'litellm[proxy]'

# Keys the config reads (the Gemini route uses Google's OpenAI-compatible endpoint):
export GEMINI_OPENAI_KEY=...        # Google AI key
export OPENAI_API_KEY=sk-...        # OpenAI key (for the gpt-4o critic)

# From the repository root, run the gateway in a separate terminal:
litellm --config examples/tiktok-shoppable-ideas/litellm.config.yaml --port 4000
```

In the shell where you will run Conduit, set:

```bash
export CONDUIT_BASE_URL=http://localhost:4000
export CONDUIT_API_KEY=sk-conduit-local                # = master_key in the config
```

Then follow the run commands above, keeping the gateway running.

A direct provider endpoint (e.g. Google's) only serves that provider's models, so `gpt-4o` 404s
against it — the gateway is what makes the mixed-provider flow run. LiteLLM also returns per-call
cost via the `x-litellm-response-cost` header, which Conduit records in the journal.

## fetch_context

```
duckdb -readonly <path/to/arcane.duckdb> -f fetch.sql
```
Run with cwd = the project root: it reads `request.json` and writes `context.json`. Every argument
is metacharacter-free, so it passes the Law-lite allowlist with **no shell wrapper**.

### `request.json` parameters (see `request.example.json`)

| field | meaning |
|---|---|
| `product_id` | TikTok **ads** product id (`campaigns.product_id`) — drives ad metrics + hooks |
| `sales_name_like` | `ILIKE` pattern matched against `orders.product_name` — drives sales (see quirk 2) |
| `active_campaigns` | **maintained** list of toggled-on campaign names (see quirk 1) |
| `lookback_days` | sales window for the variant aggregates |
| `recent_days` | size of the "recent" window for the rising-star velocity calc |
| `recent_video_days` | window for `recent_videos` (videos already made — anti-repeat) |
| `creative_brief` | **optional** free-text directive — feature a net-new drop not yet in the sales data (see below). Omit or leave `""` to let the flow pick from proven sellers. |

#### Featuring a new drop (`creative_brief`)

By default `ideate` picks a proven best-seller / rising star from the sales data — it has no way to
know about a product you *just* launched. Set `creative_brief` to direct it: the brief's item
becomes the **required hero**, grounded in the line's proven hooks/formats, and the critic treats
briefed items as intentional launches (it won't reject them for being absent from sales/video data).
Token budget is a non-issue — a paragraph or two is fine. Example:

```json
"creative_brief": "HERO: the Boomshroom — a new mushroom-house bundle (w/ 12 micros) we've already dropped; this video drives awareness. Look: sparkly red + blue with shiny white silk, glitzy summer-celebration energy (do NOT use the word 'patriotic'). Alongside it: two new character pixies, 'Firecracker Bae' (zombie) and 'Papa Boom' (beasty). Customers get these free with their orders. Ground the hook/format in what works for the Micros line."
```

### `context.json` produced

```
{ product_id,
  creative_brief,                                          -- the optional launch directive (or "")
  clock{ today, last_video_date, days_since_last_video },   -- run date + "N days since last video"
  display_name,
  ad_performance{ spend, orders, revenue, roi, cost_per_order, impressions, clicks },
  top_hooks[{ gmv, views, format_style, hook_effectiveness, hook, techniques, cta }],
  recent_videos[{ posted, description, format_style, content_summary, views, gmv }],  -- already filmed → DON'T repeat
  sales{
    name_pattern, as_of, recent_days, total{ orders, units, revenue },
    best_colorways[{ colorway, units, revenue }],     -- proven sellers: a safe colorway to feature
    rising_stars[{ variant, colorway, size, first_sold, days_live,
                   units_recent, units_prior, units_total }]  -- new/accelerating: a fresh pick to feature
  } }
```

The point of `best_colorways` + `rising_stars` is to let `ideate` ground the filming idea in a
**specific colorway/variant** — feature the proven best-seller, or pick one of the rising stars —
rather than suggesting a generic video. Velocity is anchored to the product's own latest order date
(`as_of`), so "rising" survives overall data lag.

`recent_videos` lists what's **already been filmed** for the product within `recent_video_days`
(descriptions + format/summary), so `ideate` can avoid repeating an angle that's already live. It's
anchored to the product's own latest video date, so it stays meaningful even if the dataset lags.

## Data quirks (from `ArcaneLayer/.../arcane/queries/arcane-duckdb-queries.md`)

1. **No active/inactive flag.** The campaign `status` column is stale and creative-level. "Active"
   campaigns must be supplied as a maintained name list (`active_campaigns`) — there is no signal in
   the data for which campaigns are toggled on.
2. **`product_id` (ads) ≠ `sku_id` (orders).** There is no clean join between a campaign's product
   and order rows, so sales are matched by a **name pattern** supplied alongside the product_id.
3. **`videos` has multiple rows per `video_id`** — the hook query dedups with `GROUP BY video_id`.

## Notes

- The real `arcane.duckdb` carries buyer PII and is ~36 MB → not committed. This example ships a
  small **synthetic** `fixture.duckdb` (and the script that builds it); the DB path in `flow.yaml`
  stays configurable to point at the real database.
- `clock.today` uses `CURRENT_DATE`. Start an independent run when you want fresh
  context; resuming an existing run can reuse its completed fetch checkpoint.
- Parameterizing a deterministic command's file args (e.g. the
  DB path) requires care with the no-shell-metacharacter allowlist. This example
  uses a fixed relative path; edit the literal argument in `flow.yaml` when
  selecting a different database.
- Prompt rendering uses a simple convention here: `{{<input-file>}}` (e.g. `{{context.json}}`) is
  replaced with that artifact's contents. `{{feedback}}` is supplied by the runtime
  on revision and is empty on the first attempt.
