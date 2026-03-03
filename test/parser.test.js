import test from "node:test";
import assert from "node:assert/strict";

import { parsePnpmWorkspaceYaml } from "../src/core/pnpm-workspace-parser.js";

test("parsePnpmWorkspaceYaml extracts packages, catalog, and catalogs", () => {
  const yaml = `
packages:
  - "packages/*"
  - apps/**

catalog:
  react: ^18.3.1

catalogs:
  prod:
    react: ^18.3.1
    zod: ^3.25.0
  test:
    vitest: ^2.2.0
`;

  const parsed = parsePnpmWorkspaceYaml(yaml);

  assert.deepEqual(parsed.packages, ["packages/*", "apps/**"]);
  assert.deepEqual(parsed.catalog, { react: "^18.3.1" });
  assert.deepEqual(parsed.catalogs.prod, {
    react: "^18.3.1",
    zod: "^3.25.0"
  });
  assert.deepEqual(parsed.catalogs.test, {
    vitest: "^2.2.0"
  });
});

test("parsePnpmWorkspaceYaml ignores comments and preserves quoted values", () => {
  const yaml = `
packages:
  - "packages/*" # comment
catalog:
  "@scope/pkg": "^1.0.0" # inline
`;

  const parsed = parsePnpmWorkspaceYaml(yaml);

  assert.deepEqual(parsed.packages, ["packages/*"]);
  assert.equal(parsed.catalog["@scope/pkg"], "^1.0.0");
});
