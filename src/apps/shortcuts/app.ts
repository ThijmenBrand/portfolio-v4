import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Shortcuts",
    width: 600,
    height: 480,
    minWidth: 340,
    minHeight: 300,
    translucent: true,
  },
  launcher: { name: "Shortcuts", icon: "/assets/icons/shortcuts.svg" },
} satisfies AppManifest;
