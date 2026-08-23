// In-process generation counter for the persisted reading-history snapshot.
// The database remains the source of truth across launches; this only avoids
// rereading the same twelve rows on repeated deque loads within one process.
let generation = 0;

export function noteExposureChanged(): void {
  generation++;
}

export function exposureGeneration(): number {
  return generation;
}
