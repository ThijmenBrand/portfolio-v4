import { einval } from "../errors";

export function normalize(path: string): string {
  // if path is relative, throw an error
  if (!path.startsWith("/")) throw einval(path);

  // collapse duplicate slashes and remove trailing slash (except for root)
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  // resolve . and .. segments
  const segments = path.split("/").filter(Boolean);
  const resolvedSegments: string[] = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    } else if (segment === "..") {
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(segment);
    }
  }

  // reconstruct the normalized path
  path = "/" + resolvedSegments.join("/");
  return path === "" ? "/" : path;
}

export function split(path: string): string[] {
  return normalize(path).split("/").filter(Boolean);
}

export function join(...parts: string[]): string {
  return normalize(parts.join("/"));
}

export function dirname(path: string): string {
  const parts = split(path);
  if (parts.length === 0) {
    return "/";
  }
  parts.pop();
  return "/" + parts.join("/");
}

export function basename(path: string): string {
  if (path === "/") {
    return "/";
  }

  const parts = split(path);
  return parts.at(-1) ?? "";
}

export function isValidName(name: string): boolean {
  if (name === "" || name === "." || name === "..") {
    return false;
  }
  return !name.includes("/");
}
