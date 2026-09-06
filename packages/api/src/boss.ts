import PgBoss from 'pg-boss';

let bossSingleton: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
    // Identify queues
    await bossSingleton.createQueue('identify.album');
    await bossSingleton.createQueue('identify.sweep');
    // Artist queues
    await bossSingleton.createQueue('artists.enrich');
    // Collection queues
    await bossSingleton.createQueue('collection.sync');
    await bossSingleton.createQueue('collection.push');
    await bossSingleton.createQueue('collection.remove');
    // Library/scan queues
    await bossSingleton.createQueue('roots.validate');
    await bossSingleton.createQueue('scan.root');
    await bossSingleton.createQueue('enrich.sweep');
  }
  return bossSingleton;
}
