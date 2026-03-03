const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

export function collectDependencyEntries(packageJson) {
  const entries = [];

  for (const field of DEPENDENCY_FIELDS) {
    const block = packageJson[field];
    if (!block || typeof block !== "object") {
      continue;
    }

    for (const [depName, spec] of Object.entries(block)) {
      if (typeof spec !== "string") {
        continue;
      }

      entries.push({
        section: field,
        depName,
        spec
      });
    }
  }

  return entries;
}

export function resolveDependencySpec(entry, context) {
  if (entry.spec.startsWith("workspace:")) {
    return resolveWorkspaceSpec(entry.spec, entry.depName, context.workspacePackagesByName);
  }

  if (entry.spec.startsWith("catalog:")) {
    return resolveCatalogSpec(entry.spec, entry.depName, context.catalogs);
  }

  return {
    status: "ignored",
    reason: "unsupported_spec"
  };
}

export function resolveWorkspaceSpec(spec, depName, workspacePackagesByName) {
  const pkg = workspacePackagesByName.get(depName);
  if (!pkg) {
    return {
      status: "unresolved",
      reason: "workspace_pkg_not_found"
    };
  }

  const suffix = spec.slice("workspace:".length);

  if (suffix === "*") {
    return {
      status: "resolved",
      version: pkg.version
    };
  }

  if (suffix === "^") {
    return {
      status: "resolved",
      version: `^${pkg.version}`
    };
  }

  if (suffix === "~") {
    return {
      status: "resolved",
      version: `~${pkg.version}`
    };
  }

  if (suffix && looksLikeVersionSpec(suffix)) {
    return {
      status: "resolved",
      version: suffix
    };
  }

  return {
    status: "unresolved",
    reason: "unsupported_spec"
  };
}

export function resolveCatalogSpec(spec, depName, catalogs) {
  const catalogName = spec.slice("catalog:".length).trim();

  if (catalogName.length === 0) {
    const match = catalogs.defaultCatalog.get(depName);

    if (!match) {
      return {
        status: "unresolved",
        reason: "catalog_not_found"
      };
    }

    return {
      status: "resolved",
      version: match
    };
  }

  const catalog = catalogs.namedCatalogs.get(catalogName);

  if (!catalog) {
    return {
      status: "unresolved",
      reason: "catalog_not_found"
    };
  }

  const match = catalog.get(depName);

  if (!match) {
    return {
      status: "unresolved",
      reason: "catalog_not_found"
    };
  }

  return {
    status: "resolved",
    version: match
  };
}

function looksLikeVersionSpec(value) {
  return /^(\^|~|>=|<=|>|<|=)?v?[0-9xX*]/.test(value);
}

export function buildUnresolvedMessage(reason) {
  switch (reason) {
    case "catalog_not_found":
      return "catalog not found";
    case "workspace_pkg_not_found":
      return "workspace package not found";
    case "parse_error":
      return "parse error";
    case "api_error":
      return "api error";
    case "rate_limited":
      return "rate limited";
    default:
      return "unsupported spec";
  }
}
