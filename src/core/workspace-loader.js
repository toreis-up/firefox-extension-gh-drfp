import { parsePnpmWorkspaceYaml } from "./pnpm-workspace-parser.js";

export function createEmptyWorkspaceContext() {
  return {
    workspaceConfig: null,
    workspacePackagesByName: new Map(),
    catalogs: {
      defaultCatalog: new Map(),
      namedCatalogs: new Map()
    },
    warnings: []
  };
}

export async function loadWorkspaceContext(apiClient) {
  const context = createEmptyWorkspaceContext();

  let workspaceYaml = null;
  try {
    workspaceYaml = await apiClient.fetchTextFile("pnpm-workspace.yaml");
  } catch (error) {
    context.warnings.push(mapWarningCode(error, "pnpm_workspace_missing"));
    return context;
  }

  try {
    context.workspaceConfig = parsePnpmWorkspaceYaml(workspaceYaml);
  } catch {
    context.warnings.push("parse_error");
    return context;
  }

  context.catalogs = normalizeCatalogs(context.workspaceConfig);

  let tree = [];
  try {
    tree = await apiClient.fetchTree();
  } catch (error) {
    context.warnings.push(mapWarningCode(error, "tree_fetch_failed"));
    return context;
  }

  const packageJsonPaths = findWorkspacePackageJsonPaths(tree, context.workspaceConfig.packages);

  const packages = await mapWithConcurrency(packageJsonPaths, 8, async (path) => {
    const pkg = await apiClient.fetchJsonFile(path);
    if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string") {
      return null;
    }

    return {
      name: pkg.name,
      version: pkg.version,
      path
    };
  });

  for (const pkg of packages) {
    if (!pkg) {
      continue;
    }

    context.workspacePackagesByName.set(pkg.name, {
      version: pkg.version,
      path: pkg.path
    });
  }

  return context;
}

function normalizeCatalogs(config) {
  const defaultCatalog = new Map();
  for (const [depName, version] of Object.entries(config.catalog || {})) {
    if (typeof version === "string" && version.length > 0) {
      defaultCatalog.set(depName, version);
    }
  }

  const namedCatalogs = new Map();
  for (const [catalogName, depMap] of Object.entries(config.catalogs || {})) {
    const normalized = new Map();

    for (const [depName, version] of Object.entries(depMap || {})) {
      if (typeof version === "string" && version.length > 0) {
        normalized.set(depName, version);
      }
    }

    namedCatalogs.set(catalogName, normalized);
  }

  return {
    defaultCatalog,
    namedCatalogs
  };
}

function findWorkspacePackageJsonPaths(tree, packagePatterns) {
  const globs = (packagePatterns.length > 0 ? packagePatterns : ["**"]).map(normalizeGlobPattern);
  const regexes = globs.map(globToRegExp);

  const paths = [];

  for (const node of tree) {
    if (!node || node.type !== "blob" || typeof node.path !== "string") {
      continue;
    }

    if (node.path !== "package.json" && !node.path.endsWith("/package.json")) {
      continue;
    }

    const directory = node.path === "package.json" ? "" : node.path.slice(0, -"/package.json".length);
    if (regexes.some((regex) => regex.test(directory))) {
      paths.push(node.path);
    }
  }

  return paths;
}

function normalizeGlobPattern(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === ".") {
    return "";
  }

  return trimmed.replace(/^\.\//, "").replace(/\/$/, "");
}

function globToRegExp(glob) {
  if (glob === "") {
    return /^$/;
  }

  let expression = "^";

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];

    if (char === "*" && next === "*") {
      expression += ".*";
      i += 1;
      continue;
    }

    if (char === "*") {
      expression += "[^/]*";
      continue;
    }

    if (char === "?") {
      expression += "[^/]";
      continue;
    }

    if (".+^${}()|[]\\".includes(char)) {
      expression += `\\${char}`;
      continue;
    }

    expression += char;
  }

  expression += "$";
  return new RegExp(expression);
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;

      try {
        results[index] = await mapper(values[index], index);
      } catch {
        results[index] = null;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, values.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function mapWarningCode(error, fallback) {
  if (error && typeof error.code === "string") {
    return error.code;
  }

  return fallback;
}
