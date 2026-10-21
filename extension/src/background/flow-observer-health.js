/**
 * Check the MAIN-world Flow request observer and make one bounded repair attempt.
 * This module has no UI or submit side effects; callers can safely use it as a
 * preflight before dispatching a Flow generation request.
 */
export async function ensureCorrelationObserver(tabId, scripting = globalThis.chrome?.scripting) {
  if (!Number.isInteger(tabId) || tabId < 0 || !scripting?.executeScript) {
    throw new TypeError("A valid Flow tab and Chrome scripting API are required.");
  }

  const readHealth = async () => {
    const results = await scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const observer = window.__tobyFlowCorrelationObserver || window.__tobyFlowV2CorrelationObserver;
        try { return observer?.health?.() || null; } catch { return null; }
      },
    });
    return results?.[0]?.result || null;
  };

  let health = await readHealth().catch(() => null);
  if (health?.ready === true) return health;
  if (Number(health?.activeAttempts) > 0) {
    throw Object.assign(new Error("Flow's request observer is unhealthy while another correlation attempt is active; no submission was sent."), {
      code: "FLOW_CORRELATION_OBSERVER_BUSY", retryable: false, outcome_unknown: false,
    });
  }

  // Flow can replace document_start XHR/fetch hooks. The observer refuses to
  // replace itself while attempts are active, so one bounded reinjection is safe.
  await scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["content/bridge/flow-correlation-observer.js"],
  });
  health = await readHealth().catch(() => null);
  if (health?.ready !== true) {
    throw Object.assign(new Error("Flow's request observer could not be repaired and verified; no submission was sent."), {
      code: "FLOW_CORRELATION_OBSERVER_NOT_READY", retryable: false, outcome_unknown: false,
    });
  }
  return health;
}
