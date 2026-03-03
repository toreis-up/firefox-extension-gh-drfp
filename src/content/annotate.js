const STYLE_ID = "pnpm-resolver-style";
const ANNOTATION_CLASS = "pnpm-resolver-annotation";
const STATUS_CLASS = "pnpm-resolver-status";

export function renderDependencyAnnotations(items) {
  injectStyles();
  clearDependencyAnnotations();

  const lines = findCodeLineElements();
  const remaining = new Set(items.map((_, index) => index));

  for (const line of lines) {
    const text = line.textContent || "";
    if (!text.includes(":")) {
      continue;
    }

    for (const index of [...remaining]) {
      const item = items[index];
      if (!matchesDependencyLine(text, item.depName, item.spec)) {
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
    matched: items.length - remaining.size,
    unmatched: [...remaining].map((index) => items[index])
  };
}

export function clearDependencyAnnotations() {
  for (const node of document.querySelectorAll(`.${ANNOTATION_CLASS}`)) {
    node.remove();
  }
}

export function renderStatus(message, type = "info") {
  injectStyles();
  clearStatus();

  const host = findStatusHost();
  if (!host) {
    return;
  }

  const status = document.createElement("div");
  status.className = `${STATUS_CLASS} ${STATUS_CLASS}--${type}`;
  status.textContent = `[pnpm-resolver] ${message}`;
  host.prepend(status);
}

export function clearStatus() {
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
      margin-bottom: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      border: 1px solid #d0d7de;
      color: #24292f;
      background-color: #f6f8fa;
    }

    .${STATUS_CLASS}--warning {
      color: #6e7781;
      border-color: #d8dee4;
    }

    .${STATUS_CLASS}--error {
      color: #cf222e;
      border-color: #ff818266;
      background-color: #ffebe9;
    }
  `;

  document.documentElement.appendChild(style);
}

function findCodeLineElements() {
  const selectors = [
    "td.blob-code",
    "td.blob-code-inner",
    "td.js-file-line",
    "[data-testid='code-cell']",
    "[data-line-number] + td",
    ".react-file-line"
  ];

  const unique = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      unique.add(element);
    }
  }

  return [...unique];
}

function findStatusHost() {
  return (
    document.querySelector(".file-header") ||
    document.querySelector("[data-testid='breadcrumbs']") ||
    document.querySelector("main") ||
    document.body
  );
}
