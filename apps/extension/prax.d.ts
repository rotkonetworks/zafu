// these are defined at build time by webpack, using values in .env

declare const PRAX: string;
declare const PRAX_ORIGIN: string;

// Build info for verification - injected at build time
interface BuildInfo {
  prax: {
    commit: string;
    branch: string;
    dirty: string;
  };
  penumbraWeb: {
    commit: string;
    branch: string;
    dirty: string;
  };
  buildTime: string;
}
declare const BUILD_INFO: BuildInfo;
