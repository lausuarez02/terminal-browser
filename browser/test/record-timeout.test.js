const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

// RecordSession only uses @zenbu-labs/pixel for types, but ./compositor, ./recorder and
// ../ui/markup-canvas pull the package in at runtime, and loading it requires electron plus a
// prebuilt native addon. Both only ever get touched through the RecordHost/RecordTarget stubs
// below, so the package resolves to an empty namespace here and the session class itself is real.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@zenbu-labs/pixel") return {};
  return load.call(this, request, ...rest);
};
const { RecordSession } = require("../dist/record/session.js");

const FRAME = { tMs: 0, width: 4, height: 4, dropsBefore: 0 };

function harness({ frames = [] } = {}) {
  const calls = { finished: 0, toasts: [], clipboard: [] };
  let dir = null;
  const capture = {
    stop: () => ({ durationMs: 200 }),
    index: () => ({ frames }),
    frame: () => Buffer.alloc(FRAME.width * FRAME.height * 4),
    release: () => {},
  };
  const view = {
    cdp: async () => {},
    webContents: { debugger: { on: () => {}, removeListener: () => {} } },
    recording: {
      pinFrameRate: () => {},
      onFrame: () => () => {},
      start: (framesDir) => {
        dir = path.dirname(framesDir);
        return capture;
      },
      invalidate: () => {},
      frameSize: () => ({ width: FRAME.width, height: FRAME.height }),
    },
  };
  const host = {
    root: { createSurface: () => ({ present: () => {}, close: () => {} }) },
    layout: () => null,
    canvasRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    page: () => ({ url: "https://example.test/", title: "example" }),
    fontFile: () => "",
    requestRender: () => {},
    blurToOverlay: () => {},
    refocusPage: () => {},
    reviewStarted: () => {},
    setKeyCapture: () => {},
    setClipboard: (text) => calls.clipboard.push(text),
    toast: (name, state) => calls.toasts.push(`${state}:${name}`),
    finished: () => {
      calls.finished += 1;
    },
    isRecordKey: () => false,
    recordKeyLabel: () => "ctrl+r",
  };
  return {
    calls,
    cleanup: () => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
    create: (options) => RecordSession.create(host, { tabId: 1, handle: () => view }, options),
  };
}

const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the auto-stop timeout fires on its own when nothing stops the recording", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create({ agent: true, timeoutMs: 40 });
  try {
    assert.equal(session.active, true);
    assert.equal(calls.finished, 0);
    await after(200);
    // no frames were captured, so the timeout's complete() falls through to discard
    assert.deepEqual(calls.toasts, ["failed:Nothing captured"]);
    assert.equal(calls.finished, 1);
    assert.equal(session.active, false);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("dispose clears the auto-stop timer, so it never fires afterwards", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create({ agent: true, timeoutMs: 40 });
  try {
    session.dispose();
    assert.equal(session.active, false);
    await after(200);
    // same wait as the test above, which saw the timeout land; dispose() cancelled this one
    assert.deepEqual(calls.toasts, []);
    assert.equal(calls.finished, 0);
  } finally {
    cleanup();
  }
});

test("a manual stop into review leaves the timer armed and the timeout completes the review", async () => {
  const { calls, cleanup, create } = harness({ frames: [FRAME] });
  const session = await create({ agent: true, timeoutMs: 40 });
  try {
    // keybinding "record.toggle" on a live recording -> actions.stop() -> stopReview()
    session.actions.stop();
    assert.equal(session.reviewing, true);
    assert.equal(session.active, true);
    assert.equal(calls.finished, 0);
    await after(200);
    // the timeout still owns a live session, so it completes out from under the reviewer
    assert.equal(session.active, false);
    assert.equal(calls.finished, 1);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("timeoutMs is opt-in: a manual recording arms no timer", async () => {
  const { calls, cleanup, create } = harness({ frames: [FRAME] });
  const session = await create({});
  try {
    assert.equal(session.agent, false);
    await after(200);
    assert.equal(calls.finished, 0);
    assert.equal(session.active, true);
  } finally {
    session.dispose();
    cleanup();
  }
});
