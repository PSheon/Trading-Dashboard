export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The page can edit notes and start jobs that spend Helius credits; never
  // serve it in production without a password unless told to on purpose.
  if (process.env.NODE_ENV === "production" && !process.env.APP_PASSWORD && process.env.ALLOW_NO_PASSWORD !== "1") {
    throw new Error("set APP_PASSWORD (or ALLOW_NO_PASSWORD=1 for a local build)");
  }
  const schedule = process.env.SCHEDULE_UTC;
  if (schedule) {
    const { server } = await import("./lib/server");
    server().runner.scheduleDaily(schedule);
    console.log(`daily job scheduled at ${schedule} UTC`);
  }
}
