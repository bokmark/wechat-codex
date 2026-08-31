const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = process.env.LOG_LEVEL || "info") {
  const threshold = levels[level] ?? levels.info;
  const write = (name, args) => {
    if (levels[name] < threshold) return;
    const line = `[${new Date().toISOString()}] ${name.toUpperCase()}`;
    const target = name === "error" ? console.error : name === "warn" ? console.warn : console.log;
    target(line, ...args);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}
