/**
 * Registry icon URLs point at raw.githubusercontent.com. AssetIcon never
 * fetches them: the consuming app installs a resolver that maps a known URL
 * to a locally bundled image (shipped in the build, not fetched at runtime).
 * A URL the resolver does not recognize is "unknown" - AssetIcon falls back
 * to the Identicon monogram instead of ever loading from the network.
 */
let resolve: (url: string) => string | undefined = () => undefined;

export const setBundledIconResolver = (fn: (url: string) => string | undefined): void => {
  resolve = fn;
};

export const resolveBundledIcon = (url: string): string | undefined => resolve(url);
