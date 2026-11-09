import base from "../../../../../tests/vitest.config.js";

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "apps/web-ui/packages/api/session-controller/test/**/*.test.ts",
      "apps/web-ui/packages/client/ui-workspace/test/archived-query.test.ts",
    ],
  },
};
