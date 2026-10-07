# Review Hub on Vercel

The full v1.5 app (forum, drafts, cropping, the pen tool, notifications, emoji and GIFs) with
shared storage, invite-only sign-in and roles behind it. No Google or other sign-in provider is
needed.

## What you need first

Two accounts. Both have free tiers that comfortably cover a small team.

1. **Vercel**, for hosting. <https://vercel.com>
2. **A Postgres database.** [Neon](https://neon.tech) is the easiest: create a project and copy
   the connection string. Vercel's own Postgres works too.

## 1. Deploy

Push this folder to a GitHub repository. In Vercel, choose **Add New → Project** and import it.
Framework preset is **Other**, with no build command and no output directory. The files are
served as they are.

Or, from this folder, use the CLI:

```bash
npm i -g vercel
vercel
```

## 2. Environment variables

In Vercel, go to **Project → Settings → Environment Variables**. Add the two required ones for
**Production** (and Preview if you use it). See `.env.example`.

| Name | What it is |
|---|---|
| `DATABASE_URL` | **Required.** The Postgres connection string |
| `SESSION_SECRET` | **Required.** 40+ random characters. Signs the login cookie, and is the one-time setup code |
| `CRON_SECRET` | Recommended. Any random string. Lets Vercel's scheduler rebuild Risers & Fallers |
| `MOVERS_SOURCE_URL` | Optional. Defaults to Metabase question 43429. Set it only to use a different feed |
| `MOVERS_SOURCE_TOKEN` | Optional. Sent as `Authorization: Bearer …` to that feed |
| `METABASE_HOST` + `METABASE_API_KEY` | **Needed for Risers & Fallers.** Your Metabase address and an API key that can run question 43429. `MOVERS_METABASE_API_KEY` also works |
| `MOVERS_MIN_VOLUME` | Optional. Minimum 30-day sales to be searchable in look-ups, default 3 |
| `MOVERS_LIST_VOLUME` | Optional. Sales needed to make the main lists, tried in order until a category fills, default `25,15` |
| `TCGPLAYER_PUBLIC_KEY` / `TCGPLAYER_PRIVATE_KEY` | Optional. TCGplayer developer keys, for Pokémon and One Piece card images |
| `POKEMONTCG_API_KEY` | Optional. Raises the Pokémon TCG API rate limit |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Redeploy after adding variables.** Vercel only picks them up on a new deployment.

If you set up Google sign-in before, delete `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ALLOWED_DOMAIN` and `ADMIN_EMAILS` from Vercel. Nothing reads them any more.

## 3. First run

Open the site. With no accounts yet, it shows **Set up Review Hub**. Enter your name, email and a
password, and paste your `SESSION_SECRET` as the setup code. That makes you the first admin. The
setup code is only asked for once, so a stranger who finds the URL first can't claim the site.

The database tables are created automatically on the first request. There's nothing to run by hand.

## 4. Inviting people

Open **Team** (your name in the header, or **Settings → Switch or manage team**).

1. Enter their email (any address, not just arenaclub.com), pick a role and press
   **Create invite**.
2. Copy the link, or press **Email it** to open a pre-written email. Send it to them only.
3. They open the link, type their name and a password, and they're in. From then on they sign in
   at the site with their email and password.

- **Links:** each link works once, expires after 7 days, and is replaced by any newer link for the
  same person.
- **Forgotten passwords:** press **New link** next to their name and send that. Setting a new
  password signs them out everywhere else.
- **Removing someone:** **Remove** signs them out within 30 seconds and blocks sign-in. Their
  posts stay.
- **Pending invites:** anyone who hasn't joined yet shows *invite pending* on the Team page.

## How it is put together

```
public/index.html   the whole app, one file
api/login.js        sign-in page, and first-admin setup
api/invite.js       invite link: choose name and password, then signed in
api/logout.js       clears the cookie
api/session.js      who am I, and who else is on the team
api/kv.js           read and write the app's data
api/users.js        invite, new link, roles, remove
api/movers.js       risers & fallers, from a market-data feed you configure
api/scores.js       live scores for the bottom ticker, from ESPN's public scoreboards
lib/db.js           Postgres tables: kv, users, invites
lib/auth.js         passwords, invite tokens, signed cookie sessions
lib/page.js         the sign-in and invite pages
```

The app keeps its data as JSON under keys in the `kv` table: issues, forum topics, drafts and
notifications. Photos are stored as data URLs inside those values. Settings that belong to one
person, such as your chosen font, are stored per email address. Everything else is shared.

**Security:**
- **Passwords:** hashed with scrypt, at least 10 characters.
- **Invite links:** stored only as a SHA-256 hash, so a database leak doesn't expose working links.
- **Sessions:** a signed, HttpOnly, Secure cookie, valid 30 days, re-checked against the database
  so removal and password resets take effect.
- **Guessing:** sign-in allows 8 wrong tries per address per 15 minutes.

## Worth knowing

**The camera works here.** Vercel serves over HTTPS and `vercel.json` sends `Permissions-Policy: camera=(self)`,
so browsers let the page use the camera. That covers Chrome, Edge, Firefox and Safari on desktop, and Safari and
Chrome on iPhone and Android. Each person allows it once when the browser asks.
- **USB bench cameras:** if a computer has more than one camera, **Next camera** cycles through them. The browser
  remembers the last one used on that computer.
- **Phones:** there is also a **Phone camera app** button. It opens the phone's own camera, with full
  resolution, autofocus and flash, and drops the shot straight into the issue.
- **When the camera is blocked:** the page says exactly why (permission denied, another app such as Zoom has the
  camera, no camera found, not on https) and offers Choose files instead.
- **Releasing the camera:** it switches off when you take the photo, cancel, switch tabs or close the page.
- **Links must open directly:** the camera won't start inside another site's frame, such as the claude.ai
  preview. Open the Vercel link itself.

**Photos live in the database.** Each is downscaled to 1400px before upload, so an issue with
four photos is roughly 600KB. Neon's free tier holds around 0.5GB, which is a few hundred issues.
When that gets tight, move photos to Vercel Blob and keep only the URLs in the row.

**Costs.** Vercel Hobby and Neon free cover this size of team. Hobby is for non-commercial use,
so check whether Arena Club needs a Pro seat before this becomes a work tool people rely on.

**Where the data sits.** This puts card photographs and cert numbers on Vercel and Neon rather
than inside Arena Club's own systems. That is a different answer to the question in the backend brief,
and worth clearing with whoever owns data policy before the team starts posting real work.

## If something goes wrong

- **"Not set up yet"**: `DATABASE_URL` or `SESSION_SECRET` is missing, or you added them
  without redeploying.
- **Locked out with no admin left:** in Neon's SQL editor, run `DELETE FROM users;`. Your data
  stays, and the site goes back to the **Set up** screen.
- **"Review Hub could not start"** with a database message — `DATABASE_URL` is wrong or missing,
  or you added it without redeploying.
- **Signed in as the wrong account:** visit `/api/logout`, then sign in again.
- **Everything loads but nothing saves** — open the browser console. A 401 means the cookie is
  not being set, usually a missing or too-short `SESSION_SECRET`.

## Sports ticker

The bar along the bottom shows every league ESPN reports as in season: NFL, college football, MLB,
NBA, WNBA, NHL, men's college basketball, MLS and the Premier League. Leagues with live games come
first. Logos, scores and game states come from ESPN, and each game links to its ESPN gamecast.

`api/scores.js` fetches the scoreboards on the server, so there's no CORS problem, and trims them to
what the ticker needs. Vercel's edge cache holds the result for 20 seconds while games are live
and 2 minutes otherwise, so ESPN sees about one request per window however many people have the
page open. The page polls every 30 seconds during live games, every 5 minutes otherwise, and
stops while the tab is hidden.

The feed is unofficial and undocumented. If ESPN changes it or it goes down, the bar falls back
to the old list of which leagues are in season, and nothing else is affected. It's on by default.
Each person can turn it off with the eye at the bottom left or in Settings.

## Risers & Fallers

The **Risers & Fallers** tab ranks players (baseball, basketball, football) and characters
(Pokémon, One Piece) by 30-day price change, weighted by sales volume. Anything with fewer than
`MOVERS_MIN_VOLUME` sales in 30 days is ignored. **All** shows the top 5 each way per category.
Picking a category shows the top 10.

The app ships with no data source. Point `MOVERS_SOURCE_URL` at any JSON feed that returns an
array of rows like this:

```json
{ "category": "baseball", "name": "Pete Crow-Armstrong", "image": "https://…", "url": "https://…",
  "change30": 68.67, "volume30": 412, "spark": [ /* 90 daily prices */ ] }
```

`category` is one of `baseball`, `basketball`, `football`, `pokemon` or `onepiece`. The ranking is
done in `api/movers.js`, so the feed only has to supply raw numbers.

### Speed

Risers & Fallers never queries Metabase or the public APIs while someone is waiting.
- **Building:** a scheduled job (`/api/movers-refresh`, set in `vercel.json` under `crons`) builds
  the rankings and saves them to Postgres.
- **Page loads:** they read that saved result, which takes milliseconds whether the source covers
  100 cards or 100,000.
- **Rebuild now:** admins can press **Refresh** on the page to rebuild immediately.
- **Failed builds:** if a source is down, the last good rankings stay up.
- **Setup:** add `CRON_SECRET` (any random string) in Vercel. The schedule runs daily at 12:00 UTC,
  which is once a day on the Hobby plan. On Pro, change it to `0 */6 * * *` for every 6 hours.
- **Keep the query aggregated:** the Metabase question should return one row per player or
  character, not one per card. Snowflake does the heavy lifting, and Vercel only receives a few
  thousand rows.

### Look up names (and screenshots)

**Look up names** on the Risers & Fallers page finds any player or character in our own numbers.
- **Typing:** type names, one per line. Small typos are fine.
- **Screenshots:** drop, paste or choose a screenshot, such as Alt's trends page. The text is read in
  the browser with Tesseract (free, with no API key), and every name in it that has our sales data is
  matched.
- **Only names are used:** the screenshot's own numbers are ignored. What you see is our completed
  auctions and comps (PSA, Beckett, SGC, CSG).
- **Results:** click any result for the card pop-up.
- **Speed:** look-ups read the saved build (`api/movers-lookup.js`), so they're instant. The first
  screenshot downloads the text reader once, about 10 MB, and the browser caches it.

### Free public data (works with no setup)

**Pokémon fills in on its own.** The Pokémon TCG API publishes Cardmarket's average sold prices
for every card over the last 1, 7 and 30 days. `lib/public-pokemon.js` pulls the chase-rarity
cards (illustration rares, ex, V, VMAX and so on), groups them by character, and ranks each
character by how its recent sales compare with its 30-day average.
- **Daily snapshots:** one is saved each day. After 30 days the figure becomes a true 30-day change
  and the trend line fills out to 90 days.
- **Pictures:** real card art.
- **The count column:** for Pokémon it shows how many of that character's cards sold in the last
  30 days, since Cardmarket publishes averages rather than individual sales.
- **Refresh:** the data updates twice a day. The first load after a refresh takes up to a minute
  while it collects about 8,000 cards.
- **Fine-tuning:** `POKEMON_MIN_PRICE` (default 3, in EUR) skips bulk cards. A free
  `POKEMONTCG_API_KEY` from pokemontcg.io raises the rate limit. `MOVERS_PUBLIC=off` turns it off.

**Sports and One Piece have no free public sales feed.** eBay's sold-listings data is closed to
new developers, and the card price guides that track it, such as SportsCardsPro and PriceCharting,
are paid. For those three categories, use Arena Club's comps below, which are themselves
external sold prices, or a paid price-guide key.

If `MOVERS_SOURCE_URL` also returns Pokémon rows, the feed wins and the public data is skipped.

### Wiring in Arena Club's own data (recommended)

`sql/movers.sql` builds the feed from two kinds of real market price in Snowflake. It covers all
five categories, with no column guessing. Only PSA, Beckett (BGS, BVG, BCCG), SGC and CSG slabs count.
Arena Club grades and raw cards are excluded.
- **Completed auctions:** `public.auction`, the same tables as the "ALL AUCTIONS" question. Live
  bids, reserve-not-met, cancelled and expired-payment auctions are ignored.
- **Last comps:** the comp recorded on every approved EV or recomp in `admin.estimated_value`, the
  same source as LAST_COMP in the inventory question. This covers far more cards than auctions do.
  A recomp that repeats the same comp is counted once.
- **How price moves are measured:** each sale is compared with that card's estimated value, so a
  player's number reflects the market, not which cards happened to sell that month.

1. In Metabase, choose **New → SQL query** on the Snowflake database (397), paste `sql/movers.sql`,
   run it and save it. Note the question number in the URL.
2. Create a Metabase API key: **Admin → Settings → Authentication → API keys**. Put it in a group
   that can run that question.
3. In Vercel, set:
   - `MOVERS_SOURCE_URL` = `https://arena-club.metabaseapp.com/api/card/<number>/query/json`
   - `MOVERS_METABASE_API_KEY` = the key
   - `CRON_SECRET` = any random string, if it isn't set already
4. Redeploy, open Risers & Fallers and press **Refresh** (as an admin) to build the first snapshot.

If the lists are thin, the query already requires 3 sales in each 30-day window. Leave
`MOVERS_MIN_VOLUME` at 3. If a category is crowded with noise, raise it to 5 or 10.

Nothing goes through a public link. The key stays on the server and never reaches the browser.

### Pictures

`lib/images.js` finds a picture for each name on the server:

| Category | Tried in order |
|---|---|
| Baseball, basketball, football | ESPN headshot, then the Wikipedia page image |
| Pokémon | TCGplayer card image (with keys), then the Pokémon TCG API, then Wikipedia |
| One Piece | TCGplayer card image (with keys), then Wikipedia |

Each result, hit or miss, is cached in the database: hits for 30 days, misses for 3. Each name is
looked up about once a month, not on every page load. If nothing is found, the row falls back to the
Arena card photo from `movers.sql` (④), then to a generated card.

TCGplayer's API needs developer keys. TCGplayer stopped issuing new ones, so check whether Arena Club
already has a pair. Without them, Pokémon uses the free Pokémon TCG API and One Piece uses Wikipedia.
ESPN's search feed is unofficial, like the scores feed. Wikipedia images carry their own licences,
which is fine for an internal tool but worth knowing before anything goes public.

Alt's market-trends page runs on a private API with no published feed, so using it needs Alt's
permission. Alt is a competitor, so clear that first.
