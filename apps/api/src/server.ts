import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { type AwxEvent, EventInbox, verifyWebhook } from "@bulkhead/airwallex";
import { verifyChain } from "@bulkhead/core";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Runtime } from "./runtime.js";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

export function buildServer(rt: Runtime, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const inbox = new EventInbox();

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    return payload;
  });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const requireOperator = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = rt.config.operatorToken;
    if (!token) return;
    const given = String(req.headers["x-bulkhead-operator"] ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: "operator token required" });
    }
  };

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await rt.ready();
      return { ok: true, mode: rt.config.airwallexMode, advisor: rt.advisor.kind };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/api/state", async () => {
    await rt.ready();
    return rt.engine.snapshot();
  });

  app.get("/api/events", async (req, reply) => {
    await rt.ready();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (s: unknown) => reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    send(rt.engine.snapshot());
    const unsub = rt.subscribe(send);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsub();
    });
    return reply;
  });

  app.post<{ Body: { scriptedDeposit?: boolean; injectBankReturn?: string | null } }>(
    "/api/runs",
    { preHandler: requireOperator },
    async (req, reply) => {
      await rt.ready();
      try {
        const id = await rt.engine.startRun({
          scriptedDeposit: req.body?.scriptedDeposit ?? true,
          injectBankReturn:
            typeof req.body?.injectBankReturn === "string"
              ? req.body.injectBankReturn.replace(/[^a-z]/g, "")
              : null,
        });
        return reply.code(202).send({ id });
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: "approve" | "reject"; note?: string; by?: string } }>(
    "/api/approvals/:id/decision",
    { preHandler: requireOperator },
    async (req, reply) => {
      const { decision, note, by } = req.body ?? ({} as never);
      if (decision !== "approve" && decision !== "reject")
        return reply.code(400).send({ error: "decision must be approve or reject" });
      try {
        await rt.engine.decide(req.params.id, decision, (by ?? "operator").slice(0, 40), note?.slice(0, 500));
        return { ok: true };
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { key: string }; Body: { amount: string; payer?: string } }>(
    "/api/employers/:key/deposit",
    { preHandler: requireOperator },
    async (req, reply) => {
      const tenant = rt.engine.tenantByKey(req.params.key.toUpperCase());
      if (!tenant) return reply.code(404).send({ error: "unknown employer" });
      const amount = String(req.body?.amount ?? "");
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount))
        return reply.code(400).send({ error: "amount must be a positive decimal" });
      try {
        await rt.engine.deposit(tenant, amount, (req.body?.payer ?? "Employer top-up").slice(0, 60));
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );

  app.post("/api/reset", { preHandler: requireOperator }, async (_req, reply) => {
    try {
      await rt.reset();
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/api/proofs", async () => rt.engine.proofs());

  app.get("/api/audit", async () => {
    const records = rt.engine.audit.all();
    return { verification: verifyChain(records), records };
  });

  app.post<{ Body: { text: string; employer?: string } }>(
    "/api/intake/parse",
    { preHandler: requireOperator },
    async (req, reply) => {
      const text = String(req.body?.text ?? "").slice(0, 8000);
      if (!text.trim()) return reply.code(400).send({ error: "text is required" });
      const snap = rt.engine.snapshot();
      const emp =
        snap.employers.find((e) => e.key === (req.body?.employer ?? "B").toUpperCase()) ?? snap.employers[0];
      const roster = (emp?.contractors ?? []).map((c) => ({
        name: c.name,
        payoutCurrency: c.currency as never,
      }));
      return rt.advisor.parseSubmission(text, roster);
    },
  );

  app.post("/webhooks/airwallex", async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    if (!rt.config.webhookSecret) return reply.code(503).send({ error: "webhook secret not configured" });
    const v = verifyWebhook({
      secret: rt.config.webhookSecret,
      timestamp: req.headers["x-timestamp"] as string | undefined,
      signature: req.headers["x-signature"] as string | undefined,
      rawBody: raw,
    });
    if (!v.ok) return reply.code(401).send({ error: v.reason });
    const event = req.body as AwxEvent;
    if (inbox.accept(event)) rt.engine.ingestEvent(event);
    return reply.code(200).send({ received: true });
  });

  if (existsSync(rt.config.webDist)) {
    app.register(fastifyStatic, { root: rt.config.webDist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/webhooks")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
