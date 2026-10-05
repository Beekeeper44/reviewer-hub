# Review Hub on Vercel

The full v1.5 app — forum, drafts, cropping, the pen tool, notifications, emoji and GIFs — with
shared storage, Google sign-in and roles behind it.

## What you need first

Three accounts, all with free tiers that comfortably cover a team of five.

1. **Vercel** — hosting. <https://vercel.com>
2. **A Postgres database** — [Neon](https://neon.tech) is the easiest. Create a project and copy
   the connection string. Vercel's own Postgres works too.
3. **A Google OAuth client** — for sign-in. Details below.

## 1. Google sign-in

At <https://console.cloud.google.com>:

- **APIs & Services → OAuth consent screen.** Choose **Internal** if Arena Club is a Workspace
  organisation — that alone restricts sign-in to your staff. Fill in the app name and your email.
- **APIs & Services → Credentials → Create credentials → OAuth client ID.**
  Application type **Web application**.
- Under **Authorised redirect URIs**, add:

  ```
  https://YOUR-PROJECT.vercel.app/api/callback
  ```

  You will not know the domain until after the first deploy. Deploy first, then come back and
  add the real one — sign-in fails with a redirect-mismatch error until you do.
- Copy the **Client ID** and **Client secret**.

## 2. Deploy

Push this folder to a GitHub repository, then in Vercel choose **Add New → Project** and import
it. Framework preset: **Other**. No build command, no output directory — the files are served as
they are.

Or from this folder with the CLI:

```bash
npm i -g vercel
vercel
```

## 3. Environment variables

In Vercel: **Project → Settings → Environment Variables**. Add all five for **Production**,
**Preview** and **Development**. See `.env.example`.

| Name | What it is |
|---|---|
| `DATABASE_URL` | The Postgres connection string |
| `GOOGLE_CLIENT_ID` | From the OAuth client |
| `GOOGLE_CLIENT_SECRET` | From the OAuth client |
| `SESSION_SECRET` | 40+ random characters. Signs the login cookie |
| `ALLOWED_DOMAIN` | `arenaclub.com`. Only these addresses can sign in |
| `ADMIN_EMAILS` | Your address, comma separated for more |
| `MOVERS_SOURCE_URL` | Optional. JSON feed for Risers & Fallers (see below) |
| `MOVERS_SOURCE_TOKEN` | Optional. Sent as `Authorization: Bearer …` to that feed |
| `MOVERS_METABASE_API_KEY` | Optional. Metabase API key, when the feed is a Metabase question |
| `TCGPLAYER_PUBLIC_KEY` / `TCGPLAYER_PRIVATE_KEY` | Optional. TCGplayer developer keys, for Pokémon and One Piece card images |
| `POKEMONTCG_API_KEY` | Optional. Raises the Pokémon TCG API rate limit |
| `MOVERS_MIN_VOLUME` | Optional. Minimum 30-day sales to qualify, default 10 |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Redeploy after adding variables.** Vercel only picks them up on a new deployment.

## 4. First run

Open the site. You are sent to Google, and back. The first person to sign in becomes an admin,
as does anyone listed in `ADMIN_EMAILS`.

The database tables are created automatically on the first request. Nothing to run by hand.

Add teammates from the **Team** page, or just send them the link — anyone on the allowed domain
who signs in joins as a reviewer.

## How it is put together

```
public/index.html   the whole app, one file
api/login.js        sends you to Google
api/callback.js     brings you back, checks the domain, sets the cookie
api/logout.js       clears it
api/session.js      who am I, and who else is on the team
api/kv.js           read and write the app's data
api/users.js        add people, change roles
api/movers.js       risers & fallers, from a market-data feed you configure
api/scores.js       live scores for the bottom ticker, from ESPN's public scoreboards
lib/db.js           Postgres, two tables: kv and users
lib/auth.js         signed cookie sessions
```

The app keeps its data as JSON under keys in the `kv` table — issues, forum topics, drafts,
notifications. Photos are stored as data URLs inside those values. Settings that belong to one
person, such as your chosen font, are stored per email address; everything else is shared.

Sessions are a signed, HttpOnly cookie, valid two weeks. The signature is checked in constant
time and the domain is enforced on the server, not just hinted to Google.

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
than inside Google Workspace. That is a different answer to the question in the backend brief,
and worth clearing with whoever owns data policy before the team starts posting real work.

## If something goes wrong

- **redirect_uri_mismatch** — the URI in the Google console must match your deployed domain
  exactly, including `/api/callback`.
- **"Review Hub could not start"** with a database message — `DATABASE_URL` is wrong or missing,
  or you added it without redeploying.
- **Signed in as the wrong account** — visit `/api/logout`, then sign in again.
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

### Wiring in Arena Club's own data (recommended)

`sql/movers.sql` builds the feed from `APP_PROD.ADMIN.COMPS` (130M sold prices) and `CARD_TYPES`.

1. Run the `STEP 0` check at the top of the file and fix the three marked column names if they differ.
2. Save the query as a Metabase question on the Snowflake database (397). Note its id.
3. Create a Metabase API key: Admin → Settings → Authentication → API keys. Give it a group that can
   run that question.
4. In Vercel, set:
   - `MOVERS_SOURCE_URL` = `https://arena-club.metabaseapp.com/api/card/<id>/query/json`
   - `MOVERS_METABASE_API_KEY` = the key
5. Redeploy. The tab and its 90-day trend lines fill with real data, refreshed every 10 minutes.

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
