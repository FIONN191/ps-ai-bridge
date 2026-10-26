/* Opt-in aggregate presence. The server never receives input contents or task details. */
(function (root) {
  'use strict';
  var backend = root.V7Backend;
  var host = {};
  var current = '';
  var optedIn = false;
  var stopped = false;
  var suspended = false;
  var interval = null;
  var epoch = 0;
  var lastInput = 0;
  var lastSentInput = 0;
  var lastAttempt = 0;
  var lease = false;
  var pending = false;
  var lastState = '';
  var HEARTBEAT_MS = 60000;
  var INPUT_WINDOW_MS = 300000;

  function identity(state) {
    return state && state.signedIn && state.account ? [state.baseUrl, state.account.id, state.deviceId, state.sessionVersion].join('|') : '';
  }
  function activeTask() {
    try { return typeof host.hasPendingGeneration === 'function' && host.hasPendingGeneration() === true; } catch (_) { return false; }
  }
  function visible() { return !root.document || root.document.visibilityState !== 'hidden'; }
  function reset() {
    epoch++; lastInput = 0; lastSentInput = 0; lastAttempt = 0;
    lease = false; pending = false; lastState = '';
  }
  function leave(options) {
    var hadLease = lease;
    reset();
    if (!hadLease || !backend.state().signedIn) return Promise.resolve();
    return backend.communityPresence('leave', options).catch(function () {});
  }
  function changed(state) {
    var next = identity(state);
    if (next !== current) { reset(); current = next; suspended = false; }
    var wasOptedIn = optedIn;
    optedIn = !!(state && state.account && (state.account.share_activity === true || state.account.share_activity === 1));
    if (!optedIn) {
      // Opt-out is already deleted atomically by the privacy endpoint.
      reset();
    } else if (!wasOptedIn) {
      lastInput = 0;
    }
    tick();
  }
  function tick() {
    if (stopped || suspended || !current || !optedIn || pending) return;
    var generating = activeTask();
    if (!visible() && !generating) { if (lease) leave(); return; }
    var now = Date.now();
    var freshInput = lastInput > lastSentInput && now - lastInput < INPUT_WINDOW_MS;
    if (!generating && !freshInput) return;
    var state = generating ? 'generating' : 'active';
    if (lastAttempt && now - lastAttempt < HEARTBEAT_MS && state === lastState) return;
    var version = epoch;
    var sentInput = lastInput;
    pending = true; lease = true; lastAttempt = now; lastState = state;
    backend.communityPresence(state).then(function () {
      if (version === epoch) lastSentInput = Math.max(lastSentInput, sentInput);
    }).catch(function (error) {
      if (version !== epoch) return;
      if (error && (error.code === 'ACTIVITY_CONSENT_REQUIRED' || error.status === 401)) {
        reset(); optedIn = false;
      }
    }).finally(function () { if (version === epoch) pending = false; });
  }
  function input(event) {
    if (!event || event.isTrusted !== true || stopped || suspended || !current || !optedIn || !visible()) return;
    lastInput = Date.now();
    tick();
  }
  function stop() {
    stopped = true;
    if (interval !== null) { root.clearInterval(interval); interval = null; }
    return leave({ keepalive: true });
  }
  function start() {
    stopped = false;
    if (interval === null) interval = root.setInterval(tick, 15000);
    changed(backend.state());
  }
  function sessionEnding() {
    suspended = true;
    return leave({ keepalive: true });
  }
  if (!backend) return;
  backend.onChange(changed);
  backend.onSessionEnding(sessionEnding);
  ['pointerdown', 'keydown', 'wheel', 'input'].forEach(function (name) {
    root.addEventListener(name, input, { capture: true, passive: true });
  });
  root.addEventListener('pagehide', stop);
  root.addEventListener('beforeunload', stop);
  root.addEventListener('wheelchair:explicit-quit', stop);
  if (root.document) root.document.addEventListener('visibilitychange', tick);
  root.V7CommunityPresence = {
    configure: function (options) { host = options || {}; start(); },
    tasksChanged: tick,
    stop: stop,
    start: start
  };
})(window);
