import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Settings",
    width: 640,
    height: 440,
    minWidth: 520,
    minHeight: 360,
  },
  launcher: { name: "Settings", icon: "/assets/icons/settings.svg" },
} satisfies AppManifest;
