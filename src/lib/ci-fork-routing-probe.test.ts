import { it } from "vitest";

it("CI_FORK_ROUTING_PROBE deliberate failure", () => {
  throw new Error("CI_FORK_ROUTING_PROBE intentional test failure; do not merge");
});
