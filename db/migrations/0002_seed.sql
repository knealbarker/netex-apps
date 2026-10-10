-- Starting rows every app relies on.
INSERT INTO core_organizations(id, name, legal_name, timezone) VALUES ('tcc', 'Town & Country Cleaners', 'Netex Cleaners', 'America/Chicago');
INSERT INTO core_apps(id, name, subdomain) VALUES ('core', 'Users & settings', NULL), ('planner', 'Production Planner', 'planner');
INSERT INTO core_roles(id, name, rank) VALUES ('owner', 'Owner', 40), ('admin', 'Admin', 30), ('manager', 'Manager', 20), ('viewer', 'Viewer', 10);
INSERT INTO int_integrations(id, org_id, kind, name, config_json) VALUES
  ('smrt', 'tcc', 'smrt', 'SMRT reports', '{"ordersReport":"ebe7b9bb-20b7-472b-9925-2b729fe2a38b","itemsReport":"8f6e82e5-8e64-466c-935a-35a22ee5fd01"}'),
  ('rippling', 'tcc', 'rippling', 'Rippling time clock report', NULL);
INSERT INTO plan_followup_reasons(id, name, sort) VALUES
  ('stain', 'Stain treatment', 1), ('repair', 'Repair', 2), ('customer', 'Customer request', 3),
  ('waiting', 'Waiting on customer', 4), ('missing', 'Missing item', 5), ('other', 'Other', 9);
