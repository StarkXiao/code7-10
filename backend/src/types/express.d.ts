import type { AuthUser } from "./auth";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: AuthUser;
    }
  }
}

export {};
