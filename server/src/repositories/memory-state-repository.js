// DEVELOPMENT ONLY — temporary persistence for Stage 9.
//
// Holds one application-state document in server memory so the frontend's ApiAdapter can be proven end to end.
// Restarting the server clears it. It never writes to disk or a database and is not production persistence.
// It is replaced by the MongoDB data layer (workspaces, boards, records collections) in a later stage.
//
// The methods are async on purpose: they match the shape a database-backed repository will have.
class MemoryStateRepository {
  constructor() {
    this.state = null;
    this.revision = 0;
    this.updatedAt = null;
    this.writes = Promise.resolve(); // writes apply one at a time, in arrival order
  }

  async loadState() {
    return { state: this.state === null ? null : structuredClone(this.state), revision: this.revision, updatedAt: this.updatedAt };
  }

  // Replaces the whole document. Last write wins: real per-record version checks (409 CONFLICT) come with MongoDB.
  saveState(state) {
    const write = this.writes.then(() => {
      this.state = structuredClone(state);
      this.revision += 1;
      this.updatedAt = new Date().toISOString();
      return { revision: this.revision, updatedAt: this.updatedAt };
    });
    this.writes = write.catch(() => {});
    return write;
  }
}

module.exports = { MemoryStateRepository };
