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
  // Handled in commands.ts: typing a site's name in Spotlight opens it.
  commands: [{ id: "open", title: "Open site", hidden: true }],
  search: true,
} satisfies AppManifest;
