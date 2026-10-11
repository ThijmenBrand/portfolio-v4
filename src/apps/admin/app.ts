import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Admin",
    width: 420,
    height: 260,
    minWidth: 300,
    minHeight: 180,
  },
  launcher: { name: "Admin", icon: "/assets/icons/default-app.svg" },
  admin: true,
} satisfies AppManifest;
