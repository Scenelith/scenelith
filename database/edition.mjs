export const databaseEdition = Object.freeze({
  name: "selfhost",
  baseline: {
    version: "core-v1",
    url: new URL("./baselines/core-v1.sql", import.meta.url),
  },
  legacyUrl: new URL("./legacy/", import.meta.url),
  streams: [
    { name: "core", url: new URL("./migrations/core/", import.meta.url) },
  ],
});
