import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Admin",
    width: 480,
    height: 420,
    minWidth: 320,
    minHeight: 240,
  },
  launcher: { name: "Admin", icon: "/assets/icons/default-app.svg" },
  admin: true,
} satisfies AppManifest;
