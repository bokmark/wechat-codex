import fs from "node:fs";
import path from "node:path";

function clone(value) {
  return structuredClone(value);
}

export class JsonStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, "state.json");
    this.credentialsPath = path.join(stateDir, "credentials.json");
    this.state = this.#loadState();
  }

  #defaultState() {
    return {
      version: 1,
      syncBuf: "",
      contextTokens: {},
      sessions: {},
      jobs: {},
      externalThreads: {},
      externalMonitor: {
        initialized: false,
        threads: {},
        notifiedTurnIds: [],
        pendingNotifications: [],
      },
      inbox: [],
      nextInboxId: 1,
      processedMessageIds: [],
      nextJobId: 1,
      nextExternalId: 1,
      nextApprovalId: 1,
    };
  }

  #loadState() {
    try {
      return { ...this.#defaultState(), ...JSON.parse(fs.readFileSync(this.statePath, "utf8")) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return this.#defaultState();
    }
  }

  read() {
    return clone(this.state);
  }

  update(mutator) {
    const draft = clone(this.state);
    const result = mutator(draft);
    this.state = draft;
    this.#writeAtomic(this.statePath, this.state, 0o600);
    return result;
  }

  loadCredentials() {
    try {
      return JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  saveCredentials(credentials) {
    this.#writeAtomic(this.credentialsPath, credentials, 0o600);
  }

  #writeAtomic(filePath, value, mode) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, filePath);
  }
}
