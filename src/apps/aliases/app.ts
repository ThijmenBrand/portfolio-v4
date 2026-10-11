import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Aliases",
    width: 780,
    height: 540,
    minWidth: 360,
    minHeight: 320,
  },
  launcher: { name: "Aliases", icon: "/assets/icons/aliases.svg" },
  admin: true,
} satisfies AppManifest;
