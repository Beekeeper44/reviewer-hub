-- Risers & Fallers feed, from Arena Club's own market data (Snowflake APP_PROD, Metabase db 397).
-- Source: APP_PROD.ADMIN.COMPS (130M external sold prices) joined to APP_PROD.ADMIN.CARD_TYPES (player / sport).
--
-- ⚠ STEP 0: the data dictionary doesn't list COMPS' columns, so three names below are best guesses.
--    Run this first and fix the three marked lines if they differ:
--
--    SELECT table_name, column_name, data_type FROM APP_PROD.information_schema.columns
--    WHERE table_schema='ADMIN' AND table_name IN ('COMPS','CARD_TYPES') ORDER BY 1,2;
--
--    ① COMPS.CARD_TYPE_ID  the key to CARD_TYPES.ID
--    ② COMPS.PRICE_CENTS   the sold price
--    ③ COMPS.SOLD_AT       the sale date. Check its type: NTZ needs the 3-arg CONVERT_TIMEZONE below,
--                          LTZ the 2-arg form (dialect §2.5)
--    ④ ADMIN.CARDS.FRONT_PICTURE_URL  a card photo, used as the row image (any *_picture_url on admin.cards)
--    Also confirm CARD_TYPES has PLAYER_NAME and SPORT (same values as admin.cards.sport).
--
-- Method: prices are indexed per card type (each sale ÷ that card type's 90-day median), so a player's
-- number isn't skewed by which cards happened to sell. 30-day change = median index over the last 30
-- days vs the 30 days before. Output column names are quoted lowercase so the JSON keys match the app.

WITH s AS (
  SELECT
    ct.PLAYER_NAME                                   AS name,
    LOWER(ct.SPORT)                                  AS sport,
    c.CARD_TYPE_ID                                   AS ctid,                    -- ①
    c.PRICE_CENTS / 100.0                            AS price,                   -- ②
    CONVERT_TIMEZONE('UTC','America/Los_Angeles', c.SOLD_AT)::DATE AS d          -- ③ (NTZ form)
  FROM APP_PROD.ADMIN.COMPS c
  JOIN APP_PROD.ADMIN.CARD_TYPES ct
    ON ct.ID = c.CARD_TYPE_ID AND NOT COALESCE(ct._SNOWFLAKE_DELETED, FALSE)
  WHERE NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)
    AND c.SOLD_AT >= DATEADD(day, -91, CURRENT_DATE())
    AND c.PRICE_CENTS > 0
    AND ct.PLAYER_NAME IS NOT NULL
    AND LOWER(ct.SPORT) IN ('baseball','basketball','football','pokemon','one_piece')
),
base AS (SELECT ctid, MEDIAN(price) AS med90 FROM s GROUP BY ctid),
idx  AS (SELECT s.*, s.price / NULLIF(b.med90, 0) AS ix FROM s JOIN base b ON b.ctid = s.ctid),
win  AS (
  SELECT sport, name,
    MEDIAN(IFF(d >  DATEADD(day,-30,CURRENT_DATE()), ix, NULL))                                        AS now_ix,
    MEDIAN(IFF(d <= DATEADD(day,-30,CURRENT_DATE()) AND d > DATEADD(day,-60,CURRENT_DATE()), ix, NULL)) AS prev_ix,
    COUNT_IF(d > DATEADD(day,-30,CURRENT_DATE()))                                                      AS volume30
  FROM idx GROUP BY sport, name
),
daily AS (SELECT sport, name, d, MEDIAN(ix) AS dix FROM idx GROUP BY sport, name, d),
pic AS (   -- one real card photo per player: the most recently graded Arena card of theirs
  SELECT LOWER(SPORT) AS sport, PLAYER_NAME AS name,
         MAX_BY(FRONT_PICTURE_URL, GRADED_AT) AS image                           -- ④
  FROM APP_PROD.ADMIN.CARDS
  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE) AND FRONT_PICTURE_URL IS NOT NULL
  GROUP BY 1, 2
),
spark AS (
  SELECT sport, name, ARRAY_AGG(ROUND(dix, 4)) WITHIN GROUP (ORDER BY d) AS spark
  FROM daily GROUP BY sport, name
)
SELECT
  IFF(w.sport = 'one_piece', 'onepiece', w.sport)     AS "category",
  w.name                                              AS "name",
  ROUND((w.now_ix / NULLIF(w.prev_ix, 0) - 1) * 100, 2) AS "change30",
  w.volume30                                          AS "volume30",
  p.image                                             AS "image",
  sp.spark                                            AS "spark"
FROM win w
JOIN spark sp ON sp.sport = w.sport AND sp.name = w.name
LEFT JOIN pic p ON p.sport = w.sport AND p.name = w.name
WHERE w.volume30 >= 10 AND w.prev_ix IS NOT NULL;
