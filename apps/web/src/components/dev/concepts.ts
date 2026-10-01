/** Shared by the route validator and the client-side design switcher. */
export const concepts = [
  { id: "wealth", name: "Wealth", label: "精品理財", en: "Private wealth" },
  { id: "aero", name: "Aero", label: "數位金融", en: "Digital finance" },
  { id: "edge", name: "Edge", label: "深色投資", en: "Modern investing" },
] as const;
export const previousConcepts = [
  { id: "folio", name: "Standard" },
  { id: "terminal", name: "Focus" },
  { id: "orbit", name: "Dark" },
] as const;
export const screenIds = ["home", "explore", "portfolio", "favorites", "insights", "settings", "extras"];
