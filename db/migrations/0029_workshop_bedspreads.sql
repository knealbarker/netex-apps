-- Neal, Oct 23, 2026: only bedspreads whose SMRT item type starts with "Z-SS" are worked in the Sulphur Springs workshop.
-- Other bedspreads/comforters are done at the Laundry Hub with Wash & Fold, so the planner leaves them out.
-- The saved planner SMRT mapping still has the old "Comforter, Bedspread"; switch it to "Z-SS*" (starts with Z-SS).
-- The new Laundry Hub list (smrt.hubTypes) comes from the code default ("Bedspread, Comforter") until someone saves it.
UPDATE core_settings
   SET value_json = json_set(value_json, '$.itemTypes.comf', 'Z-SS*'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE app_id = 'planner' AND key = 'smrt' AND deleted_at IS NULL
   AND json_extract(value_json, '$.itemTypes.comf') = 'Comforter, Bedspread';
