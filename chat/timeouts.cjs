// Shared application conventions; conversation state and session storage use
// the same idle lifetime, and generated summaries use the existing plan window.
const CHAT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CONFIRM_WINDOW_MS = 2 * 60 * 1000;
module.exports = { CHAT_SESSION_TIMEOUT_MS, CONFIRM_WINDOW_MS };
