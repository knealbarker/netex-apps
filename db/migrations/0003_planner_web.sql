-- The planner web app lives at prodplanner.netexcleaners.com; Neal is the first user (Owner of every app).
UPDATE core_apps SET subdomain = 'prodplanner', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), rev = rev + 1 WHERE id = 'planner';
INSERT INTO core_users(id, org_id, email, display_name) VALUES ('01M4HHR000K07CJCEBQ9BM9ZZM', 'tcc', 'neal@towncountryclean.com', 'Neal Barker');
INSERT INTO core_user_app_roles(user_id, app_id, role_id, granted_at) VALUES
  ('01M4HHR000K07CJCEBQ9BM9ZZM', 'core', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('01M4HHR000K07CJCEBQ9BM9ZZM', 'planner', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
