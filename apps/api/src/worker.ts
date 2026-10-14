// Legacy `node dist/worker.js` start command; new services run `dist/main.js` with IS_WORKER=true.
process.env.IS_WORKER = "true";
await import("./main.js");
