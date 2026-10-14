-- Station depth chart (Neal, Oct 13): each training has ONE ordered list of people (#1, #2, #3 ...). Only one person
-- can be #1 at a station, one #2, and so on. SLB 1/2 share the SLB list, DCT 1-3 the DCT list. The planner fills every
-- station that has work with its #1, then works down the list. `priority` (the person's own order) is kept, derived
-- from depth, for older readers.
ALTER TABLE plan_person_trainings ADD COLUMN depth INTEGER;

-- Neal's chart as he set it on Oct 13 (applies only to people who exist, so test databases are unaffected).
DELETE FROM plan_person_trainings WHERE person_id IN ('01M4M7ZN31G0JV76QJEQ67N8AF','01M4M7ZN31G3GYCK45N5QR5NQG','01M4M7ZN31H1AFKDATPXX1MXCZ','01M4M7ZN31884E61MJM39HQ9JS','01M4M7ZN31CVWZMCE2VFBNQ518','01M4M7ZN3118AP6Q7MEE81QJ3S','01M4M7ZN31T6C4WBEX0S089GW5','01M4M7ZN315MP8D6RN17PY48KW','01M4M7ZN319242JY70DGAVFV2Q','01M4M7ZN31QCV70K39Q353RHAX','01M4M7ZN3124Z8X40MBSDJ6J5K','01M4M7ZN31GF5BHBA0TZQWDGR5');
INSERT INTO plan_person_trainings(person_id, training_id, priority, depth)
SELECT v.p, v.t, v.pr, v.d FROM (SELECT column1 AS p, column2 AS t, column3 AS pr, column4 AS d FROM (VALUES
  ('01M4M7ZN31GF5BHBA0TZQWDGR5','slt1',1,1),
  ('01M4M7ZN31GF5BHBA0TZQWDGR5','comf',2,7),
  ('01M4M7ZN319242JY70DGAVFV2Q','slt2',1,1),
  ('01M4M7ZN319242JY70DGAVFV2Q','comf',2,1),
  ('01M4M7ZN319242JY70DGAVFV2Q','slt1',3,2),
  ('01M4M7ZN319242JY70DGAVFV2Q','slb',4,3),
  ('01M4M7ZN319242JY70DGAVFV2Q','iab2',5,3),
  ('01M4M7ZN319242JY70DGAVFV2Q','dct',6,4),
  ('01M4M7ZN3118AP6Q7MEE81QJ3S','iab1',1,1),
  ('01M4M7ZN3118AP6Q7MEE81QJ3S','iab2',2,2),
  ('01M4M7ZN3118AP6Q7MEE81QJ3S','slt1',3,3),
  ('01M4M7ZN315MP8D6RN17PY48KW','slt2',1,2),
  ('01M4M7ZN315MP8D6RN17PY48KW','dct',2,3),
  ('01M4M7ZN31H1AFKDATPXX1MXCZ','slb',1,2),
  ('01M4M7ZN31H1AFKDATPXX1MXCZ','slt2',2,3),
  ('01M4M7ZN31H1AFKDATPXX1MXCZ','dcb',3,3),
  ('01M4M7ZN31H1AFKDATPXX1MXCZ','comf',4,4),
  ('01M4M7ZN31H1AFKDATPXX1MXCZ','dct',5,5),
  ('01M4M7ZN31G3GYCK45N5QR5NQG','slb',1,1),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','dct',1,2),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','dcb',2,2),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','tc',3,2),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','comf',4,3),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','slb',5,4),
  ('01M4M7ZN31G0JV76QJEQ67N8AF','iab2',6,6),
  ('01M4M7ZN31QCV70K39Q353RHAX','dct',1,1),
  ('01M4M7ZN31QCV70K39Q353RHAX','comf',2,2),
  ('01M4M7ZN31QCV70K39Q353RHAX','iab2',3,5),
  ('01M4M7ZN31CVWZMCE2VFBNQ518','dcb',1,1),
  ('01M4M7ZN31CVWZMCE2VFBNQ518','tc',2,1),
  ('01M4M7ZN31CVWZMCE2VFBNQ518','comf',3,5),
  ('01M4M7ZN31CVWZMCE2VFBNQ518','dct',4,6),
  ('01M4M7ZN31T6C4WBEX0S089GW5','iab2',1,1),
  ('01M4M7ZN31T6C4WBEX0S089GW5','iab1',2,2),
  ('01M4M7ZN31T6C4WBEX0S089GW5','comf',3,6),
  ('01M4M7ZN3124Z8X40MBSDJ6J5K','slo',1,1),
  ('01M4M7ZN3124Z8X40MBSDJ6J5K','iab2',2,4),
  ('01M4M7ZN31884E61MJM39HQ9JS','dco',1,1))) v
  WHERE EXISTS (SELECT 1 FROM core_people WHERE id = v.p) AND EXISTS (SELECT 1 FROM plan_trainings WHERE id = v.t);

-- Everyone else goes below, in their old order.
CREATE TABLE _depth_fill AS
  SELECT t.person_id, t.training_id,
         (SELECT COALESCE(MAX(x.depth), 0) FROM plan_person_trainings x WHERE x.training_id = t.training_id)
           + ROW_NUMBER() OVER (PARTITION BY t.training_id ORDER BY t.priority, t.person_id) AS d
    FROM plan_person_trainings t WHERE t.depth IS NULL;
UPDATE plan_person_trainings SET depth = f.d FROM _depth_fill f
  WHERE f.person_id = plan_person_trainings.person_id AND f.training_id = plan_person_trainings.training_id;
DROP TABLE _depth_fill;

CREATE UNIQUE INDEX ux_training_depth ON plan_person_trainings(training_id, depth) WHERE deleted_at IS NULL;

-- Neal didn't know what "TC" meant: spell the two later-in-the-day stations out.
UPDATE plan_trainings SET short = 'Comforters' WHERE id = 'comf';
UPDATE plan_trainings SET short = 'Tablecloths' WHERE id = 'tc';
