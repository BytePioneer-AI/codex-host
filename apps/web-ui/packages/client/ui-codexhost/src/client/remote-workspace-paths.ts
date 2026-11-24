/** Pure breadcrumb path helpers for the remote workspace Finder-sheet dialog. */

export interface PathSegment {
  readonly name: string;
  readonly path: string;
}

export function buildBreadcrumbs(
  currentPath: string,
  homeDir: string | undefined,
): { inHome: boolean; rootSegment: PathSegment | null; segments: PathSegment[] } {
  if (!currentPath) return { inHome: false, rootSegment: null, segments: [] };
  const isWin = currentPath.includes("\\") && !currentPath.startsWith("/");
  const sep = isWin ? "\\" : "/";
  const stripTrailing = (p: string): string => {
    if (isWin && /^\\\\[^\\]+\\[^\\]+\\?$/u.test(p)) return p.replace(/\\+$/u, "");
    if (isWin && /^[A-Za-z]:\\?$/u.test(p)) return `${p.slice(0, 2)}\\`;
    if (!isWin && /^\/+$/u.test(p)) return "/";
    return p.replace(/[\\/]+$/u, "");
  };

  const normalized = stripTrailing(currentPath);
  const normalizedHome = homeDir ? stripTrailing(homeDir) : undefined;

  if (normalizedHome) {
    const matchesHome = isWin
      ? normalized.toLowerCase() === normalizedHome.toLowerCase() ||
        normalized.toLowerCase().startsWith(`${normalizedHome.toLowerCase()}${sep}`)
      : normalized === normalizedHome || normalized.startsWith(`${normalizedHome}${sep}`);

    if (matchesHome) {
      const rest = normalized.slice(normalizedHome.length).replace(/^[\\/]+/u, "");
      if (!rest) return { inHome: true, rootSegment: null, segments: [] };
      const parts = rest.split(/[\\/]+/u).filter(Boolean);
      const segments: PathSegment[] = [];
      let acc = normalizedHome;
      for (const part of parts) {
        acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
        segments.push({ name: part, path: acc });
      }
      return { inHome: true, rootSegment: null, segments };
    }
  }

  if (isWin) {
    const uncMatch = /^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/u.exec(normalized);
    if (uncMatch) {
      const rootPath = uncMatch[1] ?? "";
      const rest = (uncMatch[2] ?? "").replace(/^\\+/u, "");
      const parts = rest ? rest.split(/\\+/u).filter(Boolean) : [];
      const segments: PathSegment[] = [];
      let acc = rootPath;
      for (const part of parts) {
        acc = `${acc}\\${part}`;
        segments.push({ name: part, path: acc });
      }
      return { inHome: false, rootSegment: { name: rootPath, path: rootPath }, segments };
    }
    const driveMatch = /^([A-Za-z]:)(?:\\(.*))?$/u.exec(normalized);
    if (driveMatch) {
      const drive = driveMatch[1] ?? "";
      const rest = (driveMatch[2] ?? "").replace(/^\\+/u, "");
      const rootPath = `${drive}\\`;
      const parts = rest ? rest.split(/\\+/u).filter(Boolean) : [];
      const segments: PathSegment[] = [];
      let acc = rootPath;
      for (const part of parts) {
        acc = acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
        segments.push({ name: part, path: acc });
      }
      return { inHome: false, rootSegment: { name: drive, path: rootPath }, segments };
    }
  }

  const parts = normalized.split("/").filter(Boolean);
  const segments: PathSegment[] = [];
  let acc = "";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    segments.push({ name: part, path: acc });
  }
  return {
    inHome: false,
    rootSegment: normalized.startsWith("/") ? { name: "/", path: "/" } : null,
    segments,
  };
}
