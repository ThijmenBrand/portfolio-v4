import type { AppManifest } from "../../kernel/binfmt";

export default {
  url: "https://finance.thijmenbrand.nl",
  window: {
    title: "Fintrack",
    width: 1000,
    height: 680,
    minWidth: 480,
    minHeight: 360,
  },
  admin: true,
  desktop: { name: "Fintrack", icon: "/assets/icons/fintrack.svg" },
} satisfies AppManifest;
