// Keep audit evidence narrow: jobView already applies the server-side allowlist,
// and this final boundary rejects arbitrary objects from older or alternate APIs.
const FIELD_KEYS = new Set(['shape', 'prompt', 'model', 'quantity', 'referenceIds', 'project']);
const REASON_CODES = new Set([
  'payload_unparsed', 'payload_shape_mismatch', 'quantity_mismatch', 'prompt_mismatch',
  'model_mismatch', 'reference_ids_mismatch', 'project_mismatch', 'request_path_unrecognized',
  'payload_match_failed', 'retired_request_signature', 'attempt_interfered',
  'request_cardinality_exhausted', 'rpc_payload_unparsed',
]);

export function auditRequestDiagnostics(job) {
  const input = job?.request_diagnostics;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const request = input.requestDiagnostics;
  if (!request || request.version !== 1 || !Array.isArray(request.events)) return null;
  const events = request.events.slice(-32).map(event => ({
    observedAt: typeof event?.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(event.observedAt) ? event.observedAt : null,
    mediaType: ['image', 'video', 'unknown'].includes(event?.mediaType) ? event.mediaType : 'unknown',
    transport: ['xhr', 'fetch', 'unknown'].includes(event?.transport) ? event.transport : 'unknown',
    payloadVersion: Number.isSafeInteger(event?.payloadVersion) && event.payloadVersion >= 0 && event.payloadVersion <= 1000 ? event.payloadVersion : null,
    payloadShape: typeof event?.payloadShape === 'string' ? event.payloadShape.slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, '') || null : null,
    pathClass: ['image', 'video', 'other'].includes(event?.pathClass) ? event.pathClass : 'other',
    pathRecognized: event?.pathRecognized === true,
    payloadMatched: event?.payloadMatched === true,
    fields: Object.fromEntries(Object.entries(event?.fields || {}).filter(([key]) => FIELD_KEYS.has(key)).slice(0, 32).map(([key, value]) => [key, Boolean(value)])),
    reasons: Array.isArray(event?.reasons) ? [...new Set(event.reasons.filter(reason => typeof reason === 'string' && REASON_CODES.has(reason)))].slice(0, 16) : [],
  }));
  return {
    clickDelivered: input.clickDelivered === true,
    observerReady: input.observerReady === true,
    xhrHookActive: input.xhrHookActive === true,
    fetchHookActive: input.fetchHookActive === true,
    requestDiagnostics: { version: 1, count: events.length, events },
  };
}

export function auditLatestJob(job) {
  return {
    status: ['queued', 'running', 'submitted', 'done', 'failed', 'cancelled'].includes(job?.status) ? job.status : 'unknown',
    attempts: Number.isSafeInteger(job?.attempts) && job.attempts >= 0 ? job.attempts : null,
    credits: Number.isFinite(job?.credits) ? job.credits : null,
    credit_quote_verified: job?.credit_quote_verified === true,
    error_category: ['quota', 'rate_limit', 'session', 'download', 'unsupported', 'extension', 'generation'].includes(job?.error_category) ? job.error_category : null,
    outcome_unknown: job?.outcome_unknown === true,
    request_dispatched: job?.request_dispatched === true,
    server_acceptance_observed: job?.server_acceptance_observed === true,
    request_diagnostics: auditRequestDiagnostics(job),
  };
}
