// `env` from "cloudflare:workers" is typed as Cloudflare.Env (generated
// worker-configuration.d.ts and @cloudflare/vitest-plugin/types). The
// test-only migrations binding is added by declaration merging, which needs an
// interface. The test-apis page suggests a ProvidedEnv interface instead, but
// nothing in the installed 1.8.0 types reads ProvidedEnv.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
