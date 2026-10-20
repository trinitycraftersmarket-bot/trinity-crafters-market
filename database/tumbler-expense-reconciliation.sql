-- Ashley / Salty Luna Co tumbler credits are organizer expenses, not vendor cancellation credits.
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS payee text NOT NULL DEFAULT '';
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS settled_by text;
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS tumbler_quantity integer;
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS tumbler_source_type text;
ALTER TABLE market.expenses ADD COLUMN IF NOT EXISTS tumbler_source_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS market_expenses_tumbler_source_unique
ON market.expenses(tumbler_source_type, tumbler_source_id) WHERE tumbler_source_id IS NOT NULL;
UPDATE market.expenses
 SET category='Tumbler Credit',
     payee=CASE WHEN payee='' THEN 'Ashley / Salty Luna Co' ELSE payee END,
     tumbler_quantity=CASE WHEN amount>0 AND amount%2000=0 THEN amount/2000 ELSE tumbler_quantity END
 WHERE lower(trim(description))='tumbler credit' AND (category='General' OR payee='' OR tumbler_quantity IS NULL);
-- Existing expenses remain the single source of truth, with their original amounts and dates intact.
