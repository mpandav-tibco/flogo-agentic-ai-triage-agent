/**
 * Mock ServiceNow Incident API
 * Shape mirrors the real ServiceNow REST API so it can be swapped later
 * by changing only the base URL.
 *
 * Endpoints:
 *   POST   /api/now/table/incident            create incident
 *   GET    /api/now/table/incident            list/search (query params)
 *   GET    /api/now/table/incident/:sys_id    get by id
 *   PATCH  /api/now/table/incident/:sys_id    update (append work note, bump occurrence)
 *   GET    /api/now/stats                     demo helper: counts by decision
 *   POST   /api/now/reset                     demo helper: clear store
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8081;

// In-memory store
const incidents = new Map(); // sys_id -> incident
const rejected = [];         // bad-data audit trail
let counter = 1000;

function newIncident(payload) {
    const sys_id = crypto.randomUUID();
    const number = `INC${String(++counter).padStart(7, '0')}`;
    const now = new Date().toISOString();
    const incident = {
        sys_id,
        number,
        state: 'New',                 // New | In Progress | Resolved | Closed
        active: true,
        severity: payload.severity || '3 - Moderate',
        short_description: payload.short_description || '',
        description: payload.description || '',
        u_error_code: payload.u_error_code || '',
        u_app_name: payload.u_app_name || '',
        u_app_node: payload.u_app_node || '',
        u_process_name: payload.u_process_name || '',
        u_activity_name: payload.u_activity_name || '',
        u_correlation_id: payload.u_correlation_id || '',
        u_occurrence_count: 1,
        u_first_seen: now,
        u_last_seen: now,
        u_decision_source: payload.u_decision_source || 'manual',
        u_agent_confidence: payload.u_agent_confidence ?? null,
        opened_at: now,
        sys_updated_on: now,
        work_notes: (() => {
            const notes = [];
            if (payload.work_notes) notes.push({ at: now, note: payload.work_notes });
            if (payload.u_triage_reason) {
                const conf = payload.u_agent_confidence != null ? ` (conf=${payload.u_agent_confidence})` : '';
                const src = payload.u_decision_source ? ` [${payload.u_decision_source}]` : '';
                notes.push({ at: now, note: `Agent decision${src}${conf}: ${payload.u_triage_reason}` });
            }
            return notes;
        })()
    };
    incidents.set(sys_id, incident);
    return incident;
}

// --- Create ---
app.post('/api/now/table/incident', (req, res) => {
    const incident = newIncident(req.body || {});
    res.status(201).json({ result: incident });
});

// --- List / Search ---
// Supports: ?active=true&u_error_code=BW-JDBC-100014&u_app_name=OrderService&sysparm_limit=10&since_minutes=60
app.get('/api/now/table/incident', (req, res) => {
    const {
        active,
        u_error_code,
        u_app_name,
        u_app_node,
        u_process_name,
        severity,
        sysparm_limit = '50',
        since_minutes
    } = req.query;

    const limit = parseInt(sysparm_limit, 10);
    const sinceMs = since_minutes ? Date.now() - parseInt(since_minutes, 10) * 60 * 1000 : null;

    let result = Array.from(incidents.values());
    if (active !== undefined) result = result.filter(i => String(i.active) === String(active === 'true'));
    if (u_error_code) result = result.filter(i => i.u_error_code === u_error_code);
    if (u_app_name) result = result.filter(i => i.u_app_name === u_app_name);
    if (u_app_node) result = result.filter(i => i.u_app_node === u_app_node);
    if (u_process_name) result = result.filter(i => i.u_process_name === u_process_name);
    if (severity) result = result.filter(i => i.severity === severity);
    if (sinceMs) result = result.filter(i => new Date(i.u_last_seen).getTime() >= sinceMs);

    result.sort((a, b) => new Date(b.u_last_seen) - new Date(a.u_last_seen));
    res.json({ result: result.slice(0, limit) });
});

// --- Get by id ---
app.get('/api/now/table/incident/:sys_id', (req, res) => {
    const inc = incidents.get(req.params.sys_id);
    if (!inc) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ result: inc });
});

// --- Update (append work note / bump occurrence / change state) ---
app.patch('/api/now/table/incident/:sys_id', (req, res) => {
    const inc = incidents.get(req.params.sys_id);
    if (!inc) return res.status(404).json({ error: { message: 'Not found' } });

    const { work_notes, increment_occurrence, state, u_last_seen, u_agent_confidence } = req.body || {};
    const now = new Date().toISOString();

    if (work_notes) inc.work_notes.push({ at: now, note: work_notes });
    if (increment_occurrence) inc.u_occurrence_count += 1;
    if (state) {
        inc.state = state;
        inc.active = !['Resolved', 'Closed', 'Cancelled'].includes(state);
    }
    if (u_last_seen) inc.u_last_seen = u_last_seen;
    if (u_agent_confidence !== undefined) inc.u_agent_confidence = u_agent_confidence;
    inc.sys_updated_on = now;

    res.json({ result: inc });
});

// --- Demo helpers ---
app.post('/api/now/reject', (req, res) => {
    const entry = { at: new Date().toISOString(), ...req.body };
    rejected.push(entry);
    res.status(201).json({ result: entry });
});

app.get('/api/now/stats', (req, res) => {
    const all = Array.from(incidents.values());
    const created = all.filter(i => i.u_decision_source === 'agent-new' || i.u_decision_source === 'manual').length;
    const merges = all.reduce((sum, i) => sum + Math.max(0, i.u_occurrence_count - 1), 0);
    res.json({
        incidents_total: all.length,
        incidents_created: created,
        duplicates_merged: merges,
        bad_data_rejected: rejected.length,
        noise_reduction_pct: (merges + rejected.length + created) === 0
            ? 0
            : Math.round(((merges + rejected.length) / (merges + rejected.length + created)) * 100)
    });
});

app.post('/api/now/reset', (req, res) => {
    incidents.clear();
    rejected.length = 0;
    counter = 1000;
    res.json({ ok: true });
});

app.get('/api/now/rejected', (req, res) => res.json({ result: rejected }));

app.get('/health', (req, res) => res.json({ status: 'up', service: 'mock-servicenow' }));

app.listen(PORT, () => {
    console.log(`[mock-servicenow] listening on http://localhost:${PORT}`);
    console.log(`  POST   /api/now/table/incident`);
    console.log(`  GET    /api/now/table/incident?active=true&u_error_code=...`);
    console.log(`  PATCH  /api/now/table/incident/:sys_id`);
    console.log(`  GET    /api/now/stats`);
});
