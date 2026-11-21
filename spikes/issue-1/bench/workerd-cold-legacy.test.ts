// See bench/harness.ts: local workerd, whole-millisecond WALL time.
// Runs in its own Vitest process so the legacy initialize is the isolate's
// first request, which bench/workerd-wall.test.ts cannot measure.
import { it } from "vitest";
import { legacyInitialize, legacyToolsCall } from "../scripts/requests.ts";
import { serve } from "./harness.ts";

it("times a cold legacy initialize in local workerd (wall time)", async () => {
  const init = await serve(legacyInitialize(-1), false);
  const call = await serve(legacyToolsCall(-1, init.sessionId), false);
  console.log(
    JSON.stringify({
      label: "LOCAL workerd WALL ms, cold legacy (whole-ms clock; indicative only)",
      coldLegacyInitializeWallMs: init.wallMs,
      thenLegacyToolsCallWallMs: call.wallMs,
    }),
  );
});
