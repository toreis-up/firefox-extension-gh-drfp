import test from "node:test";
import assert from "node:assert/strict";

import {
  collectDependencyEntries,
  resolveWorkspaceSpec,
  resolveCatalogSpec,
  resolveDependencySpec,
  buildUnresolvedMessage
} from "../src/core/resolver.js";

test("collectDependencyEntries collects supported dependency sections", () => {
  const packageJson = {
    dependencies: {
      a: "1.0.0"
    },
    devDependencies: {
      b: "2.0.0"
    },
    scripts: {
      test: "node"
    }
  };

  const entries = collectDependencyEntries(packageJson);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { section: "dependencies", depName: "a", spec: "1.0.0" });
  assert.deepEqual(entries[1], { section: "devDependencies", depName: "b", spec: "2.0.0" });
});

test("resolveWorkspaceSpec resolves workspace shorthand", () => {
  const map = new Map([["pkg-a", { version: "1.2.3", path: "packages/a/package.json" }]]);

  assert.deepEqual(resolveWorkspaceSpec("workspace:*", "pkg-a", map), {
    status: "resolved",
    version: "1.2.3"
  });
  assert.deepEqual(resolveWorkspaceSpec("workspace:^", "pkg-a", map), {
    status: "resolved",
    version: "^1.2.3"
  });
  assert.deepEqual(resolveWorkspaceSpec("workspace:~", "pkg-a", map), {
    status: "resolved",
    version: "~1.2.3"
  });
  assert.deepEqual(resolveWorkspaceSpec("workspace:2.0.0", "pkg-a", map), {
    status: "resolved",
    version: "2.0.0"
  });
});

test("resolveWorkspaceSpec returns unresolved when package does not exist", () => {
  const map = new Map();
  assert.deepEqual(resolveWorkspaceSpec("workspace:*", "missing", map), {
    status: "unresolved",
    reason: "workspace_pkg_not_found"
  });
});

test("resolveCatalogSpec resolves named and default catalog", () => {
  const catalogs = {
    defaultCatalog: new Map([["react", "^18.3.1"]]),
    namedCatalogs: new Map([
      ["prod", new Map([["react", "^18.3.1"], ["zod", "^3.25.0"]])]
    ])
  };

  assert.deepEqual(resolveCatalogSpec("catalog:prod", "zod", catalogs), {
    status: "resolved",
    version: "^3.25.0"
  });

  assert.deepEqual(resolveCatalogSpec("catalog:", "react", catalogs), {
    status: "resolved",
    version: "^18.3.1"
  });
});

test("resolveDependencySpec routes by prefix", () => {
  const context = {
    workspacePackagesByName: new Map([["pkg-a", { version: "1.0.0", path: "packages/a/package.json" }]]),
    catalogs: {
      defaultCatalog: new Map(),
      namedCatalogs: new Map([["prod", new Map([["pkg-b", "^2.0.0"]])]])
    }
  };

  assert.deepEqual(resolveDependencySpec({ depName: "pkg-a", spec: "workspace:*" }, context), {
    status: "resolved",
    version: "1.0.0"
  });

  assert.deepEqual(resolveDependencySpec({ depName: "pkg-b", spec: "catalog:prod" }, context), {
    status: "resolved",
    version: "^2.0.0"
  });

  assert.deepEqual(resolveDependencySpec({ depName: "pkg-c", spec: "npm:pkg-c@1" }, context), {
    status: "ignored",
    reason: "unsupported_spec"
  });
});

test("buildUnresolvedMessage maps reasons", () => {
  assert.equal(buildUnresolvedMessage("catalog_not_found"), "catalog not found");
  assert.equal(buildUnresolvedMessage("workspace_pkg_not_found"), "workspace package not found");
  assert.equal(buildUnresolvedMessage("unsupported_spec"), "unsupported spec");
});
