const API_BASE = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = status;
  }
}

export class GitHubApiClient {
  constructor(owner, repo, ref) {
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.cache = new Map();
    this.pending = new Map();
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

  async fetchTree(ref = this.ref) {
    const endpoint = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const data = await this.#requestJson(endpoint);

    if (!data || !Array.isArray(data.tree)) {
      throw new GitHubApiError("Unexpected Git tree response", "api_error", 200);
    }

    return data.tree;
  }

  async #requestJson(endpoint) {
    const cacheKey = endpoint;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    if (this.pending.has(cacheKey)) {
      return this.pending.get(cacheKey);
    }

    const request = (async () => {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: {
          Accept: "application/vnd.github+json"
        }
      });

      if (response.status === 403 || response.status === 429) {
        throw new GitHubApiError("GitHub API rate limited", "rate_limited", response.status);
      }

      if (response.status === 404) {
        throw new GitHubApiError("GitHub resource not found", "not_found", response.status);
      }

      if (!response.ok) {
        throw new GitHubApiError(`GitHub API request failed: ${response.status}`, "api_error", response.status);
      }

      const json = await response.json();
      this.cache.set(cacheKey, json);
      return json;
    })();

    this.pending.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.pending.delete(cacheKey);
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
