// PLACEHOLDER until adapter research lands: series used by the synthetic fixture.
export const SAMPLE_SERIES = Array.from({ length: 103 }, (_, i) => ({
  siteId: 'comix', slug: `series-${i}`, name: `Series ${i}`, url: i % 2 ? `https://comix.to/title/series-${i}` : undefined,
}));
