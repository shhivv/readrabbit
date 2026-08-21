import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { runCrawl } from "./crawler/engine";

export const BACKGROUND_CRAWL_TASK = "nc-background-crawl";

// Defined at global scope so it fires even when no React tree is mounted.
TaskManager.defineTask(BACKGROUND_CRAWL_TASK, async () => {
  try {
    await runCrawl({ mode: "background" });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundCrawl(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Available) {
      // OS treats this as a minimum; iOS typically runs it overnight windows
      await BackgroundTask.registerTaskAsync(BACKGROUND_CRAWL_TASK, {
        minimumInterval: 6 * 60, // 6 hours
      });
    }
  } catch {
    // simulator / Expo Go limitations — foreground refresh carries the load
  }
}
