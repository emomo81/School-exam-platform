import type { Request, Response, NextFunction, RequestHandler } from "express";

/** Wrap an async route so rejected promises reach Express's error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Thrown by handlers to return a specific HTTP status with a JSON body. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}
export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}
export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}

/** Central Express error handler (registered last in index.ts). */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("unhandled_error", err);
  res.status(500).json({ error: "server_error", message: "Something went wrong." });
}
