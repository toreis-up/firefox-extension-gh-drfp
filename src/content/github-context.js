const resolvedContextCache = new Map();

export async function resolvePackageJsonContext(createApiClient) {
  const pathname = window.location.pathname;

  if (resolvedContextCache.has(pathname)) {
    return resolvedContextCache.get(pathname);
  }

  const parsed = parseGitHubBlobPath(pathname);
  if (!parsed) {
    return null;
  }

  const candidates = buildBlobCandidates(parsed.tailSegments);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const api = createApiClient(parsed.owner, parsed.repo, candidate.ref);

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

      resolvedContextCache.set(pathname, resolved);
      return resolved;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function parseGitHubBlobPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
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

function buildBlobCandidates(tailSegments) {
  const candidates = [];

  for (let split = 1; split < tailSegments.length; split += 1) {
    const ref = tailSegments.slice(0, split).join("/");
    const filePath = tailSegments.slice(split).join("/");

    if (!filePath || !filePath.endsWith("package.json")) {
      continue;
    }

    candidates.push({ ref, filePath });
  }

  return candidates;
}
