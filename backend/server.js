const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const pool = require('./db');
const app  = express();

app.use(cors());
app.use(express.json());

// ── Helper: generate 3-digit work_id ─────────────────────────────
// Finds the max existing work_id and increments, padded to 3 digits
async function generateWorkId(client) {
  // Use NULLIF + REGEXP to safely cast only numeric work_ids
  const result = await client.query(
    `SELECT MAX(CAST(NULLIF(REGEXP_REPLACE(work_id, '[^0-9]', '', 'g'), '') AS INTEGER)) as max_id
     FROM work_order_items`
  );
  const maxId = result.rows[0].max_id || 0;
  return String(maxId + 1).padStart(3, '0');
}

// ── GET /api/items/search?q=<query> ──────────────────────────────
app.get('/api/items/search', async (req, res) => {
  const raw = (req.query.q || '');
  const words = raw.toLowerCase().split(' ').map(w => w.trim()).filter(w => w.length > 0);
  if (words.length === 0) return res.json([]);

  try {
    // Simple approach: build one query that checks each word independently
    // Each word checked with LIKE against raw description AND cleaned description
    // WHERE = OR of all words (any match shows result)
    // Score = sum of matching words (for ranking)

    let paramIndex = 1;
    const params = [];
    const scoreParts = [];
    const whereParts = [];

    for (const word of words) {
      // clean version: remove all non-alphanumeric chars
      const clean = word.replace(/[^a-z0-9]/g, '');
      const likeWord  = '%' + word  + '%';
      const likeClean = '%' + clean + '%';

      params.push(likeWord);   const pi1 = paramIndex++;
      params.push(likeClean);  const pi2 = paramIndex++;

      // Match if: raw desc has word OR cleaned desc has cleaned word
      const matchExpr = `(LOWER(item_description) LIKE $${pi1} OR LOWER(REGEXP_REPLACE(item_description,'[^a-zA-Z0-9]','','g')) LIKE $${pi2})`;

      scoreParts.push(`CASE WHEN ${matchExpr} THEN 1 ELSE 0 END`);
      whereParts.push(matchExpr);
    }

    // AND: every typed word must be found somewhere in the description
    // This means only truly matching items appear — no partial junk
    const sql = `
      SELECT sl_no AS id, item_description AS description, unit, rate,
             (${scoreParts.join(' + ')}) AS score
      FROM finished
      WHERE ${whereParts.join(' AND ')}
      ORDER BY item_description
      LIMIT 30
    `;

    const result = await pool.query(sql, params);
    res.json(result.rows.map(r => ({
      id: r.id, description: r.description,
      unit: r.unit, rate: r.rate, score: Number(r.score)
    })));
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

// ── GET /api/items/:slno ─────────────────────────────────────────
app.get('/api/items/:slno', async (req, res) => {
  const { slno } = req.params;
  try {
    const sql = `
      SELECT sl_no AS id, item_description AS description, unit, rate
      FROM finished WHERE sl_no = $1
    `;
    const result = await pool.query(sql, [slno]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch item error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── GET /api/items ───────────────────────────────────────────────
app.get('/api/items', async (req, res) => {
  try {
    const sql = `
      SELECT sl_no AS id, item_description AS description, unit, rate
      FROM finished ORDER BY sl_no
    `;
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch all error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── POST /api/save-work-order ────────────────────────────────────
// Saves all items into work_order_items table.
// Generates:
//   work_id  = 3-digit number e.g. "001", "002"
//   item_id  = work_id + "_" + 2-digit item seq e.g. "001_01", "001_02"
//
// Make sure your work_order_items table has these columns:
//   work_id  TEXT
//   item_id  TEXT
//
// ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS work_id TEXT;
// ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_id TEXT;

app.post('/api/save-work-order', async (req, res) => {
  const { nameOfWork, division, circle, ward, items, savedBy, designation } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'No items to save' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const workId = await generateWorkId(client);
    const savedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item    = items[i];
      const itemSeq = String(i + 1).padStart(2, '0');
      const itemId  = `${workId}_${itemSeq}`;

      await client.query(
        `INSERT INTO work_order_items
           (work_id, item_id, name_of_work, division, circle, ward, sl_no,
            description, numbers, length, breadth, depth,
            quantity, unit, rate, amount, is_material,
            current_stage, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          workId, itemId,
          nameOfWork, division, circle, ward,
          i + 1,
          item.description,
          item.numbers  || 0,
          item.length   || 0,
          item.breadth  || 0,
          item.depth    || 0,
          item.quantity || 0,
          item.unit     || '',
          item.rate     || 0,
          item.amount   || 0,
          item.isMaterial === 'Yes',
          'Manager',   // always starts at Manager stage
          'draft',
          savedBy || ''
        ]
      );

      savedItems.push({ ...item, workId, itemId });
    }

    await client.query('COMMIT');
    res.json({ success: true, workId, savedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save work order error:', err.message);
    res.status(500).json({ error: 'Failed to save work order items', detail: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/save-abstract ──────────────────────────────────────
// Saves abstract summary. work_id links it to the work_order_items.
//
// ALTER TABLE abstracts ADD COLUMN IF NOT EXISTS work_id TEXT;

app.post('/api/save-abstract', async (req, res) => {
  const { workId, nameOfWork, materialTotal, civilWorksTotal, gstRate, gstAmount, lsAmount, grandTotal, editedBy } = req.body;
  const wid = (workId || '').trim();
  if (!wid) {
    return res.status(400).json({ error: 'workId is required to save abstract' });
  }
  try {
    // Check if abstract already exists for this work_id
    const existing = await pool.query(
      `SELECT id, ls_amount FROM abstracts WHERE work_id = $1`, [wid]
    );
    // Keep existing LS if new value is 0 (don't overwrite with 0)
    const existingLs = existing.rows.length > 0 ? Number(existing.rows[0].ls_amount) || 0 : 0;
    const finalLs    = (Number(lsAmount) > 0) ? Number(lsAmount) : existingLs;
    const finalGrand = parseFloat(
      (Number(materialTotal) + Number(civilWorksTotal) + Number(gstAmount) + finalLs).toFixed(2)
    );

    if (existing.rows.length > 0) {
      // UPDATE existing row
      await pool.query(
        `UPDATE abstracts SET
           name_of_work      = $1,
           material_total    = $2,
           civil_works_total = $3,
           gst_percentage    = $4,
           gst_amount        = $5,
           ls_amount         = $6,
           grand_total       = $7,
           edited_by         = $8
         WHERE work_id = $9`,
        [nameOfWork, materialTotal, civilWorksTotal,
         gstRate, gstAmount, finalLs, finalGrand, editedBy || '', wid]
      );
    } else {
      // INSERT new row
      await pool.query(
        `INSERT INTO abstracts
           (work_id, name_of_work, material_total, civil_works_total,
            gst_percentage, gst_amount, ls_amount, grand_total, edited_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [wid, nameOfWork, materialTotal, civilWorksTotal,
         gstRate, gstAmount, finalLs, finalGrand, editedBy || '']
      );
    }
    res.json({ success: true, ls_amount: finalLs, grand_total: finalGrand });
  } catch (err) {
    console.error('Save abstract error:', err.message);
    res.status(500).json({ error: 'Failed to save abstract', detail: err.message });
  }
});

// ── POST /api/login ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, username, password, designation, department, ward, circle, division, contact_number
       FROM users WHERE username = $1`,
      [username.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const user = result.rows[0];

    if (user.password !== password) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const assignmentColumns = {
      Manager:  { key: 'manager_key',  name: 'manager_name',  contact: 'manager_contact' },
      DGM:      { key: 'dgm_key',      name: 'dgm_name',      contact: 'dgm_contact' },
      GM:       { key: 'gm_key',       name: 'gm_name',       contact: 'gm_contact' },
      CGM:      { key: 'cgm_key',      name: 'cgm_name',      contact: 'cgm_contact' },
      Director: { key: 'director_key', name: 'director_name', contact: 'director_contact' }
    };
    const officerColumns = assignmentColumns[user.designation] || null;
    let assignedWard = user.ward || null;
    let assignedCircle = user.circle || null;
    let assignedDivision = user.division || null;

    if (officerColumns) {
      const assigned = await pool.query(
        `SELECT DISTINCT ward, circle, division
         FROM jurisdiction
         WHERE ${officerColumns.key} = $1
            OR LOWER(${officerColumns.name}) = LOWER($2)
            OR ${officerColumns.contact} = $3
         ORDER BY division, circle, ward`,
        [user.username, user.name || '', user.contact_number || '']
      );

      if (assigned.rows.length > 0) {
        const uniqueList = (field) => [...new Set(
          assigned.rows
            .map(row => (row[field] || '').toString().trim())
            .filter(Boolean)
        )].join(', ');

        assignedWard = uniqueList('ward') || assignedWard;
        assignedCircle = uniqueList('circle') || assignedCircle;
        assignedDivision = uniqueList('division') || assignedDivision;
      }
    }

    res.json({
      success: true,
      user: {
        id:            user.id,
        name:          user.name,
        username:      user.username,
        designation:   user.designation,
        department:    user.department,
        ward:          assignedWard     || null,
        circle:        assignedCircle   || null,
        division:      assignedDivision || null,
        contactNumber: user.contact_number
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});



// ── HIERARCHY CONFIG ─────────────────────────────────────────────
// Admin officer assignment maps selected jurisdiction depth to the officer role.
const ASSIGNMENT_LEVELS = {
  corporation: { designation: 'Director', keyCol: 'director_key', nameCol: 'director_name', contactCol: 'director_contact', required: ['corporation'] },
  zone: { designation: 'CGM', keyCol: 'cgm_key', nameCol: 'cgm_name', contactCol: 'cgm_contact', required: ['corporation', 'zone'] },
  division: { designation: 'GM', keyCol: 'gm_key', nameCol: 'gm_name', contactCol: 'gm_contact', required: ['corporation', 'zone', 'division'] },
  circle: { designation: 'DGM', keyCol: 'dgm_key', nameCol: 'dgm_name', contactCol: 'dgm_contact', required: ['corporation', 'zone', 'division', 'circle'] },
  ward: { designation: 'Manager', keyCol: 'manager_key', nameCol: 'manager_name', contactCol: 'manager_contact', required: ['corporation', 'zone', 'division', 'circle', 'ward'] }
};

function cleanText(value) {
  return (value || '').toString().trim();
}

function pickLevelFromQuery(query) {
  if (cleanText(query.ward)) return 'ward';
  if (cleanText(query.circle)) return 'circle';
  if (cleanText(query.division)) return 'division';
  if (cleanText(query.zone)) return 'zone';
  if (cleanText(query.corporation)) return 'corporation';
  return null;
}

function buildJurisdictionWhere(source, fields) {
  const clauses = [];
  const params = [];
  for (const field of fields) {
    const value = cleanText(source[field]);
    if (!value) continue;
    params.push(value);
    clauses.push(`${field} = $${params.length}`);
  }
  return { clauses, params };
}

function ensureRequiredScope(level, source) {
  const config = ASSIGNMENT_LEVELS[level];
  if (!config) return 'Invalid assignment level';
  if (!cleanText(source[level])) return `${level} is required`;
  return '';
}

app.get('/api/admin/jurisdiction/options', async (req, res) => {
  const { corporation, zone, division, circle } = req.query;
  const distinctOptions = (column, filters) => {
    const clauses = [`${column} IS NOT NULL`, `${column} <> ''`];
    const params = [];
    for (const [field, value] of Object.entries(filters)) {
      if (!cleanText(value)) continue;
      params.push(cleanText(value));
      clauses.push(`${field} = $${params.length}`);
    }
    return pool.query(
      `SELECT DISTINCT ${column} AS value FROM jurisdiction WHERE ${clauses.join(' AND ')} ORDER BY ${column}`,
      params
    );
  };

  try {
    const [corporations, zones, divisions, circles, wards] = await Promise.all([
      distinctOptions('corporation', { zone, division, circle }),
      distinctOptions('zone', { corporation, division, circle }),
      distinctOptions('division', { corporation, zone, circle }),
      distinctOptions('circle', { corporation, zone, division }),
      distinctOptions('ward', { corporation, zone, division, circle })
    ]);
    const values = rows => rows.map(r => r.value);
    const divisionsList = values(divisions.rows).sort((a, b) => Number(a) - Number(b));
    res.json({
      corporations: values(corporations.rows),
      zones: values(zones.rows),
      divisions: divisionsList,
      circles: values(circles.rows),
      wards: values(wards.rows)
    });
  } catch (err) {
    console.error('Admin options error:', err.message);
    res.status(500).json({ error: 'Failed to load jurisdiction options', detail: err.message });
  }
});

app.get('/api/admin/officers', async (req, res) => {
  const designation = cleanText(req.query.designation);
  try {
    const result = designation
      ? await pool.query(`SELECT "key", name, contact, designation FROM officers WHERE LOWER(designation) = LOWER($1) ORDER BY name`, [designation])
      : await pool.query(`SELECT "key", name, contact, designation FROM officers ORDER BY designation, name`);
    res.json(result.rows);
  } catch (err) {
    console.error('Admin officers error:', err.message);
    res.status(500).json({ error: 'Failed to load officers', detail: err.message });
  }
});

app.post('/api/admin/officers', async (req, res) => {
  const key = cleanText(req.body.key);
  const name = cleanText(req.body.name);
  const contact = cleanText(req.body.contact);
  const designation = cleanText(req.body.designation);
  if (!key || !name || !designation) return res.status(400).json({ error: 'key, name and designation are required' });

  try {
    const result = await pool.query(
      `INSERT INTO officers ("key", name, contact, designation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("key")
       DO UPDATE SET name = EXCLUDED.name, contact = EXCLUDED.contact, designation = EXCLUDED.designation
       RETURNING "key", name, contact, designation`,
      [key, name, contact, designation]
    );
    res.json({ success: true, officer: result.rows[0] });
  } catch (err) {
    console.error('Save officer error:', err.message);
    res.status(500).json({ error: 'Failed to save officer', detail: err.message });
  }
});

app.delete('/api/admin/officers/:key', async (req, res) => {
  const officerKey = cleanText(req.params.key);
  if (!officerKey) return res.status(400).json({ error: 'Officer key is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE jurisdiction SET
         manager_name = CASE WHEN manager_key = $1 THEN '' ELSE manager_name END,
         manager_contact = CASE WHEN manager_key = $1 THEN '' ELSE manager_contact END,
         manager_key = CASE WHEN manager_key = $1 THEN '' ELSE manager_key END,
         dgm_name = CASE WHEN dgm_key = $1 THEN '' ELSE dgm_name END,
         dgm_contact = CASE WHEN dgm_key = $1 THEN '' ELSE dgm_contact END,
         dgm_key = CASE WHEN dgm_key = $1 THEN '' ELSE dgm_key END,
         gm_name = CASE WHEN gm_key = $1 THEN '' ELSE gm_name END,
         gm_contact = CASE WHEN gm_key = $1 THEN '' ELSE gm_contact END,
         gm_key = CASE WHEN gm_key = $1 THEN '' ELSE gm_key END,
         cgm_name = CASE WHEN cgm_key = $1 THEN '' ELSE cgm_name END,
         cgm_contact = CASE WHEN cgm_key = $1 THEN '' ELSE cgm_contact END,
         cgm_key = CASE WHEN cgm_key = $1 THEN '' ELSE cgm_key END,
         director_name = CASE WHEN director_key = $1 THEN '' ELSE director_name END,
         director_contact = CASE WHEN director_key = $1 THEN '' ELSE director_contact END,
         director_key = CASE WHEN director_key = $1 THEN '' ELSE director_key END`,
      [officerKey]
    );
    const deleted = await client.query(`DELETE FROM officers WHERE "key" = $1 RETURNING "key", name, contact, designation`, [officerKey]);
    await client.query('COMMIT');
    res.json({ success: true, removed: deleted.rows[0] || null });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete officer error:', err.message);
    res.status(500).json({ error: 'Failed to delete officer', detail: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/assignment', async (req, res) => {
  const level = cleanText(req.query.level) || pickLevelFromQuery(req.query);
  const config = ASSIGNMENT_LEVELS[level];
  if (!config) return res.status(400).json({ error: 'Select at least a corporation' });
  const scopeError = ensureRequiredScope(level, req.query);
  if (scopeError) return res.status(400).json({ error: scopeError });

  const { clauses, params } = buildJurisdictionWhere(req.query, config.required);
  try {
    const result = await pool.query(
      `SELECT ${config.keyCol} AS officer_key, ${config.nameCol} AS officer_name, ${config.contactCol} AS officer_contact
       FROM jurisdiction WHERE ${clauses.join(' AND ')} LIMIT 1`,
      params
    );
    res.json({ level, designation: config.designation, assignment: result.rows[0] || null });
  } catch (err) {
    console.error('Assignment fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load current assignment', detail: err.message });
  }
});

app.put('/api/admin/assignment', async (req, res) => {
  const level = cleanText(req.body.level) || pickLevelFromQuery(req.body);
  const officerKey = cleanText(req.body.officerKey);
  const config = ASSIGNMENT_LEVELS[level];
  if (!config) return res.status(400).json({ error: 'Invalid assignment level' });
  const scopeError = ensureRequiredScope(level, req.body);
  if (scopeError) return res.status(400).json({ error: scopeError });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let officer = { key: '', name: '', contact: '' };
    if (officerKey) {
      const officerResult = await client.query(
        `SELECT "key", name, contact, designation FROM officers WHERE "key" = $1 AND LOWER(designation) = LOWER($2)`,
        [officerKey, config.designation]
      );
      if (officerResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Select a valid ${config.designation}` });
      }
      officer = officerResult.rows[0];
    }

    const { clauses, params } = buildJurisdictionWhere(req.body, config.required);
    const updateParams = [officer.key || '', officer.name || '', officer.contact || '', ...params];
    const whereSql = clauses.map((clause, index) => clause.replace(`$${index + 1}`, `$${index + 4}`)).join(' AND ');
    const updated = await client.query(
      `UPDATE jurisdiction SET ${config.keyCol} = $1, ${config.nameCol} = $2, ${config.contactCol} = $3 WHERE ${whereSql}`,
      updateParams
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      rowsUpdated: updated.rowCount,
      level,
      designation: config.designation,
      assignment: { officer_key: officer.key || '', officer_name: officer.name || '', officer_contact: officer.contact || '' }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Assignment update error:', err.message);
    res.status(500).json({ error: 'Failed to update assignment', detail: err.message });
  } finally {
    client.release();
  }
});

const HIERARCHY = ['Manager', 'DGM', 'GM', 'CGM', 'Director'];

function getNextStageInHierarchy(stage) {
  const idx = HIERARCHY.indexOf(stage);
  return idx >= 0 && idx < HIERARCHY.length - 1 ? HIERARCHY[idx + 1] : null;
}

function canEditWork(userDesignation, workCurrentStage) {
  // User can edit if work is currently at their stage
  return userDesignation === workCurrentStage;
}

function canViewWork(userDesignation, workCurrentStage) {
  // User can view if work has passed through their stage or is at/above their stage
  const userIdx = HIERARCHY.indexOf(userDesignation);
  const stageIdx = HIERARCHY.indexOf(workCurrentStage);
  return userIdx <= stageIdx; // can view if work is at or above their level
}

// ── GET /api/debug/works ── (temporary debug endpoint)
app.get('/api/debug/works', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (work_id) work_id, name_of_work, current_stage, status, submitted_by, created_at
       FROM work_order_items ORDER BY work_id, created_at DESC`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/debug/submissions ── (temporary debug endpoint)
app.get('/api/debug/submissions', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM work_submissions ORDER BY submitted_at DESC LIMIT 20`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/works/check?workId=<id>&designation=<des> ──────────
// Hierarchy (bottom to top): Manager -> DGM -> GM -> CGM -> Director
// Rules:
//   Director always gets edit
//   designation === current_stage -> edit
//   everyone else -> view only
app.get('/api/works/check', async (req, res) => {
  const { workId, designation } = req.query;
  if (!workId || !designation) {
    return res.status(400).json({ error: 'workId and designation are required' });
  }

  try {
    const sql = `
      SELECT DISTINCT ON (work_id)
        work_id, name_of_work, division, circle, ward,
        current_stage, status, submitted_by, created_at
      FROM work_order_items
      WHERE work_id = $1 OR LOWER(name_of_work) LIKE LOWER($2)
      ORDER BY work_id, created_at DESC
      LIMIT 1
    `;
    const result = await pool.query(sql, [workId.trim(), `%${workId.trim()}%`]);

    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }

    const work = result.rows[0];

    // Get last submission info
    const subResult = await pool.query(
      `SELECT submitted_at, from_stage, to_stage, submitted_by
       FROM work_submissions
       WHERE work_id = $1
       ORDER BY submitted_at DESC LIMIT 1`,
      [work.work_id]
    );
    const lastSub = subResult.rows.length > 0 ? subResult.rows[0] : null;

    // Access logic
    let access = 'view';
    if (designation === 'Director') {
      access = 'edit';  // Director always edits
    } else if (designation === work.current_stage) {
      access = 'edit';  // Work is waiting at this person's level
    }
    // All others (submitter and above-but-not-yet-reached) = view

    res.json({
      exists:            true,
      access,
      work_id:           work.work_id,
      name_of_work:      work.name_of_work,
      division:          work.division,
      circle:            work.circle,
      ward:              work.ward,
      current_stage:     work.current_stage,
      status:            work.status,
      next_stage:        getNextStageInHierarchy(work.current_stage),
      last_submitted_at: lastSub ? lastSub.submitted_at : null,
      last_submitted_by: lastSub ? lastSub.submitted_by : null,
      last_from_stage:   lastSub ? lastSub.from_stage   : null,
      last_to_stage:     lastSub ? lastSub.to_stage     : null
    });

  } catch (err) {
    console.error('works/check error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── GET /api/works/by-name?q=<query> ────────────────────────────
// Search work by work_id or name_of_work — returns first match with stage info
app.get('/api/works/by-name', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json(null);

  try {
    // Try exact work_id first, then name match
    const sql = `
      SELECT DISTINCT ON (work_id)
        work_id, name_of_work, division, circle, ward,
        current_stage, status, edited_by, created_at
      FROM work_order_items
      WHERE work_id = $1 OR LOWER(name_of_work) LIKE LOWER($2)
      ORDER BY work_id, created_at DESC
      LIMIT 1
    `;
    const result = await pool.query(sql, [q, `%${q}%`]);
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('works/by-name error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── WORKFLOW CONFIG ──────────────────────────────────────────────
const STAGES = ['Manager', 'DGM', 'GM', 'CGM', 'Director'];

function getNextStage(current) {
  const idx = STAGES.indexOf(current);
  return idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
}

function getDesignationStage(designation) {
  // Map designation to stage name
  const map = {
    'Manager':  'Manager',
    'DGM':      'DGM',
    'GM':       'GM',
    'CGM':      'CGM',
    'Director': 'Director'
  };
  return map[designation] || null;
}

// ── GET /api/works?stage=DGM&submittedBy=Rajesh ──────────────────
// Returns two sets merged:
//   1. Works currently AT this stage (in_progress) — user needs to review
//   2. Works this user already submitted further (submitted) — for their record
app.get('/api/works', async (req, res) => {
  const { stage, submittedBy } = req.query;
  if (!stage) return res.status(400).json({ error: 'stage is required' });

  try {
    // Set 1: works waiting at this stage → display_status = 'in_progress'
    const inProgressSql = `
      SELECT DISTINCT ON (w.work_id)
        w.work_id, w.name_of_work, w.division, w.circle, w.ward,
        w.current_stage, w.created_at,
        s.submitted_at, s.from_stage, s.to_stage, s.submitted_by AS last_submitted_by,
        'in_progress' AS display_status
      FROM work_order_items w
      LEFT JOIN (
        SELECT DISTINCT ON (work_id) work_id, submitted_at, from_stage, to_stage, submitted_by
        FROM work_submissions ORDER BY work_id, submitted_at DESC
      ) s ON s.work_id = w.work_id
      WHERE w.current_stage = $1
      ORDER BY w.work_id, w.created_at DESC
    `;

    // Set 2: works this user submitted (moved past their stage) → display_status = 'submitted'
    // These are works where this user appears in work_submissions as submitted_by
    // and current_stage is now BEYOND this stage
    const submittedSql = `
      SELECT DISTINCT ON (w.work_id)
        w.work_id, w.name_of_work, w.division, w.circle, w.ward,
        w.current_stage, w.created_at,
        s.submitted_at, s.from_stage, s.to_stage, s.submitted_by AS last_submitted_by,
        'submitted' AS display_status
      FROM work_order_items w
      INNER JOIN (
        SELECT DISTINCT ON (work_id) work_id, submitted_at, from_stage, to_stage, submitted_by
        FROM work_submissions
        WHERE submitted_by = $1
        ORDER BY work_id, submitted_at DESC
      ) s ON s.work_id = w.work_id
      WHERE w.current_stage <> $2
      ORDER BY w.work_id, w.created_at DESC
    `;

    const [inProgressResult, submittedResult] = await Promise.all([
      pool.query(inProgressSql, [stage]),
      submittedBy
        ? pool.query(submittedSql, [submittedBy, stage])
        : Promise.resolve({ rows: [] })
    ]);

    // Merge — if a work_id appears in both, keep in_progress version
    const seen = new Set();
    const combined = [];

    for (const row of inProgressResult.rows) {
      seen.add(row.work_id);
      combined.push(row);
    }
    for (const row of submittedResult.rows) {
      if (!seen.has(row.work_id)) {
        seen.add(row.work_id);
        combined.push(row);
      }
    }

    // Sort: in_progress first, then submitted; within each group by created_at desc
    combined.sort((a, b) => {
      if (a.display_status === b.display_status) {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      return a.display_status === 'in_progress' ? -1 : 1;
    });

    res.json(combined);
  } catch (err) {
    console.error('Fetch works error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── POST /api/works/save ─────────────────────────────────────────
// Save a NEW work (draft) without submitting
app.post('/api/works/save', async (req, res) => {
  const { nameOfWork, division, circle, ward, items, gstRate, gstAmount, grandTotal, submittedBy, designation } = req.body;
  if (!nameOfWork || !items || items.length === 0) {
    return res.status(400).json({ error: 'Work name and at least one item are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workId = await generateWorkId(client);

    // Delete any existing rows for this name (shouldn't exist but safety first)
    await client.query('DELETE FROM work_order_items WHERE LOWER(name_of_work) = LOWER($1)', [nameOfWork]);

    for (let i = 0; i < items.length; i++) {
      const item    = items[i];
      const itemSeq = String(i + 1).padStart(2, '0');
      const itemId  = `${workId}_${itemSeq}`;
      await client.query(
        `INSERT INTO work_order_items
           (work_id, item_id, name_of_work, division, circle, ward, sl_no,
            description, numbers, length, breadth, depth,
            quantity, unit, rate, amount, is_material,
            current_stage, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          workId, itemId, nameOfWork, division || '', circle || '', ward || '',
          i + 1, item.description,
          item.numbers || 0, item.length || 0, item.breadth || 0, item.depth || 0,
          item.quantity || 0, item.unit || '', item.rate || 0, item.amount || 0,
          item.isMaterial === 'Yes',
          designation || 'Manager',  // current_stage = user's own stage for draft
          'draft',
          submittedBy || ''
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, work_id: workId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save new work error:', err.message);
    res.status(500).json({ error: 'Failed to save work', detail: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/works/:workId/save ──────────────────────────────────
// Update (re-save) an existing work draft without submitting
app.post('/api/works/:workId/save', async (req, res) => {
  const { workId } = req.params;
  const { nameOfWork, division, circle, ward, items, gstRate, gstAmount, grandTotal, submittedBy, designation } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete old items for this work
    await client.query('DELETE FROM work_order_items WHERE work_id = $1', [workId]);

    for (let i = 0; i < items.length; i++) {
      const item    = items[i];
      const itemSeq = String(i + 1).padStart(2, '0');
      const itemId  = `${workId}_${itemSeq}`;
      await client.query(
        `INSERT INTO work_order_items
           (work_id, item_id, name_of_work, division, circle, ward, sl_no,
            description, numbers, length, breadth, depth,
            quantity, unit, rate, amount, is_material,
            current_stage, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          workId, itemId, nameOfWork || '', division || '', circle || '', ward || '',
          i + 1, item.description,
          item.numbers || 0, item.length || 0, item.breadth || 0, item.depth || 0,
          item.quantity || 0, item.unit || '', item.rate || 0, item.amount || 0,
          item.isMaterial === 'Yes',
          designation || 'Manager',
          'draft',
          submittedBy || ''
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, work_id: workId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update work error:', err.message);
    res.status(500).json({ error: 'Failed to update work', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/works/:workId/items ─────────────────────────────────
// Returns all items for a given work_id
app.get('/api/works/:workId/items', async (req, res) => {
  const { workId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM work_order_items WHERE work_id = $1 ORDER BY sl_no`,
      [workId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch work items error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── GET /api/works/:workId/abstract ──────────────────────────────
app.get('/api/works/:workId/abstract', async (req, res) => {
  const { workId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM abstracts WHERE work_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Abstract not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch abstract error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── POST /api/works/:workId/submit ───────────────────────────────
// Submits work to next stage
app.post('/api/works/:workId/submit', async (req, res) => {
  const { workId } = req.params;
  const { submittedBy, designation, remarks } = req.body;

  const currentStage = getDesignationStage(designation);
  if (!currentStage) {
    return res.status(400).json({ error: 'Invalid designation' });
  }

  const nextStage = getNextStage(currentStage);
  if (!nextStage) {
    return res.status(400).json({ error: 'Already at final stage (Director)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log(`[SUBMIT] workId=${workId} designation=${designation} currentStage=${currentStage} nextStage=${nextStage}`);

    // Update work_order_items to next stage
    const updateResult = await client.query(
      `UPDATE work_order_items
       SET current_stage = $1, status = 'submitted', submitted_by = $2
       WHERE work_id = $3`,
      [nextStage, submittedBy, workId]
    );
    console.log(`[SUBMIT] rows updated: ${updateResult.rowCount}`);

    // Update abstract to next stage
    await client.query(
      `UPDATE abstracts SET current_stage = $1, status = 'submitted'
       WHERE work_id = $2`,
      [nextStage, workId]
    );

    // Log submission
    await client.query(
      `INSERT INTO work_submissions (work_id, from_stage, to_stage, submitted_by, remarks)
       VALUES ($1, $2, $3, $4, $5)`,
      [workId, currentStage, nextStage, submittedBy, remarks || '']
    );

    await client.query('COMMIT');
    res.json({ success: true, fromStage: currentStage, toStage: nextStage });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Submit failed', detail: err.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/works/:workId/items ─────────────────────────────────
// Update items (for DGM/GM/CGM/Director edits)
app.put('/api/works/:workId/items', async (req, res) => {
  const { workId } = req.params;
  const { items, editedBy } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(
        `UPDATE work_order_items
         SET description=$1, numbers=$2, length=$3, breadth=$4, depth=$5,
             quantity=$6, unit=$7, rate=$8, amount=$9, edited_by=$10
         WHERE work_id=$11 AND item_id=$12`,
        [item.description, item.numbers, item.length, item.breadth, item.depth,
         item.quantity, item.unit, item.rate, item.amount, editedBy,
         workId, item.item_id]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update items error:', err.message);
    res.status(500).json({ error: 'Update failed', detail: err.message });
  } finally {
    client.release();
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
