export function parsePnpmWorkspaceYaml(text) {
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
    const char = line[i];

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
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
