/*======================================================================
  Review Hub — RISERS & FALLERS feed
  Snowflake APP_PROD · save as a Metabase question on database 397

  GRADERS: PSA, Beckett (BGS / BVG / BCCG), SGC and CSG slabs only. Arena Club grades
           and raw cards are excluded, so the market read isn't tied to our own grades.

  TWO KINDS OF REAL MARKET PRICE, unioned:

   1. AUCTIONS  — Arena Club's completed card auctions (public.auction): status
                  'completed' with a winning bid. Live bids, reserve-not-met,
                  cancelled and expired-payment auctions are left out.
                  Same tables as the "ALL AUCTIONS" question.
   2. LAST COMPS — the market comp the grading team records on every approved EV
                  or recomp (admin.estimated_value.last_comp_value_cents, statuses
                  'approved' / 'done_skip_verify'), dated by finished_at. Same
                  source as LAST_COMP in the inventory question (4131), but across
                  every card and every recomp, not just today's warehouse.
                  A recomp that repeats the same comp for the same card is counted
                  once, so re-approvals don't inflate volume.

  HOW MOVEMENT IS MEASURED (like-for-like, so the card mix can't fake a move):
    Cards are grouped into "same card" buckets: card type + parallel + grader + grade
    (e.g. 2018 Prizm Luka #280 Silver PSA 10). For each bucket that sold in BOTH windows:
        bucket change = median price, last 30 days  /  median price, days 31-60  - 1
    A player's change30 is the average of their bucket changes, weighted by how many
    sales each bucket had, with every bucket capped at +/-80% so one oddball sale can't
    swing it. (A plain median stuck at 0% whenever most of a star's cards hadn't moved.)
    A comp copied onto several copies of the same card counts once.
    (The first version divided by the card's current EV; because EVs are set from the
    same comps, busy players came out at 0.00%. This replaces that.)

    change30 = sales-weighted average bucket change across that player's like-for-like cards
    pairs    = how many like-for-like buckets sold in both windows
    volume30 = auction sales + new comp values in the last 30 days (a recomp that keeps the
               same comp is a price reading, not a sale: it says the card is still worth that)
    spark    = weekly median of price ÷ that bucket's 91-day median, last 13 weeks
    image / card_image = slab photo of the most recently sold card (the app shows an
               ESPN / Wikipedia / TCG picture in the list and this card in the pop-up)
    card_title = that card: set, name, parallel, grade
    url      = public page of the most recently sold card

  Output columns are quoted lowercase so the JSON keys match the app.
  Returns one row per player / character, a few thousand rows at most.
  ======================================================================*/
WITH cards AS (
  SELECT
    id, number, sport, set_name, player_name, parallel_name, grading_company, overall,
    front_slab_picture_url, estimated_value_cents,
    COALESCE(card_type_id::varchar, set_name || '|' || player_name) || '|' || COALESCE(parallel_id::varchar, parallel_name, '')
      || '|' || UPPER(TRIM(grading_company)) || '|' || COALESCE(overall::varchar, '')  AS bucket,
    CASE
      WHEN sport ILIKE '%baseball%'                                 THEN 'baseball'
      WHEN sport ILIKE '%basketball%'                               THEN 'basketball'
      WHEN sport ILIKE '%football%' AND sport NOT ILIKE '%soccer%'  THEN 'football'
      WHEN sport ILIKE '%pok%'                                      THEN 'pokemon'
      WHEN sport ILIKE '%one%piece%'                                THEN 'onepiece'
    END                                                             AS category
  FROM APP_PROD.ADMIN.CARDS
  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
    -- third-party slabs only: PSA, Beckett (BGS / BVG / BCCG), SGC, CSG. No Arena Club grades, no raw cards.
    AND UPPER(TRIM(grading_company)) ILIKE ANY ('PSA%', 'BGS%', 'BVG%', 'BCCG%', '%BECKETT%', 'SGC%', 'CSG%')
    AND NULLIF(TRIM(player_name), '') IS NOT NULL
),
auction_sales AS (
  SELECT a.item_id AS card_id,
         a.current_bid_value_cents                               AS price_cents,
         CONVERT_TIMEZONE('America/Los_Angeles', a.end_at)::date AS d,
         a.end_at::timestamp_ntz                                 AS evt_at,
         1                                                       AS is_new
  FROM   APP_PROD.PUBLIC.AUCTION a
  WHERE  a.item_category = 'card'
    AND  NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
    AND  a.status::text = 'completed'
    AND  a.current_bid_value_cents > 0
    AND  a.end_at >= DATEADD(day, -91, CURRENT_TIMESTAMP)
    AND  a.end_at <= CURRENT_TIMESTAMP
),
comp_sales AS (   -- every approved comp is a price reading; only a NEW comp value counts as a sale
  SELECT card_id,
         last_comp_value_cents                                AS price_cents,
         COALESCE(finished_at, created_at)::timestamp::date   AS d,
         COALESCE(finished_at, created_at)::timestamp_ntz     AS evt_at,
         IFF(ROW_NUMBER() OVER (PARTITION BY card_id, last_comp_value_cents
                                ORDER BY COALESCE(finished_at, created_at)) = 1, 1, 0) AS is_new
  FROM   APP_PROD.ADMIN.ESTIMATED_VALUE
  WHERE  NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
    AND  grading_task_status IN ('approved', 'done_skip_verify')
    AND  last_comp_value_cents > 0
    AND  COALESCE(finished_at, created_at) >= DATEADD(day, -91, CURRENT_TIMESTAMP)
),
sales AS (
  SELECT c.category,
         TRIM(c.player_name)                                    AS name,
         c.bucket,
         x.price_cents / 100.0                                  AS price,
         x.d,
         x.is_new,
         x.evt_at                                               AS end_at,
         c.front_slab_picture_url                               AS pic,
         TRIM(COALESCE(c.set_name, '') || ' ' || COALESCE(c.player_name, '')
              || COALESCE(' ' || NULLIF(c.parallel_name, ''), '')
              || COALESCE(' ' || c.grading_company || ' ' || c.overall, ''))  AS card_title,
         'https://arenaclub.com/cards/'
           || TRIM(LOWER(REGEXP_REPLACE(c.sport || '-' || c.set_name || '-' || c.player_name,
                                        '[^A-Za-z0-9]+', '-')), '-')
           || '-8AC' || LPAD(c.number::varchar, 9, '0')         AS url
  FROM (SELECT * FROM auction_sales UNION ALL SELECT * FROM comp_sales) x
  JOIN cards c ON c.id = x.card_id
),
dedup AS (   -- the same comp copied onto several copies of one card is ONE market sale
  SELECT * FROM sales WHERE category IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY category, name, bucket, price, d ORDER BY is_new DESC, end_at DESC) = 1
),
s AS (   -- drop obvious data errors: a sale 20x away from its bucket's typical price is a typo
  SELECT dedup.*, MEDIAN(price) OVER (PARTITION BY bucket) AS bucket_med
  FROM dedup
  QUALIFY price BETWEEN bucket_med / 20 AND bucket_med * 20
),
buckets AS (   -- like-for-like: same card type, parallel, grader and grade
  SELECT category, name, bucket,
    MEDIAN(IFF(d >  DATEADD(day, -30, CURRENT_DATE()), price, NULL))                                           AS now_p,
    MEDIAN(IFF(d <= DATEADD(day, -30, CURRENT_DATE()) AND d > DATEADD(day, -60, CURRENT_DATE()), price, NULL)) AS prev_p,
    COUNT_IF(d > DATEADD(day, -60, CURRENT_DATE()))                                                            AS n
  FROM s GROUP BY category, name, bucket
),
win AS (
  SELECT s.category, s.name,
    COUNT_IF(s.d > DATEADD(day, -30, CURRENT_DATE()) AND s.is_new = 1)  AS volume30,   -- auctions + new comps
    MAX_BY(s.pic, s.end_at)                            AS image,
    MAX_BY(s.url, s.end_at)                            AS url,
    MAX_BY(s.card_title, s.end_at)                     AS card_title
  FROM s GROUP BY s.category, s.name
),
moves AS (
  SELECT category, name,
    SUM(LEAST(GREATEST(now_p / prev_p - 1, -0.8), 0.8) * n) / NULLIF(SUM(n), 0)  AS chg,
    COUNT(*)                    AS pairs
  FROM buckets
  WHERE now_p > 0 AND prev_p > 0
  GROUP BY category, name
),
weekly AS (
  SELECT category, name, DATE_TRUNC('week', d) AS wk, MEDIAN(price / NULLIF(bucket_med, 0)) AS r
  FROM s GROUP BY category, name, DATE_TRUNC('week', d)
),
spark AS (
  SELECT category, name, ARRAY_AGG(ROUND(r, 4)) WITHIN GROUP (ORDER BY wk) AS spark
  FROM weekly GROUP BY category, name
)
SELECT
  w.category                                          AS "category",
  w.name                                              AS "name",
  ROUND(m.chg * 100, 2)                               AS "change30",
  m.pairs                                             AS "pairs",
  w.volume30                                          AS "volume30",
  w.image                                             AS "image",
  w.url                                               AS "url",
  w.image                                             AS "card_image",
  w.card_title                                        AS "card_title",
  sp.spark                                            AS "spark"
FROM   win w
JOIN   moves m  ON m.category  = w.category AND m.name  = w.name
JOIN   spark sp ON sp.category = w.category AND sp.name = w.name
WHERE  w.volume30 >= 3          -- at least 3 sales in the last 30 days
  AND  m.pairs    >= 1          -- and at least one like-for-like card that sold in both windows
ORDER  BY ABS("change30") DESC;
