import type { INestApplication } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import type { RuntimeConfig } from "../../config/runtime-config.js";

export function configureHttpSecurity(app: INestApplication, config: RuntimeConfig) {
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    if (["production", "staging"].includes(config.app.nodeEnv)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  });
  app.enableCors({
    origin: config.http.corsOrigins,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept", "Accept-Language", "X-API-Contract", "X-Request-ID"],
    exposedHeaders: ["X-API-Contract", "X-Request-ID", "Retry-After"],
    maxAge: 600,
  });
}
