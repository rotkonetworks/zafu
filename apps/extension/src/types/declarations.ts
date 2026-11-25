declare module '*.mp4' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}

/** a bundled file as a data: url (webpack `asset/inline`), for a page that must not fetch it */
declare module '*?inline' {
  const dataUrl: string;
  export default dataUrl;
}
