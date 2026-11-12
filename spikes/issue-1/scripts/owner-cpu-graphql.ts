// OWNER-RUN STEP 4a. Reads deployed CPU time per invocation from the Workers
// metrics in the GraphQL Analytics API, which needs no request logging.
//
// Verified against the docs (read 2026-11-12):
//   - Endpoint, headers, the workersInvocationsAdaptive node, its filter keys
//     (scriptName, datetime_geq, datetime_leq), and the quantile fields
//     cpuTimeP50 and cpuTimeP99: "Querying Workers Metrics with GraphQL",
//     https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
//   - Token: Account > Account Analytics > Read,
//     https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
//   - The schema is dynamic and introspectable,
//     https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/
// NOT verified: whether a cpuTimeP95 field exists, and the unit of the values.
// So the script first introspects the schema, prints every cpuTime* quantile
// field with its description (which states the unit), and asks for
// cpuTimeP95 only if the schema has it.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_TAG=... CLOUDFLARE_ANALYTICS_TOKEN=... \
//     node scripts/owner-cpu-graphql.ts canimcp-probe-spike-1 .tmp/bench-http.ndjson
import { readFileSync } from "node:fs";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const accountTag = process.env["CLOUDFLARE_ACCOUNT_TAG"];
const token = process.env["CLOUDFLARE_ANALYTICS_TOKEN"];
const [scriptName, benchFile] = process.argv.slice(2);
if (!accountTag || !token || !scriptName || !benchFile) {
  console.error(
    "Usage: CLOUDFLARE_ACCOUNT_TAG=... CLOUDFLARE_ANALYTICS_TOKEN=... node scripts/owner-cpu-graphql.ts <script-name> <bench-http.ndjson>",
  );
  process.exit(64);
}

async function graphql(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as { data?: unknown; errors?: unknown };
  if (payload.errors) throw new Error(`GraphQL errors: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

// 1. Introspect: find the type(s) that carry cpuTimeP50, and list their cpuTime fields.
const schema = (await graphql("{ __schema { types { name fields { name description } } } }")) as {
  __schema: {
    types: { name: string; fields: { name: string; description: string | null }[] | null }[];
  };
};
const quantileTypes = schema.__schema.types.filter((type) =>
  type.fields?.some((field) => field.name === "cpuTimeP50"),
);
const cpuFields = new Map<string, string | null>();
for (const type of quantileTypes) {
  for (const field of type.fields ?? [])
    if (field.name.startsWith("cpuTime")) cpuFields.set(field.name, field.description);
}
console.log(
  JSON.stringify(
    {
      introspection: {
        types: quantileTypes.map((type) => type.name),
        cpuTimeFields: Object.fromEntries(cpuFields),
      },
    },
    null,
    2,
  ),
);
const wanted = ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99"].filter((name) => cpuFields.has(name));
if (!cpuFields.has("cpuTimeP95")) {
  console.log(
    "cpuTimeP95 is not in the schema. Use owner-run step 4b (the with-invocation-logs environment) for p95.",
  );
}

// 2. One query per window that bench-http.ts recorded. The query shape is the tutorial's.
const query = `query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 100, filter: {
        scriptName: $scriptName,
        datetime_geq: $datetimeStart,
        datetime_leq: $datetimeEnd
      }) {
        sum { requests errors }
        quantiles { ${wanted.join(" ")} }
        dimensions { scriptName status }
      }
    }
  }
}`;

const windows = readFileSync(benchFile, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map(
    (line) =>
      JSON.parse(line) as { window?: string; path?: string; startUtc?: string; endUtc?: string },
  )
  .filter((line) => line.window !== undefined);

for (const window of windows) {
  const data = await graphql(query, {
    accountTag,
    scriptName,
    datetimeStart: window.startUtc,
    datetimeEnd: window.endUtc,
  });
  console.log(
    JSON.stringify({
      window: window.window,
      path: window.path,
      startUtc: window.startUtc,
      endUtc: window.endUtc,
      data,
    }),
  );
}
