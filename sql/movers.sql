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

  WHY RATIOS: every sale is divided by that card's estimated value, so a player's
  number isn't skewed by which cards happened to sell (a $2,000 rookie one month,
  $40 base cards the next). The EV is just a fixed yardstick per card; what moves is
  how far above or below it the hammer lands.

    change30 = median(hammer ÷ EV, last 30 days) ÷ median(hammer ÷ EV, days 31–60) − 1
    volume30 = auction sales + distinct comps in the last 30 days
    spark    = weekly median hammer ÷ EV over the last 13 weeks
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
    CASE
      WHEN sport ILIKE '%baseball%'                                 THEN 'baseball'
      WHEN sport ILIKE '%basketball%'                               THEN 'basketball'
      WHEN sport ILIKE '%football%' AND sport NOT ILIKE '%soccer%'  THEN 'football'
      WHEN sport ILIKE '%pok%'                                      THEN 'pokemon'
      WHEN sport ILIKE '%one%piece%'                                THEN 'onepiece'
    END                                                             AS category
  FROM APP_PROD.ADMIN.CARDS
  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
    AND estimated_value_cents > 0
    -- third-party slabs only: PSA, Beckett (BGS / BVG / BCCG), SGC, CSG. No Arena Club grades, no raw cards.
    AND UPPER(TRIM(grading_company)) ILIKE ANY ('PSA%', 'BGS%', 'BVG%', 'BCCG%', '%BECKETT%', 'SGC%', 'CSG%')
    AND NULLIF(TRIM(player_name), '') IS NOT NULL
),
auction_sales AS (
  SELECT a.item_id AS card_id,
         a.current_bid_value_cents                               AS price_cents,
         CONVERT_TIMEZONE('America/Los_Angeles', a.end_at)::date AS d,
         a.end_at::timestamp_ntz                                 AS evt_at
  FROM   APP_PROD.PUBLIC.AUCTION a
  WHERE  a.item_category = 'card'
    AND  NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
    AND  a.status::text = 'completed'
    AND  a.current_bid_value_cents > 0
    AND  a.end_at >= DATEADD(day, -91, CURRENT_TIMESTAMP)
    AND  a.end_at <= CURRENT_TIMESTAMP
),
comp_sales AS (   -- one row per distinct (card, comp) — a repeated recomp is not a new sale
  SELECT card_id,
         last_comp_value_cents                                AS price_cents,
         COALESCE(finished_at, created_at)::timestamp::date   AS d,
         COALESCE(finished_at, created_at)::timestamp_ntz     AS evt_at
  FROM   APP_PROD.ADMIN.ESTIMATED_VALUE
  WHERE  NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
    AND  grading_task_status IN ('approved', 'done_skip_verify')
    AND  last_comp_value_cents > 0
    AND  COALESCE(finished_at, created_at) >= DATEADD(day, -91, CURRENT_TIMESTAMP)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY card_id, last_comp_value_cents
                             ORDER BY COALESCE(finished_at, created_at)) = 1
),
sales AS (
  SELECT c.category,
         TRIM(c.player_name)                                    AS name,
         x.price_cents / c.estimated_value_cents                AS ratio,
         x.d,
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
s AS (   -- drop obvious data errors: a hammer 20× over or under EV is a typo, not a market move
  SELECT * FROM sales
  WHERE  category IS NOT NULL
    AND  ratio BETWEEN 0.05 AND 20
),
win AS (
  SELECT category, name,
    MEDIAN(IFF(d >  DATEADD(day, -30, CURRENT_DATE()), ratio, NULL))                                           AS now_r,
    MEDIAN(IFF(d <= DATEADD(day, -30, CURRENT_DATE()) AND d > DATEADD(day, -60, CURRENT_DATE()), ratio, NULL)) AS prev_r,
    COUNT_IF(d >  DATEADD(day, -30, CURRENT_DATE()))                                                           AS volume30,
    COUNT_IF(d <= DATEADD(day, -30, CURRENT_DATE()) AND d > DATEADD(day, -60, CURRENT_DATE()))                 AS prev_n,
    MAX_BY(pic, end_at)                                                                                        AS image,
    MAX_BY(url, end_at)                                                                                        AS url,
    MAX_BY(card_title, end_at)                                                                                 AS card_title
  FROM s
  GROUP BY category, name
),
weekly AS (
  SELECT category, name, DATE_TRUNC('week', d) AS wk, MEDIAN(ratio) AS r
  FROM s GROUP BY category, name, DATE_TRUNC('week', d)
),
spark AS (
  SELECT category, name, ARRAY_AGG(ROUND(r, 4)) WITHIN GROUP (ORDER BY wk) AS spark
  FROM weekly GROUP BY category, name
)
SELECT
  w.category                                          AS "category",
  w.name                                              AS "name",
  ROUND((w.now_r / NULLIF(w.prev_r, 0) - 1) * 100, 2) AS "change30",
  w.volume30                                          AS "volume30",
  w.image                                             AS "image",
  w.url                                               AS "url",
  w.image                                             AS "card_image",
  w.card_title                                        AS "card_title",
  sp.spark                                            AS "spark"
FROM   win w
JOIN   spark sp ON sp.category = w.category AND sp.name = w.name
WHERE  w.volume30 >= 3          -- enough sales in each window to mean something;
  AND  w.prev_n   >= 3          -- the app's MOVERS_MIN_VOLUME can raise the bar further
  AND  w.prev_r   > 0
ORDER  BY ABS("change30") DESC;
