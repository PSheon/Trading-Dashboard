// Legacy start command (`node dist/worker.js`) of services configured before
// the IS_WORKER switch: the same entry point, run as the worker. New services
// start `node dist/main.js` with IS_WORKER=true.
process.env.IS_WORKER = "true";
await import("./main.js");
