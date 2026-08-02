// Zero-dependency typed event emitter for the provider discovery system.
// All discovery, health, model, and capability state changes flow through this bus.
// The main process owns the bus; the renderer subscribes via IPC bridge events.
//
// Typed: every event has a well-defined payload shape documented in EVENTS. Emitting an
// unregistered event is allowed (loose coupling for future extension) but logged in debug.

const EVENTS = {
  // Discovery lifecycle
  'discovery:start':            ['providerType'],
  'discovery:provider:load':    ['providerId', 'providerType'],
  'discovery:provider:done':    ['providerId', 'providerType', 'modelCount', 'error'],
  'discovery:complete':         ['providerType', 'total', 'succeeded', 'failed'],
  'discovery:error':            ['providerId', 'error'],

  // Models
  'models:update':              ['providerId', 'models'],
  'models:selected':            ['providerType', 'providerId', 'tier', 'modelId'],
  'models:deprecated':          ['providerId', 'modelId', 'replacement'],
  'models:unavailable':         ['providerId', 'modelId', 'reason'],

  // Capabilities
  'capabilities:update':        ['providerId', 'capabilities'],

  // Health
  'health:provider':            ['providerId', 'state', 'previousState', 'timestamp'],
  'health:model':               ['providerId', 'modelId', 'state', 'previousState', 'timestamp'],

  // Cache
  'cache:loaded':               ['providerType', 'fromDisk', 'age'],
  'cache:updated':              ['providerType', 'modelCount'],
  'cache:invalidated':          ['providerId'],
}

class EventBus {
  constructor() {
    this._listeners = new Map() // event → Set<{cb, once}>
  }

  // Subscribe to an event. Returns an unsubscribe function.
  on(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('EventBus.on: callback must be a function');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    const entry = { cb, once: false };
    this._listeners.get(event).add(entry);
    return () => this._listeners.get(event)?.delete(entry);
  }

  // Subscribe to fire once, then auto-remove.
  once(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('EventBus.once: callback must be a function');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    const entry = { cb, once: true };
    this._listeners.get(event).add(entry);
    return () => this._listeners.get(event)?.delete(entry);
  }

  // Unsubscribe a specific callback (reference equality).
  off(event, cb) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const entry of set) {
      if (entry.cb === cb) { set.delete(entry); break; }
    }
  }

  // Emit an event with a payload object. Calls listeners synchronously.
  emit(event, data = {}) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Iterate over a snapshot so mid-call unsubscribes are safe
    const snapshot = [...set];
    for (const entry of snapshot) {
      try { entry.cb(data); } catch (err) { /* listener errors never propagate */ }
      if (entry.once) set.delete(entry);
    }
  }

  // Number of listeners for an event (for diagnostics / tests).
  listenerCount(event) {
    return this._listeners.get(event)?.size || 0;
  }

  // Remove all listeners (test escape hatch).
  _reset() {
    this._listeners.clear();
  }
}

// Export the event name constants for type safety at call sites
module.exports = { EventBus, EVENTS }
