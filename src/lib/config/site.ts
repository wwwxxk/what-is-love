export const site = {
  name: "WHAT IS LOVE?",
  description: "A robot wants to understand love. Will you help it?",
} as const;

export const contributionDimensions = [
  { id: "who", label: "Who", description: "The people we hold close." },
  { id: "what", label: "What", description: "The shapes love takes." },
  { id: "when", label: "When", description: "The moments that stay." },
  { id: "where", label: "Where", description: "The places we belong." },
  { id: "how", label: "How", description: "The ways we show it." },
  { id: "feeling", label: "Feeling", description: "The sounds that move us." },
] as const;

export type ContributionDimension = (typeof contributionDimensions)[number]["id"];
