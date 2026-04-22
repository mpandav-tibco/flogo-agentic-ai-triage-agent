/**
 * BW6 Container Edition Error Simulator
 *
 * Modes:
 *   single  -> emit 1 random event
 *   storm   -> emit N events with heavy duplication (to prove noise reduction)
 *   edge    -> emit carefully crafted cases (bad-data, cross-app, low-confidence)
 *
 * Usage:
 *   node simulator.js --mode=storm --count=50 --target=http://localhost:8080/triage
 *   node simulator.js --mode=single
 *   node simulator.js --mode=edge
 *
 * If --target points at the triage agent, events flow through AI.
 * If --bypass is set, events go straight to mock ServiceNow (baseline noise).
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'bw6-error-catalog.json'), 'utf8'));

// ---- args ----
const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v === undefined ? true : v];
    })
);
const MODE = args.mode || 'single';
const COUNT = parseInt(args.count || '10', 10);
const TARGET = args.target || process.env.TARGET || 'http://localhost:8080/triage';
const BYPASS_TARGET = args.bypassTarget || process.env.BYPASS_TARGET || 'http://localhost:8081/api/now/table/incident';
const BYPASS = !!args.bypass;
const DELAY_MS = parseInt(args.delayMs || '200', 10);

// ---- helpers ----
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const podSuffix = () => Math.floor(Math.random() * 5);
const cid = () => crypto.randomUUID();

function buildEvent(template, overrides = {}) {
    const now = new Date().toISOString();
    return {
        timestamp: now,
        appName: template.appName,
        appNode: `${template.appNodePrefix}-${podSuffix()}`,
        processName: template.processName,
        activityName: template.activityName,
        errorCode: template.errorCode,
        errorMsg: template.messageTemplate,
        stackTrace: template.stackTraceTemplate,
        correlationId: cid(),
        severity: template.severity,
        ...overrides
    };
}

function buildBadData() {
    // Randomly chosen bad-data flavor
    const flavors = [
        { errorCode: '', errorMsg: 'null', appName: '', severity: '' }, // missing fields
        { errorCode: '???', errorMsg: '\x00\x00garbled\x00', appName: '???' }, // garbage
        { /* empty */ }
    ];
    return { timestamp: new Date().toISOString(), correlationId: cid(), ...pick(flavors) };
}

// ---- event generators ----
function genSingle() {
    return [buildEvent(pick(CATALOG))];
}

function genStorm(n) {
    // Pick 3 "real" issues, then blast duplicates of them. Sprinkle 2 bad-data events.
    const chosen = [
        CATALOG.find(c => c.id === 'E1'),
        CATALOG.find(c => c.id === 'E2'),
        CATALOG.find(c => c.id === 'E4')
    ];
    const events = [];
    const badDataCount = 2;
    const uniqueCount = chosen.length;
    const duplicatesPerIssue = Math.max(0, n - uniqueCount - badDataCount);

    // Seed: one of each unique
    for (const c of chosen) events.push(buildEvent(c));

    // Duplicates: same errorCode + same appName, slight variation of node/correlation
    for (let i = 0; i < duplicatesPerIssue; i++) {
        const c = chosen[i % chosen.length];
        events.push(buildEvent(c));
    }

    // Bad data
    for (let i = 0; i < badDataCount; i++) events.push(buildBadData());

    // Shuffle
    for (let i = events.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [events[i], events[j]] = [events[j], events[i]];
    }
    return events;
}

function genEdge() {
    // Curated edge cases:
    const e1 = CATALOG.find(c => c.id === 'E1');
    const e3 = CATALOG.find(c => c.id === 'E3');
    return [
        // 1. A JDBC timeout on OrderService (new)
        buildEvent(e1),
        // 2. Same JDBC timeout on OrderService again (should be duplicate)
        buildEvent(e1),
        // 3. Same JDBC timeout BUT on PaymentService (sneaky NEW - different app)
        buildEvent(e1, {
            appName: 'PaymentService',
            appNode: 'paymentservice-appnode-2',
            processName: 'PaymentFlow.process.PersistTransaction'
        }),
        // 4. REST 500 on same app/process (clear new incident)
        buildEvent(e3),
        // 5. Obvious duplicate of event 4 — same process, same message
        buildEvent(e3),
        // 6. LOW-CONFIDENCE: same app + errorCode (BW-REST-500, PaymentService),
        //    BUT different processName (FraudScreening vs ChargeCard) AND different
        //    downstream URL (fraud-check.internal vs stripe.example).
        //    Hits BOTH low-conf criteria from the rubric → agent must score conf < 0.75
        //    and open a new ticket rather than silently merging.
        buildEvent(e3, {
            appNode: 'paymentservice-appnode-7',
            processName: 'PaymentFlow.process.FraudScreening',
            activityName: 'InvokeRESTService',
            errorCode: 'BW-REST-500',
            errorMsg: 'Downstream service returned HTTP 500 Internal Server Error from https://fraud-check.internal/screen — fraud screening service unavailable',
            severity: '2 - High',
            stackTrace: 'com.tibco.bw.palette.rest.RESTPluginException: Non-2xx response from downstream\n\tat com.tibco.bw.palette.rest.runtime.InvokeRESTServiceActivity.processResponse(InvokeRESTServiceActivity.java:342)\nCaused by: java.io.IOException: Server returned HTTP response code: 500 for URL: https://fraud-check.internal/screen'
        }),
        // 7. Bad data
        buildBadData()
    ];
}

// ---- transport ----
function post(targetUrl, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(targetUrl);
        const lib = u.protocol === 'https:' ? https : http;
        const data = JSON.stringify(body);
        const req = lib.request(
            {
                method: 'POST',
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            },
            res => {
                let chunks = '';
                res.on('data', c => (chunks += c));
                res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
            }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function toBypassIncident(evt) {
    // If bypassing agent, every event becomes a raw incident (baseline noise)
    return {
        short_description: `[${evt.errorCode || 'UNKNOWN'}] ${evt.appName || 'unknown-app'} - ${evt.activityName || 'unknown-activity'}`,
        description: evt.errorMsg || '',
        severity: evt.severity || '3 - Moderate',
        u_error_code: evt.errorCode || '',
        u_app_name: evt.appName || '',
        u_app_node: evt.appNode || '',
        u_process_name: evt.processName || '',
        u_activity_name: evt.activityName || '',
        u_correlation_id: evt.correlationId || '',
        u_decision_source: 'bypass-baseline'
    };
}

// ---- main ----
async function run() {
    let events;
    if (MODE === 'storm') events = genStorm(COUNT);
    else if (MODE === 'edge') events = genEdge();
    else events = genSingle();

    const destination = BYPASS ? BYPASS_TARGET : TARGET;
    console.log(`[simulator] mode=${MODE} count=${events.length} target=${destination} bypass=${BYPASS}`);

    let ok = 0, fail = 0;
    for (const evt of events) {
        const payload = BYPASS ? toBypassIncident(evt) : evt;
        try {
            const res = await post(destination, payload);
            ok++;
            const label = BYPASS ? 'bypass->SN' : 'agent';
            console.log(`  [${label}] ${evt.errorCode || 'BAD_DATA'} @ ${evt.appName || '-'} -> HTTP ${res.status}`);
        } catch (e) {
            fail++;
            console.error(`  ! send failed: ${e.message}`);
        }
        if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    }
    console.log(`[simulator] done. sent=${ok} failed=${fail}`);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
