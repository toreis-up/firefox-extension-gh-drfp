(() => {
  const API_BASE = "https://api.github.com";
  const STYLE_ID = "pnpm-resolver-style";
  const ANNOTATION_CLASS = "pnpm-resolver-annotation";
  const STATUS_CLASS = "pnpm-resolver-status";

  const state = {
    initialized: false,
    running: false,
    scheduled: false,
    lastSignature: ""
  };

  const CONTEXT_FAILURE_TTL_MS = 30_000;
  const API_ERROR_TTL_MS = 60_000;
  const RATE_LIMIT_TTL_MS = 120_000;
  const NOT_FOUND_TTL_MS = 300_000;
  const API_ERROR_CACHE_LIMIT = 500;

  const pageContextCache = new Map();
  const contextFailureCache = new Map();
  const workspaceContextCache = new Map();
  const apiResponseCache = new Map();
  const apiPendingCache = new Map();
  const apiErrorCache = new Map();

  console.info("[pnpm-resolver] content script loaded", window.location.href);
  start();

  function start() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;

    const scheduleRun = debounce(() => {
      void runResolverOverlay();
    }, 250);

    observePageChanges(scheduleRun);
    hookHistory(scheduleRun);
    scheduleRun();
  }

  async function runResolverOverlay() {
    if (state.running) {
      state.scheduled = true;
      return;
    }

    state.running = true;

    try {
      const context = await resolvePackageJsonContext();

      if (!context) {
        clearDependencyAnnotations();
        clearStatus();
        state.lastSignature = "";
        return;
      }

      const signature = `${context.owner}/${context.repo}@${context.ref}:${context.filePath}`;
      if (signature === state.lastSignature && document.querySelector(`.${ANNOTATION_CLASS}`)) {
        return;
      }

      const dependencyEntries = collectDependencyEntries(context.packageJson).filter((entry) => {
        return entry.spec.startsWith("workspace:") || entry.spec.startsWith("catalog:");
      });

      if (dependencyEntries.length === 0) {
        clearDependencyAnnotations();
        clearStatus();
        state.lastSignature = signature;
        return;
      }

      const requiredWorkspaceDepNames = new Set(
        dependencyEntries.filter((entry) => entry.spec.startsWith("workspace:")).map((entry) => entry.depName)
      );
      const workspaceContext = await loadWorkspaceContext(
        context.api,
        context.owner,
        context.repo,
        context.ref,
        requiredWorkspaceDepNames
      );

      const annotations = dependencyEntries.map((entry) => {
        const result = resolveDependencySpec(entry, workspaceContext);

        if (result.status === "resolved") {
          return {
            depName: entry.depName,
            spec: entry.spec,
            status: "resolved",
            version: result.version
          };
        }

        return {
          depName: entry.depName,
          spec: entry.spec,
          status: "unresolved",
          reasonMessage: buildUnresolvedMessage(result.reason)
        };
      });

      const summary = renderDependencyAnnotations(annotations);

      const warning = chooseWarning(workspaceContext.warnings);
      if (warning) {
        renderStatus(warning, "warning");
      } else if (summary.matched < summary.total) {
        renderStatus(`Only ${summary.matched}/${summary.total} dependencies could be annotated in this GitHub view.`, "warning");
      } else {
        clearStatus();
      }

      state.lastSignature = signature;
    } catch (error) {
      if (error && error.code === "rate_limited") {
        renderStatus("GitHub API rate limit reached. Please retry later.", "warning");
      } else if (error && error.code === "network_error") {
        renderStatus("Network/CORS error while calling GitHub API.", "warning");
      } else if (error instanceof TypeError) {
        renderStatus("Network/CORS error while calling GitHub API.", "warning");
      } else {
        renderStatus("Failed to resolve dependency specs on this page.", "error");
      }
      console.error("[pnpm-resolver] run failed", error);
    } finally {
      state.running = false;
      if (state.scheduled) {
        state.scheduled = false;
        void runResolverOverlay();
      }
    }
  }

  async function resolvePackageJsonContext() {
    const pathname = window.location.pathname;

    if (pageContextCache.has(pathname)) {
      return pageContextCache.get(pathname);
    }

    const cachedFailure = contextFailureCache.get(pathname);
    if (cachedFailure && cachedFailure.expiresAt > Date.now()) {
      return null;
    }
    if (cachedFailure) {
      contextFailureCache.delete(pathname);
    }

    const permalinkContext = await resolveFromPermalink();
    if (permalinkContext) {
      contextFailureCache.delete(pathname);
      pageContextCache.set(pathname, permalinkContext);
      return permalinkContext;
    }

    const parsed = parseGitHubBlobPath(pathname);
    if (!parsed) {
      return null;
    }

    const candidates = buildBlobCandidates(parsed.tailSegments);
    let lastError = null;
    for (const candidate of candidates) {
      const api = new GitHubApiClient(parsed.owner, parsed.repo, candidate.ref);

      try {
        const packageJson = await api.fetchJsonFile(candidate.filePath);
        const resolved = {
          owner: parsed.owner,
          repo: parsed.repo,
          ref: candidate.ref,
          filePath: candidate.filePath,
          packageJson,
          api
        };

        pageContextCache.set(pathname, resolved);
        return resolved;
      } catch (error) {
        lastError = error;
        // Continue trying other split points.
      }
    }

    cacheContextFailure(pathname, lastError);
    return null;
  }

  async function resolveFromPermalink() {
    const permalinkHref = findPermalinkHref();
    if (!permalinkHref) {
      return null;
    }

    let url;
    try {
      url = new URL(permalinkHref, window.location.origin);
    } catch {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/(.+)$/i);
    if (!match) {
      return null;
    }

    const owner = decodeURIComponent(match[1]);
    const repo = decodeURIComponent(match[2]);
    const ref = match[3];
    const filePath = decodeURIComponent(match[4]);

    if (!filePath.endsWith("package.json")) {
      return null;
    }

    const api = new GitHubApiClient(owner, repo, ref);

    try {
      const packageJson = await api.fetchJsonFile(filePath);
      return {
        owner,
        repo,
        ref,
        filePath,
        packageJson,
        api
      };
    } catch {
      return null;
    }
  }

  function findPermalinkHref() {
    const selectors = [
      "a#permalink",
      "a[data-hotkey='y']",
      "a[aria-label*='Permalink']",
      "a[data-testid='permalink-button']"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node && typeof node.getAttribute === "function") {
        const href = node.getAttribute("href");
        if (href && href.includes("/blob/")) {
          return href;
        }
      }
    }

    return null;
  }

  function parseGitHubBlobPath(pathname) {
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => safeDecodeURIComponent(segment));
    if (segments.length < 5) {
      return null;
    }

    if (segments[2] !== "blob") {
      return null;
    }

    const owner = segments[0];
    const repo = segments[1];
    const tailSegments = segments.slice(3);

    if (!tailSegments.join("/").endsWith("package.json")) {
      return null;
    }

    return {
      owner,
      repo,
      tailSegments
    };
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function buildBlobCandidates(tailSegments) {
    const candidates = [];

    for (let split = 1; split < tailSegments.length; split += 1) {
      const ref = tailSegments.slice(0, split).join("/");
      const filePath = tailSegments.slice(split).join("/");

      if (!filePath.endsWith("package.json")) {
        continue;
      }

      candidates.push({ ref, filePath });
    }

    return candidates;
  }

  async function loadWorkspaceContext(apiClient, owner, repo, ref, requiredWorkspaceDepNames) {
    const cacheKey = `${owner}/${repo}@${ref}`;
    let context = workspaceContextCache.get(cacheKey);

    if (!context) {
      context = {
        initialized: false,
        workspaceConfig: null,
        workspacePackagesByName: new Map(),
        unresolvedWorkspaceDepNames: new Set(),
        workspacePackageJsonPaths: null,
        workspacePathIndexLoaded: false,
        workspacePathIndexComplete: false,
        catalogs: {
          defaultCatalog: new Map(),
          namedCatalogs: new Map()
        },
        warnings: []
      };
      workspaceContextCache.set(cacheKey, context);
    }

    if (!context.initialized) {
      let workspaceYaml = "";

      try {
        workspaceYaml = await apiClient.fetchTextFile("pnpm-workspace.yaml");
      } catch (error) {
        addWarning(context, error && error.code ? error.code : "pnpm_workspace_missing");
        context.initialized = true;
        return context;
      }

      try {
        context.workspaceConfig = parsePnpmWorkspaceYaml(workspaceYaml);
      } catch {
        addWarning(context, "parse_error");
        context.initialized = true;
        return context;
      }

      context.catalogs = normalizeCatalogs(context.workspaceConfig);
      context.initialized = true;
    }

    if (!requiredWorkspaceDepNames || requiredWorkspaceDepNames.size === 0) {
      return context;
    }

    if (!context.workspaceConfig) {
      return context;
    }

    if (!context.workspacePathIndexLoaded) {
      await loadWorkspacePathIndex(apiClient, context);
    }

    for (const depName of requiredWorkspaceDepNames) {
      if (context.workspacePackagesByName.has(depName) || context.unresolvedWorkspaceDepNames.has(depName)) {
        continue;
      }

      const resolved = await resolveWorkspacePackageByName(
        apiClient,
        context.workspaceConfig.packages,
        depName,
        context.workspacePackageJsonPaths,
        context.workspacePathIndexComplete
      );

      if (resolved.status === "resolved") {
        context.workspacePackagesByName.set(depName, {
          version: resolved.version,
          path: resolved.path
        });
      } else {
        context.unresolvedWorkspaceDepNames.add(depName);
      }

      if (resolved.warning) {
        addWarning(context, resolved.warning);
      }

      if (resolved.warning === "rate_limited" || resolved.warning === "network_error") {
        break;
      }
    }

    return context;
  }

  async function loadWorkspacePathIndex(apiClient, context) {
    context.workspacePathIndexLoaded = true;

    try {
      const treeSnapshot = await apiClient.fetchTreeSnapshot();
      context.workspacePackageJsonPaths = buildWorkspacePackageJsonPathSet(
        treeSnapshot.tree,
        context.workspaceConfig ? context.workspaceConfig.packages : []
      );
      context.workspacePathIndexComplete = !treeSnapshot.truncated;

      if (treeSnapshot.truncated) {
        addWarning(context, "workspace_index_truncated");
      }
    } catch (error) {
      addWarning(context, error && error.code ? error.code : "workspace_path_index_failed");
    }
  }

  async function resolveWorkspacePackageByName(
    apiClient,
    packagePatterns,
    depName,
    existingWorkspacePackageJsonPaths,
    isPathIndexComplete
  ) {
    const candidates = buildPackageJsonCandidatesForDependency(packagePatterns, depName);

    let preferredCandidates = candidates;
    let fallbackCandidates = [];

    if (existingWorkspacePackageJsonPaths instanceof Set) {
      preferredCandidates = candidates.filter((path) => existingWorkspacePackageJsonPaths.has(path));
      fallbackCandidates = candidates.filter((path) => !existingWorkspacePackageJsonPaths.has(path));
    }

    const preferredResult = await tryResolveWithCandidatePaths(apiClient, depName, preferredCandidates);
    if (preferredResult.status === "resolved" || preferredResult.warning) {
      return preferredResult;
    }

    if (existingWorkspacePackageJsonPaths instanceof Set && fallbackCandidates.length > 0) {
      const fallbackLimit = isPathIndexComplete ? 20 : 80;
      const limitedFallback = fallbackCandidates.slice(0, fallbackLimit);
      const fallbackResult = await tryResolveWithCandidatePaths(apiClient, depName, limitedFallback);
      if (fallbackResult.status === "resolved" || fallbackResult.warning) {
        return fallbackResult;
      }

      if (fallbackCandidates.length > fallbackLimit) {
        return {
          status: "unresolved",
          warning: "workspace_lookup_incomplete"
        };
      }
    }

    return {
      status: "unresolved"
    };
  }

  async function tryResolveWithCandidatePaths(apiClient, depName, candidatePaths) {
    for (const path of candidatePaths) {
      try {
        const pkg = await apiClient.fetchJsonFile(path);
        if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string") {
          continue;
        }

        if (pkg.name !== depName) {
          continue;
        }

        return {
          status: "resolved",
          version: pkg.version,
          path
        };
      } catch (error) {
        if (error && error.code === "not_found") {
          continue;
        }

        if (error && error.code === "rate_limited") {
          return {
            status: "unresolved",
            warning: "rate_limited"
          };
        }

        if (error && error.code === "network_error") {
          return {
            status: "unresolved",
            warning: "network_error"
          };
        }
      }
    }

    return {
      status: "unresolved"
    };
  }

  function buildWorkspacePackageJsonPathSet(tree, packagePatterns) {
    const paths = new Set();
    const regexes = compileWorkspacePatternRegexes(packagePatterns);

    for (const node of tree || []) {
      if (!node || node.type !== "blob" || typeof node.path !== "string") {
        continue;
      }

      if (node.path !== "package.json" && !node.path.endsWith("/package.json")) {
        continue;
      }

      const dir = node.path === "package.json" ? "" : node.path.slice(0, -"/package.json".length);
      if (!regexes.some((regex) => regex.test(dir))) {
        continue;
      }

      paths.add(node.path);
    }

    return paths;
  }

  function compileWorkspacePatternRegexes(packagePatterns) {
    const patterns = packagePatterns && packagePatterns.length > 0 ? packagePatterns : ["**"];
    return patterns.map((pattern) => globToRegExp(normalizeGlobPattern(pattern)));
  }

  function buildPackageJsonCandidatesForDependency(packagePatterns, depName) {
    const MAX_CANDIDATES = 120;
    const patterns = packagePatterns && packagePatterns.length > 0 ? packagePatterns : ["packages/*", "apps/*", "libs/*"];
    const variants = buildDependencyNameVariants(depName);
    const candidates = [];
    const seen = new Set();

    const preferredPrefixes = buildPreferredPrefixes(patterns);
    for (const prefix of preferredPrefixes) {
      for (const variant of variants) {
        if (candidates.length >= MAX_CANDIDATES) {
          return candidates;
        }

        if (!prefix) {
          addCandidate(`${variant}/package.json`);
        } else {
          addCandidate(`${prefix}/${variant}/package.json`);
        }
      }
    }

    for (const pattern of patterns) {
      const normalized = normalizeGlobPattern(pattern);
      if (!normalized) {
        addCandidate("package.json");
        continue;
      }

      const dirs = expandPatternWithVariants(normalized, variants);
      for (const dir of dirs) {
        if (candidates.length >= MAX_CANDIDATES) {
          return candidates;
        }
        addCandidate(`${dir}/package.json`);
      }
    }

    for (const variant of variants) {
      if (candidates.length >= MAX_CANDIDATES) {
        break;
      }

      addCandidate(`${variant}/package.json`);
    }

    return candidates;

    function addCandidate(path) {
      const normalized = normalizeCandidatePath(path);
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      candidates.push(normalized);
    }
  }

  function buildDependencyNameVariants(depName) {
    const variants = [];
    const seen = new Set();

    add(depName);
    add(depName.replace(/^@/, ""));
    add(depName.replace(/\//g, "-"));

    const scoped = depName.match(/^@([^/]+)\/(.+)$/);
    if (scoped) {
      const scope = scoped[1];
      const name = scoped[2];
      add(`${scope}/${name}`);
      add(name);
      add(`${scope}-${name}`);
      add(`${scope}_${name}`);
    }

    return variants;

    function add(value) {
      const normalized = normalizeCandidatePath(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      variants.push(normalized);
    }
  }

  function buildPreferredPrefixes(packagePatterns) {
    const prefixes = [];
    const seen = new Set();

    add("");
    add("packages");
    add("apps");
    add("libs");

    for (const pattern of packagePatterns || []) {
      const normalized = normalizeGlobPattern(pattern);
      if (!normalized) {
        continue;
      }

      const prefix = extractStaticPrefix(normalized);
      if (prefix) {
        add(prefix);
      }
    }

    return prefixes;

    function add(value) {
      const normalized = normalizeCandidatePath(value);
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      prefixes.push(normalized);
    }
  }

  function extractStaticPrefix(pattern) {
    const segments = pattern.split("/").filter(Boolean);
    const staticSegments = [];

    for (const segment of segments) {
      if (segment.includes("*") || segment.includes("?")) {
        break;
      }
      staticSegments.push(segment);
    }

    return staticSegments.join("/");
  }

  function expandPatternWithVariants(pattern, variants) {
    if (!pattern.includes("*")) {
      return [normalizeCandidatePath(pattern)];
    }

    const results = [];
    const seen = new Set();

    for (const variant of variants) {
      const replaced = replaceWildcards(pattern, variant);
      if (!replaced || replaced.includes("*")) {
        continue;
      }

      const normalized = normalizeCandidatePath(replaced);
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      results.push(normalized);
    }

    return results;
  }

  function replaceWildcards(pattern, variant) {
    const variantSegments = variant.split("/").filter(Boolean);
    const fallback = variantSegments[variantSegments.length - 1] || variant;
    let pointer = 0;

    return pattern
      .split("/")
      .map((segment) => {
        if (segment === "**") {
          pointer = variantSegments.length;
          return variantSegments.join("/");
        }

        if (!segment.includes("*")) {
          return segment;
        }

        const token = variantSegments[Math.min(pointer, variantSegments.length - 1)] || fallback;
        pointer += 1;
        return segment.replace(/\*/g, token);
      })
      .join("/");
  }

  function normalizeCandidatePath(path) {
    return String(path || "")
      .trim()
      .replace(/^\.?\//, "")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
  }

  function addWarning(context, warning) {
    if (!warning) {
      return;
    }
    if (!context.warnings.includes(warning)) {
      context.warnings.push(warning);
    }
  }

  function parsePnpmWorkspaceYaml(text) {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    const result = {
      packages: [],
      catalog: {},
      catalogs: {}
    };

    let section = null;
    let currentCatalogName = null;

    for (const rawLine of lines) {
      if (!rawLine.trim()) {
        continue;
      }

      const withoutComment = stripComment(rawLine);
      if (!withoutComment.trim()) {
        continue;
      }

      const indent = withoutComment.match(/^\s*/)[0].length;
      const trimmed = withoutComment.trim();

      if (indent === 0) {
        section = null;
        currentCatalogName = null;

        if (trimmed === "packages:" || trimmed.startsWith("packages:")) {
          section = "packages";
        } else if (trimmed === "catalog:" || trimmed.startsWith("catalog:")) {
          section = "catalog";
        } else if (trimmed === "catalogs:" || trimmed.startsWith("catalogs:")) {
          section = "catalogs";
        }

        continue;
      }

      if (section === "packages") {
        const packageMatch = trimmed.match(/^-\s+(.+)$/);
        if (packageMatch) {
          result.packages.push(unquote(packageMatch[1].trim()));
        }
        continue;
      }

      if (section === "catalog") {
        const pair = parseKeyValue(trimmed);
        if (pair) {
          result.catalog[pair.key] = pair.value;
        }
        continue;
      }

      if (section === "catalogs") {
        if (indent === 2 && trimmed.endsWith(":")) {
          currentCatalogName = unquote(trimmed.slice(0, -1).trim());
          if (currentCatalogName) {
            result.catalogs[currentCatalogName] = {};
          }
          continue;
        }

        if (indent >= 4 && currentCatalogName) {
          const pair = parseKeyValue(trimmed);
          if (pair) {
            result.catalogs[currentCatalogName][pair.key] = pair.value;
          }
        }
      }
    }

    return result;
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

  function collectDependencyEntries(packageJson) {
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const entries = [];

    for (const field of fields) {
      const block = packageJson[field];
      if (!block || typeof block !== "object") {
        continue;
      }

      for (const [depName, spec] of Object.entries(block)) {
        if (typeof spec !== "string") {
          continue;
        }

        entries.push({ field, depName, spec });
      }
    }

    return entries;
  }

  function resolveDependencySpec(entry, context) {
    if (entry.spec.startsWith("workspace:")) {
      return resolveWorkspaceSpec(entry.spec, entry.depName, context.workspacePackagesByName);
    }

    if (entry.spec.startsWith("catalog:")) {
      return resolveCatalogSpec(entry.spec, entry.depName, context.catalogs);
    }

    return {
      status: "unresolved",
      reason: "unsupported_spec"
    };
  }

  function resolveWorkspaceSpec(spec, depName, workspacePackagesByName) {
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

    if (suffix && /^(\^|~|>=|<=|>|<|=)?v?[0-9xX*]/.test(suffix)) {
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

  function resolveCatalogSpec(spec, depName, catalogs) {
    const catalogName = spec.slice("catalog:".length).trim();

    if (catalogName.length === 0) {
      const defaultValue = catalogs.defaultCatalog.get(depName);
      if (!defaultValue) {
        return {
          status: "unresolved",
          reason: "catalog_not_found"
        };
      }

      return {
        status: "resolved",
        version: defaultValue
      };
    }

    const catalog = catalogs.namedCatalogs.get(catalogName);
    if (!catalog) {
      return {
        status: "unresolved",
        reason: "catalog_not_found"
      };
    }

    const value = catalog.get(depName);
    if (!value) {
      return {
        status: "unresolved",
        reason: "catalog_not_found"
      };
    }

    return {
      status: "resolved",
      version: value
    };
  }

  function buildUnresolvedMessage(reason) {
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

  function renderDependencyAnnotations(items) {
    injectStyles();
    clearDependencyAnnotations();

    const lines = findCodeLineElements();
    const remaining = new Set(items.map((_, index) => index));

    for (const line of lines) {
      const lineText = line.textContent || "";
      if (!lineText.includes(":")) {
        continue;
      }

      for (const index of [...remaining]) {
        const item = items[index];
        if (!matchesDependencyLine(lineText, item.depName, item.spec)) {
          continue;
        }

        appendAnnotation(line, item);
        remaining.delete(index);
      }

      if (remaining.size === 0) {
        break;
      }
    }

    return {
      total: items.length,
      matched: items.length - remaining.size
    };
  }

  function clearDependencyAnnotations() {
    for (const node of document.querySelectorAll(`.${ANNOTATION_CLASS}`)) {
      node.remove();
    }
  }

  function renderStatus(message, type) {
    injectStyles();
    clearStatus();

    const host =
      document.querySelector(".file-header") ||
      document.querySelector("[data-testid='breadcrumbs']") ||
      document.querySelector("main") ||
      document.body;

    if (!host) {
      return;
    }

    const node = document.createElement("div");
    node.className = `${STATUS_CLASS} ${STATUS_CLASS}--${type || "info"}`;
    node.textContent = `[pnpm-resolver] ${message}`;
    host.prepend(node);
  }

  function clearStatus() {
    for (const node of document.querySelectorAll(`.${STATUS_CLASS}`)) {
      node.remove();
    }
  }

  function appendAnnotation(line, item) {
    const annotation = document.createElement("span");
    annotation.className = `${ANNOTATION_CLASS} ${item.status === "resolved" ? `${ANNOTATION_CLASS}--resolved` : `${ANNOTATION_CLASS}--unresolved`}`;
    annotation.textContent = item.status === "resolved" ? `  -> ${item.version}` : `  -> unresolved (${item.reasonMessage})`;
    line.appendChild(annotation);
  }

  function matchesDependencyLine(text, depName, spec) {
    const depPattern = escapeRegExp(depName);
    const specPattern = escapeRegExp(spec);
    const regex = new RegExp(`["']${depPattern}["']\\s*:\\s*["']${specPattern}["']`);
    return regex.test(text);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findCodeLineElements() {
    const selectors = [
      "td.blob-code",
      "td.blob-code-inner",
      "td.js-file-line",
      "[data-testid='code-cell']",
      "[data-testid='code-line']",
      ".react-code-line",
      ".react-file-line",
      "tr.react-code-line td:last-child",
      "[data-line-number] + td"
    ];

    const seen = new Set();
    const lines = [];

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) {
          continue;
        }

        seen.add(node);
        lines.push(node);
      }
    }

    return lines;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${ANNOTATION_CLASS} {
        margin-left: 8px;
        font-size: 12px;
        font-style: italic;
        white-space: nowrap;
      }

      .${ANNOTATION_CLASS}--resolved {
        color: #1f883d;
      }

      .${ANNOTATION_CLASS}--unresolved {
        color: #6e7781;
      }

      .${STATUS_CLASS} {
        margin: 0 0 8px;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
        border: 1px solid #d0d7de;
        color: #24292f;
        background: #f6f8fa;
      }

      .${STATUS_CLASS}--warning {
        color: #6e7781;
        border-color: #d8dee4;
      }

      .${STATUS_CLASS}--error {
        color: #cf222e;
        border-color: rgba(255, 129, 130, 0.4);
        background: #ffebe9;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function chooseWarning(warnings) {
    if (!warnings || warnings.length === 0) {
      return "";
    }

    if (warnings.includes("rate_limited")) {
      return "GitHub API rate limit reached while loading workspace metadata.";
    }

    if (warnings.includes("pnpm_workspace_missing") || warnings.includes("not_found")) {
      return "pnpm-workspace.yaml not found; catalog/workspace resolution may be incomplete.";
    }

    if (warnings.includes("parse_error")) {
      return "Could not parse pnpm-workspace.yaml; resolution may be incomplete.";
    }

    if (warnings.includes("workspace_lookup_incomplete")) {
      return "Workspace scan was partial to avoid API limits; some workspace:* entries may remain unresolved.";
    }

    if (warnings.includes("workspace_index_truncated")) {
      return "Workspace file index was truncated; fallback lookup is enabled for unresolved packages.";
    }

    if (warnings.includes("workspace_path_index_failed")) {
      return "Workspace file index could not be loaded; using direct candidate probing.";
    }

    return "Some workspace metadata could not be loaded.";
  }

  function observePageChanges(onChange) {
    const observer = new MutationObserver(() => {
      onChange();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function hookHistory(onChange) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      originalPushState.apply(this, args);
      onChange();
    };

    history.replaceState = function patchedReplaceState(...args) {
      originalReplaceState.apply(this, args);
      onChange();
    };

    window.addEventListener("popstate", onChange);
  }

  function debounce(fn, delayMs) {
    let timeoutId = null;

    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        timeoutId = null;
        fn();
      }, delayMs);
    };
  }

  class GitHubApiError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = "GitHubApiError";
      this.code = code;
      this.status = status;
    }
  }

  class GitHubApiClient {
    constructor(owner, repo, ref) {
      this.owner = owner;
      this.repo = repo;
      this.ref = ref;
    }

    async fetchJsonFile(path, ref = this.ref) {
      const text = await this.fetchTextFile(path, ref);

      try {
        return JSON.parse(text);
      } catch {
        throw new GitHubApiError(`Failed to parse JSON: ${path}`, "parse_error", 200);
      }
    }

    async fetchTextFile(path, ref = this.ref) {
      const encodedPath = path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");

      const endpoint = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
      const data = await this.#requestJson(endpoint);

      if (!data || typeof data.content !== "string") {
        throw new GitHubApiError(`Unexpected GitHub contents response for ${path}`, "api_error", 200);
      }

      return decodeBase64Utf8(data.content);
    }

    async fetchTreeSnapshot(ref = this.ref) {
      const endpoint = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const data = await this.#requestJson(endpoint);

      if (!data || !Array.isArray(data.tree)) {
        throw new GitHubApiError("Unexpected Git tree response", "api_error", 200);
      }

      return {
        tree: data.tree,
        truncated: Boolean(data.truncated)
      };
    }

    async #requestJson(endpoint) {
      const globalKey = `${this.owner}/${this.repo}${endpoint}`;

      if (apiResponseCache.has(globalKey)) {
        return apiResponseCache.get(globalKey);
      }

      const cachedError = apiErrorCache.get(globalKey);
      if (cachedError && cachedError.expiresAt > Date.now()) {
        throw new GitHubApiError(cachedError.message, cachedError.code, cachedError.status);
      }
      if (cachedError) {
        apiErrorCache.delete(globalKey);
      }

      if (apiPendingCache.has(globalKey)) {
        return apiPendingCache.get(globalKey);
      }

      const request = (async () => {
        try {
          const response = await fetch(`${API_BASE}${endpoint}`, {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28"
            }
          });

          if (response.status === 403 || response.status === 429) {
            const ttl = computeRateLimitTtl(response);
            const error = new GitHubApiError("GitHub API rate limited", "rate_limited", response.status);
            rememberApiError(globalKey, error, ttl);
            throw error;
          }

          if (response.status === 404) {
            const error = new GitHubApiError("GitHub resource not found", "not_found", response.status);
            rememberApiError(globalKey, error, NOT_FOUND_TTL_MS);
            throw error;
          }

          if (!response.ok) {
            const error = new GitHubApiError(`GitHub API request failed: ${response.status}`, "api_error", response.status);
            rememberApiError(globalKey, error, API_ERROR_TTL_MS);
            throw error;
          }

          const json = await response.json();
          apiErrorCache.delete(globalKey);
          apiResponseCache.set(globalKey, json);
          return json;
        } catch (error) {
          if (error instanceof GitHubApiError) {
            throw error;
          }

          const networkError = new GitHubApiError("Network error while calling GitHub API", "network_error", 0);
          rememberApiError(globalKey, networkError, API_ERROR_TTL_MS);
          throw networkError;
        }
      })();

      apiPendingCache.set(globalKey, request);

      try {
        return await request;
      } finally {
        apiPendingCache.delete(globalKey);
      }
    }
  }

  function decodeBase64Utf8(value) {
    const normalized = value.replace(/\n/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder().decode(bytes);
  }

  function cacheContextFailure(pathname, error) {
    const ttl = error && error.code === "rate_limited" ? RATE_LIMIT_TTL_MS : CONTEXT_FAILURE_TTL_MS;
    contextFailureCache.set(pathname, {
      expiresAt: Date.now() + ttl
    });
  }

  function rememberApiError(key, error, ttlMs) {
    apiErrorCache.set(key, {
      message: error.message,
      code: error.code || "api_error",
      status: error.status || 0,
      expiresAt: Date.now() + Math.max(1_000, ttlMs)
    });

    if (apiErrorCache.size > API_ERROR_CACHE_LIMIT) {
      const oldestKey = apiErrorCache.keys().next().value;
      if (oldestKey) {
        apiErrorCache.delete(oldestKey);
      }
    }
  }

  function computeRateLimitTtl(response) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (reset > nowSec) {
        return Math.min((reset - nowSec) * 1000, 10 * 60 * 1000);
      }
    }

    return RATE_LIMIT_TTL_MS;
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

  function parseKeyValue(line) {
    const match = line.match(/^([^:]+):\s*(.+)?$/);
    if (!match) {
      return null;
    }

    const key = unquote(match[1].trim());
    const value = unquote((match[2] || "").trim());

    if (!key) {
      return null;
    }

    return { key, value };
  }

  function stripComment(line) {
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (ch === "#" && !inSingle && !inDouble) {
        return line.slice(0, i);
      }
    }

    return line;
  }

  function unquote(value) {
    if (!value) {
      return "";
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    return value;
  }
})();
