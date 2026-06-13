/// <reference types="chrome" />

// The background worker and executors use the `chrome.*` namespace directly
// (debugger, scripting, tabGroups, tabs.captureVisibleTab) — these are typed by
// @types/chrome and work on both Chromium and Firefox (which aliases `chrome`).
