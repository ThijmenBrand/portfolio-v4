import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Shortcuts",
    width: 560,
    height: 420,
    minWidth: 340,
    minHeight: 300,
  },
  launcher: { name: "Shortcuts", icon: "/assets/icons/shortcuts.svg" },
} satisfies AppManifest;
