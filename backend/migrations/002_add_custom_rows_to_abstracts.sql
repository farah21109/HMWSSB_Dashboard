-- Migration: Add custom_rows JSONB column to abstracts table
-- Purpose: Enable storing custom line items for Part II and Part III in abstract

ALTER TABLE abstracts
  ADD COLUMN IF NOT EXISTS custom_rows JSONB DEFAULT '{"part2":[],"part3":[]}'::jsonb;

-- Example structure of custom_rows:
-- {
--   "part2": [
--     {"description": "Custom Item 1", "amount": 500},
--     {"description": "Custom Item 2", "amount": 1000}
--   ],
--   "part3": [
--     {"description": "Custom Provision 1", "amount": 250},
--     {"description": "Custom Provision 2", "amount": 750}
--   ]
-- }
