import { renderDependencyAnnotations, renderStatus, clearStatus, clearDependencyAnnotations } from "./annotate.js";
import { resolvePackageJsonContext } from "./github-context.js";
import { GitHubApiClient } from "../core/github-api.js";
import { loadWorkspaceContext } from "../core/workspace-loader.js";
import { collectDependencyEntries, resolveDependencySpec, buildUnresolvedMessage } from "../core/resolver.js";

const state = {
  initialized: false,
  running: false,
  scheduled: false,
  lastSignature: ""
};

export function start() {
  if (state.initialized) {
    return;
  }

  state.initialized = true;

  const scheduleRun = debounce(() => {
    void runResolverOverlay();
  }, 200);

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
    const context = await resolvePackageJsonContext((owner, repo, ref) => new GitHubApiClient(owner, repo, ref));
    if (!context) {
      clearDependencyAnnotations();
      clearStatus();
      state.lastSignature = "";
      return;
    }

    const signature = `${context.owner}/${context.repo}@${context.ref}:${context.filePath}`;
    if (signature === state.lastSignature && document.querySelector(".pnpm-resolver-annotation")) {
      return;
    }

    const dependencyEntries = collectDependencyEntries(context.packageJson)
      .filter((entry) => entry.spec.startsWith("workspace:") || entry.spec.startsWith("catalog:"));

    if (dependencyEntries.length === 0) {
      clearDependencyAnnotations();
      clearStatus();
      state.lastSignature = signature;
      return;
    }

    const workspaceContext = await loadWorkspaceContext(context.api);

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
      renderStatus(`Only ${summary.matched}/${summary.total} dependencies could be annotated in this DOM view.`, "warning");
    } else {
      clearStatus();
    }

    state.lastSignature = signature;
  } catch (error) {
    if (error && error.code === "rate_limited") {
      renderStatus("GitHub API rate limit reached. Please retry later.", "warning");
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

function chooseWarning(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
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
