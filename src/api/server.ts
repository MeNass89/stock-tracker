import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import { config } from "../config.js";
import { getDb } from "../db/queries.js";
import { alertsRoutes } from "./routes/alerts.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { rankingsRoutes } from "./routes/rankings.js";
import { senatorsRoutes } from "./routes/senators.js";
import { tradesRoutes } from "./routes/trades.js";
import { FUND_MANAGERS } from "../tracking/fund-manager-tracker.js";

const sseClients = new Set<ServerResponse>();

export function broadcastSSE(event: string, data: unknown) {
  let serialized = "null";
  try {
    serialized = JSON.stringify(data);
  } catch {
    // Keep the broadcast path alive on non-serializable payloads.
  }
  const payload = `event: ${event}\ndata: ${serialized}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function buildServer() {
  const server = Fastify({ logger: true, ignoreTrailingSlash: true });
  const db = getDb();

  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.headers.authorization !== `Bearer ${config.API_AUTH_TOKEN}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  server.get("/health", async () => ({ ok: true, uptime: process.uptime() }));
  server.register(dashboardRoutes(db), { prefix: "/api/dashboard" });
  server.register(rankingsRoutes(db), { prefix: "/api/rankings" });
  server.register(tradesRoutes(db), { prefix: "/api/trades" });
  server.register(portfolioRoutes(db), { prefix: "/api/portfolio" });
  server.register(senatorsRoutes(db), { prefix: "/api/senators" });
  server.register(alertsRoutes(db), { prefix: "/api/alerts" });
  server.get("/api/funds", async () => FUND_MANAGERS);

  server.get("/api/events", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "http://localhost:5173"
    });
    const timer = setInterval(() => {
      try {
        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      } catch {
        clearInterval(timer);
        sseClients.delete(reply.raw);
      }
    }, 15_000);
    sseClients.add(reply.raw);
    reply.raw.on("close", () => {
      clearInterval(timer);
      sseClients.delete(reply.raw);
    });
  });

  return server;
}

export async function startApi() {
  const server = buildServer();
  await server.listen({ port: config.API_PORT, host: config.API_HOST });
  return server;
}
