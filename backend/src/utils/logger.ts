import pino from "pino";
import { env, isTest } from "../config/env";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "*.password",
      "*.passwordHash",
      "token",
      "*.token",
    ],
    remove: true,
  },
});

export type Logger = typeof logger;
