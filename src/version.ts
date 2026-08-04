import pkg from "../package.json";

// package.json is the single source of truth for the version. `--version`, the
// root endpoint, and release tags all read it, so they cannot drift apart.
export const VERSION: string = pkg.version;
