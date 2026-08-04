export interface LogRecord {
  level: "info" | "warn" | "error";
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  log(record: LogRecord): void;
}

export const jsonLogger: Logger = {
  log(record) {
    const output = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
    if (record.level === "error") console.error(output);
    else if (record.level === "warn") console.warn(output);
    else console.log(output);
  },
};

export const silentLogger: Logger = { log() {} };
