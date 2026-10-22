import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const configPath = path.resolve(process.cwd(), "wrangler.jsonc");
const source = fs.readFileSync(configPath, "utf8");
const require = createRequire(path.resolve(process.cwd(), "package.json"));
const ts = require("typescript");
const parsed = ts.parseConfigFileTextToJson(configPath, source);

function fail(message) {
	throw new Error(`Mailflare deploy preparation: ${message}`);
}

const config = parsed.config;
if (parsed.error || !config || typeof config !== "object" || Array.isArray(config)) {
	fail("wrangler.jsonc is invalid JSONC.");
}

const databaseId = process.env.MAILFLARE_D1_DATABASE_ID ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
	fail("MAILFLARE_D1_DATABASE_ID must be a valid UUID.");
}
if (config.name !== "mailflare") fail("unexpected Worker name.");

const allowedResourceSections = new Set([
	"assets", "durable_objects", "d1_databases", "images", "queues", "r2_buckets", "send_email", "services",
	"ratelimits", "ai", "triggers", "workers_dev", "preview_urls", "keep_vars", "name", "main", "$schema",
	"compatibility_date", "compatibility_flags", "migrations", "observability", "upload_source_maps",
]);
for (const key of Object.keys(config)) {
	if (!allowedResourceSections.has(key)) fail(`unexpected Worker configuration section ${key}.`);
}

function exactBindings(items, expected, label, field = "binding") {
	if (!Array.isArray(items) || items.length !== expected.length) fail(`unexpected ${label} resources.`);
	const actual = items.map((item) => item?.[field]);
	if (expected.some((name) => !actual.includes(name)) || actual.some((name) => !expected.includes(name))) {
		fail(`unexpected ${label} bindings.`);
	}
}

exactBindings(config.d1_databases, ["DB"], "D1");
if (config.d1_databases[0].database_name !== "mailflare") fail("unexpected D1 database name.");
exactBindings(config.r2_buckets, ["BUCKET"], "R2");
if (config.r2_buckets[0].bucket_name !== "mailflare-raw") fail("unexpected R2 bucket name.");
exactBindings(config.queues?.producers, ["INBOUND_QUEUE", "OUTBOUND_QUEUE", "AGENT_QUEUE"], "queue producer");
const producerQueues = new Map(config.queues.producers.map(({ binding, queue }) => [binding, queue]));
for (const [binding, queue] of Object.entries({ INBOUND_QUEUE: "mailflare-inbound", OUTBOUND_QUEUE: "mailflare-outbound", AGENT_QUEUE: "mailflare-agent" })) {
	if (producerQueues.get(binding) !== queue) fail(`unexpected queue resource for ${binding}.`);
}
exactBindings(config.queues?.consumers, ["mailflare-inbound", "mailflare-outbound", "mailflare-agent"], "queue consumer", "queue");
exactBindings(config.services, ["WORKER_SELF_REFERENCE"], "service");
if (config.services[0].service !== "mailflare") fail("unexpected service resource name.");
exactBindings(config.durable_objects?.bindings, ["REALTIME"], "Durable Object", "name");
if (config.durable_objects.bindings[0].class_name !== "RealtimeHub") fail("unexpected Durable Object class.");
const migration = config.migrations?.[0];
if (!Array.isArray(config.migrations) || config.migrations.length !== 1 || !migration ||
	Object.keys(migration).length !== 2 || migration.tag !== "v1" ||
	!Array.isArray(migration.new_sqlite_classes) || migration.new_sqlite_classes.length !== 1 ||
	migration.new_sqlite_classes[0] !== "RealtimeHub") fail("unexpected Durable Object migration.");

const expectedRateLimits = {
	LOGIN_RATE_LIMIT: ["1001", 20, 60],
	DEVICE_LOGIN_RATE_LIMIT: ["1003", 10, 60],
	AGENT_RATE_LIMIT: ["1002", 120, 60],
};
exactBindings(config.ratelimits, Object.keys(expectedRateLimits), "rate limit", "name");
for (const limit of config.ratelimits) {
	const [namespace, count, period] = expectedRateLimits[limit.name];
	if (Object.keys(limit).length !== 3 || limit.namespace_id !== namespace ||
		!limit.simple || Object.keys(limit.simple).length !== 2 ||
		limit.simple.limit !== count || limit.simple.period !== period) fail("unexpected rate limit configuration.");
}

exactBindings(config.send_email, ["EMAIL"], "email", "name");
exactBindings(config.assets ? [config.assets] : [], ["ASSETS"], "assets", "binding");
exactBindings(config.images ? [config.images] : [], ["IMAGES"], "images", "binding");

function rejectRoutes(value, key = "") {
	if (["routes", "route", "custom_domain", "custom_domains"].includes(key)) fail(`unexpected ${key} configuration.`);
	if (Array.isArray(value)) value.forEach((item) => rejectRoutes(item));
	else if (value && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value)) rejectRoutes(child, childKey);
	}
}
rejectRoutes(config);

const expectedCrons = ["0 2 * * *", "*/5 * * * *"];
if (JSON.stringify(config.triggers?.crons) !== JSON.stringify(expectedCrons)) fail("unexpected cron configuration.");

config.d1_databases[0].database_id = databaseId;
config.workers_dev = true;
config.preview_urls = false;
config.keep_vars = true;
delete config.ai;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
