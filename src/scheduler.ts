import schedule from "node-schedule";
import { fetchLiveStreams } from "./modules/holodex";
import { HolodexLiveStreamInfo } from "./modules/holodex/types";
import { getQueueInstance } from "./modules/queue";
import { guessFreeChat, timeoutThen } from "./util";
import { ErrorCode, Result, Stats } from "./worker";
import assert from "assert";

const SHUTDOWN_TIMEOUT = 30 * 1000;
const IGNORE_FREE_CHAT = process.env.IGNORE_FREE_CHAT ?? false;
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 1);
const HOLODEX_API_KEY = process.env.HOLODEX_API_KEY;

function schedulerLog(...obj: any) {
  console.log(...obj);
}

export async function runScheduler() {
  const queue = getQueueInstance({ isWorker: false });
  const handledVideoIdCache: Set<string> = new Set();

  process.on("SIGTERM", async () => {
    schedulerLog("quitting scheduler (SIGTERM) ...");

    try {
      await queue.close(SHUTDOWN_TIMEOUT);
    } catch (err) {
      schedulerLog("bee-queue failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  async function handleStream(stream: HolodexLiveStreamInfo) {
    const videoId = stream.id;
    const title = stream.title;
    const scheduledStartTime = stream.start_scheduled;

    if (handledVideoIdCache.has(videoId)) return;

    // filter out freechat
    if (IGNORE_FREE_CHAT && guessFreeChat(title)) return;

    const startUntil = scheduledStartTime
      ? new Date(scheduledStartTime).getTime() - Date.now()
      : 0;
    const startsInMin = Math.floor(startUntil / 1000 / 60);
    // if (startsInMin < -10080 && !guessFreeChat(title)) {
    //   schedulerLog(
    //     `${videoId} (${title}) will be ignored. it was started in ${startsInMin} min and not a free chat, which must be abandoned.`
    //   );
    //   return;
    // }

    // if failed to receive chat:
    // prechat -> retry after max(1m, 1/3 of startUntil) for 3 times
    // livechat -> retry after 5m for 3 times
    // but not longer than 30 minutes
    const estimatedDelay = Math.min(
      Math.max(Math.floor(startUntil / 3), 5 * 60 * 1000),
      30 * 60 * 1000
    );
    await queue
      .createJob({ videoId, stream })
      .setId(videoId)
      .retries(3)
      .backoff("fixed", estimatedDelay)
      .save();

    schedulerLog(
      `scheduled ${videoId} (${title}) starting in ${startsInMin} minutes`
    );

    handledVideoIdCache.add(videoId);

    await timeoutThen(3 * 1000);
  }

  async function checkStalledJobs() {
    const res = await queue.checkStalledJobs();
    if (res > 0) {
      console.log("enqueue stalled jobs:", res);
    }
  }

  async function rearrange(invokedAt: Date) {
    assert(HOLODEX_API_KEY);

    schedulerLog("@@@@@@@@ updating index", invokedAt);

    const alreadyActiveJobs = (
      await queue.getJobs("active", { start: 0, end: 300 })
    ).map((job) => job.data.videoId);

    const liveAndUpcomingStreams = await fetchLiveStreams(HOLODEX_API_KEY);

    const unscheduledStreams = liveAndUpcomingStreams.filter(
      (stream) => !alreadyActiveJobs.includes(stream.id)
    );

    schedulerLog(`currently ${alreadyActiveJobs.length} job(s) are running`);

    if (unscheduledStreams.length === 0) {
      schedulerLog("no new streams");
      return;
    }

    schedulerLog(
      `will schedule ${unscheduledStreams.length} stream(s) out of ${liveAndUpcomingStreams.length} streams`
    );

    for (const stream of unscheduledStreams) {
      await handleStream(stream);
    }

    // show metrics
    const health = await queue.checkHealth();
    const activeJobs = await queue.getJobs("active", { start: 0, end: 300 });
    let nbWarmingUp = 0;
    let nbTotal = 0;
    for (const job of activeJobs) {
      nbTotal += 1;
      const progress: Stats = job.progress;
      if (progress.isWarmingUp) nbWarmingUp += 1;
    }
    console.log(
      `<| Queue Metrics |>
Total=${nbTotal}
Active=${nbTotal - nbWarmingUp}
WarmingUp=${nbWarmingUp}
Waiting=${health.waiting}
Delayed=${health.delayed}`
    );

    // TODO: auto scale worker nodes
    const totalJobs = health.active + health.delayed + health.waiting;
    const totalWorkers = Math.ceil(totalJobs / JOB_CONCURRENCY);
    // terraform apply -var total_workers=${totalWorkers}
    console.log(`SUGGESTED WORKER COUNT: ${totalWorkers}`);
  }

  queue.on("stalled", (jobId) => {
    schedulerLog("[stalled]:", jobId);
  });

  // redis related error
  queue.on("error", (err) => {
    schedulerLog(`${err.message}`);
    process.exit(1);
  });

  queue.on("job succeeded", async (jobId, result: Result) => {
    const job = await queue.getJob(jobId);

    schedulerLog("[job succeeded]:", jobId, result);

    switch (result.error) {
      case ErrorCode.MembershipOnly: {
        // do not remove id from cache so that the scheduler can ignore the stream.
        await job.remove();
        schedulerLog("[job succeeded]:", `removed ${jobId} from job queue`);
        break;
      }
      case ErrorCode.Ban: {
        // handle ban
        handledVideoIdCache.delete(job.data.videoId);
        await job.remove();
        schedulerLog(
          "[job cancelled]:",
          `removed ${jobId} from handled id cache due to yt ban`
        );
        break;
      }
      case ErrorCode.UnknownError: {
        // live stream is still ongoing but somehow got response with empty continuation hence mistaken as being finished -> will be added in next invocation. If the stream was actually ended that's ok bc the stream index won't have that stream anymore, or else it will be added to worker again.
        // live stream was over and the result is finalized -> the index won't have that videoId anymore so it's safe to remove them from the cache
        handledVideoIdCache.delete(job.data.videoId);
        await job.remove();
        schedulerLog(
          "[job succeeded]:",
          `removed ${jobId} from handled id cache`
        );
      }
    }
  });

  queue.on("job retrying", async (jobId, err) => {
    const job = await queue.getJob(jobId);
    const retries = job.options.retries;
    const retryDelay = job.options.backoff.delay;

    schedulerLog(
      "[job retrying]:",
      `will retry ${jobId} in ${Math.ceil(
        retryDelay / 1000 / 60
      )} minutes (${retries}). cause: ${err.message}`
    );
  });

  queue.on("job failed", async (jobId, err) => {
    schedulerLog("[job failed]:", jobId, err.message);

    const job = await queue.getJob(jobId);

    // chances that chat is disabled until live goes online
    handledVideoIdCache.delete(job.data.videoId);
    await queue.removeJob(jobId);

    schedulerLog(
      "[job failed]:",
      `removed ${job.data.videoId} from cache and job queue for later retry`
    );
  });

  queue.on("ready", async () => {
    console.log(`starting scheduler (concurrency: ${JOB_CONCURRENCY})`);

    handledVideoIdCache.clear();

    schedule.scheduleJob("*/10 * * * *", rearrange);
    schedule.scheduleJob("*/1 * * * *", checkStalledJobs);

    console.log("scheduler has been started:");

    await rearrange(new Date());
  });
}
