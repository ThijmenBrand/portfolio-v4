import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Projects",
    width: 1140,
    height: 740,
    minWidth: 340,
    minHeight: 420,
    translucent: true,
  },
  admin: true,
  launcher: { name: "Projects", icon: "/assets/icons/projects.svg" },
} satisfies AppManifest;
