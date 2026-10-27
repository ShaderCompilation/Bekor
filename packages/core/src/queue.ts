import { PgBoss } from "pg-boss";
export const JUDGE_QUEUE = "judge-submission";
export async function createQueue(connectionString: string) {
  const boss = new PgBoss({ connectionString });
  boss.on("error", () => {
    process.stderr.write("Queue infrastructure error\n");
  });
  await boss.start();
  await boss.createQueue(JUDGE_QUEUE, {
    retryLimit: 2,
    retryDelay: 2,
    retryBackoff: true,
    expireInSeconds: 150,
    retentionSeconds: 86400,
    deleteAfterSeconds: 86400,
  });
  return boss;
}
